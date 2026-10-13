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

  // ---------- Trading P&L (real, from /api/pnl) ----------
  let pnl = null, pnlErr = null, pnlAcct = '', pnlPeriod = 'YTD', pnlBusy = false, pnlAccts = [];
  let pnlSer = null; // /api/pnl/series — for the unrealized-gap honesty note only
  const PNL_INV = new Set(['brokerage', 'retirement']);
  const isoDay = (d) => d.toISOString().slice(0, 10);
  function pnlQuery() {
    const q = new URLSearchParams();
    if (pnlAcct) q.set('account_id', pnlAcct);
    const t = new Date();
    if (pnlPeriod === 'YTD') q.set('from', t.getFullYear() + '-01-01');
    else if (pnlPeriod === '1Y') { const d = new Date(t); d.setFullYear(d.getFullYear() - 1); q.set('from', isoDay(d)); }
    q.set('to', isoDay(t));
    return q.toString();
  }
  function pnlBars(byMonth) {
    const w = 640, h = 240, base = h - 34;
    const vals = byMonth.flatMap((m) => [Number(m.stocks) || 0, Number(m.options) || 0]);
    const mx = Math.max(0.01, ...vals), mn = Math.min(-0.01, ...vals);
    const zy = 12 + (mx / (mx - mn)) * (base - 12);
    const step = (w - 70) / byMonth.length, bw = Math.max(4, Math.min(26, step / 2 - 5));
    const bar = (v, x, cPos, lbl) => {
      const bh = (Math.abs(v) / (mx - mn)) * (base - 12);
      return `<rect x="${x.toFixed(1)}" y="${(v >= 0 ? zy - bh : zy).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(bh, 1).toFixed(1)}" rx="3" fill="${v >= 0 ? cPos : '#ee7a7a'}"><title>${esc(lbl)} ${cPos === '#4f9cf0' ? 'stocks' : 'options'}: ${v >= 0 ? '+' : ''}${usd(v, 0)}</title></rect>`;
    };
    const bars = byMonth.map((m, i) => {
      const x = 44 + i * step, lbl = mlabel(m.month);
      return bar(m.stocks, x, '#4f9cf0', lbl) + bar(m.options, x + bw + 3, '#52c08a', lbl) +
        `<text x="${(x + bw + 1).toFixed(1)}" y="${h - 8}" fill="#8393ad" font-size="10" text-anchor="middle">${mlabel(m.month).split(' ')[0]}</text>`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Monthly realized profit and loss"><line x1="34" x2="${w}" y1="${zy.toFixed(1)}" y2="${zy.toFixed(1)}" stroke="#1c2a42"/>${bars}</svg>
      <div class="legend"><span class="legend"><i style="background:#4f9cf0"></i>Stocks</span><span class="legend"><i style="background:#52c08a"></i>Options</span><span class="legend"><i style="background:#ee7a7a"></i>Loss</span></div>`;
  }
  function pnlSplit(r) {
    const rows = [['Stocks', Number(r.stocks) || 0, '#4f9cf0'], ['Options', Number(r.options) || 0, '#52c08a']];
    const mx = Math.max(1, ...rows.map((x) => Math.abs(x[1])));
    return rows.map(([l, v, c]) => `
      <div style="display:grid;grid-template-columns:76px 1fr 110px;gap:10px;align-items:center;padding:8px 0">
        <div>${l}</div>
        <div style="background:#16233a;border-radius:6px;height:14px"><div style="width:${(Math.abs(v) / mx * 100).toFixed(1)}%;background:${v >= 0 ? c : '#ee7a7a'};height:14px;border-radius:6px"></div></div>
        <div class="num ${v >= 0 ? 'up' : 'down'}" style="text-align:right">${usd(v, 2)}</div>
      </div>`).join('') + '<p class="sub">Realized P&amp;L split for the selected period and accounts.</p>';
  }
  function pnlHtml() {
    if (pnlErr) return `<div class="card"><h3>Couldn't load P&amp;L</h3><p class="sub">${esc(pnlErr)}</p><button class="btn" data-retry>Try again</button></div>`;
    const chips = `<div class="bar"><span class="lbl">Accounts</span><button class="chip sm ${pnlAcct ? '' : 'on'}" data-pnlacct="">Combined</button>${pnlAccts.map((a) => `<button class="chip sm ${pnlAcct === a.id ? 'on' : ''}" data-pnlacct="${esc(a.id)}">${esc(a.name)}</button>`).join('')}<span class="lbl" style="margin-left:10px">Period</span>${['YTD', '1Y', 'All'].map((p) => `<button class="chip sm ${pnlPeriod === p ? 'on' : ''}" data-pnlper="${p}">${p}</button>`).join('')}</div>`;
    if (!pnl) return chips + '<div class="card"><p class="sub">Loading…</p></div>';
    if (pnl.dataStatus === 'empty') return chips + `<div class="card"><h3>No P&amp;L data yet</h3><p class="sub">No investment transactions synced yet — link your brokerage on the Accounts page. P&amp;L appears after the next sync.</p><a class="btn" href="#accounts">Go to Accounts</a></div>`;
    const r = pnl.realized || {}, u = pnl.unrealized || {}, byMonth = r.byMonth || [];
    const status = pnl.dataStatus === 'live' ? '<span class="tag ok">Live</span>' : pnl.dataStatus === 'partial' ? '<span class="tag warn">Partial</span>' : `<span class="tag">${esc(pnl.dataStatus || '—')}</span>`;
    const rt = Number(r.total) || 0, ut = Number(u.total) || 0;
    const k = (l, v, d, cls) => `<div class="card kpi"><div class="l">${l}</div><div class="v num ${cls || ''}">${v}</div><div class="d">${d}</div></div>`;
    const cum = []; let c = 0;
    byMonth.forEach((m) => { c += Number(m.total) || 0; cum.push(c); });
    return chips + `
      <div style="margin-bottom:14px;display:flex;gap:10px;align-items:center">${status}<span class="sub">${esc(pnl.note || '')}</span></div>
      <div class="grid g4">
        ${k('Realized P&L', usd(rt, 2), `Stocks ${usd(Number(r.stocks) || 0, 2)} · Options ${usd(Number(r.options) || 0, 2)}`, rt >= 0 ? 'up' : 'down')}
        ${k('Unrealized P&L', usd(ut, 2), `Delayed marks · as of ${esc(String(u.asOf || '').slice(0, 10))}${u.priceSource ? ' · ' + esc(u.priceSource) : ''}`, ut >= 0 ? 'up' : 'down')}
        ${k('Dividends', usd(Number(pnl.dividends) || 0, 2), 'Cash dividends received')}
        ${k('Fees', usd(-Math.abs(Number(pnl.fees) || 0), 2), 'Brokerage fees paid', 'down')}
      </div>
      <div class="grid g2" style="margin-top:14px">
        <div class="card"><h3>Monthly realized P&amp;L</h3><div class="hint">Stocks vs options per month</div>${byMonth.length ? pnlBars(byMonth) : '<p class="sub">No monthly data for this period.</p>'}</div>
        <div class="card"><h3>Cumulative realized</h3><div class="hint">Running total of monthly realized P&amp;L</div>${cum.length ? line(cum, { labels: byMonth.map((m) => mlabel(m.month).split(' ')[0]), color: cum[cum.length - 1] >= 0 ? '#52c08a' : '#ee7a7a' }) : '<p class="sub">No monthly data for this period.</p>'}</div>
      </div>
      <div class="card" style="margin-top:14px"><h3>Stocks vs options</h3><div class="hint">Realized P&amp;L split</div>${pnlSplit(r)}</div>
      ${u.note ? `<p class="sub" style="margin-top:10px">${esc(u.note)}</p>` : ''}
      ${pnlReconHtml()}`;
  }
  async function loadPnl() {
    if (pnlBusy) return; pnlBusy = true;
    try {
      if (!pnlAccts.length) {
        const list = accounts.length ? accounts : (await api('/accounts')).accounts;
        pnlAccts = (list || []).filter((a) => PNL_INV.has(a.kind));
      }
      const q = pnlQuery();
      const [p, s] = await Promise.allSettled([api('/pnl?' + q), api('/pnl/series?' + q)]);
      pnl = p.status === 'fulfilled' ? p.value : null; pnlErr = p.status === 'rejected' ? p.reason.message : null;
      pnlSer = s.status === 'fulfilled' ? s.value : null; // failure is fine — the gap note is just skipped
    } catch (e) { pnlErr = e.message; }
    pnlBusy = false; paintPnl();
  }
  function paintPnl() {
    const el = document.getElementById('v-trading'); if (!el) return;
    el.innerHTML = pnlHtml();
    el.querySelectorAll('[data-pnlacct]').forEach((b) => (b.onclick = () => { pnlAcct = b.dataset.pnlacct; loadPnl(); }));
    el.querySelectorAll('[data-pnlper]').forEach((b) => (b.onclick = () => { pnlPeriod = b.dataset.pnlper; loadPnl(); }));
    el.querySelectorAll('[data-retry]').forEach((b) => (b.onclick = loadPnl));
  }
  V.trading = pnlHtml;
  window.addEventListener('hashchange', () => { if (location.hash === '#trading') loadPnl(); });
  if (location.hash === '#trading') setTimeout(loadPnl, 0);

  // ---------- Phase 1 delta: shared honest-number + reconciliation helpers ----------
  const usdOr = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? '—' : usd(Number(n), d));
  const secH1 = (t) => `<div style="margin-top:14px"><h1 style="font-size:20px">${t}</h1></div>`;
  function reconCard(exceptions, notes) {
    const ex = (exceptions || []).map((e) => `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)"><span class="tag warn" style="flex:none">${esc(e.type || 'exception')}</span><div>${esc(e.detail || 'No detail provided.')}${e.groupKey ? `<div class="sub">Group: ${esc(e.groupKey)}</div>` : ''}</div></div>`).join('');
    const ns = (notes || []).filter(Boolean).map((n) => `<div style="padding:8px 0;border-bottom:1px solid var(--line)"><span class="tag">Note</span> <span class="sub">${esc(n)}</span></div>`).join('');
    const body = (ex + ns) || '<p class="sub">Nothing to reconcile for this view — records tie out.</p>';
    return `<div class="card"><h3>Reconciliation</h3><div class="hint">Items that need review — related figures may be incomplete until these are resolved.</div>${body}</div>`;
  }
  // AC-10: a null unrealized point is an explicit gap — never interpolate, just say so.
  function seriesGapNote(s) {
    if (!s || !Array.isArray(s.points) || !s.points.length) return null;
    const first = s.points.find((p) => p && p.unrealized != null);
    if (!first) return 'unrealized unavailable across this period — no historical marks';
    if (s.points.indexOf(first) <= 0) return null;
    return `unrealized unavailable before ${String(first.date).slice(0, 10)} — no historical marks`;
  }
  function pnlReconHtml() {
    if (!pnl || pnlErr) return '';
    return secH1('Reconciliation') + reconCard(pnl.exceptions, [seriesGapNote(pnlSer)]);
  }

  // ---------- Options (open positions + history) ----------
  let optOpen = null, optOpenErr = null, optHist = null, optHistErr = null, optBusy = false;
  let optCol = null, optColErr = null; // /api/pnl — collateral card lives on the Options view
  const markSub = (p) => (p.markAsOf ? `<div class="sub">delayed · ${esc(String(p.markAsOf).slice(0, 10))}</div>` : '');
  function optOpenHtml() {
    if (optOpenErr) return `<div class="card"><h3>Couldn't load open positions</h3><p class="sub">${esc(optOpenErr)}</p><button class="btn" data-optretry>Try again</button></div>`;
    if (!optOpen) return '<div class="card"><p class="sub">Loading…</p></div>';
    const pos = optOpen.positions || [];
    if (!pos.length) return '<div class="card"><h3>No open option positions</h3><p class="sub">Sold puts and calls appear here once they are on your books.</p></div>';
    const rows = pos.map((p) => {
      const isCall = p.contractType === 'call';
      const pa = p.premiumAccounting || {};
      // AC-01: gross credit, current liability and unrealized gain stay three separate figures.
      // Fall back to the legacy fields so the view keeps working against an older API.
      const gross = pa.grossCredit != null ? Number(pa.grossCredit) : (p.premiumReceived != null ? Number(p.premiumReceived) : null);
      const liab = pa.currentLiability != null ? Number(pa.currentLiability) : (p.costToClose != null ? Number(p.costToClose) : null);
      const ug = pa.unrealizedGain != null ? Number(pa.unrealizedGain) : (gross != null && liab != null ? gross - liab : null);
      // Cash-secured is only ever shown when the backend says so — never assumed.
      let cov = '';
      if (!isCall) {
        const c = String(p.coverage || '').toLowerCase();
        if (c === 'cash_secured' || p.cashSecured === true) cov = ' <span class="tag ok">Cash-secured</span>';
        else if (c === 'margin_secured' || c === 'margin' || p.cashSecured === false) cov = ' <span class="tag warn">Margin-secured</span>';
      }
      const typeCell = `${isCall ? 'Call' : 'Put'}${isCall ? (p.coverage === 'naked_call' ? ' <span class="tag off">Naked</span>' : ' <span class="tag ok">Covered</span>') : cov}`;
      const q = pa.quote || {};
      const qSub = (q.method || q.asOf) ? `<div class="sub">${esc([q.method, q.source, q.asOf ? String(q.asOf).slice(0, 10) : null].filter(Boolean).join(' · '))}</div>` : '';
      const grossCell = gross == null ? '<span class="mut">—</span>'
        : `<span class="num">${usd(gross, 2)}</span>${pa.fees ? `<div class="sub">fees ${usd(Number(pa.fees), 2)}</div>` : ''}`;
      const liabCell = liab == null
        ? '<span class="mut">mark unavailable — needs live quotes</span>'
        : `<span class="num">${usd(liab, 2)}</span>${markSub(p)}${qSub}`;
      const pc = p.pctCaptured;
      const ugCell = ug == null ? '<span class="mut">—</span>'
        : `<span class="num ${ug >= 0 ? 'up' : 'down'}">${usd(ug, 2)}</span>${pc == null ? '' : `<div class="sub">${Number(pc).toFixed(0)}% captured</div>`}${pa.realizedPnl ? `<div class="sub">realized ${usd(Number(pa.realizedPnl), 2)}</div>` : ''}`;
      const fl = [];
      const F = p.flags || {};
      if (F.captured75) fl.push('<span class="tag ok">75% captured</span>');
      if (F.fastFlip) fl.push('<span class="tag warn">Fast flip</span>');
      if (F.cheapClose) fl.push('<span class="tag warn">≤2 DTE $0.01</span>');
      if (F.deepItm) fl.push('<span class="tag off">Deep ITM</span>');
      if (F.nearStrike) fl.push('<span class="tag warn">Near strike</span>');
      if (F.insufficientCash) fl.push('<span class="tag off">Low assignment cash</span>');
      if (F.quoteStale) fl.push('<span class="tag warn">Stale quote</span>');
      if (F.highCostPct) fl.push('<span class="tag warn">High cost %</span>');
      if (p.coverage === 'naked_call') fl.push('<span class="tag off">Naked</span>');
      if (F.evaluatedAt) fl.push(`<div class="sub">flags evaluated ${esc(String(F.evaluatedAt).slice(0, 10))}</div>`);
      return `<tr><td><b>${esc(p.underlying)}</b><div class="sub">${esc(p.accountName || '')}</div></td><td>${typeCell}</td>
        <td class="r num">${usd(Number(p.strike), 2)}</td><td>${esc(p.expiry)}</td><td class="r num">${p.contracts}</td>
        <td class="r">${grossCell}</td><td class="r">${liabCell}</td><td class="r">${ugCell}</td>
        <td class="r num ${Number(p.dte) <= 2 ? 'down' : ''}">${p.dte}</td><td>${fl.join(' ') || '<span class="mut">—</span>'}</td></tr>`;
    }).join('');
    return `<div class="card"><h3>Open positions</h3><div class="hint">Marks as of ${esc(optOpen.asOf || '—')}${optOpen.priceSource ? ' · ' + esc(optOpen.priceSource) : ''} — delayed quotes, not live. Opening credit is not realized profit: gross credit is cash collected at open, current liability is the estimated cost to close now, unrealized gain is the difference.</div>
      <div style="overflow-x:auto"><table><tr><th>Underlying</th><th>Type</th><th class="r">Strike</th><th>Expiry</th><th class="r">Contracts</th><th class="r">Gross credit</th><th class="r">Current liability</th><th class="r">Unrealized gain</th><th class="r">DTE</th><th>Flags</th></tr>${rows}</table></div>
      ${optOpen.note ? `<p class="sub" style="margin-top:8px">${esc(optOpen.note)}</p>` : ''}</div>`;
  }
  const OPT_KIND_LABEL = { sold_put: 'Sold put', covered_call: 'Covered call', naked_call: 'Naked call', long_call: 'Long call', long_put: 'Long put' };
  function optHistHtml() {
    if (optHistErr) return `<div class="card"><h3>Couldn't load option history</h3><p class="sub">${esc(optHistErr)}</p><button class="btn" data-optretry>Try again</button></div>`;
    if (!optHist) return '<div class="card"><p class="sub">Loading…</p></div>';
    const s = optHist.summary || {};
    const cards = [['soldPuts', 'Sold puts'], ['coveredCalls', 'Covered calls'], ['nakedCalls', 'Naked calls'], ['longOptions', 'Long options']].map(([key, label]) => {
      const ksum = s[key] || {};
      const g = Number(ksum.groups) || 0, prem = Number(ksum.premium) || 0, pnlv = Number(ksum.pnl) || 0;
      let wr = ksum.winRate;
      wr = wr == null ? '—' : (wr > 1 ? wr.toFixed(0) + '%' : (wr * 100).toFixed(0) + '%');
      return `<div class="card kpi"><div class="l">${label}</div><div class="v num ${pnlv >= 0 ? 'up' : 'down'}">${usd(pnlv, 2)}</div><div class="d">${g} group${g === 1 ? '' : 's'} · ${usd(prem, 2)} premium · ${wr} win</div></div>`;
    }).join('');
    const cp = optHist.cumulativePremium || [];
    const curve = cp.length ? `<div class="card" style="margin-top:14px"><h3>Cumulative premium collected</h3><div class="hint">Running total of net premium across closed groups</div>${line(cp.map((x) => Number(x.cumulative) || 0), { labels: cp.map((x) => esc(String(x.date).slice(5))), color: '#52c08a' })}</div>` : '';
    const groups = optHist.groups || [];
    const outcomeChip = (o) => o === 'expired_inferred' ? '<span class="tag warn">Expired (inferred)</span>'
      : o === 'expired' || o === 'expired_worthless' ? '<span class="tag ok">Expired</span>'
      : o === 'closed' ? '<span class="tag">Closed</span>'
      : o === 'assigned' ? '<span class="tag warn">Assigned</span>'
      : `<span class="tag">${esc(o || '—')}</span>`;
    const grows = groups.map((g) => {
      const prem = (Number(g.premiumCollected) || 0) - (Number(g.premiumPaid) || 0);
      const pv = Number(g.pnl) || 0;
      return `<tr><td><b>${esc(g.underlying)}</b></td><td>${esc(OPT_KIND_LABEL[g.kind] || g.kind || '—')}</td>
        <td class="num">${usd(Number(g.strike), 2)} · ${esc(g.expiry)}</td>
        <td>${esc(g.openedOn)} → ${esc(g.closedOn || '—')}</td><td class="r num">${g.contracts}</td>
        <td class="r num">${usd(prem, 2)}<div class="sub">fees ${usd(Number(g.fees) || 0, 2)}</div></td>
        <td class="r num ${pv >= 0 ? 'up' : 'down'}">${usd(pv, 2)}</td>
        <td>${outcomeChip(g.outcome)}</td><td>${g.win ? '<span class="tag ok">Win</span>' : '<span class="tag off">Loss</span>'}</td></tr>`;
    }).join('');
    return `<div class="grid g4" style="margin-top:14px">${cards}</div>${curve}
      <div class="card" style="margin-top:14px"><h3>History</h3><div class="hint">Closed option groups, newest last</div>
      ${groups.length ? `<div style="overflow-x:auto"><table><tr><th>Underlying</th><th>Kind</th><th class="r">Strike · Expiry</th><th>Opened → Closed</th><th class="r">Contracts</th><th class="r">Premium</th><th class="r">P&amp;L</th><th>Outcome</th><th>Win/Loss</th></tr>${grows}</table></div>` : '<p class="sub">No closed option groups yet.</p>'}</div>`;
  }
  function optCollateralHtml() {
    if (optColErr) return secH1('Collateral') + `<p class="sub">Collateral unavailable: ${esc(optColErr)}</p>`;
    if (!optCol || optCol.collateral === undefined) return '';
    const c = optCol.collateral;
    if (c === null) return secH1('Collateral') + '<div class="card"><h3>No collateral data yet</h3><p class="sub">Collateral requirements appear here once short puts are on your books.</p></div>';
    const k = (l, v, d, cls) => `<div class="card kpi"><div class="l">${l}</div><div class="v num ${cls || ''}">${v}</div><div class="d">${d}</div></div>`;
    const f1 = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toFixed(1) + '%');
    const puts = (c.puts || []).map((x) => {
      const lab = x.label != null ? String(x.label)
        : x.cashSecured === true ? 'Cash-secured' : x.cashSecured === false ? 'Margin-secured' : '—';
      const cls = x.label != null ? '' : x.cashSecured === true ? 'ok' : x.cashSecured === false ? 'warn' : '';
      return `<tr><td><b>${esc(x.underlying)}</b></td><td class="r num">${usdOr(x.strike)}</td><td>${esc(x.expiry)}</td><td class="r num">${x.contracts}</td><td class="r num">${usdOr(x.required)}</td><td>${cls ? `<span class="tag ${cls}">${esc(lab)}</span>` : `<span class="mut">${esc(lab)}</span>`}</td></tr>`;
    }).join('');
    const calls = (c.coveredCalls || []).map((x) => `<tr><td><b>${esc(x.underlying)}</b></td><td class="r num">${x.contracts}</td><td class="r num">${x.sharesHeld == null ? '—' : Number(x.sharesHeld).toLocaleString()}</td><td>${esc(x.capitalDenominator == null ? '—' : String(x.capitalDenominator))}</td><td class="r num">${usdOr(x.capitalValue)}</td></tr>`).join('');
    return secH1('Collateral') + `<div class="grid g4">
        ${k('Utilization', f1(c.utilizationPct), `Required ${usdOr(c.totalRequired)} vs cash ${usdOr(c.cashAvailable)}`)}
        ${k('Idle cash', usdOr(c.idleCash), `Cash method: ${esc(c.cashMethod || '—')}`)}
        ${k('Return on collateral', f1(c.returnOnCollateralPct), `Net premium ${usdOr(c.netPremium)} ÷ ${usdOr(c.premiumDenominator)}`)}
        ${k('Annualized yield', f1(c.annualizedYieldPct), 'Comparison, not a forecast')}
      </div>
      <div class="card" style="margin-top:14px"><h3>Collateral detail</h3>
        <div class="hint">As of ${esc(String(c.asOf || '').slice(0, 10))} · ${esc(c.methodology || 'methodology not provided')}</div>
        <p class="sub">Net premium per $10k of collateral: <b class="num">${usdOr(c.netPremiumPer10k)}</b> · capital committed ${c.daysCommitted == null ? '—' : esc(String(c.daysCommitted)) + ' days'}${c.annualizedNote ? ' · ' + esc(c.annualizedNote) : ''}</p>
        ${puts ? `<h3 style="margin-top:12px">Puts</h3><div style="overflow-x:auto"><table><tr><th>Underlying</th><th class="r">Strike</th><th>Expiry</th><th class="r">Contracts</th><th class="r">Required</th><th>Secured</th></tr>${puts}</table></div>` : '<p class="sub">No short puts requiring collateral in this view.</p>'}
        ${calls ? `<h3 style="margin-top:12px">Covered calls — capital denominators</h3><div style="overflow-x:auto"><table><tr><th>Underlying</th><th class="r">Contracts</th><th class="r">Shares held</th><th>Denominator</th><th class="r">Capital value</th></tr>${calls}</table></div>` : ''}
      </div>`;
  }
  const EV_LABEL = { put_sold: 'Put sold', assigned: 'Assigned — shares bought', shares_held: 'Shares held', call_sold: 'Covered call sold', shares_sold: 'Shares sold', disposed: 'Position disposed', expired: 'Expired', closed: 'Closed', rolled: 'Rolled' };
  const evLabel = (kk) => EV_LABEL[kk] || String(kk ?? '—').replace(/_/g, ' ').replace(/(^|\s)[a-z]/g, (ch) => ch.toUpperCase());
  function optWheelsHtml() {
    if (!optHist || optHistErr || optHist.wheels === undefined) return '';
    const w = optHist.wheels;
    if (!w.length) return secH1('Wheel tracker') + '<div class="card"><h3>No wheel cycles yet</h3><p class="sub">A cycle starts when a sold put is assigned into shares. Open and completed cycles appear here.</p></div>';
    const cards = w.map((cy) => {
      const evs = (cy.events || []).map((e) => {
        const parts = [];
        if (e.contracts != null) parts.push(`${e.contracts} contract${Number(e.contracts) === 1 ? '' : 's'}`);
        if (e.shares != null) parts.push(`${Number(e.shares).toLocaleString()} sh`);
        if (e.price != null && Number.isFinite(Number(e.price))) parts.push('@ ' + usd(Number(e.price), 2));
        if (e.premium != null && Number.isFinite(Number(e.premium))) parts.push('premium ' + usd(Number(e.premium), 2));
        return `<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)"><div class="sub" style="min-width:96px;flex:none">${esc(String(e.date || '').slice(0, 10))}</div><div><b>${esc(evLabel(e.kind))}</b>${parts.length ? `<div class="sub">${esc(parts.join(' · '))}</div>` : ''}${e.groupKey ? `<div class="sub">${esc(e.groupKey)}</div>` : ''}</div></div>`;
      }).join('');
      const f = cy.flags;
      const fl = f ? (Array.isArray(f) ? f : Object.keys(f).filter((kk) => f[kk] && kk !== 'evaluatedAt')) : [];
      const st = String(cy.status || '').toLowerCase();
      const chip = st === 'complete' ? '<span class="tag ok">Complete</span>' : st === 'open' ? '<span class="tag warn">Open</span>' : `<span class="tag">${esc(cy.status || '—')}</span>`;
      const pv = Number(cy.economicPnl);
      return `<div class="card" style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px"><h3 style="margin:0">${esc(cy.underlying)} ${chip}</h3><span class="sub">${esc(cy.accountId || '')}</span></div>
        <div class="grid g2" style="margin-top:10px">
          <div><div class="sub">Economic entry / share</div><div class="num" style="font-size:20px">${usdOr(cy.economicEntryPerShare)}</div><div class="sub">Strategy-level reference, not tax basis${cy.caveat ? ' · ' + esc(cy.caveat) : ''}</div></div>
          <div><div class="sub">Cycle economic P&amp;L</div><div class="num ${Number.isFinite(pv) && cy.economicPnl != null ? (pv >= 0 ? 'up' : 'down') : ''}" style="font-size:20px">${cy.economicPnl == null ? '—' : usd(pv, 2)}</div>${fl.length ? `<div style="margin-top:6px">${fl.map((x) => `<span class="tag warn">${esc(String(x).replace(/_/g, ' '))}</span>`).join(' ')}</div>` : ''}</div>
        </div>
        <h3 style="margin-top:12px">Events</h3>${evs || '<p class="sub">No events recorded for this cycle.</p>'}</div>`;
    }).join('');
    return secH1('Wheel tracker') + cards;
  }
  function optRollsHtml() {
    if (!optHist || optHistErr || optHist.rolls === undefined) return '';
    const r = optHist.rolls;
    if (!r.length) return secH1('Rolls') + '<div class="card"><p class="sub">No rolls in this period.</p></div>';
    // AC-08: closing debit, opening credit, net cash flow, cumulative credit and old→new expiry stay separate figures.
    const rows = r.map((x) => `<tr><td>${esc(String(x.date || '').slice(0, 10))}</td><td><b>${esc(x.underlying)}</b>${x.contractType ? `<div class="sub">${esc(x.contractType)}</div>` : ''}</td>
      <td class="r num">${usdOr(x.closingDebit)}</td><td class="r num">${usdOr(x.openingCredit)}</td>
      <td class="r num ${x.netCashFlow == null ? '' : Number(x.netCashFlow) >= 0 ? 'up' : 'down'}">${usdOr(x.netCashFlow)}</td>
      <td class="r num">${usdOr(x.cumulativeCredit)}</td><td>${esc(x.oldExpiry || '—')} → ${esc(x.newExpiry || '—')}</td></tr>`).join('');
    return secH1('Rolls') + `<div class="card"><div class="hint">Each figure is shown separately — net cash flow is closing debit vs opening credit for that roll; cumulative credit is the running total for the contract line.</div>
      <div style="overflow-x:auto"><table><tr><th>Date</th><th>Underlying</th><th class="r">Closing debit</th><th class="r">Opening credit</th><th class="r">Net cash flow</th><th class="r">Cumulative credit</th><th>Old → new expiry</th></tr>${rows}</table></div></div>`;
  }
  function optReconHtml() {
    if (!optHist || optHistErr || optHist.exceptions === undefined) return '';
    return secH1('Reconciliation') + reconCard(optHist.exceptions, []);
  }
  function optionsHtml() {
    return `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:14px"><h1 style="font-size:20px">Options</h1><span class="sub">Sold and covered positions on your books</span></div>` +
      optOpenHtml() + optCollateralHtml() + optWheelsHtml() + optRollsHtml() + optReconHtml() +
      secH1('Premium history') + optHistHtml();
  }
  async function loadOptions() {
    if (optBusy) return; optBusy = true;
    const [o, h, c] = await Promise.allSettled([api('/options/open'), api('/options/history'), api('/pnl')]);
    optOpen = o.status === 'fulfilled' ? o.value : null; optOpenErr = o.status === 'rejected' ? o.reason.message : null;
    optHist = h.status === 'fulfilled' ? h.value : null; optHistErr = h.status === 'rejected' ? h.reason.message : null;
    optCol = c.status === 'fulfilled' ? c.value : null; optColErr = c.status === 'rejected' ? c.reason.message : null;
    optBusy = false; paintOptions();
  }
  function paintOptions() {
    const el = document.getElementById('v-options'); if (!el) return;
    el.innerHTML = optionsHtml();
    el.querySelectorAll('[data-optretry]').forEach((b) => (b.onclick = loadOptions));
  }
  V.options = optionsHtml;
  window.addEventListener('hashchange', () => { if (location.hash === '#options') loadOptions(); });
  if (location.hash === '#options') setTimeout(loadOptions, 0);

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

  // Take over the live views and label the rest honestly.
  V.overview = overviewHtml;
  V.accounts = accountsHtml;
  const banner = document.querySelector('.banner');
  if (banner) banner.innerHTML = 'Overview, Accounts, Banking, Cash Flow, Investments, Trading P&L and Options show <b>your real data</b>. Other screens are still <b>sample data</b> until connected.';
  Object.keys(done).forEach((k) => delete done[k]);
  route();
  api('/me').then((m) => {
    me = m; canWrite = m.role === 'owner';
    const tag = document.querySelector('.who .tag'); if (tag) tag.textContent = m.email;
    return loadPlaid().then(load);
  }).catch((e) => { error = e.message; paint(); });
})();
