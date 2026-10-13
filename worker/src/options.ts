// Covered-call chains. Demo mode builds a Black-Scholes chain and is always flagged demo:true.
// Live mode reads Tradier option chains (Greeks refresh hourly there). Member-only: shares come from the caller's own holdings.
import { db, HttpError, type Ctx } from './ledger';
import { quoteFor, type MarketConfig } from './quotes';

const SYMBOL = /^[A-Z]{1,5}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n: number) => Math.round(n * 100) / 100;
export interface CallRow { strike: number; bid: number; ask: number; mid: number; delta: number | null; iv: number | null; oi: number | null; volume: number | null; otmPct: number; staticPct: number; annPct: number; calledPct: number; }

function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const cdf = (x: number) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp((-x * x) / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
export function bsCall(S: number, K: number, T: number, iv: number, r = 0.04) {
  const d1 = (Math.log(S / K) + (r + (iv * iv) / 2) * T) / (iv * Math.sqrt(T)), d2 = d1 - iv * Math.sqrt(T);
  return { price: S * cdf(d1) - K * Math.exp(-r * T) * cdf(d2), delta: cdf(d1) };
}
export function dteOf(expiry: string, now = Date.now()) { return Math.max(1, Math.round((Date.parse(expiry + 'T20:00:00Z') - now) / 86_400_000)); }
export function demoExpirations(now = Date.now()): string[] {
  const out: string[] = []; const d = new Date(now); d.setUTCHours(0, 0, 0, 0);
  while (out.length < 8) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() === 5) out.push(d.toISOString().slice(0, 10)); }
  return out;
}
const step = (s: number) => (s < 25 ? 0.5 : s < 100 ? 2.5 : s < 250 ? 5 : 10);

// premium is the BID (what you'd realistically collect). annualised = static yield scaled to 365 days.
export function metrics(spot: number, strike: number, bid: number, dte: number) {
  const staticPct = (bid / spot) * 100;
  return { otmPct: r2(((strike - spot) / spot) * 100), staticPct: r2(staticPct), annPct: r2(staticPct * (365 / dte)), calledPct: r2(((strike - spot + bid) / spot) * 100) };
}
function demoChain(sym: string, spot: number, expiry: string, now: number): CallRow[] {
  const dte = dteOf(expiry, now), T = dte / 365, base = 0.22 + (hash(sym) % 25) / 100, rows: CallRow[] = [];
  const st = step(spot), lo = Math.floor((spot * 0.92) / st) * st, hi = spot * 1.25;
  for (let k = lo; k <= hi; k += st) {
    const iv = base + Math.max(0, (spot - k) / spot) * 0.3 + 0.02;
    const { price, delta } = bsCall(spot, k, T, iv);
    const mid = Math.max(0.02, price), bid = Math.max(0.01, mid * 0.97), ask = mid * 1.03 + 0.01;
    rows.push({ strike: r2(k), bid: r2(bid), ask: r2(ask), mid: r2(mid), delta: r2(delta), iv: r2(iv * 100), oi: 50 + (hash(sym + k) % 4000), volume: hash(sym + 'v' + k) % 900, ...metrics(spot, k, r2(bid), dte) });
  }
  return rows;
}

async function tradierGet(cfg: MarketConfig, send: typeof fetch, path: string, params: Record<string, string>) {
  const base = cfg.tradierEnv === 'sandbox' ? 'https://sandbox.tradier.com' : 'https://api.tradier.com';
  const res = await send(`${base}${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${cfg.tradierToken}`, Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new HttpError(502, 'market_data_error');
  return res.json() as Promise<any>;
}
const arr = (x: any): any[] => (Array.isArray(x) ? x : x == null ? [] : [x]);
const num = (x: any) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

async function liveExpirations(cfg: MarketConfig, send: typeof fetch, sym: string, now: number) {
  const d = await tradierGet(cfg, send, '/v1/markets/options/expirations', { symbol: sym, includeAllRoots: 'false', strikes: 'false' });
  const today = new Date(now).toISOString().slice(0, 10);
  return arr(d?.expirations?.date).map(String).filter((x) => DATE.test(x) && x >= today).slice(0, 12);
}
async function liveChain(cfg: MarketConfig, send: typeof fetch, sym: string, expiry: string, spot: number, now: number): Promise<CallRow[]> {
  const d = await tradierGet(cfg, send, '/v1/markets/options/chains', { symbol: sym, expiration: expiry, greeks: 'true' });
  const dte = dteOf(expiry, now), rows: CallRow[] = [];
  for (const o of arr(d?.options?.option)) {
    if (o?.option_type !== 'call') continue;
    const strike = num(o.strike), bid = num(o.bid), ask = num(o.ask);
    if (strike == null || bid == null || ask == null || bid <= 0 || ask < bid) continue;     // no bid = nothing to sell into
    const iv = num(o?.greeks?.mid_iv);
    rows.push({ strike: r2(strike), bid: r2(bid), ask: r2(ask), mid: r2((bid + ask) / 2), delta: num(o?.greeks?.delta) == null ? null : r2(Number(o.greeks.delta)), iv: iv == null ? null : r2(iv * 100), oi: num(o.open_interest), volume: num(o.volume), ...metrics(spot, strike, bid, dte) });
  }
  return rows.sort((a, b) => a.strike - b.strike);
}

export async function coveredCalls(ctx: Ctx, cfg: MarketConfig | undefined, url: URL, now = Date.now()) {
  const held = await db(ctx, 'pf_holdings', {}, { select: 'ticker,quantity', owner_id: `eq.${ctx.ownerId}`, ticker: 'not.is.null', limit: '2000' });
  const shares = new Map<string, number>();
  for (const h of held) { const t = String(h.ticker).toUpperCase(); if (SYMBOL.test(t)) shares.set(t, (shares.get(t) ?? 0) + Number(h.quantity || 0)); }
  const eligible = [...shares.entries()].filter(([, q]) => q >= 100).sort((a, b) => b[1] - a[1]).map(([ticker, q]) => ({ ticker, shares: q, contracts: Math.floor(q / 100) }));
  const symbol = (url.searchParams.get('symbol') ?? eligible[0]?.ticker ?? '').toUpperCase();
  if (!symbol) return { demo: !cfg?.tradierToken, eligible, symbol: null, calls: [], expirations: [] };
  if (!SYMBOL.test(symbol)) throw new HttpError(400, 'invalid_symbol');
  const wanted = url.searchParams.get('expiry');
  if (wanted && !DATE.test(wanted)) throw new HttpError(400, 'invalid_expiry');

  const { quote, demo: quotesDemo } = await quoteFor(cfg, ctx.fetcher, symbol, now);
  if (!quote) throw new HttpError(404, 'symbol_not_found');
  const live = !!cfg?.tradierToken;
  const expirations = live ? await liveExpirations(cfg!, ctx.fetcher, symbol, now) : demoExpirations(now);
  if (!expirations.length) throw new HttpError(404, 'no_options');
  const expiry = wanted && expirations.includes(wanted) ? wanted : expirations[Math.min(2, expirations.length - 1)];
  const calls = live ? await liveChain(cfg!, ctx.fetcher, symbol, expiry, quote.p, now) : demoChain(symbol, quote.p, expiry, now);
  const owned = shares.get(symbol) ?? 0;
  return { demo: !live || quotesDemo, symbol, spot: quote.p, dayPct: quote.pct, shares: owned, contracts: Math.floor(owned / 100), eligible, expirations, expiry, dte: dteOf(expiry, now), calls, note: live ? 'Greeks refresh about hourly. Premium shown is the bid.' : 'Demo data - not real prices.' };
}
