// Floating market bar, shared by the signed-in app and the public page. Config: window.PRISM_TICKER = { url, mode }.
(function () {
  const cfg = window.PRISM_TICKER || { url: '/public/quotes', mode: 'public' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const css = `#pfbar{position:fixed;left:0;right:0;bottom:0;z-index:40;background:rgba(9,16,29,.96);backdrop-filter:blur(8px);border-top:1px solid #1c2a42;color:#e7edf7;font:13px/1.2 'Segoe UI',system-ui,sans-serif;padding-bottom:env(safe-area-inset-bottom)}
#pfbar .top{display:flex;align-items:center;gap:10px;padding:6px 12px 0;font-size:12px;color:#8393ad;white-space:nowrap;overflow:hidden}
#pfbar .st{border:1px solid #1c2a42;border-radius:999px;padding:2px 9px;font-weight:700;letter-spacing:.04em;font-size:11px}
#pfbar .st.open{color:#52c08a;border-color:#2d6b4d;background:#0f2a22}#pfbar .st.closed{color:#e6b450;border-color:#6b5320;background:#2a2210}
#pfbar .demo{color:#e6b450;font-weight:700}#pfbar .sp{flex:1}#pfbar .asof{overflow:hidden;text-overflow:ellipsis}
#pfbar .lane{overflow:hidden;padding:7px 0 8px;touch-action:pan-x}
#pfbar .track{display:inline-flex;gap:8px;padding-left:8px;animation:pfscroll var(--dur,120s) linear infinite;will-change:transform}
#pfbar .lane:hover .track,#pfbar .lane.hold .track{animation-play-state:paused}
@keyframes pfscroll{to{transform:translateX(-50%)}}
@media (prefers-reduced-motion:reduce){#pfbar .track{animation:none}#pfbar .lane{overflow-x:auto}}
#pfbar .chip{display:inline-flex;align-items:center;gap:7px;border:1px solid #1c2a42;border-radius:10px;padding:7px 11px;background:#0d1626;white-space:nowrap}
#pfbar .chip.mine{border-color:#3b82d6;background:#12233d}#pfbar .chip b{font-weight:700}
#pfbar .up{color:#52c08a}#pfbar .dn{color:#ee7a7a}#pfbar .tag{font-size:10px;color:#8393ad;text-transform:uppercase;letter-spacing:.06em;align-self:center;padding:0 4px}
#pfbar .msg{padding:8px 12px 10px;color:#8393ad}
body.pf-pad{padding-bottom:84px}
@media (max-width:600px){#pfbar{font-size:12.5px}#pfbar .chip{padding:6px 9px}}
.pfm .row{display:grid;grid-template-columns:62px 1fr auto;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid #1c2a42}.pfm .row:last-child{border:0}
.pfm .sym{font-weight:700}.pfm .px{text-align:right;font-variant-numeric:tabular-nums}.pfm .up{color:#52c08a}.pfm .dn{color:#ee7a7a}.pfm small{display:block}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const bar = document.createElement('div'); bar.id = 'pfbar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Market prices');
  bar.innerHTML = '<div class="msg">Loading prices…</div>';
  document.body.appendChild(bar); document.body.classList.add('pf-pad');

  function marketState(now = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now).map((x) => [x.type, x.value]));
    const mins = (Number(p.hour) % 24) * 60 + Number(p.minute), wk = !['Sat', 'Sun'].includes(p.weekday);
    return wk && mins >= 570 && mins < 960; // 9:30–16:00 ET; exchange holidays are not modelled
  }
  const chip = (q, mine) => { const up = q.pct >= 0;
    return `<span class="chip${mine ? ' mine' : ''}"><b>${esc(q.s)}</b><span>${num(q.p)}</span><span class="${up ? 'up' : 'dn'}">${up ? '▲' : '▼'} ${up ? '+' : ''}${num(q.pct)}%</span></span>`; };
  let last = null;
  function render(d) {
    last = d; window.PrismTicker.data = d;
    const open = marketState();
    const spy = (d.index || []).find((x) => x.s === 'SPY');
    const mood = spy ? (Math.abs(spy.pct) < 0.1 ? 'Flat' : spy.pct > 0 ? 'Up' : 'Down') + ' ' + (spy.pct >= 0 ? '+' : '') + num(spy.pct) + '%' : '';
    const idx = (d.index || []).map((q) => chip(q, false)).join('');
    let items = idx, label = '';
    if (d.mode === 'member') {
      const own = (d.holdings || []);
      const ownSet = new Set(own.map((q) => q.s));
      items = (own.length ? '<span class="tag">Yours</span>' + own.map((q) => chip(q, true)).join('') : '<span class="tag">No holdings synced yet</span>') + '<span class="tag">Nasdaq-100</span>' + (d.nasdaq100 || []).filter((q) => !ownSet.has(q.s)).map((q) => chip(q, false)).join('');
      items = idx + items;
    } else {
      items = idx + '<span class="tag">Nasdaq top 500</span>' + (d.quotes || []).map((q) => chip(q, false)).join('');
    }
    const when = d.asOf ? 'as of ' + new Date(d.asOf).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET' : '';
    bar.innerHTML = `<div class="top"><span class="st ${open ? 'open' : 'closed'}">${open ? 'OPEN' : 'CLOSED'}</span><span>${esc(mood)}</span>${d.demo ? '<span class="demo">DEMO PRICES</span>' : '<span>Delayed/IEX feed</span>'}<span class="sp"></span><span class="asof">${esc(when)}</span></div>
      <div class="lane" id="pflane"><div class="track" id="pftrack">${items}${items}</div></div>`;
    const n = (items.match(/class="chip/g) || []).length;
    bar.querySelector('#pftrack').style.setProperty('--dur', Math.max(60, n * 2.2) + 's');
    const lane = bar.querySelector('#pflane');
    lane.addEventListener('touchstart', () => lane.classList.add('hold'), { passive: true });
    lane.addEventListener('touchend', () => setTimeout(() => lane.classList.remove('hold'), 1500), { passive: true });
  }
  function fail(msg) { if (!last) bar.innerHTML = '<div class="msg">' + esc(msg) + '</div>'; }
  async function tick() {
    try {
      const r = await fetch(cfg.url, { credentials: 'same-origin' });
      if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('x');
      render(await r.json());
    } catch { fail('Prices are unavailable right now.'); }
  }
  function moversHtml(d) {
    d = d || last; if (!d || !d.gainers) return '<p class="sub">Loading…</p>';
    const col = (title, list) => `<div><h3>${title}</h3>${list.map((q) => `<div class="row"><span class="sym">${esc(q.s)}</span><span></span><span class="px">${num(q.p)}<small class="${q.pct >= 0 ? 'up' : 'dn'}">${q.c >= 0 ? '+' : ''}${num(q.c)} (${q.pct >= 0 ? '+' : ''}${num(q.pct)}%)</small></span></div>`).join('')}</div>`;
    return `<div class="pfm" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px">${col('Top gainers', d.gainers)}${col('Top losers', d.losers)}</div>`;
  }
  window.PrismTicker = { data: null, moversHtml, refresh: tick };
  tick(); setInterval(() => { if (!document.hidden) tick(); }, 30000);
})();
