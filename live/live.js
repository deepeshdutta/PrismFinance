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
  function accountsHtml() { return error ? errHtml() : !me ? '<div class="card"><p class="sub">Loading…</p></div>' : form() + table(); }
  const errHtml = () => `<div class="card"><h3>Couldn't load your data</h3><p class="sub">${esc(error)}</p><button class="btn" data-retry>Try again</button></div>`;
  function paint() {
    const ov = document.getElementById('v-overview'), ac = document.getElementById('v-accounts');
    if (!ov || !ac) return;
    ov.innerHTML = overviewHtml(); ac.innerHTML = accountsHtml();
    document.querySelectorAll('[data-retry]').forEach((b) => (b.onclick = load));
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
    const stamp = document.querySelector('.who span'); if (stamp && !error) stamp.textContent = 'Updated ' + new Date().toLocaleString();
  }

  // Take over the two views and label the rest honestly.
  V.overview = overviewHtml;
  V.accounts = accountsHtml;
  const banner = document.querySelector('.banner');
  if (banner) banner.innerHTML = 'Overview and Accounts show <b>your real data</b>. Other screens are still <b>sample data</b> until connected.';
  Object.keys(done).forEach((k) => delete done[k]);
  route();
  api('/me').then((m) => {
    me = m; canWrite = m.role === 'owner';
    const tag = document.querySelector('.who .tag'); if (tag) tag.textContent = m.email;
    return load();
  }).catch((e) => { error = e.message; paint(); });
})();
