// P&L + options engine (MVP1). Pure option/equity math, then owner-scoped route
// handlers. Every database read is owner-scoped inline so the isolation static
// audit passes: each db(ctx, 'pf_...') line carries ...owned(ctx).
//
// PLAID SIGN CONVENTION (matches supabase/investments.sql): on investment
// transactions, amount < 0 means cash moved INTO the account (sale proceeds,
// premium received, dividends); amount > 0 means cash moved OUT (purchases,
// premium paid, fees).
//
// Marks from pf_holdings are broker marks: always labelled 'delayed', never live.
// NOTE: Plaid investment-transactions sync wiring is a separate PR gated on Plaid
// Production approval; these handlers only read rows already imported.
import { db, HttpError, type Ctx } from './ledger';
import { dteOf } from './options';

const owned = (ctx: Ctx) => ({ owner_id: `eq.${ctx.ownerId}` });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
/**
 * Estimated commission per trade, USD. P&L figures are GROSS of commissions
 * everywhere (user decision 2026-10-14: the majority of commissions are
 * ~$0.01/trade, so netting them into P&L adds noise, not signal). The P&L
 * screen shows a separate "N trades · est. commission ≈ $X" line item computed
 * as tradeCount × COMMISSION_PER_TRADE_ESTIMATE, always labeled an estimate.
 */
export const COMMISSION_PER_TRADE_ESTIMATE = 0.01;

// ---------- exported types ----------
export type OptionAction = 'SHORT_OPEN' | 'SHORT_CLOSE' | 'LONG_OPEN' | 'LONG_CLOSE' | 'EXPIRE' | 'ASSIGN' | 'UNKNOWN';
export interface OptionLeg {
  accountId: string; securityId: string; underlying: string; contractType: 'put' | 'call';
  expiry: string; strike: number; action: OptionAction; quantity: number; amount: number;
  fees: number; postedOn: string;
}
export interface EquityLeg {
  accountId: string; securityId: string; ticker: string; postedOn: string;
  quantity: number; amount: number; fees: number; name?: string | null;
}
export type OptionOutcome =
  | 'open' | 'closed' | 'expired' | 'assigned'
  | 'closed+expired' | 'closed+assigned' | 'expired+assigned' | 'closed+expired+assigned'
  | 'expired_inferred' | 'incomplete';
export type OptionKind = 'sold_put' | 'covered_call' | 'naked_call' | 'long_option' | 'unknown';
export interface OptionGroup {
  key: string; accountId: string; underlying: string; contractType: 'put' | 'call';
  expiry: string; strike: number; openedOn: string | null; closedOn: string | null;
  contracts: number; openContracts: number;
  premiumCollected: number; premiumPaid: number; fees: number; pnl: number;
  outcome: OptionOutcome; win: boolean | null; kind: OptionKind;
  coverage: 'covered' | 'naked' | null; flags: string[]; legCount: number;
  // --- Phase-1 delta (additive; populated by groupOptionLegs / detectRolls) ---
  /** Buy-to-close legs: contracts closed and debit paid (positive). Feeds roll detection. */
  shortCloses: ShortCashLeg[];
  /** Sell-to-open legs: contracts opened and credit received (positive). Feeds roll detection. */
  shortOpens: ShortCashLeg[];
  /** Contracts removed by ASSIGN / EXPIRE terminal markers. */
  assignedContracts: number; expiredContracts: number;
  /** Set by detectRolls: group keys this group rolls to / from. */
  rollFrom?: string; rollTo?: string;
}
/** One short-option cash leg. `cash` is the credit received (opens) or debit paid (closes), always positive. */
export interface ShortCashLeg { postedOn: string; contracts: number; cash: number; }
/** Reconciliation exception surfaced during grouping (FR-07). */
export interface GroupException {
  type: 'pre_window_open' | 'assign_marker_without_equity_leg' | 'no_terminal_marker' | 'multi_security_id' | 'unknown_action' | 'partial_fill';
  groupKey: string; detail: string;
}

// ---------- action classification ----------
const OPT_NAME = /^(buy|sell|expiration of|assignment of)\s+([\d.]+)\s+(\S+)\s+(calls?|puts?)\s+with strike of \$([\d.]+)(?:\s+for \$([\d.]+) each)?(?:\s+to (open|close))?\s*-\s*(PURCHASED|SOLD|OPTIONEXPIRATION|OPTIONEXERCISE)/i;
/** Classify a Plaid investment transaction (type, subtype, name) into an option action. Never throws. */
export function classifyOptionAction(type: unknown, subtype: unknown, name: unknown): OptionAction {
  try {
    const m = OPT_NAME.exec(String(name ?? ''));
    if (m) {
      const verb = m[1].toLowerCase();
      if (verb === 'expiration of') return 'EXPIRE';
      if (verb === 'assignment of') return 'ASSIGN';
      const oc = (m[7] ?? '').toLowerCase();
      if (verb === 'sell' && oc === 'open') return 'SHORT_OPEN';
      if (verb === 'buy' && oc === 'close') return 'SHORT_CLOSE';
      if (verb === 'buy' && oc === 'open') return 'LONG_OPEN';
      if (verb === 'sell' && oc === 'close') return 'LONG_CLOSE';
      return 'UNKNOWN';
    }
    const blob = `${type ?? ''} ${subtype ?? ''} ${name ?? ''}`.toLowerCase();
    if (/\bexpiration of\b|optionexpiration|\bexpired\b/.test(blob)) return 'EXPIRE';
    if (/\bassignment of\b|optionexercise|\bassigned\b|due to assignment/.test(blob)) return 'ASSIGN';
    const buy = /\bbuy\b/.test(blob), sell = /\bsell\b/.test(blob);
    const open = /\bopen\b/.test(blob), close = /\bclose\b/.test(blob);
    if (sell && open && !close) return 'SHORT_OPEN';
    if (buy && close && !open) return 'SHORT_CLOSE';
    if (buy && open && !close) return 'LONG_OPEN';
    if (sell && close && !open) return 'LONG_CLOSE';
    return 'UNKNOWN';
  } catch { return 'UNKNOWN'; }
}

// ---------- normalization / keys ----------
/** Strip trailing digits brokers append to adjusted underlyings (CWVX1 -> CWVX, UVXY1 -> UVXY). */
export function normalizeUnderlying(ticker: string): string {
  return String(ticker ?? '').trim().toUpperCase().replace(/\d+$/, '');
}
/** Group key on (account, normalized underlying, type, expiry, strike) — never security_id alone. */
export function optionGroupKey(accountId: string, underlying: string, contractType: string, expiry: string, strike: number | string): string {
  return [accountId, normalizeUnderlying(underlying), String(contractType).toLowerCase(), expiry, Number(strike)].join('|');
}
/**
 * Contracts per leg. Cash legs (buy/sell) report quantity in SHARES, so divide by 100.
 * Marker legs (EXPIRE/ASSIGN) report CONTRACTS; their sign is unreliable, so use abs().
 */
export function legContracts(action: OptionAction, quantity: number): number {
  const q = Math.abs(Number(quantity) || 0);
  if (action === 'EXPIRE' || action === 'ASSIGN') return q;
  if (action === 'SHORT_OPEN' || action === 'SHORT_CLOSE' || action === 'LONG_OPEN' || action === 'LONG_CLOSE') return q / 100;
  return 0;
}

// ---------- grouping ----------
type SharesFn = (accountId: string, underlying: string, openedOn: string | null) => number | null;
const COMPLETE: ReadonlySet<string> = new Set(['closed', 'expired', 'assigned', 'closed+expired', 'closed+assigned', 'expired+assigned', 'closed+expired+assigned']);

/**
 * Group option legs into positions. getShares verifies call coverage against equity holdings (label only).
 * When `exceptions` is supplied, reconciliation exceptions (FR-07) are collected into it alongside flags.
 */
export function groupOptionLegs(
  legs: OptionLeg[],
  getShares?: SharesFn,
  equityLegs: EquityLeg[] = [],
  now = Date.now(),
  exceptions?: GroupException[],
): OptionGroup[] {
  const buckets = new Map<string, OptionLeg[]>();
  for (const leg of legs) {
    const key = optionGroupKey(leg.accountId, leg.underlying, leg.contractType, leg.expiry, leg.strike);
    const b = buckets.get(key) ?? [];
    b.push(leg);
    buckets.set(key, b);
  }
  const today = new Date(now).toISOString().slice(0, 10);
  const out: OptionGroup[] = [];
  for (const [key, raw] of buckets) {
    const sorted = [...raw].sort((a, b) => (a.postedOn < b.postedOn ? -1 : a.postedOn > b.postedOn ? 1 : 0));
    const flags: string[] = [];
    let net = 0, openedShort = 0, openedLong = 0;
    let closedQty = 0, expiredQty = 0, assignedQty = 0;
    let premiumIn = 0, premiumOut = 0, fees = 0;
    let openedOn: string | null = null, closedOn: string | null = null;
    let hasBuyClose = false, hasSellClose = false, hasMarker = false;
    const secIds = new Set<string>();
    const shortOpens: ShortCashLeg[] = [], shortCloses: ShortCashLeg[] = [];
    let assignedC = 0, expiredC = 0;
    for (const leg of sorted) {
      const c = legContracts(leg.action, leg.quantity);
      secIds.add(leg.securityId);
      if (leg.action === 'SHORT_OPEN') {
        net -= c; openedShort += c; openedOn = openedOn ?? leg.postedOn;
        shortOpens.push({ postedOn: leg.postedOn, contracts: r2(c), cash: r2(Math.max(0, -leg.amount)) });
      }
      else if (leg.action === 'LONG_OPEN') { net += c; openedLong += c; openedOn = openedOn ?? leg.postedOn; }
      else if (leg.action === 'SHORT_CLOSE') {
        net += c; closedQty += c; hasBuyClose = true; closedOn = leg.postedOn;
        shortCloses.push({ postedOn: leg.postedOn, contracts: r2(c), cash: r2(Math.max(0, leg.amount)) });
      }
      else if (leg.action === 'LONG_CLOSE') { net -= c; closedQty += c; hasSellClose = true; closedOn = leg.postedOn; }
      else if (leg.action === 'EXPIRE' || leg.action === 'ASSIGN') {
        hasMarker = true;
        const reduce = Math.min(c, Math.abs(net));
        if (reduce < c) {
          flags.push('partial_marker');
          if (exceptions) exceptions.push({ type: 'partial_fill', groupKey: key, detail: `Terminal ${leg.action} marker on ${leg.postedOn} covered ${r2(reduce)} of ${r2(c)} contracts; remainder unresolved.` });
        }
        net -= Math.sign(net) * reduce;
        if (leg.action === 'EXPIRE') { expiredQty += reduce; expiredC += reduce; } else { assignedQty += reduce; assignedC += reduce; }
        closedOn = leg.postedOn;
      } else {
        flags.push('unknown_leg');
        if (exceptions) exceptions.push({ type: 'unknown_action', groupKey: key, detail: `Leg posted ${leg.postedOn} could not be classified; excluded from contract math.` });
      }
      // Plaid sign: amount < 0 = cash IN (sells), amount > 0 = cash OUT (buys).
      if (leg.amount < 0) premiumIn += -leg.amount; else premiumOut += leg.amount;
      fees += leg.fees || 0;
    }
    if (!openedOn) openedOn = sorted.length ? sorted[0].postedOn : null;
    const expiryPassed = !!sorted[0]?.expiry && sorted[0].expiry < today;
    let outcome: OptionOutcome;
    if (Math.abs(net) < 1e-9) {
      const terms: string[] = [];
      if (closedQty > 0) terms.push('closed');
      if (expiredQty > 0) terms.push('expired');
      if (assignedQty > 0) terms.push('assigned');
      outcome = (terms.length ? terms.join('+') : 'closed') as OptionOutcome;
    } else if (openedShort + openedLong < 1e-9) {
      outcome = 'incomplete'; // pre-window: only close/marker legs seen, no opens
      flags.push('pre_window_open');
    } else if (expiryPassed && !hasMarker) {
      outcome = 'expired_inferred';
      flags.push('no_terminal_marker');
    } else {
      outcome = 'open';
    }
    const complete = COMPLETE.has(outcome) && !flags.includes('pre_window_open');
    // kind: short+put -> sold_put; short+call -> coverage label; long -> long_option.
    let kind: OptionKind = 'unknown';
    const contracts = openedShort + openedLong;
    if (openedShort >= openedLong && openedShort > 1e-9) {
      if (sorted[0].contractType === 'put') kind = 'sold_put';
      else {
        const shares = getShares ? getShares(sorted[0].accountId, normalizeUnderlying(sorted[0].underlying), openedOn) : null;
        if (shares == null) flags.push('coverage_unknown');
        kind = shares != null && shares >= 100 * openedShort ? 'covered_call' : 'naked_call';
      }
    } else if (openedLong > 1e-9) {
      kind = 'long_option';
    } else {
      // pre-window: infer direction from the close legs alone.
      if (hasBuyClose && !hasSellClose) kind = sorted[0].contractType === 'put' ? 'sold_put' : 'naked_call';
      else if (hasSellClose && !hasBuyClose) kind = 'long_option';
      if (kind === 'naked_call') flags.push('coverage_unknown');
    }
    const coverage: OptionGroup['coverage'] = kind === 'covered_call' ? 'covered' : kind === 'naked_call' ? 'naked' : null;
    // ASSIGN markers must be backed by an equity leg, else flag.
    if (assignedQty > 1e-9) {
      const g = sorted[0];
      const found = equityLegs.some((e) =>
        e.accountId === g.accountId &&
        normalizeUnderlying(e.ticker) === normalizeUnderlying(g.underlying) &&
        Math.abs(Date.parse(e.postedOn) - Date.parse(g.expiry)) <= 4 * 86_400_000 &&
        String(e.name ?? '').toLowerCase().includes('due to assignment of') &&
        Math.abs(Math.abs(e.amount) / Math.max(1e-9, Math.abs(e.quantity)) - g.strike) < 0.01);
      if (!found) flags.push('assign_marker_without_equity_leg');
    }
    // Reconciliation exceptions (FR-07): mirror the corresponding flags with detail.
    if (exceptions) {
      if (flags.includes('pre_window_open')) exceptions.push({ type: 'pre_window_open', groupKey: key, detail: 'Group has close/marker legs but no opening legs in the imported window; P&L is incomplete.' });
      if (flags.includes('no_terminal_marker')) exceptions.push({ type: 'no_terminal_marker', groupKey: key, detail: `Expiry ${sorted[0]?.expiry} passed with no EXPIRE/ASSIGN marker; outcome inferred, not confirmed.` });
      if (flags.includes('assign_marker_without_equity_leg')) exceptions.push({ type: 'assign_marker_without_equity_leg', groupKey: key, detail: 'ASSIGN marker has no matching equity leg; assignment economics are unverified.' });
      if (secIds.size > 1) exceptions.push({ type: 'multi_security_id', groupKey: key, detail: `${secIds.size} distinct security_ids merged by (account, underlying, type, expiry, strike): ${[...secIds].slice(0, 3).join(', ')}${secIds.size > 3 ? ', …' : ''}.` });
    }
    // Cash-secured status of puts is NOT derivable from Plaid rows alone — the
    // collateral label is applied only where cash data is available (see computeCollateral).
    // P&L is gross of commissions (user decision 2026-10-14): fees remain visible
    // on the group (highCostPct flag, collateral methodology) but are never
    // netted into any P&L figure. See COMMISSION_PER_TRADE_ESTIMATE.
    const pnl = r2(premiumIn - premiumOut);
    out.push({
      key, accountId: sorted[0]?.accountId ?? '', underlying: normalizeUnderlying(sorted[0]?.underlying ?? ''),
      contractType: sorted[0]?.contractType ?? 'put', expiry: sorted[0]?.expiry ?? '', strike: sorted[0]?.strike ?? 0,
      openedOn, closedOn: complete ? closedOn : null,
      contracts: r2(contracts), openContracts: r2(Math.abs(net)),
      premiumCollected: r2(premiumIn), premiumPaid: r2(premiumOut), fees: r2(fees), pnl,
      outcome, win: complete ? pnl > 0 : null, kind, coverage,
      flags: [...new Set(flags)], legCount: sorted.length,
      shortOpens, shortCloses, assignedContracts: r2(assignedC), expiredContracts: r2(expiredC),
    });
  }
  return out;
}

// ---------- FIFO equity realized P&L ----------
export interface FifoLot { accountId: string; ticker: string; quantity: number; perShare: number; postedOn: string; }
/**
 * FIFO realized P&L for long equity. Buys (quantity > 0) open lots; sells
 * (quantity < 0) match earliest lots, partial lots split. Sells that exceed
 * known lots (pre-window buys) are excluded from gains — basis unknown.
 */
export function fifoEquity(legs: EquityLeg[]): {
  realized: number; byMonth: { month: string; pnl: number }[]; byDay: { date: string; pnl: number }[]; openLots: FifoLot[];
} {
  const books = new Map<string, FifoLot[]>();
  const byMonth = new Map<string, number>();
  const byDay = new Map<string, number>();
  let realized = 0;
  const sorted = [...legs].sort((a, b) => (a.postedOn < b.postedOn ? -1 : a.postedOn > b.postedOn ? 1 : 0));
  for (const leg of sorted) {
    if (!(leg.quantity > 0) && !(leg.quantity < 0)) continue;
    const key = `${leg.accountId}|${leg.ticker}`;
    let book = books.get(key);
    if (!book) { book = []; books.set(key, book); }
    if (leg.quantity > 0) {
      // Plaid sign: buy amount > 0 = cash OUT = cost.
      book.push({ accountId: leg.accountId, ticker: leg.ticker, quantity: leg.quantity, perShare: leg.amount / leg.quantity, postedOn: leg.postedOn });
    } else {
      // Sell: amount < 0 = cash IN = proceeds.
      let need = -leg.quantity;
      const pps = (-leg.amount) / need;
      let gain = 0;
      while (need > 1e-9 && book.length) {
        const lot = book[0];
        const take = Math.min(need, lot.quantity);
        gain += take * (pps - lot.perShare);
        lot.quantity -= take; need -= take;
        if (lot.quantity <= 1e-9) book.shift();
      }
      realized += gain;
      byMonth.set(leg.postedOn.slice(0, 7), (byMonth.get(leg.postedOn.slice(0, 7)) ?? 0) + gain);
      byDay.set(leg.postedOn, (byDay.get(leg.postedOn) ?? 0) + gain);
    }
  }
  const months = [...byMonth.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, pnl]) => ({ month, pnl: r2(pnl) }));
  const days = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, pnl]) => ({ date, pnl: r2(pnl) }));
  const openLots = [...books.values()].flat().filter((l) => l.quantity > 1e-9)
    .map((l) => ({ ...l, quantity: r2(l.quantity), perShare: r2(l.perShare) }));
  return { realized: r2(realized), byMonth: months, byDay: days, openLots };
}

// ---------- OCC ticker parsing ----------
/** Parse OCC option tickers (e.g. AAPL260116C00150000) for best-effort holdings matching. Null when unparseable. */
export function parseOccTicker(ticker: string): { underlying: string; expiry: string; contractType: 'call' | 'put'; strike: number } | null {
  try {
    const t = String(ticker ?? '').trim().toUpperCase();
    if (t.length < 16) return null;
    const tail = t.slice(-15), root = t.slice(0, -15);
    const m = /^(\d{6})([CP])(\d{8})$/.exec(tail);
    if (!m || !/^[A-Z][A-Z0-9]{0,5}$/.test(root)) return null;
    const expiry = `20${m[1].slice(0, 2)}-${m[1].slice(2, 4)}-${m[1].slice(4, 6)}`;
    if (!DATE.test(expiry) || Number.isNaN(Date.parse(expiry))) return null;
    return { underlying: root, expiry, contractType: m[2] === 'C' ? 'call' : 'put', strike: Number(m[3]) / 1000 };
  } catch { return null; }
}

// ============================================================================
// Phase-1 delta: premium accounting, roll detection, wheel cycles, collateral,
// risk flags, reconciliation exceptions. Implements PutSell_RequirementsSpec
// v1.0 Phase 1 / P0 only. Deliberately NOT built: close/hold/roll/assignment
// simulator, SPY/QQQ benchmarks, tax-aware views, stress tests, Greeks,
// earnings/ex-div/concentration flags.
//
// §18 DECISION DEFAULTS (applied consistently, documented here):
//   - Premium-capture denominator = gross initial credit (premiumCollected).
//   - "Within 2 days" (rolls, fast-flip) = 2 CALENDAR days (not 48h, not trading days).
//   - Quote method = mark (midpoint of bid/ask); broker marks are delayed quotes, never live.
//   - Stale quote = mark older than 1 trading day (weekends adjusted; no holiday calendar).
// ============================================================================

// ---------- premium accounting (FR-03) ----------
export interface PremiumMark { costToClose: number; source: string; asOf: string | null; }
export interface PremiumAccounting {
  grossCredit: number; currentLiability: number | null; unrealizedGain: number | null;
  realizedPnl: number | null; fees: number;
  quote: { method: 'mark'; source: string; asOf: string | null };
  presentedAs: 'realized' | 'unrealized';
}
/**
 * FR-03: keep gross premium credits separate from net realized option P&L and
 * current option liabilities. An opening credit is NEVER presented as realized
 * profit: open positions report realizedPnl: null and presentedAs: 'unrealized'
 * (AC-01). Closed groups report realizedPnl = premiumIn − premiumOut − fees
 * with no remaining liability (AC-02). Quote method is always 'mark' (§18).
 */
export function premiumAccountingFor(group: OptionGroup, mark: PremiumMark | null): PremiumAccounting {
  const quote = { method: 'mark' as const, source: mark?.source ?? 'unavailable', asOf: mark?.asOf ?? null };
  if (COMPLETE.has(group.outcome)) {
    return {
      grossCredit: group.premiumCollected, currentLiability: 0, unrealizedGain: null,
      realizedPnl: group.pnl, fees: group.fees, quote, presentedAs: 'realized',
    };
  }
  // Open (or inferred/incomplete): liability and unrealized gain are estimates
  // against the current mark; nothing is realized yet.
  const share = group.contracts > 1e-9 && group.openContracts > 1e-9 ? group.openContracts / group.contracts : 1;
  const grossCredit = r2(group.premiumCollected * share);
  const currentLiability = mark ? r2(mark.costToClose) : null;
  return {
    grossCredit, currentLiability,
    unrealizedGain: currentLiability != null ? r2(grossCredit - currentLiability) : null,
    realizedPnl: null, fees: r2(group.fees * share), quote, presentedAs: 'unrealized',
  };
}

// ---------- roll detection (FR-04) ----------
export interface Roll {
  id: string; accountId: string; underlying: string; contractType: 'put' | 'call';
  date: string; closingDebit: number; openingCredit: number; netCashFlow: number;
  cumulativeCredit: number; oldExpiry: string; newExpiry: string;
  closeGroupKey: string; openGroupKey: string;
}
/**
 * FR-04 roll detection (AC-08). Rule: a SHORT_CLOSE in group G1 followed within
 * 2 CALENDAR days (§18) by a SHORT_OPEN in group G2 — same account, underlying,
 * contractType — is a roll. Chains supported: a roll target may itself be
 * rolled, and cumulativeCredit accumulates gross opening credits across the
 * whole chain. Each open group pairs with at most one close group (the latest
 * qualifying close); a close group may roll into several opens.
 */
export function detectRolls(groups: OptionGroup[]): { rolls: Roll[]; links: Map<string, { rollFrom?: string; rollTo?: string }> } {
  interface Ev { g: OptionGroup; date: string; }
  const closes: Ev[] = [], opens: Ev[] = [];
  for (const g of groups) {
    for (const l of g.shortCloses) closes.push({ g, date: l.postedOn });
    for (const l of g.shortOpens) opens.push({ g, date: l.postedOn });
  }
  const same = (a: OptionGroup, b: OptionGroup) =>
    a.accountId === b.accountId && a.underlying === b.underlying && a.contractType === b.contractType;
  const paired = new Set<string>();
  const rolls: Roll[] = [];
  for (const o of opens.sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (paired.has(o.g.key)) continue;
    let best: Ev | null = null;
    for (const c of closes) {
      if (c.g.key === o.g.key || !same(c.g, o.g)) continue;
      const d = (Date.parse(o.date) - Date.parse(c.date)) / 86_400_000;
      if (d >= 0 && d <= 2 && (!best || c.date > best.date)) best = c;
    }
    if (!best) continue;
    paired.add(o.g.key);
    // BUG-5 pairing method (documented): a roll pairs one CLOSE EVENT with one
    // OPEN EVENT — same account/underlying/contract-type, close 0–2 days before
    // the open, latest such close wins. closingDebit sums only the close legs
    // posted on the paired close date (not every close the group ever had);
    // openingCredit sums only the open legs posted on the paired open date.
    // Partial rolls therefore report the paired legs' cash, not group totals.
    const closingDebit = r2(best.g.shortCloses.filter((l) => l.postedOn === best!.date).reduce((a, l) => a + l.cash, 0));
    const openingCredit = r2(o.g.shortOpens.filter((l) => l.postedOn === o.date).reduce((a, l) => a + l.cash, 0));
    rolls.push({
      id: `roll:${o.date}:${best.g.key}>>${o.g.key}`,
      accountId: o.g.accountId, underlying: o.g.underlying, contractType: o.g.contractType,
      date: o.date, closingDebit, openingCredit, netCashFlow: r2(openingCredit - closingDebit),
      cumulativeCredit: openingCredit, // fixed up for chains below
      oldExpiry: best.g.expiry, newExpiry: o.g.expiry,
      closeGroupKey: best.g.key, openGroupKey: o.g.key,
    });
  }
  rolls.sort((a, b) => (a.date < b.date ? -1 : 1));
  const byOpenKey = new Map(rolls.map((r) => [r.openGroupKey, r]));
  for (const r of rolls) {
    const parent = byOpenKey.get(r.closeGroupKey);
    if (parent) r.cumulativeCredit = r2(parent.cumulativeCredit + r.openingCredit);
  }
  const links = new Map<string, { rollFrom?: string; rollTo?: string }>();
  for (const r of rolls) {
    const c = links.get(r.closeGroupKey) ?? {}; c.rollTo = r.openGroupKey; links.set(r.closeGroupKey, c);
    const o = links.get(r.openGroupKey) ?? {}; o.rollFrom = r.closeGroupKey; links.set(r.openGroupKey, o);
  }
  return { rolls, links };
}

// ---------- wheel tracker (§7) ----------
export interface WheelEvent {
  kind: 'put_sold' | 'assigned' | 'call_sold' | 'called_away' | 'shares_sold';
  date: string; contracts?: number; shares?: number; price?: number;
  premium?: number; proceeds?: number; gain?: number; groupKey?: string;
}
export interface WheelCycle {
  id: string; accountId: string; underlying: string; strike: number;
  events: WheelEvent[];
  /** (shares × strike − put premiums kept) / shares; null until assignment. Strategy-level reference, NOT tax basis. */
  economicEntryPerShare: number | null;
  /** Cumulative: put premiums + call premiums + share disposal gains. Before fees/tax. Never double-counts. */
  economicPnl: number;
  status: 'open' | 'complete';
  flags: string[];
  caveat: 'Economic entry is a strategy-level reference, not tax basis.';
  sharesAssigned: number; sharesDisposed: number;
}
const ASSIGN_WINDOW_MS = 4 * 86_400_000;
const assignName = (e: EquityLeg): boolean => String(e.name ?? '').toLowerCase().includes('due to assignment of');
/**
 * §7 wheel tracker (AC-03/AC-04/AC-07). Links a sold put → assignment into
 * shares → subsequent covered calls → share disposal, preserving each taxable
 * transaction as its own event while accumulating strategy-level economics.
 * AC-07: option premium and equity P&L stay separate line items — economicPnl
 * is their sum, never a merged double-count. Supports partial fills (share
 * quantities) and overlapping cycles (calls attach to the earliest cycle with
 * shares remaining, by date order).
 */
export function buildWheelCycles(groups: OptionGroup[], equityLegs: EquityLeg[]): WheelCycle[] {
  const putAssigns = groups
    .filter((g) => g.contractType === 'put' && g.assignedContracts > 1e-9)
    .sort((a, b) => ((a.closedOn ?? a.expiry) < (b.closedOn ?? b.expiry) ? -1 : 1));
  const cycles: WheelCycle[] = [];
  const used = new Set<EquityLeg>();
  const assignDateOf = (c: WheelCycle): string => c.events.find((e) => e.kind === 'assigned')?.date ?? c.events[0].date;
  for (const g of putAssigns) {
    const buys = equityLegs.filter((e) =>
      !used.has(e) && e.accountId === g.accountId &&
      normalizeUnderlying(e.ticker) === g.underlying && e.quantity > 0 &&
      Math.abs(Date.parse(e.postedOn) - Date.parse(g.expiry)) <= ASSIGN_WINDOW_MS &&
      assignName(e) &&
      Math.abs(Math.abs(e.amount) / Math.max(1e-9, Math.abs(e.quantity)) - g.strike) < 0.01);
    buys.forEach((e) => used.add(e));
    const shares = r2(buys.reduce((a, e) => a + e.quantity, 0));
    const putNet = r2(g.premiumCollected - g.premiumPaid);
    const c: WheelCycle = {
      id: `wheel:${g.accountId}|${g.underlying}|${g.closedOn ?? g.expiry}|${g.strike}`,
      accountId: g.accountId, underlying: g.underlying, strike: g.strike,
      events: [
        { kind: 'put_sold', date: g.openedOn ?? g.expiry, contracts: g.contracts, premium: putNet, groupKey: g.key },
        ...buys.map((e): WheelEvent => ({ kind: 'assigned', date: e.postedOn, shares: r2(e.quantity), price: r2(Math.abs(e.amount) / Math.abs(e.quantity)), groupKey: g.key })),
      ],
      economicEntryPerShare: shares > 1e-9 ? r2((shares * g.strike - putNet) / shares) : null,
      economicPnl: putNet, status: 'open', flags: [],
      caveat: 'Economic entry is a strategy-level reference, not tax basis.',
      sharesAssigned: shares, sharesDisposed: 0,
    };
    if (!buys.length) c.flags.push('missing_equity_leg');
    cycles.push(c);
  }
  const remaining = (c: WheelCycle) => c.sharesAssigned - c.sharesDisposed;
  // Short calls after assignment attach to the earliest cycle with shares remaining (date order).
  const callGroups = groups
    .filter((g) => g.contractType === 'call' && g.kind !== 'long_option' && g.openedOn && g.contracts > 1e-9)
    .sort((a, b) => ((a.openedOn ?? '') < (b.openedOn ?? '') ? -1 : 1));
  for (const g of callGroups) {
    const cands = cycles
      .filter((c) => c.accountId === g.accountId && c.underlying === g.underlying && assignDateOf(c) <= (g.openedOn ?? ''))
      .sort((a, b) => (assignDateOf(a) < assignDateOf(b) ? -1 : 1));
    if (!cands.length) continue; // no wheel anchor: plain call, not part of a wheel
    let c = cands.find((x) => remaining(x) >= 100 * g.contracts - 1e-9);
    if (!c) { c = cands[cands.length - 1]; c.flags.push('overlapping'); }
    const callNet = r2(g.premiumCollected - g.premiumPaid);
    c.economicPnl = r2(c.economicPnl + callNet);
    c.events.push({ kind: 'call_sold', date: g.openedOn ?? g.expiry, contracts: g.contracts, premium: callNet, groupKey: g.key });
    if (g.assignedContracts > 1e-9) {
      const sh = r2(g.assignedContracts * 100);
      const sells = equityLegs.filter((e) =>
        !used.has(e) && e.accountId === g.accountId &&
        normalizeUnderlying(e.ticker) === g.underlying && e.quantity < 0 &&
        Math.abs(Date.parse(e.postedOn) - Date.parse(g.expiry)) <= ASSIGN_WINDOW_MS &&
        assignName(e) &&
        Math.abs(Math.abs(e.amount) / Math.max(1e-9, Math.abs(e.quantity)) - g.strike) < 0.01);
      sells.forEach((e) => used.add(e));
      const proceeds = r2(sells.reduce((a, e) => a + Math.abs(e.amount), 0));
      // Disposal gain is measured against the assignment acquisition price
      // (the put's strike), per the §7.1 worked example — not the call strike.
      const gain = r2(proceeds - sh * c.strike);
      c.economicPnl = r2(c.economicPnl + gain);
      c.sharesDisposed = r2(c.sharesDisposed + sh);
      c.events.push({ kind: 'called_away', date: g.closedOn ?? g.expiry, shares: sh, price: g.strike, proceeds, gain, groupKey: g.key });
      if (sells.length && Math.abs(sells.reduce((a, e) => a + Math.abs(e.quantity), 0) - sh) > 1e-9) c.flags.push('partial_fill');
    }
  }
  // Manual (non-assignment) share disposals after assignment attach by date order too.
  const manualSells = equityLegs.filter((e) => !used.has(e) && e.quantity < 0)
    .sort((a, b) => (a.postedOn < b.postedOn ? -1 : 1));
  for (const e of manualSells) {
    const cands = cycles
      .filter((c) => c.accountId === e.accountId && c.underlying === normalizeUnderlying(e.ticker) && assignDateOf(c) <= e.postedOn && remaining(c) > 1e-9)
      .sort((a, b) => (assignDateOf(a) < assignDateOf(b) ? -1 : 1));
    const c = cands.find((x) => remaining(x) >= Math.abs(e.quantity) - 1e-9) ?? cands[0];
    if (!c) continue;
    const sh = r2(Math.abs(e.quantity));
    const proceeds = r2(Math.abs(e.amount));
    const gain = r2(proceeds - sh * c.strike);
    c.economicPnl = r2(c.economicPnl + gain);
    c.sharesDisposed = r2(c.sharesDisposed + sh);
    c.events.push({ kind: 'shares_sold', date: e.postedOn, shares: sh, price: r2(proceeds / sh), proceeds, gain });
    if (remaining(c) > 1e-9 && remaining(c) < c.sharesAssigned - 1e-9) c.flags.push('partial_fill');
  }
  for (const c of cycles) {
    c.events.sort((a, b) => (a.date < b.date ? -1 : 1));
    if (c.sharesAssigned > 1e-9 && c.sharesDisposed >= c.sharesAssigned - 1e-9) c.status = 'complete';
    c.flags = [...new Set(c.flags)];
    c.economicPnl = r2(c.economicPnl);
  }
  // Overlapping cycles: same account+underlying with interleaved date ranges.
  for (let i = 0; i < cycles.length; i++) for (let j = i + 1; j < cycles.length; j++) {
    const a = cycles[i], b = cycles[j];
    if (a.accountId !== b.accountId || a.underlying !== b.underlying) continue;
    const aEnd = a.events[a.events.length - 1].date;
    if (assignDateOf(b) <= aEnd && assignDateOf(a) <= assignDateOf(b)) {
      if (!a.flags.includes('overlapping')) a.flags.push('overlapping');
      if (!b.flags.includes('overlapping')) b.flags.push('overlapping');
    }
  }
  return cycles.sort((a, b) => (assignDateOf(a) < assignDateOf(b) ? -1 : 1));
}

// ---------- collateral metrics (§8) ----------
export interface CollateralInput {
  openPuts: OptionGroup[];
  coveredCalls: OptionGroup[];
  /** Groups completed inside the queried window (for netPremium). */
  closedGroups: OptionGroup[];
  accounts: { id: string; balance: number }[];
  holdings: { accountId: string; value: number }[];
  equityMarks: { accountId: string; ticker: string; quantity: number; price: number; asOf: string | null }[];
  now?: number;
}
export interface CollateralPut {
  key: string; underlying: string; strike: number; expiry: string; contracts: number;
  required: number; label: 'cash-secured' | 'margin-secured'; labelNote: string;
}
export interface CollateralCall {
  key: string; underlying: string; contracts: number;
  capitalDenominator: 'share_market_value'; capitalValue: number | null; capitalNote: string;
}
export interface CollateralMetrics {
  puts: CollateralPut[]; totalRequired: number;
  cashAvailable: number; cashMethod: string; cashEstimate: true;
  idleCash: number; utilizationPct: number | null;
  netPremium: number; netPremiumNote: string;
  returnOnCollateralPct: number | null; collateralDenominator: number; denominatorNote: string;
  daysCommitted: number | null; daysNote: string;
  annualizedYieldPct: number | null; annualizedNote: string;
  netPremiumPer10k: number | null;
  coveredCalls: CollateralCall[];
  overallLabel: 'cash-secured' | 'margin-secured';
}
/**
 * §8 capital efficiency. Definitions:
 * - required per put = strike × 100 × open contracts.
 * - cashAvailable = max(0, Σ account balances − Σ holding market values). ESTIMATE
 *   (see cashMethod): unsettled cash, encumbrances and margin effects are not excluded.
 * - idleCash = max(0, cashAvailable − totalRequired).
 * - utilizationPct = totalRequired / cashAvailable × 100 (null when no cash).
 * - netPremium = Σ (premiumCollected − premiumPaid) over open puts,
 *   gross of commissions (user decision 2026-10-14),
 *   open covered calls and groups completed inside the queried window.
 * - returnOnCollateralPct = netPremium / totalRequired × 100; denominator is shown.
 * - daysCommitted = required-collateral-weighted average days since openedOn (open puts).
 * - annualizedYieldPct = RoC × 365 / daysCommitted — a COMPARISON, not a forecast.
 * - netPremiumPer10k = netPremium / totalRequired × 10000.
 * - Covered-call capital denominator = share_market_value (backing shares × mark);
 *   the chosen definition is shown explicitly per §8.
 * LABEL RULE: a put is 'cash-secured' iff cashAvailable ≥ strike×100×contracts,
 * else 'margin-secured' — never 'cash-secured' otherwise.
 */
export function computeCollateral(input: CollateralInput): CollateralMetrics {
  const totalBalance = input.accounts.reduce((a, x) => a + (Number(x.balance) || 0), 0);
  const totalHoldings = input.holdings.reduce((a, x) => a + (Number(x.value) || 0), 0);
  const cashAvailable = Math.max(0, r2(totalBalance - totalHoldings));
  const puts: CollateralPut[] = input.openPuts.map((g) => {
    const required = r2(g.strike * 100 * g.openContracts);
    const secured = cashAvailable >= required;
    return {
      key: g.key, underlying: g.underlying, strike: g.strike, expiry: g.expiry,
      contracts: g.openContracts, required,
      label: secured ? 'cash-secured' : 'margin-secured',
      labelNote: secured
        ? 'Available cash covers this position\u2019s required collateral.'
        : 'Available cash does not cover this position\u2019s required collateral; treat as margin-secured.',
    };
  });
  const totalRequired = r2(puts.reduce((a, p) => a + p.required, 0));
  const idleCash = r2(Math.max(0, cashAvailable - totalRequired));
  const utilizationPct = cashAvailable > 0 ? r1((totalRequired / cashAvailable) * 100) : null;
  const netOf = (g: OptionGroup) => g.premiumCollected - g.premiumPaid; // gross of commissions (user decision 2026-10-14)
  const netPremium = r2([...input.openPuts, ...input.coveredCalls, ...input.closedGroups].reduce((a, g) => a + netOf(g), 0));
  const returnOnCollateralPct = totalRequired > 0 ? r2((netPremium / totalRequired) * 100) : null;
  const today = new Date(input.now ?? Date.now()).toISOString().slice(0, 10);
  let wDays = 0, wReq = 0;
  for (const g of input.openPuts) {
    if (!g.openedOn || g.openContracts <= 1e-9) continue;
    const req = g.strike * 100 * g.openContracts;
    const age = Math.max(0, Math.round((Date.parse(today) - Date.parse(g.openedOn)) / 86_400_000));
    wDays += req * age; wReq += req;
  }
  const daysCommitted = wReq > 0 ? r1(wDays / wReq) : null;
  const annualizedYieldPct = returnOnCollateralPct != null && daysCommitted ? r2(returnOnCollateralPct * 365 / daysCommitted) : null;
  const netPremiumPer10k = totalRequired > 0 ? r2((netPremium / totalRequired) * 10000) : null;
  const coveredCalls: CollateralCall[] = input.coveredCalls.map((g) => {
    const ms = input.equityMarks.filter((m) => m.accountId === g.accountId && normalizeUnderlying(m.ticker) === g.underlying);
    const shares = ms.reduce((a, m) => a + (Number(m.quantity) || 0), 0);
    const px = shares > 0 ? ms.reduce((a, m) => a + Number(m.quantity) * Number(m.price), 0) / shares : null;
    const backing = Math.min(shares, 100 * g.openContracts);
    const capitalValue = px != null ? r2(backing * px) : null;
    return {
      key: g.key, underlying: g.underlying, contracts: g.openContracts,
      capitalDenominator: 'share_market_value' as const, capitalValue,
      capitalNote: capitalValue != null
        ? `Denominator = share_market_value: ${r2(backing)} backing shares × $${r2(px!)} mark. Alternative definitions (e.g. share cost) are not computed.`
        : 'No equity mark available for the underlying; capital value unknown.',
    };
  });
  return {
    puts, totalRequired, cashAvailable,
    cashMethod: 'estimate: Σ account balances − Σ holding market values. Unsettled cash, encumbered margin and pending settlements are not excluded — approximation only.',
    cashEstimate: true,
    idleCash, utilizationPct, netPremium,
    netPremiumNote: 'Σ (premiumCollected − premiumPaid), gross of commissions, over open short puts, open covered calls and groups completed inside the queried window.',
    returnOnCollateralPct, collateralDenominator: totalRequired,
    denominatorNote: 'totalRequired = Σ strike×100×open contracts across open short puts.',
    daysCommitted, daysNote: 'Required-collateral-weighted average days since openedOn for open short puts.',
    annualizedYieldPct, annualizedNote: 'Comparison only, not a forecast: assumes the measured return on collateral repeats for a full year.',
    netPremiumPer10k, coveredCalls,
    overallLabel: cashAvailable >= totalRequired ? 'cash-secured' : 'margin-secured',
  };
}

// ---------- risk flags (§6.1) ----------
export interface UnderlyingRef { price: number | null; source: 'delayed' | 'unavailable'; asOf: string | null; }
export interface RiskFlags { deepItm: boolean; nearStrike: boolean; insufficientCash: boolean; quoteStale: boolean; highCostPct: boolean; }
/**
 * Most recent weekday (Mon–Fri) before today. No holiday calendar: around
 * market holidays this may flag a quote stale one session early (documented).
 */
export function previousTradingDay(now = Date.now()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
/**
 * §6.1 Phase-1 flags (earnings/ex-div/concentration are Phase 2 — NOT built).
 * Every evaluation carries evaluatedAt and the quote methodology (AC-12).
 * Underlying price u comes from the pf_holdings equity match (delayed, labeled);
 * when unavailable, price-dependent flags are false and a note is recorded.
 */
export function evaluateRiskFlags(opts: {
  group: OptionGroup; markAsOf: string | null; markSource: string; underlying: UnderlyingRef;
  cashAvailable: number | null; now?: number;
}): { flags: RiskFlags; evaluatedAt: string; quote: { method: 'mark'; source: string; asOf: string | null }; notes: string[] } {
  const { group, underlying } = opts;
  const now = opts.now ?? Date.now();
  const u = underlying.price;
  const isPut = group.contractType === 'put';
  const deepItm = u != null && group.strike > 0 &&
    (isPut ? (group.strike - u) / group.strike >= 0.10 : (u - group.strike) / group.strike >= 0.10);
  const nearStrike = u != null && group.strike > 0 && Math.abs(u - group.strike) / group.strike <= 0.03;
  const required = group.strike * 100 * group.openContracts;
  const insufficientCash = isPut && opts.cashAvailable != null && opts.cashAvailable < required;
  const quoteStale = opts.markAsOf != null && opts.markAsOf < previousTradingDay(now);
  const highCostPct = group.premiumCollected > 0 && group.fees / group.premiumCollected >= 0.05;
  const notes: string[] = [];
  if (u == null) notes.push('Underlying price unavailable: deepItm/nearStrike evaluated false.');
  if (opts.cashAvailable == null) notes.push('Cash estimate unavailable: insufficientCash evaluated false.');
  if (opts.markAsOf == null) notes.push('No mark as-of date: quoteStale evaluated false.');
  return {
    flags: { deepItm, nearStrike, insufficientCash, quoteStale, highCostPct },
    evaluatedAt: new Date(now).toISOString(),
    quote: { method: 'mark', source: opts.markSource, asOf: opts.markAsOf }, // §18: quote method = mark (midpoint)
    notes,
  };
}

// ---------- shared mark helpers ----------
/** Broker marks for option positions, keyed by group key. Marks are delayed quotes, never live. */
function optionMarks(holdings: HoldingRow[]): Map<string, { value: number; asOf: string | null }> {
  const marks = new Map<string, { value: number; asOf: string | null }>();
  for (const h of holdings) {
    const p = parseOccTicker(String(h.ticker ?? ''));
    if (!p || h.value == null) continue;
    marks.set(`${h.account_id}|${normalizeUnderlying(p.underlying)}|${p.contractType}|${p.expiry}|${p.strike}`,
      { value: Number(h.value), asOf: h.as_of ?? (h.updated_at ? String(h.updated_at).slice(0, 10) : null) });
  }
  return marks;
}
/** Equity marks for underlying prices, keyed `${account_id}|${UNDERLYING}` (VWAP across rows). Delayed, labeled. */
function underlyingMarks(holdings: HoldingRow[]): Map<string, { price: number; quantity: number; asOf: string | null }> {
  const agg = new Map<string, { value: number; qty: number; asOf: string | null }>();
  for (const h of holdings) {
    const st = String(h.sec_type ?? '').toLowerCase();
    if (st === 'derivative' || st === 'option' || st === 'cash') continue;
    const t = String(h.ticker ?? '').toUpperCase();
    if (!t || parseOccTicker(t)) continue;
    if (!(Number(h.quantity) > 0) || h.value == null) continue;
    const key = `${h.account_id}|${normalizeUnderlying(t)}`;
    const e = agg.get(key) ?? { value: 0, qty: 0, asOf: null };
    e.value += Number(h.value); e.qty += Number(h.quantity);
    const asOf = h.as_of ?? (h.updated_at ? String(h.updated_at).slice(0, 10) : null);
    if (asOf && (!e.asOf || asOf > e.asOf)) e.asOf = asOf;
    agg.set(key, e);
  }
  const out = new Map<string, { price: number; quantity: number; asOf: string | null }>();
  for (const [k, e] of agg) out.set(k, { price: e.qty > 0 ? e.value / e.qty : 0, quantity: e.qty, asOf: e.asOf });
  return out;
}
/** Premium mark for a group's open contracts from the broker-marks map; null when none (honest, not synthesized). */
function markForGroup(g: OptionGroup, marks: Map<string, { value: number; asOf: string | null }>): PremiumMark | null {
  const m = marks.get(g.key);
  if (!m) return null;
  const isShort = g.kind === 'sold_put' || g.kind === 'covered_call' || g.kind === 'naked_call';
  if (!isShort || g.openContracts <= 1e-9) return null;
  return { costToClose: r2(-m.value), source: 'delayed', asOf: m.asOf };
}

// ---------- route plumbing ----------
function accountScope(url: URL): string | null {
  const a = url.searchParams.get('account_id');
  if (a == null || a === '') return null;
  if (!UUID.test(a)) throw new HttpError(400, 'invalid_body');
  return a;
}
function dateParam(url: URL, name: string, def: string): string {
  const v = url.searchParams.get(name) ?? def;
  if (!DATE.test(v) || Number.isNaN(Date.parse(v))) throw new HttpError(400, 'invalid_date');
  return v;
}
/**
 * BUG-2: an omitted `from` (the UI's "All" chip) resolves to the earliest
 * available transaction date — unbounded history — not the 12-month default.
 * An explicit `from` is validated as before.
 */
function resolveFrom(url: URL, rows: { posted_on: string }[], to: string): string {
  const d = new Date(`${to}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 12);
  const dflt = d.toISOString().slice(0, 10);
  if (url.searchParams.get('from')) return dateParam(url, 'from', dflt);
  const earliest = rows.reduce((m, r) => (r.posted_on && r.posted_on < m ? r.posted_on : m), to);
  return earliest < dflt ? earliest : dflt;
}
interface InvRow {
  account_id: string; security_id: string | null; posted_on: string; txn_type: string; subtype: string | null;
  name: string | null; quantity: number | null; amount: number | null; fees: number | null; ticker: string | null;
  sec_type: string | null; option_type: string | null; option_expiry: string | null;
  option_strike: number | null; option_underlying: string | null;
}
const INV_SELECT = 'account_id,security_id,posted_on,txn_type,subtype,name,quantity,amount,fees,ticker,sec_type,option_type,option_expiry,option_strike,option_underlying';
/** All investment txns for the owner (oldest first); callers filter by date in code so FIFO/grouping see pre-window rows. */
async function allInvestmentRows(ctx: Ctx, accountId: string | null): Promise<InvRow[]> {
  return db(ctx, 'pf_investment_txns', {}, { select: INV_SELECT, ...owned(ctx), ...(accountId ? { account_id: `eq.${accountId}` } : {}), order: 'posted_on.asc', limit: '20000' });
}
function toOptionLeg(r: InvRow): OptionLeg | null {
  const ot = String(r.option_type ?? '').toLowerCase();
  if ((ot !== 'call' && ot !== 'put') || !r.option_expiry) return null; // no expiry: ungroupable
  return {
    accountId: String(r.account_id), securityId: String(r.security_id ?? ''),
    underlying: normalizeUnderlying(String(r.option_underlying ?? r.ticker ?? '')),
    contractType: ot, expiry: String(r.option_expiry ?? ''), strike: Number(r.option_strike ?? 0),
    action: classifyOptionAction(r.txn_type, r.subtype, r.name),
    quantity: Number(r.quantity ?? 0), amount: Number(r.amount ?? 0), fees: Number(r.fees ?? 0),
    postedOn: String(r.posted_on),
  };
}
function toEquityLeg(r: InvRow): EquityLeg | null {
  if (r.txn_type !== 'buy' && r.txn_type !== 'sell') return null;
  const ot = String(r.option_type ?? '').toLowerCase();
  if (ot === 'call' || ot === 'put') return null; // option leg, not equity
  if (!r.ticker) return null;
  return {
    accountId: String(r.account_id), securityId: String(r.security_id ?? ''), ticker: String(r.ticker).toUpperCase(),
    postedOn: String(r.posted_on), quantity: Number(r.quantity ?? 0), amount: Number(r.amount ?? 0),
    fees: Number(r.fees ?? 0), name: r.name,
  };
}
const notNull = <T>(v: T | null): v is T => v != null;
interface HoldingRow { account_id: string; ticker: string | null; sec_type: string | null; quantity: number | null; value: number | null; cost_basis: number | null; as_of: string | null; updated_at: string | null; }
async function loadHoldings(ctx: Ctx, accountId: string | null): Promise<HoldingRow[]> {
  return db(ctx, 'pf_holdings', {}, { select: 'account_id,ticker,sec_type,quantity,value,cost_basis,as_of,updated_at', ...owned(ctx), ...(accountId ? { account_id: `eq.${accountId}` } : {}), limit: '5000' });
}
async function loadAccounts(ctx: Ctx, accountId: string | null): Promise<{ id: string; name: string; kind: string; balance: number | null }[]> {
  return db(ctx, 'pf_accounts', {}, { select: 'id,name,kind,balance', ...owned(ctx), ...(accountId ? { id: `eq.${accountId}` } : {}), kind: 'in.(brokerage,retirement)', limit: '200' });
}
function makeSharesFn(holdings: HoldingRow[]): SharesFn {
  const byAcct = new Map<string, Map<string, number>>();
  for (const h of holdings) {
    const t = String(h.ticker ?? '').toUpperCase();
    if (!t) continue;
    let m = byAcct.get(h.account_id);
    if (!m) { m = new Map(); byAcct.set(h.account_id, m); }
    m.set(t, (m.get(t) ?? 0) + Number(h.quantity || 0));
  }
  return (accountId, underlying) => {
    const m = byAcct.get(accountId);
    if (!m) return null;
    if (m.has(underlying)) return m.get(underlying)!;
    for (const [t, q] of m) if (normalizeUnderlying(t) === underlying) return q;
    return null;
  };
}
function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ey, em] = to.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}
const SYNC_NOTE = 'Investment-transaction sync is a separate PR (needs Plaid Production); figures below reflect imported rows only.';

// ---------- GET /api/pnl ----------
export async function pnlSummary(ctx: Ctx, url: URL, now = Date.now()) {
  const accountId = accountScope(url);
  const to = dateParam(url, 'to', new Date(now).toISOString().slice(0, 10));
  const accounts = await loadAccounts(ctx, accountId);
  if (accountId && !accounts.length) throw new HttpError(404, 'not_found');
  const [rows, holdings] = await Promise.all([allInvestmentRows(ctx, accountId), loadHoldings(ctx, accountId)]);
  const from = resolveFrom(url, rows, to);
  if (from > to) throw new HttpError(400, 'invalid_date');
  const inRange = rows.filter((r) => r.posted_on >= from && r.posted_on <= to);
  // DISC-1: commission estimate line item (user decision 2026-10-14). P&L is
  // gross of commissions; this is a separate, clearly labeled estimate.
  const tradeCount = inRange.filter((r) => r.txn_type === 'buy' || r.txn_type === 'sell').length;
  const equityLegs = rows.map(toEquityLeg).filter(notNull);
  const optLegs = rows.map(toOptionLeg).filter(notNull);
  const groups = groupOptionLegs(optLegs, makeSharesFn(holdings), equityLegs, now);

  const fifo = fifoEquity(equityLegs);
  const fm = from.slice(0, 7), tm = to.slice(0, 7);
  const stockByMonth = new Map(fifo.byMonth.filter((x) => x.month >= fm && x.month <= tm).map((x) => [x.month, x.pnl]));
  const stocks = r2([...stockByMonth.values()].reduce((a, b) => a + b, 0));
  const optByMonth = new Map<string, number>();
  let options = 0;
  for (const g of groups) {
    if (!COMPLETE.has(g.outcome) || !g.closedOn || g.closedOn < from || g.closedOn > to) continue;
    options = r2(options + g.pnl);
    const mo = g.closedOn.slice(0, 7);
    optByMonth.set(mo, r2((optByMonth.get(mo) ?? 0) + g.pnl));
  }
  const byMonth = monthRange(from, to).map((month) => {
    const s = stockByMonth.get(month) ?? 0, o = optByMonth.get(month) ?? 0;
    return { month, stocks: s, options: o, total: r2(s + o) };
  });

  let unrealStocks = 0, unrealOptions = 0, asOf: string | null = null;
  for (const h of holdings) {
    if (h.cost_basis == null || h.value == null) continue;
    const gain = Number(h.value) - Number(h.cost_basis);
    const st = String(h.sec_type ?? '').toLowerCase();
    if (st === 'derivative' || st === 'option') unrealOptions += gain;
    else if (st !== 'cash') unrealStocks += gain;
    const t = h.as_of ?? (h.updated_at ? String(h.updated_at).slice(0, 10) : null);
    if (t && (!asOf || t > asOf)) asOf = t;
  }
  let dividends = 0, fees = 0;
  for (const r of inRange) {
    if (r.txn_type === 'dividend') dividends += -(Number(r.amount ?? 0)); // amount < 0 = cash IN
    fees += Number(r.fees ?? 0);
    if (r.txn_type === 'fee') fees += Number(r.amount ?? 0);
  }
  const dataStatus = !rows.length && !holdings.length ? 'empty'
    : !inRange.length || !holdings.length ? 'partial' : 'live';
  // §8 collateral metrics (Phase 1): open short puts + covered calls, realized window premium.
  const isOpenPosition = (g: OptionGroup) => (g.outcome === 'open' || g.outcome === 'expired_inferred') && g.openContracts > 1e-9;
  const closedInWindow = groups.filter((g) => COMPLETE.has(g.outcome) && g.closedOn != null && g.closedOn >= from && g.closedOn <= to);
  const collateral = computeCollateral({
    openPuts: groups.filter((g) => g.kind === 'sold_put' && isOpenPosition(g)),
    coveredCalls: groups.filter((g) => g.kind === 'covered_call' && isOpenPosition(g)),
    closedGroups: closedInWindow,
    accounts: accounts.map((a) => ({ id: a.id, balance: Number(a.balance ?? 0) })),
    holdings: holdings.map((h) => ({ accountId: h.account_id, value: Number(h.value ?? 0) })),
    equityMarks: [...underlyingMarks(holdings).entries()].map(([k, v]) => {
      const [accountId, ticker] = k.split('|');
      return { accountId, ticker, quantity: v.quantity, price: v.price, asOf: v.asOf };
    }),
    now,
  });
  return {
    from, to,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
    realized: { total: r2(stocks + options), stocks, options, byMonth },
    unrealized: {
      total: r2(unrealStocks + unrealOptions), stocks: r2(unrealStocks), options: r2(unrealOptions),
      asOf, priceSource: 'delayed' as const,
      note: 'Broker holdings marks are delayed quotes, not live prices.',
    },
    dividends: r2(dividends), fees: r2(fees),
    commissionEstimate: {
      trades: tradeCount, perTradeUsd: COMMISSION_PER_TRADE_ESTIMATE,
      estimateUsd: r2(tradeCount * COMMISSION_PER_TRADE_ESTIMATE),
      note: 'Estimate only: trades × $0.01 per trade. All P&L figures are gross of commissions.',
    },
    collateral,
    dataStatus, note: SYNC_NOTE,
  };
}

// ---------- GET /api/options/open ----------
export async function openOptions(ctx: Ctx, url: URL, now = Date.now()) {
  const accountId = accountScope(url);
  const accounts = await loadAccounts(ctx, accountId);
  if (accountId && !accounts.length) throw new HttpError(404, 'not_found');
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const [rows, holdings] = await Promise.all([allInvestmentRows(ctx, accountId), loadHoldings(ctx, accountId)]);
  const getShares = makeSharesFn(holdings);
  const groups = groupOptionLegs(rows.map(toOptionLeg).filter(notNull), getShares, rows.map(toEquityLeg).filter(notNull), now);
  const marks = optionMarks(holdings);
  const umarks = underlyingMarks(holdings);
  // Per-account cash estimate for the insufficientCash flag (§8 formula, labeled estimate).
  const cashByAcct = new Map<string, { cash: number; hasBalance: boolean }>();
  for (const a of accounts) {
    const hv = holdings.filter((h) => h.account_id === a.id).reduce((s, h) => s + (Number(h.value) || 0), 0);
    cashByAcct.set(a.id, a.balance == null
      ? { cash: 0, hasBalance: false }
      : { cash: Math.max(0, r2(Number(a.balance) - hv)), hasBalance: true });
  }
  const today = new Date(now).toISOString().slice(0, 10);
  const positions = groups
    .filter((g) => g.outcome === 'open' || g.outcome === 'expired_inferred')
    .map((g) => {
      const mark = marks.get(g.key) ?? null;
      const isShort = g.kind === 'sold_put' || g.kind === 'covered_call' || g.kind === 'naked_call';
      const share = g.openContracts > 1e-9 && g.contracts > 1e-9 ? g.openContracts / g.contracts : 1;
      const premiumReceived = isShort ? r2(g.premiumCollected * share) : 0;
      const costToClose = isShort && mark ? r2(-mark.value) : null; // short holding value is negative
      const costToClosePerContract = costToClose != null && g.openContracts > 1e-9 ? r2(costToClose / g.openContracts) : null;
      const pctCaptured = premiumReceived > 0 && costToClose != null ? r1((1 - costToClose / premiumReceived) * 100) : null;
      const dte = dteOf(g.expiry, now);
      const ageDays = g.openedOn ? Math.max(0, Math.round((Date.parse(today) - Date.parse(g.openedOn)) / 86_400_000)) : null;
      // FR-03 premium accounting: opening credit is never presented as realized profit.
      const premium = premiumAccountingFor(g, costToClose != null
        ? { costToClose, source: 'delayed', asOf: mark?.asOf ?? null } : null);
      // §6.1 Phase-1 risk flags with evaluatedAt + quote methodology (AC-12).
      const um = umarks.get(`${g.accountId}|${g.underlying}`);
      const underlyingPrice: UnderlyingRef = um
        ? { price: r2(um.price), source: 'delayed', asOf: um.asOf }
        : { price: null, source: 'unavailable', asOf: null };
      const cashInfo = cashByAcct.get(g.accountId);
      // BUG-4: expired_inferred positions stay listed (state visible) but ALL
      // action flags are suppressed — a "review close" flag on a likely-dead
      // position misleads.
      const dead = g.outcome === 'expired_inferred';
      const risk = evaluateRiskFlags({
        group: g, markAsOf: mark?.asOf ?? null, markSource: mark ? 'delayed' : 'unavailable',
        underlying: underlyingPrice, cashAvailable: cashInfo && cashInfo.hasBalance ? cashInfo.cash : null, now,
      });
      return {
        accountId: g.accountId, accountName: names.get(g.accountId) ?? null,
        underlying: g.underlying, contractType: g.contractType, strike: g.strike, expiry: g.expiry,
        contracts: g.openContracts, openedOn: g.openedOn, kind: g.kind,
        premiumReceived, costToClose, costToClosePerContract, pctCaptured, dte,
        markAsOf: mark?.asOf ?? null, markSource: (mark ? 'delayed' : 'unavailable') as 'delayed' | 'unavailable',
        flags: {
          captured75: !dead && pctCaptured != null && pctCaptured >= 75,
          fastFlip: !dead && pctCaptured != null && pctCaptured > 50 && ageDays != null && ageDays <= 2,
          cheapClose: !dead && dte <= 2 && costToClosePerContract != null && costToClosePerContract <= 0.01,
        },
        premium,
        riskFlags: dead
          ? { deepItm: false, nearStrike: false, insufficientCash: false, quoteStale: false, highCostPct: false }
          : risk.flags,
        riskNotes: risk.notes,
        evaluatedAt: risk.evaluatedAt,
        quote: risk.quote,
        underlyingPrice,
        coverage: g.coverage,
        note: g.outcome === 'expired_inferred'
          ? 'Expiry passed with no terminal marker; likely expired but unconfirmed. Action flags suppressed.'
          : g.kind === 'long_option' ? 'Long option: cost-to-close and % captured are not applicable.' : null,
      };
    })
    .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : a.underlying < b.underlying ? -1 : 1));
  return {
    asOf: today, priceSource: 'delayed' as const, positions,
    note: 'Cost-to-close uses latest broker marks (delayed quotes), matched best-effort via OCC tickers; null when unmatchable. Never live prices. ' + SYNC_NOTE,
  };
}

// ---------- GET /api/options/history ----------
export async function optionsHistory(ctx: Ctx, url: URL, now = Date.now()) {
  const accountId = accountScope(url);
  const to = dateParam(url, 'to', new Date(now).toISOString().slice(0, 10));
  const dflt = new Date(`${to}T00:00:00Z`); dflt.setUTCMonth(dflt.getUTCMonth() - 12);
  const from = dateParam(url, 'from', dflt.toISOString().slice(0, 10));
  if (from > to) throw new HttpError(400, 'invalid_date');
  const accounts = await loadAccounts(ctx, accountId);
  if (accountId && !accounts.length) throw new HttpError(404, 'not_found');
  const [rows, holdings] = await Promise.all([allInvestmentRows(ctx, accountId), loadHoldings(ctx, accountId)]);
  const getShares = makeSharesFn(holdings);
  const equityLegs = rows.map(toEquityLeg).filter(notNull);
  const exceptions: GroupException[] = [];
  const allGroups = groupOptionLegs(rows.map(toOptionLeg).filter(notNull), getShares, equityLegs, now, exceptions);
  // Rolls and wheel cycles are computed on the full (unfiltered) groups so
  // chains are never cut by the query window.
  const { rolls, links } = detectRolls(allGroups);
  const wheels = buildWheelCycles(allGroups, equityLegs);
  const marks = optionMarks(holdings);
  const groups = allGroups
    .filter((g) => g.openedOn != null && g.openedOn <= to && (g.closedOn == null || g.closedOn >= from))
    .sort((a, b) => ((a.openedOn ?? '') < (b.openedOn ?? '') ? -1 : 1));
  for (const g of groups) {
    const l = links.get(g.key);
    if (l?.rollFrom) g.rollFrom = l.rollFrom;
    if (l?.rollTo) g.rollTo = l.rollTo;
  }
  const summarize = (kind: OptionKind) => {
    const done = groups.filter((g) => g.kind === kind && g.win != null);
    const wins = done.filter((g) => g.win).length;
    return {
      groups: done.length,
      premium: r2(done.reduce((a, g) => a + g.premiumCollected, 0)),
      pnl: r2(done.reduce((a, g) => a + g.pnl, 0)),
      winRate: done.length ? r2(wins / done.length) : null,
    };
  };
  const cum = new Map<string, number>();
  let run = 0;
  const sells = rows
    .map(toOptionLeg).filter(notNull)
    .filter((l) => (l.action === 'SHORT_OPEN' || l.action === 'LONG_CLOSE') && l.postedOn >= from && l.postedOn <= to)
    .sort((a, b) => (a.postedOn < b.postedOn ? -1 : 1));
  for (const l of sells) { run = r2(run - l.amount); cum.set(l.postedOn, run); } // amount < 0 = premium in
  return {
    from, to,
    groups: groups.map((g) => ({
      key: g.key, accountId: g.accountId, underlying: g.underlying, contractType: g.contractType,
      strike: g.strike, expiry: g.expiry, openedOn: g.openedOn, closedOn: g.closedOn,
      contracts: g.contracts, openContracts: g.openContracts,
      premiumCollected: g.premiumCollected, premiumPaid: g.premiumPaid, fees: g.fees, pnl: g.pnl,
      outcome: g.outcome, win: g.win, kind: g.kind, coverage: g.coverage, flags: g.flags,
      rollFrom: g.rollFrom ?? null, rollTo: g.rollTo ?? null,
      premium: premiumAccountingFor(g, markForGroup(g, marks)),
    })),
    summary: {
      soldPuts: summarize('sold_put'), coveredCalls: summarize('covered_call'),
      nakedCalls: summarize('naked_call'), longOptions: summarize('long_option'),
    },
    cumulativePremium: [...cum.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, cumulative]) => ({ date, cumulative })),
    rolls, wheels, exceptions,
  };
}

// ---------- GET /api/pnl/series ----------
export async function pnlSeries(ctx: Ctx, url: URL, now = Date.now()) {
  const accountId = accountScope(url);
  const to = dateParam(url, 'to', new Date(now).toISOString().slice(0, 10));
  const accounts = await loadAccounts(ctx, accountId);
  if (accountId && !accounts.length) throw new HttpError(404, 'not_found');
  const [rows, holdings] = await Promise.all([allInvestmentRows(ctx, accountId), loadHoldings(ctx, accountId)]);
  // BUG-3: arbitrary from/to ranges allowed (BRS INV-02 2Y/3Y/All). Realized
  // computes over the full range; unrealized keeps honest null gaps (AC-10).
  const from = resolveFrom(url, rows, to);
  if (from > to) throw new HttpError(400, 'invalid_date');
  const equityLegs = rows.map(toEquityLeg).filter(notNull);
  const fifo = fifoEquity(equityLegs);
  const groups = groupOptionLegs(rows.map(toOptionLeg).filter(notNull), makeSharesFn(holdings), equityLegs, now);
  const optDay = new Map<string, number>();
  for (const g of groups) {
    if (!COMPLETE.has(g.outcome) || !g.closedOn) continue;
    optDay.set(g.closedOn, r2((optDay.get(g.closedOn) ?? 0) + g.pnl));
  }
  const stockDay = new Map(fifo.byDay.map((x) => [x.date, x.pnl]));
  const divDay = new Map<string, number>();
  for (const r of rows) {
    if (r.txn_type !== 'dividend') continue;
    divDay.set(r.posted_on, r2((divDay.get(r.posted_on) ?? 0) - Number(r.amount ?? 0)));
  }
  // AC-10 / FR-06: no contemporaneous historical marks are stored, so unrealized
  // is null at every point — an explicit gap. NEVER backfill with today's marks.
  const points: { date: string; realizedCumulative: number; dividendsCumulative: number; unrealized: null }[] = [];
  let rc = 0, dc = 0;
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    rc = r2(rc + (stockDay.get(date) ?? 0) + (optDay.get(date) ?? 0));
    dc = r2(dc + (divDay.get(date) ?? 0));
    points.push({ date, realizedCumulative: rc, dividendsCumulative: dc, unrealized: null });
  }
  return {
    from, to, points, priceSource: 'delayed' as const,
    gaps: 'No contemporaneous historical marks are stored; unrealized is null at every point and is never backfilled from current marks.',
    note: 'Realized series from imported transactions only. Net-liq history needs statement imports (MVP2).',
  };
}
