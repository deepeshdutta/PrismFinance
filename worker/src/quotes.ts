// Market quotes. The browser never talks to the data provider: one Worker call fetches prices and caches them for everyone.
// Public output contains generic market data only; the signed-in output adds symbols from the caller's own holdings.
import { NASDAQ_100, NASDAQ_TOP500 } from './symbols';
import { db, type Ctx } from './ledger';

export interface MarketConfig { keyId: string; secret: string; tradierToken?: string; tradierEnv?: string; }
export interface Quote { s: string; p: number; c: number; pct: number; t: string | null; }
const BENCH = ['SPY', 'QQQ', 'DIA', 'IWM'];
const UNIVERSE = [...new Set([...BENCH, ...NASDAQ_TOP500])];
const TTL_MS = 20_000;
const SYMBOL = /^[A-Z]{1,5}$/;
const r2 = (n: number) => Math.round(n * 100) / 100;

let cache: { at: number; quotes: Map<string, Quote>; demo: boolean } | null = null;
export function resetQuoteCache() { cache = null; }

// Deterministic pseudo-prices so the bar can be previewed before data keys are added. Always flagged demo:true.
function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function demoQuote(sym: string, now = Date.now()): Quote {
  const base = 20 + (hash(sym) % 48000) / 100;
  const slow = Math.sin(now / 90_000 + (hash(sym + 'a') % 628) / 100);
  const day = ((hash(sym + 'd') % 1000) / 1000 - 0.5) * 0.06;
  const pct = r2((day + slow * 0.006) * 100);
  const prev = r2(base);
  const p = r2(prev * (1 + pct / 100));
  return { s: sym, p, c: r2(p - prev), pct, t: new Date(now).toISOString() };
}

async function tradier(cfg: MarketConfig, symbols: string[], send: typeof fetch): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const base = cfg.tradierEnv === 'sandbox' ? 'https://sandbox.tradier.com' : 'https://api.tradier.com';
  for (let i = 0; i < symbols.length; i += 100) {
    const part = symbols.slice(i, i + 100);
    const res = await send(`${base}/v1/markets/quotes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.tradierToken}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ symbols: part.join(','), greeks: 'false' }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error('market_data_error');
    const data = await res.json() as any;
    const raw = data?.quotes?.quote;
    const list: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const v of list) {
      const sym = String(v?.symbol ?? '');
      const p = Number(v?.last ?? v?.close);
      const prev = Number(v?.prevclose);
      if (!sym || !Number.isFinite(p) || p <= 0 || !Number.isFinite(prev) || prev <= 0) continue;
      const ts = Number(v?.trade_date);
      out.set(sym, { s: sym, p: r2(p), c: r2(p - prev), pct: r2(((p - prev) / prev) * 100), t: Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null });
    }
  }
  return out;
}
const live = (cfg: MarketConfig, symbols: string[], send: typeof fetch) => cfg.tradierToken ? tradier(cfg, symbols, send) : alpaca(cfg, symbols, send);

async function alpaca(cfg: MarketConfig, symbols: string[], send: typeof fetch): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  for (let i = 0; i < symbols.length; i += 200) {
    const part = symbols.slice(i, i + 200);
    const url = `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${part.join(',')}&feed=iex`;
    const res = await send(url, { headers: { 'APCA-API-KEY-ID': cfg.keyId, 'APCA-API-SECRET-KEY': cfg.secret }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('market_data_error');
    const data = await res.json() as Record<string, any>;
    const snaps = (data && typeof data === 'object' && data.snapshots && typeof data.snapshots === 'object') ? data.snapshots : data;
    for (const [sym, v] of Object.entries<any>(snaps)) {
      const p = Number(v?.latestTrade?.p ?? v?.dailyBar?.c);
      const prev = Number(v?.prevDailyBar?.c);
      if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(prev) || prev <= 0) continue;
      out.set(sym, { s: sym, p: r2(p), c: r2(p - prev), pct: r2(((p - prev) / prev) * 100), t: v?.latestTrade?.t ?? v?.dailyBar?.t ?? null });
    }
  }
  return out;
}

export async function getUniverse(cfg: MarketConfig | undefined, send: typeof fetch, now = Date.now()) {
  if (cache && now - cache.at < TTL_MS) return cache;
  const demo = !cfg || !(cfg.tradierToken || (cfg.keyId && cfg.secret));
  const quotes = demo ? new Map(UNIVERSE.map((s) => [s, demoQuote(s, now)])) : await live(cfg!, UNIVERSE, send);
  cache = { at: now, quotes, demo };
  return cache;
}
async function extra(cfg: MarketConfig | undefined, send: typeof fetch, symbols: string[], demo: boolean, have: Map<string, Quote>) {
  const need = symbols.filter((s) => !have.has(s));
  if (!need.length) return new Map<string, Quote>();
  return demo ? new Map(need.map((s) => [s, demoQuote(s)])) : live(cfg!, need, send).catch(() => new Map<string, Quote>());
}
// One symbol's quote, for the options screen (member context, same cache/provider as the bar).
export async function quoteFor(cfg: MarketConfig | undefined, send: typeof fetch, sym: string, now = Date.now()): Promise<{ quote: Quote | null; demo: boolean }> {
  const u = await getUniverse(cfg, send, now);
  const hit = u.quotes.get(sym);
  if (hit) return { quote: hit, demo: u.demo };
  const m = await extra(cfg, send, [sym], u.demo, u.quotes);
  return { quote: m.get(sym) ?? null, demo: u.demo };
}
const by = (m: Map<string, Quote>, list: string[]) => list.map((s) => m.get(s)).filter((q): q is Quote => !!q);
function movers(m: Map<string, Quote>) {
  const all = by(m, NASDAQ_TOP500).filter((q) => q.p >= 2);
  const sorted = [...all].sort((a, b) => b.pct - a.pct);
  return { gainers: sorted.slice(0, 5), losers: sorted.slice(-5).reverse() };
}
function asOf(m: Map<string, Quote>) { let t = 0; for (const q of m.values()) { const v = q.t ? Date.parse(q.t) : 0; if (v > t) t = v; } return t ? new Date(t).toISOString() : null; }

// Logged-out: generic, famous NASDAQ names (largest 500 by market cap). Nothing user-specific.
export async function publicQuotes(cfg: MarketConfig | undefined, send: typeof fetch) {
  const u = await getUniverse(cfg, send);
  return { mode: 'public', demo: u.demo, asOf: asOf(u.quotes), index: by(u.quotes, BENCH), quotes: by(u.quotes, NASDAQ_TOP500), ...movers(u.quotes) };
}
// Logged-in: day change for what this member owns, then the NASDAQ-100.
export async function memberQuotes(ctx: Ctx, cfg: MarketConfig | undefined) {
  const u = await getUniverse(cfg, ctx.fetcher);
  const rows = await db(ctx, 'pf_holdings', {}, { select: 'ticker,value', owner_id: `eq.${ctx.ownerId}`, ticker: 'not.is.null', limit: '2000' });
  const val = new Map<string, number>();
  for (const h of rows) { const t = String(h.ticker).toUpperCase(); if (SYMBOL.test(t)) val.set(t, (val.get(t) ?? 0) + Number(h.value || 0)); }
  const held = [...val.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([t]) => t);
  const more = await extra(cfg, ctx.fetcher, held, u.demo, u.quotes);
  const all = new Map([...u.quotes, ...more]);
  return { mode: 'member', demo: u.demo, asOf: asOf(all), index: by(all, BENCH), holdings: by(all, held), nasdaq100: by(all, NASDAQ_100), ...movers(all) };
}
