// Live layer: Overview + Accounts use the owner-scoped API. Other screens remain sample until connected.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KINDS = [['checking', 'Checking'], ['savings', 'Savings'], ['credit', 'Credit card'], ['brokerage', 'Brokerage'], ['retirement', 'Retirement'], ['loan', 'Loan'], ['property', 'Property'], ['other', 'Other']];
  const KIND_LABEL = Object.fromEntries(KINDS);
  const DEBT = new Set(['credit', 'loan']);
  let me = null, accounts = [], summary = null, error = null, canWrite = false;

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('json')) throw new Error(res.status === 403 ? 'You have read-only access.' : 'Request failed (' + res.status + ')');
    return res.json();
  }
  const signed = (a) => (DEBT.has(a.kind) ? -Math.abs(Number(a.balance)) : Number(a.balance));

  function form() {
    if (!canWrite) return '<p class="sub">You have read-only access.</p>';
    return `<form id="addAcct" class="card" style="margin-bottom:14px"><h3>Add an account</h3>
      <div class="hint">Enter debts (credit card, loan) as the positive amount you owe.</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-top:10px">
        <div><label class="sub" for="fName">Name</label><input id="fName" maxlength="80" required placeholder="Everyday checking"></div>
        <div><label class="sub" for="fKind">Type</label><select id="fKind">${KINDS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
        <div><label class="sub" for="fInst">Institution (optional)</label><input id="fInst" maxlength="80" placeholder="First Harbor Bank"></div>
        <div><label class="sub" for="fBal">Balance (USD)</label><input id="fBal" type="number" step="0.01" required placeholder="0.00"></div>
      </div><button class="btn" type="submit" style="margin-top:12px">Add account</button><span class="sub" id="fMsg" role="status" style="margin-left:10px"></span></form>`;
  }
  function kpis() {
    const s = summary || { assets: 0, liabilities: 0, netWorth: 0, accounts: 0 };
    const card = (l, v, d) => `<div class="card kpi"><div class="l">${l}</div><div class="v num">${v}</div><div class="d">${d}</div></div>`;
    return `<div class="grid g4">${card('Total assets', usd(s.assets, 2), s.accounts + ' account' + (s.accounts === 1 ? '' : 's'))}${card('Total liabilities', usd(-s.liabilities, 2), 'Credit cards and loans')}${card('Net worth', usd(s.netWorth, 2), 'Assets minus liabilities')}${card('Accounts', s.accounts, 'Entered by you')}</div>`;
  }
  function table() {
    if (!accounts.length) return '<div class="card"><h3>No accounts yet</h3><p class="sub">Add your first account above. Only you can see what you enter.</p></div>';
    const groups = {};
    for (const a of accounts) (groups[a.institution || 'Other accounts'] ||= []).push(a);
    return Object.entries(groups).map(([inst, list]) => `<div class="card" style="margin-bottom:14px"><h3>${esc(inst)}</h3><div style="overflow-x:auto"><table>
      <tr><th>Account</th><th>Type</th><th class="r">Balance</th><th>Updated</th>${canWrite ? '<th></th>' : ''}</tr>
      ${list.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(KIND_LABEL[a.kind] || a.kind)}</td><td class="r num ${signed(a) < 0 ? 'down' : ''}">${usd(signed(a), 2)}</td><td>${esc(String(a.updated_at || '').slice(0, 10))}</td>
      ${canWrite ? `<td class="r"><button class="chip sm" data-edit="${esc(a.id)}">Update</button> <button class="chip sm" data-del="${esc(a.id)}">Delete</button></td>` : ''}</tr>`).join('')}
      </table></div></div>`).join('');
  }
  function overviewHtml() {
    if (error) return errHtml();
    if (!me) return '<div class="card"><p class="sub">Loading…</p></div>';
    return kpis() + (accounts.length ? '' : '<div class="card" style="margin-top:14px"><h3>Welcome</h3><p class="sub">Go to Accounts and add your first account to see your net worth here.</p><a class="btn" href="#accounts">Add an account</a></div>');
  }
  function accountsHtml() { return error ? errHtml() : !me ? '<div class="card"><p class="sub">Loading…</p></div>' : plaidHtml() + form() + table(); }
  const errHtml = () => `<div class="card"><h3>Couldn't load your data</h3><p class="sub">${esc(error)}</p><button class="btn" data-retry>Try again</button></div>`;
  function paint() {
    const ov = document.getElementById('v-overview'), ac = document.getElementById('v-accounts');
    if (!ov || !ac) return;
    ov.innerHTML = overviewHtml(); ac.innerHTML = accountsHtml();
    document.querySelectorAll('[data-retry]').forEach((b) => (b.onclick = load));
    bindPlaid(ac);
    const f = document.getElementById('addAcct');
    if (f) f.onsubmit = async (e) => {
      e.preventDefault(); const msg = document.getElementById('fMsg'); msg.textContent = 'Saving…';
      try {
        await api('/accounts', { method: 'POST', body: JSON.stringify({ name: f.querySelector('#fName').value, kind: f.querySelector('#fKind').value, institution: f.querySelector('#fInst').value || null, balance: Number(f.querySelector('#fBal').value) }) });
        await load();
      } catch (err) { msg.textContent = err.message; }
    };
    ac.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = async () => {
      const v = prompt('New balance (USD):'); if (v === null) return; const n = Number(v);
      if (!Number.isFinite(n)) return alert('Enter a number.');
      try { await api('/accounts/' + b.dataset.edit, { method: 'PATCH', body: JSON.stringify({ balance: n }) }); await load(); } catch (err) { alert(err.message); }
    }));
    ac.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!confirm('Delete this account? This cannot be undone.')) return;
      try { await api('/accounts/' + b.dataset.del, { method: 'DELETE' }); await load(); } catch (err) { alert(err.message); }
    }));
  }
  async function load() {
    try {
      const [a, s] = await Promise.all([api('/accounts'), api('/summary')]);
      accounts = a.accounts; summary = s; error = null;
    } catch (e) { error = e.message; }
    paint();
    await loadMore();
    const stamp = document.querySelector('.who span'); if (stamp && !error) stamp.textContent = 'Updated ' + new Date().toLocaleString();
  }


  // ---------- Banking (transactions) and Cash Flow ----------
  let txns = [], flow = null, flowErr = null, txErr = null;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mlabel = (k) => MON[Number(k.slice(5, 7)) - 1] + ' ' + k.slice(2, 4);
  const acctName = (id) => (accounts.find((a) => a.id === id) || {}).name || 'Unknown';
  const today = () => new Date().toISOString().slice(0, 10);
  function txForm() {
    if (!canWrite) return '';
    if (!accounts.length) return '<div class="card" style="margin-bottom:14px"><p class="sub">Add an account first, then you can record transactions.</p><a class="btn" href="#accounts">Go to Accounts</a></div>';
    return `<form id="addTx" class="card" style="margin-bottom:14px"><h3>Add a transaction</h3>
      <div class="hint">Money out is negative (e.g. -42.10). Use the category "Transfer" for moves between your own accounts so they are not counted as income or spending.</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:10px">
        <div><label class="sub" for="tDate">Date</label><input id="tDate" type="date" required value="${today()}"></div>
        <div><label class="sub" for="tAcct">Account</label><select id="tAcct">${accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select></div>
        <div><label class="sub" for="tDesc">Description</label><input id="tDesc" maxlength="200" required placeholder="Market Basket"></div>
        <div><label class="sub" for="tCat">Category</label><input id="tCat" maxlength="60" placeholder="Groceries"></div>
        <div><label class="sub" for="tAmt">Amount (USD)</label><input id="tAmt" type="number" step="0.01" required placeholder="-42.10"></div>
      </div><button class="btn" type="submit" style="margin-top:12px">Add transaction</button><span class="sub" id="tMsg" role="status" style="margin-left:10px"></span></form>`;
  }
  function txTable() {
    if (!txns.length) return '<div class="card"><h3>No transactions yet</h3><p class="sub">Transactions you add appear here. Only you can see them.</p></div>';
    return `<div class="card"><h3>Recent transactions</h3><div class="hint">Transfers are excluded from income and expenses</div><div style="overflow-x:auto"><table>
      <tr><th>Date</th><th>Description</th><th>Category</th><th>Account</th><th class="r">Amount</th>${canWrite ? '<th></th>' : ''}</tr>
      ${txns.map((t) => `<tr><td>${esc(t.posted_on)}</td><td>${esc(t.description)}</td><td>${esc(t.category || '—')}</td><td>${esc(acctName(t.account_id))}</td><td class="r num ${Number(t.amount) < 0 ? 'down' : 'up'}">${usd(Number(t.amount), 2)}</td>${canWrite ? `<td class="r"><button class="chip sm" data-deltx="${esc(t.id)}">Delete</button></td>` : ''}</tr>`).join('')}</table></div></div>`;
  }
  function bankingHtml() {
    if (txErr) return `<div class="card"><h3>Couldn't load transactions</h3><p class="sub">${esc(txErr)}</p><button class="btn" data-retry>Try again</button></div>`;
    if (!me) return '<div class="card"><p class="sub">Loading…</p></div>';
    return txForm() + txTable();
  }
  function cashflowHtml() {
    if (flowErr) return `<div class="card"><h3>Couldn't load cash flow</h3><p class="sub">${esc(flowErr)}</p><button class="btn" data-retry>Try again</button></div>`;
    if (!flow) return '<div class="card"><p class="sub">Loading…</p></div>';
    const ms = flow.months, any = ms.some((m) => m.income || m.expenses);
    if (!any) return '<div class="card"><h3>No cash flow yet</h3><p class="sub">Add transactions in Banking and your income and spending appear here.</p><a class="btn" href="#banking">Go to Banking</a></div>';
    const w = 640, h = 240, max = Math.max(1, ...ms.flatMap((m) => [m.income, m.expenses])), bw = Math.min(34, 280 / ms.length), step = (w - 60) / ms.length;
    const bars = ms.map((m, i) => { const x = 40 + i * step, hi = (m.income / max) * (h - 50), he = (m.expenses / max) * (h - 50);
      return `<rect x="${x}" y="${h - 30 - hi}" width="${bw}" height="${hi}" rx="4" fill="#4f9cf0"><title>${mlabel(m.month)} income ${usd(m.income)}</title></rect><rect x="${x + bw + 4}" y="${h - 30 - he}" width="${bw}" height="${he}" rx="4" fill="#2fb589"><title>${mlabel(m.month)} expenses ${usd(m.expenses)}</title></rect><text x="${x + bw}" y="${h - 10}" fill="#8393ad" font-size="11" text-anchor="middle">${mlabel(m.month).split(' ')[0]}</text>`; }).join('');
    const [yy, mm] = flow.currentMonth.split('-').map(Number), days = new Date(yy, mm, 0).getDate(), lead = new Date(yy, mm - 1, 1).getDay();
    const vals = Array.from({ length: days }, (_, i) => flow.daily[`${flow.currentMonth}-${String(i + 1).padStart(2, '0')}`] || 0), mx = Math.max(1, ...vals);
    const col = (v) => (v === 0 ? '#e8f3ec' : v < mx * 0.2 ? '#bfe3cb' : v < mx * 0.45 ? '#7ccb97' : v < mx * 0.75 ? '#3ea66b' : '#1f7a4d');
    const heat = [...Array(lead).fill('<span></span>'), ...vals.map((v, i) => `<button style="background:${col(v)};${v >= mx * 0.75 ? 'color:#fff' : ''}" data-d="${i + 1}" data-v="${v}" aria-label="${MON[mm - 1]} ${i + 1}: ${usd(v, 2)}">${i + 1}</button>`)].join('');
    const cur = ms[ms.length - 1];
    return `<div class="grid g4"><div class="card kpi"><div class="l">Income (${mlabel(cur.month)})</div><div class="v num up">${usd(cur.income, 2)}</div></div><div class="card kpi"><div class="l">Expenses</div><div class="v num down">${usd(-cur.expenses, 2)}</div></div><div class="card kpi"><div class="l">Net cash flow</div><div class="v num ${cur.net < 0 ? 'down' : 'up'}">${usd(cur.net, 2)}</div></div><div class="card kpi"><div class="l">Savings rate</div><div class="v num">${cur.income ? Math.round((cur.net / cur.income) * 100) + '%' : '—'}</div></div></div>
      <div class="grid g2" style="margin-top:14px"><div class="card"><h3>Monthly cash flow</h3><div class="hint"><span style="color:#4f9cf0">■</span> Income &nbsp;<span style="color:#2fb589">■</span> Expenses · transfers excluded</div><svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Monthly income and expenses"><line x1="30" x2="${w}" y1="${h - 30}" y2="${h - 30}" stroke="#1c2a42"/>${bars}</svg>
      <table style="margin-top:8px"><tr><th>Month</th><th class="r">Income</th><th class="r">Expenses</th><th class="r">Net</th></tr>${ms.map((m) => `<tr><td>${mlabel(m.month)}</td><td class="r num">${usd(m.income, 2)}</td><td class="r num">${usd(m.expenses, 2)}</td><td class="r num ${m.net < 0 ? 'down' : 'up'}">${usd(m.net, 2)}</td></tr>`).join('')}</table></div>
      <div class="card"><h3>Spending heatmap · ${MON[mm - 1]} ${yy}</h3><div class="hint">Darker = higher daily spend. Click a day for details.</div><div class="dow"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div><div class="heat" id="heat">${heat}</div><div class="tip" id="heatTip" aria-live="polite">Select a day to see its spending.</div>
      <h3 style="margin-top:14px">Top categories this month</h3>${flow.categories.length ? `<table>${flow.categories.slice(0, 8).map((c) => `<tr><td>${esc(c.category)}</td><td class="r num">${usd(c.amount, 2)}</td></tr>`).join('')}</table>` : '<p class="sub">No spending yet this month.</p>'}</div></div>`;
  }
  async function loadMore() {
    try { txns = (await api('/transactions?limit=200')).transactions; txErr = null; } catch (e) { txErr = e.message; }
    try { flow = await api('/cashflow?months=6'); flowErr = null; } catch (e) { flowErr = e.message; }
    paintMore();
    await loadHoldings();
  }
  function paintMore() {
    const bk = document.getElementById('v-banking'), cf = document.getElementById('v-cashflow');
    if (bk) bk.innerHTML = bankingHtml();
    if (cf) { cf.innerHTML = cashflowHtml(); const h = cf.querySelector('#heat'); if (h) h.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; const v = Number(b.dataset.v); const tip = cf.querySelector('#heatTip'); tip.textContent = v ? `Day ${b.dataset.d} · ${usd(v, 2)} spent` : `Day ${b.dataset.d} · no spending`; }; }
    document.querySelectorAll('[data-retry]').forEach((b) => (b.onclick = () => { load(); }));
    const f = document.getElementById('addTx');
    if (f) f.onsubmit = async (e) => {
      e.preventDefault(); const msg = f.querySelector('#tMsg'); msg.textContent = 'Saving…';
      try {
        await api('/transactions', { method: 'POST', body: JSON.stringify({ posted_on: f.querySelector('#tDate').value, account_id: f.querySelector('#tAcct').value, description: f.querySelector('#tDesc').value, category: f.querySelector('#tCat').value || null, amount: Number(f.querySelector('#tAmt').value) }) });
        await loadMore();
      } catch (err) { msg.textContent = err.message; }
    };
    document.querySelectorAll('[data-deltx]').forEach((b) => (b.onclick = async () => {
      if (!confirm('Delete this transaction?')) return;
      try { await api('/transactions/' + b.dataset.deltx, { method: 'DELETE' }); await loadMore(); } catch (err) { alert(err.message); }
    }));
  }
  V.banking = bankingHtml; V.cashflow = cashflowHtml;



  // ---------- Investments (holdings) ----------
  let hold = null, holdErr = null;
  const pct = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
  function investmentsHtml() {
    if (holdErr) return `<div class="card"><h3>Couldn't load holdings</h3><p class="sub">${esc(holdErr)}</p><button class="btn" data-retry>Try again</button></div>`;
    const mv = '<div class="card" style="margin-top:14px"><h3>Nasdaq movers</h3><div class="hint">Largest 500 Nasdaq companies, today</div><div id="moversBox">' + (window.PrismTicker ? window.PrismTicker.moversHtml() : '') + '</div></div>';
    if (!hold) return '<div class="card"><p class="sub">Loading…</p></div>';
    if (!hold.holdings.length) return '<div class="card"><h3>No holdings yet</h3><p class="sub">Link a brokerage on the Accounts page and your positions appear here after the next sync. Only you can see them.</p><a class="btn" href="#accounts">Go to Accounts</a></div>' + mv;
    const t = hold.totals, gl = t.gain, glp = t.costBasis ? (gl / t.costBasis) * 100 : null;
    const card = (l, v, d) => `<div class="card kpi"><div class="l">${l}</div><div class="v num">${v}</div><div class="d">${d}</div></div>`;
    const alloc = hold.allocation.map((a) => `<tr><td>${esc(a.type)}</td><td class="r num">${usd(a.value, 2)}</td><td class="r num">${t.value ? ((a.value / t.value) * 100).toFixed(1) : '0.0'}%</td></tr>`).join('');
    const rows = hold.holdings.map((h) => { const g = h.cost_basis == null ? null : Number(h.value) - Number(h.cost_basis);
      return `<tr><td><b>${esc(h.ticker || '—')}</b></td><td>${esc(h.name)}</td><td>${esc(acctName(h.account_id))}</td><td class="r num">${Number(h.quantity).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td><td class="r num">${usd(Number(h.price), 2)}</td><td class="r num">${usd(Number(h.value), 2)}</td><td class="r num ${g == null ? '' : g >= 0 ? 'up' : 'down'}">${g == null ? '—' : usd(g, 2)}</td></tr>`; }).join('');
    return `<div class="grid g4">${card('Portfolio value', usd(t.value, 2), t.positions + ' position' + (t.positions === 1 ? '' : 's'))}${card('Cost basis', t.costBasis == null ? '—' : usd(t.costBasis, 2), 'As reported by your broker')}${card('Unrealized gain', gl == null ? '—' : usd(gl, 2), glp == null ? '' : pct(glp))}${card('Data freshness', 'Periodic', 'Synced from Plaid, not live ticks')}</div>
      <div class="grid g2" style="margin-top:14px"><div class="card"><h3>Allocation</h3><table><tr><th>Type</th><th class="r">Value</th><th class="r">Share</th></tr>${alloc}</table></div>
      <div class="card"><h3>About this data</h3><p class="sub">Prices and positions come from your broker through Plaid and refresh when you sync. Live streaming quotes are a later step.</p></div></div>
      <div class="card" style="margin-top:14px"><h3>Positions</h3><div style="overflow-x:auto"><table><tr><th>Ticker</th><th>Name</th><th>Account</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Value</th><th class="r">Gain</th></tr>${rows}</table></div></div>` + mv;
  }
  setInterval(() => { const b = document.getElementById('moversBox'); if (b && window.PrismTicker && window.PrismTicker.data) b.innerHTML = window.PrismTicker.moversHtml(); }, 2000);
  async function loadHoldings() {
    try { hold = await api('/holdings'); holdErr = null; } catch (e) { holdErr = e.message; }
    const iv = document.getElementById('v-investments'); if (iv) { iv.innerHTML = investmentsHtml(); iv.querySelectorAll('[data-retry]').forEach((b) => (b.onclick = loadHoldings)); }
  }
  V.investments = investmentsHtml;

  // ---------- Covered calls ----------
  let cc = null, ccErr = null, ccSym = '', ccExp = '', ccBusy = false;
  const money = (n) => '$' + Number(n).toFixed(2);
  function ccHtml() {
    if (ccErr) return `<div class="card"><h3>Couldn't load option chains</h3><p class="sub">${esc(ccErr)}</p><button class="btn" data-ccretry>Try again</button></div>`;
    if (!cc) return '<div class="card"><p class="sub">Loading…</p></div>';
    if (!cc.eligible.length) return `<div class="card"><h3>No lots of 100 shares yet</h3><p class="sub">A covered call needs at least 100 shares of one stock. Link a brokerage on the Accounts page and eligible positions appear here. Only you can see them.</p><a class="btn" href="#accounts">Go to Accounts</a></div>`;
    const demo = cc.demo ? '<div class="banner" style="margin:0 0 14px"><b>DEMO DATA</b> - these option prices are simulated, not real quotes. Do not trade on them.</div>' : '';
    const pick = cc.eligible.map((e) => `<button class="chip sm ${e.ticker === cc.symbol ? 'on' : ''}" data-ccsym="${esc(e.ticker)}">${esc(e.ticker)} · ${e.contracts}x</button>`).join(' ');
    const exps = cc.expirations.map((x) => `<button class="chip sm ${x === cc.expiry ? 'on' : ''}" data-ccexp="${esc(x)}">${esc(x.slice(5))}</button>`).join(' ');
    const k = (l, v, d) => `<div class="card kpi"><div class="l">${l}</div><div class="v num">${v}</div><div class="d">${d}</div></div>`;
    const rows = cc.calls.map((c) => `<tr class="${c.otmPct < 0 ? 'mut' : ''}"><td class="num"><b>${money(c.strike)}</b></td><td class="r num ${c.otmPct < 0 ? 'down' : ''}">${c.otmPct >= 0 ? '+' : ''}${c.otmPct.toFixed(1)}%</td><td class="r num">${money(c.bid)}</td><td class="r num">${money(c.ask)}</td><td class="r num">${c.delta == null ? '—' : c.delta.toFixed(2)}</td><td class="r num">${c.iv == null ? '—' : c.iv.toFixed(0) + '%'}</td><td class="r num"><b>${money(c.bid * 100 * Math.max(1, cc.contracts))}</b></td><td class="r num">${c.staticPct.toFixed(2)}%</td><td class="r num up">${c.annPct.toFixed(1)}%</td><td class="r num">${c.calledPct >= 0 ? '+' : ''}${c.calledPct.toFixed(2)}%</td><td class="r num">${c.oi == null ? '—' : c.oi.toLocaleString()}</td></tr>`).join('');
    return demo + `<div class="grid g4">${k(esc(cc.symbol) + ' price', money(cc.spot), (cc.dayPct >= 0 ? '+' : '') + cc.dayPct.toFixed(2) + '% today')}${k('You own', cc.shares.toLocaleString() + ' sh', cc.contracts + ' contract' + (cc.contracts === 1 ? '' : 's') + ' coverable')}${k('Expiry', esc(cc.expiry), cc.dte + ' days')}${k('Premium basis', 'Bid', 'What you could actually collect')}</div>
      <div class="card" style="margin-top:14px"><h3>Stock</h3><div>${pick}</div><h3 style="margin-top:12px">Expiry</h3><div>${exps}</div></div>
      <div class="card" style="margin-top:14px"><h3>Calls to sell · ${esc(cc.symbol)} · ${esc(cc.expiry)}</h3><div class="hint">Premium total is for ${Math.max(1, cc.contracts)} contract${cc.contracts > 1 ? 's' : ''} (100 shares each). "If called" = return if shares are sold at the strike, premium included. Greyed rows are in the money - your shares would likely be called away.</div>
      <div style="overflow-x:auto"><table><tr><th>Strike</th><th class="r">From price</th><th class="r">Bid</th><th class="r">Ask</th><th class="r">Delta</th><th class="r">IV</th><th class="r">Premium</th><th class="r">Yield</th><th class="r">Annualised</th><th class="r">If called</th><th class="r">Open int.</th></tr>${rows || '<tr><td colspan="11">No quoted calls for this expiry.</td></tr>'}</table></div>
      <p class="sub" style="margin-top:8px">${esc(cc.note || '')} Selling calls caps your upside at the strike and does not protect against a fall. This is information, not advice.</p></div>`;
  }
  async function loadCalls() {
    if (ccBusy) return; ccBusy = true;
    try { const q = new URLSearchParams(); if (ccSym) q.set('symbol', ccSym); if (ccExp) q.set('expiry', ccExp); cc = await api('/options/calls?' + q); ccSym = cc.symbol || ccSym; ccExp = cc.expiry || ''; ccErr = null; } catch (e) { ccErr = e.message; }
    ccBusy = false; paintCalls();
  }
  function paintCalls() {
    const el = document.getElementById('v-calls'); if (!el) return;
    el.innerHTML = ccHtml();
    el.querySelectorAll('[data-ccsym]').forEach((b) => (b.onclick = () => { ccSym = b.dataset.ccsym; ccExp = ''; loadCalls(); }));
    el.querySelectorAll('[data-ccexp]').forEach((b) => (b.onclick = () => { ccExp = b.dataset.ccexp; loadCalls(); }));
    el.querySelectorAll('[data-ccretry]').forEach((b) => (b.onclick = loadCalls));
  }
  V.calls = ccHtml;
  window.addEventListener('hashchange', () => { if (location.hash === '#calls') loadCalls(); });
  if (location.hash === '#calls') setTimeout(loadCalls, 0);

  // ---------- Plaid: connect banks ----------
  let plaidState = { configured: false, environment: null, items: [], busy: '' };
  function loadPlaidScript() {
    return new Promise((res, rej) => {
      if (window.Plaid) return res();
      const sc = document.createElement('script'); sc.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
      sc.onload = res; sc.onerror = () => rej(new Error('Could not load Plaid Link.')); document.head.appendChild(sc);
    });
  }
  function plaidHtml() {
    if (!canWrite && !plaidState.items.length) return '';
    if (!plaidState.configured) return '<div class="card" style="margin-bottom:14px"><h3>Connect your banks</h3><p class="sub">Bank linking is not switched on yet. It activates once the Plaid keys are added to the server.</p></div>';
    const env = plaidState.environment === 'production' ? '' : ' <span class="tag">' + esc(plaidState.environment) + ' test mode</span>';
    const items = plaidState.items.map((i) => `<tr><td>${esc(i.institution_name || 'Bank')}</td><td>${i.status === 'ok' ? '<span class="tag ok">Connected</span>' : '<span class="tag">Needs attention</span>'}</td><td>${esc(i.last_synced_at ? new Date(i.last_synced_at).toLocaleString() : 'Not yet')}</td>${canWrite ? `<td class="r"><button class="chip sm" data-unlink="${esc(i.id)}">Disconnect</button></td>` : ''}</tr>`).join('');
    return `<div class="card" style="margin-bottom:14px"><h3>Connect your banks${env}</h3><div class="hint">Linked through Plaid. Your login goes to your bank, never to us. Only you can see these accounts.</div>
      ${items ? `<div style="overflow-x:auto"><table><tr><th>Bank</th><th>Status</th><th>Last synced</th>${canWrite ? '<th></th>' : ''}</tr>${items}</table></div>` : ''}
      ${canWrite ? `<div style="margin-top:10px"><button class="btn" id="plaidConnect" ${plaidState.busy ? 'disabled' : ''}>Connect a bank</button> ${plaidState.items.length ? '<button class="chip" id="plaidSync">Sync now</button>' : ''} <span class="sub" id="plaidMsg" role="status">${esc(plaidState.busy)}</span></div>` : ''}</div>`;
  }
  async function loadPlaid() {
    try {
      const st = await api('/plaid/status'); plaidState.configured = st.configured; plaidState.environment = st.environment;
      plaidState.items = st.configured ? (await api('/plaid/items')).items : [];
    } catch { /* leave as not configured */ }
  }
  function bindPlaid(root) {
    const say = (t) => { const m = root.querySelector('#plaidMsg'); if (m) m.textContent = t; };
    const c = root.querySelector('#plaidConnect');
    if (c) c.onclick = async () => {
      try {
        say('Starting…'); c.disabled = true;
        const [{ link_token }] = await Promise.all([api('/plaid/link-token', { method: 'POST' }), loadPlaidScript()]);
        const h = window.Plaid.create({ token: link_token,
          onSuccess: async (public_token, meta) => {
            say('Linking and importing…');
            try { const r = await api('/plaid/exchange', { method: 'POST', body: JSON.stringify({ public_token, institution_name: meta && meta.institution ? meta.institution.name : null }) }); say('Imported ' + r.sync.added + ' transactions.'); }
            catch (e) { say(e.message); }
            await refreshAll();
          },
          onExit: () => { c.disabled = false; say(''); } });
        h.open();
      } catch (e) { c.disabled = false; say(e.message); }
    };
    const sy = root.querySelector('#plaidSync');
    if (sy) sy.onclick = async () => { say('Syncing…'); try { const r = await api('/plaid/sync', { method: 'POST' }); say(r.sync.failed ? 'Some banks need attention.' : 'Up to date (+' + r.sync.added + ').'); } catch (e) { say(e.message); } await refreshAll(); };
    root.querySelectorAll('[data-unlink]').forEach((b) => (b.onclick = async () => {
      if (!confirm('Disconnect this bank? Imported history stays; no new data will sync.')) return;
      try { await api('/plaid/items/' + b.dataset.unlink, { method: 'DELETE' }); } catch (e) { alert(e.message); }
      await refreshAll();
    }));
  }
  async function refreshAll() { await loadPlaid(); await load(); }

  // Take over the two views and label the rest honestly.
  V.overview = overviewHtml;
  V.accounts = accountsHtml;
  const banner = document.querySelector('.banner');
  if (banner) banner.innerHTML = 'Overview, Accounts, Banking, Cash Flow and Investments show <b>your real data</b>. Other screens are still <b>sample data</b> until connected.';
  Object.keys(done).forEach((k) => delete done[k]);
  route();
  api('/me').then((m) => {
    me = m; canWrite = m.role === 'owner';
    const tag = document.querySelector('.who .tag'); if (tag) tag.textContent = m.email;
    return loadPlaid().then(load);
  }).catch((e) => { error = e.message; paint(); });
})();
