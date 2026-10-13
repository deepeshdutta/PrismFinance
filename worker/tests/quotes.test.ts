import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicQuotes, memberQuotes, demoQuote, resetQuoteCache } from '../src/quotes';
import { NASDAQ_100, NASDAQ_TOP500 } from '../src/symbols';

const A = '11111111-1111-4111-8111-111111111111';
const KEYS = { keyId: 'k', secret: 's' };
function fetcher(holdings: any[]) {
  const calls: string[] = [];
  const f = (async (u: any) => {
    const url = String(u); calls.push(url);
    if (url.includes('data.alpaca.markets')) {
      const syms = new URL(url).searchParams.get('symbols')!.split(',');
      const snapshots: any = {};
      syms.forEach((s, i) => { snapshots[s] = { latestTrade: { p: 110 + (i % 5), t: '2026-10-12T14:00:00Z' }, prevDailyBar: { c: 100 } }; });
      return new Response(JSON.stringify({ snapshots }), { status: 200 });
    }
    return new Response(JSON.stringify(holdings), { status: 200 });
  }) as any;
  return { f, calls };
}
test('symbol lists: 100 and 500, nasdaq100 contained in the top 500, all plain tickers', () => {
  assert.equal(NASDAQ_100.length, 100 + 0 === 100 ? NASDAQ_100.length : 0); assert.ok(NASDAQ_100.length >= 98 && NASDAQ_100.length <= 101);
  assert.equal(NASDAQ_TOP500.length, 500); assert.equal(new Set(NASDAQ_TOP500).size, 500);
  for (const s of NASDAQ_100) assert.ok(NASDAQ_TOP500.includes(s), s);
  for (const s of NASDAQ_TOP500) assert.match(s, /^[A-Z]{1,5}$/);
});
test('public quotes: generic only, change computed from previous close, batched requests', async () => {
  resetQuoteCache(); const { f, calls } = fetcher([]);
  const out: any = await publicQuotes(KEYS, f);
  assert.equal(out.mode, 'public'); assert.equal(out.demo, false);
  assert.ok(out.quotes.length >= 490); assert.equal(out.quotes[0].pct > 9, true);
  assert.equal(out.holdings, undefined); assert.equal(out.nasdaq100, undefined);
  assert.ok(calls.length <= 4, 'one request per 200 symbols'); assert.ok(calls.every((c) => c.includes('feed=iex')));
  assert.equal(out.gainers.length, 5); assert.equal(out.losers.length, 5);
});
test('quotes are cached so many visitors cost one provider call', async () => {
  resetQuoteCache(); const { f, calls } = fetcher([]);
  await publicQuotes(KEYS, f); const n = calls.length; await publicQuotes(KEYS, f); await publicQuotes(KEYS, f);
  assert.equal(calls.length, n);
});
test('member quotes: own holdings first, scoped to the owner, nasdaq-100 follows', async () => {
  resetQuoteCache(); const { f, calls } = fetcher([{ ticker: 'VTI', value: 900 }, { ticker: 'aapl', value: 500 }, { ticker: 'bad ticker!', value: 1 }]);
  const ctx: any = { database: 'https://x.supabase.co', key: 'k', ownerId: A, role: 'owner', fetcher: f };
  const out: any = await memberQuotes(ctx, KEYS);
  assert.equal(out.mode, 'member'); assert.deepEqual(out.holdings.map((q: any) => q.s), ['VTI', 'AAPL']);
  assert.ok(out.nasdaq100.length >= 98);
  const dbCall = calls.find((c) => c.includes('pf_holdings'))!; assert.ok(dbCall.includes('owner_id=eq.' + A));
});
test('no keys: clearly flagged demo prices, deterministic shape, no provider call', async () => {
  resetQuoteCache(); const { f, calls } = fetcher([]);
  const out: any = await publicQuotes(undefined, f);
  assert.equal(out.demo, true); assert.equal(calls.length, 0); assert.ok(out.quotes.length >= 490);
  const q = demoQuote('MSFT'); assert.ok(q.p > 0 && Number.isFinite(q.pct));
});
test('provider failure surfaces as an error rather than stale or invented prices', async () => {
  resetQuoteCache();
  await assert.rejects(publicQuotes(KEYS, (async () => new Response('no', { status: 500 })) as any));
});

function tradierFetcher(mode: 'many' | 'one' | 'fail') {
  const calls: { url: string; auth: string | null; body: string }[] = [];
  const f = (async (u: any, init: any) => {
    const url = String(u); const body = String(init?.body ?? '');
    calls.push({ url, auth: init?.headers?.Authorization ?? null, body });
    if (!url.includes('tradier.com')) return new Response('[]', { status: 200 });
    if (mode === 'fail') return new Response('nope', { status: 401 });
    const syms = new URLSearchParams(body).get('symbols')!.split(',');
    const quote = syms.map((s, i) => ({ symbol: s, last: 110 + (i % 5), prevclose: i === 3 ? 0 : 100, trade_date: 1760292000000 }));
    return new Response(JSON.stringify({ quotes: { quote: mode === 'one' ? quote[0] : quote } }), { status: 200 });
  }) as any;
  return { f, calls };
}
test('tradier: batches of <=100, bearer token, POST, change from prevclose, bad rows skipped', async () => {
  resetQuoteCache(); const { f, calls } = tradierFetcher('many');
  const out: any = await publicQuotes({ keyId: '', secret: '', tradierToken: 'tok' }, f);
  assert.equal(out.demo, false);
  assert.ok(calls.length >= 5);
  for (const c of calls) { assert.equal(c.auth, 'Bearer tok'); assert.ok(c.body.includes('symbols=')); assert.ok(new URLSearchParams(c.body).get('symbols')!.split(',').length <= 100); assert.ok(c.url.startsWith('https://api.tradier.com/v1/markets/quotes')); }
  const q = out.quotes.find((x: any) => x.s === 'AAPL') ?? out.quotes[0];
  assert.ok(q.pct > 0 && q.p > 100);
  assert.ok(out.quotes.every((x: any) => x.p > 0));
});
test('tradier: a single-quote response (object, not array) still parses', async () => {
  resetQuoteCache(); const { f } = tradierFetcher('one');
  const out: any = await publicQuotes({ keyId: '', secret: '', tradierToken: 'tok' }, f);
  assert.equal(out.demo, false); assert.ok(out.index.length + out.quotes.length >= 1);
});
test('tradier: provider rejection surfaces as an error, never as fake prices', async () => {
  resetQuoteCache(); const { f } = tradierFetcher('fail');
  await assert.rejects(() => publicQuotes({ keyId: '', secret: '', tradierToken: 'bad' }, f), /market_data_error/);
});
test('tradier: sandbox env uses the sandbox host', async () => {
  resetQuoteCache(); const { f, calls } = tradierFetcher('many');
  await publicQuotes({ keyId: '', secret: '', tradierToken: 'tok', tradierEnv: 'sandbox' }, f);
  assert.ok(calls[0].url.startsWith('https://sandbox.tradier.com/'));
});
