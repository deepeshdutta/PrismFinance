import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coveredCalls, metrics, bsCall, dteOf, demoExpirations } from '../src/options';
import { resetQuoteCache } from '../src/quotes';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const DB = [
  { owner_id: A, ticker: 'AAPL', quantity: 250 }, { owner_id: A, ticker: 'MSFT', quantity: 40 }, { owner_id: B, ticker: 'NVDA', quantity: 500 },
];
function ctx(owner: string, extra?: (u: string, i: any) => Response | null) {
  const calls: string[] = [];
  const fetcher = (async (u: any, i: any) => {
    const url = String(u); calls.push(url);
    const e = extra?.(url, i); if (e) return e;
    if (url.includes('pf_holdings')) { const m = /owner_id=eq\.([^&]+)/.exec(url); return new Response(JSON.stringify(DB.filter((r) => r.owner_id === decodeURIComponent(m![1]))), { status: 200 }); }
    return new Response('[]', { status: 200 });
  }) as any;
  return { c: { database: 'https://db.test', key: 'k', ownerId: owner, role: 'owner', fetcher } as any, calls };
}
const now = Date.parse('2026-10-13T14:00:00Z');

test('metrics: yield is bid/price, annualised scales by 365/dte, called-away includes premium', () => {
  const m = metrics(100, 105, 2, 30);
  assert.equal(m.staticPct, 2); assert.equal(m.otmPct, 5); assert.equal(m.annPct, 24.33); assert.equal(m.calledPct, 7);
  assert.equal(metrics(100, 95, 6, 30).otmPct, -5);
});
test('black-scholes sanity: deep ITM delta near 1, deep OTM near 0, price >= intrinsic', () => {
  assert.ok(bsCall(100, 50, 0.1, 0.3).delta > 0.99); assert.ok(bsCall(100, 200, 0.1, 0.3).delta < 0.01);
  assert.ok(bsCall(100, 90, 0.1, 0.3).price >= 10 - 0.01);
});
test('demo expirations are future Fridays and dte >= 1', () => {
  const ex = demoExpirations(now); assert.equal(ex.length, 8);
  for (const x of ex) { assert.equal(new Date(x + 'T00:00:00Z').getUTCDay(), 5); assert.ok(x > '2026-10-13'); assert.ok(dteOf(x, now) >= 1); }
});
test('demo mode: flagged demo, only 100-share lots eligible, chain sorted with bid<=ask', async () => {
  resetQuoteCache(); const { c } = ctx(A);
  const out: any = await coveredCalls(c, undefined, new URL('http://x/api/options/calls'), now);
  assert.equal(out.demo, true); assert.deepEqual(out.eligible.map((e: any) => e.ticker), ['AAPL']);   // MSFT 40 sh excluded
  assert.equal(out.contracts, 2); assert.equal(out.symbol, 'AAPL'); assert.ok(out.calls.length > 5);
  for (let i = 0; i < out.calls.length; i++) { const r = out.calls[i]; assert.ok(r.bid <= r.ask); assert.ok(r.bid > 0); if (i) assert.ok(r.strike > out.calls[i - 1].strike); }
});
test('isolation: another member never sees this owner’s shares or tickers', async () => {
  resetQuoteCache(); const { c: cb } = ctx(B);
  const out: any = await coveredCalls(cb, undefined, new URL('http://x/api/options/calls'), now);
  assert.deepEqual(out.eligible.map((e: any) => e.ticker), ['NVDA']);
  const { c: ca } = ctx(A);
  const o2: any = await coveredCalls(ca, undefined, new URL('http://x/api/options/calls?symbol=NVDA'), now);
  assert.equal(o2.shares, 0); assert.equal(o2.contracts, 0);                 // not A's stock: no shares credited
});
test('no eligible lots → empty list, no error', async () => {
  resetQuoteCache(); const { c } = ctx('33333333-3333-4333-8333-333333333333');
  const out: any = await coveredCalls(c, undefined, new URL('http://x/api/options/calls'), now);
  assert.deepEqual(out.eligible, []); assert.equal(out.symbol, null); assert.deepEqual(out.calls, []);
});
test('input validation: bad symbol and bad expiry are rejected', async () => {
  resetQuoteCache(); const { c } = ctx(A);
  await assert.rejects(() => coveredCalls(c, undefined, new URL('http://x/a?symbol=AAPL;DROP'), now), /invalid_symbol/);
  await assert.rejects(() => coveredCalls(c, undefined, new URL('http://x/a?expiry=tomorrow'), now), /invalid_expiry/);
});
test('tradier live: parses calls only, drops no-bid rows, single-object tolerant, live not demo', async () => {
  resetQuoteCache();
  const { c, calls } = ctx(A, (url) => {
    if (url.includes('/markets/quotes')) return new Response(JSON.stringify({ quotes: { quote: [{ symbol: 'AAPL', last: 200, prevclose: 198 }] } }), { status: 200 });
    if (url.includes('/options/expirations')) return new Response(JSON.stringify({ expirations: { date: '2026-10-23' } }), { status: 200 });
    if (url.includes('/options/chains')) return new Response(JSON.stringify({ options: { option: [
      { option_type: 'call', strike: 205, bid: 2.1, ask: 2.2, open_interest: 900, volume: 10, greeks: { delta: 0.3, mid_iv: 0.25 } },
      { option_type: 'put', strike: 195, bid: 1, ask: 1.1 },
      { option_type: 'call', strike: 250, bid: 0, ask: 0.05 },
      { option_type: 'call', strike: 190, bid: 11.5, ask: 11.7, greeks: { delta: 0.9, mid_iv: 0.3 } },
    ] } }), { status: 200 });
    return null;
  });
  const cfg = { keyId: '', secret: '', tradierToken: 'tok' };
  const out: any = await coveredCalls(c, cfg, new URL('http://x/api/options/calls'), now);
  assert.equal(out.demo, false); assert.deepEqual(out.expirations, ['2026-10-23']);
  assert.deepEqual(out.calls.map((r: any) => r.strike), [190, 205]);
  const r = out.calls[1]; assert.equal(r.bid, 2.1); assert.equal(r.delta, 0.3); assert.equal(r.iv, 25); assert.equal(r.otmPct, 2.5); assert.equal(r.staticPct, 1.05);
  assert.ok(calls.some((u) => u.includes('api.tradier.com')));
});
test('tradier rejection surfaces as an error, never as demo numbers', async () => {
  resetQuoteCache();
  const { c } = ctx(A, (url) => (url.includes('tradier.com') ? new Response('no', { status: 401 }) : null));
  await assert.rejects(() => coveredCalls(c, { keyId: '', secret: '', tradierToken: 'bad' }, new URL('http://x/a'), now), /market_data_error/);
});
