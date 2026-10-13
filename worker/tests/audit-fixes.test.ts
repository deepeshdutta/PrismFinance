// Regression tests for the BRS audit cheap-wins batch (2026-10-14):
// BUG-1..BUG-5 + DISC-1 (gross-of-commissions P&L + estimate line item).
// All fixtures synthetic. Route tests use a minimal fake PostgREST.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  groupOptionLegs, detectRolls, openOptions, pnlSeries, pnlSummary,
  COMMISSION_PER_TRADE_ESTIMATE,
  type OptionLeg, type EquityLeg,
} from '../src/pnl';

const A = '11111111-1111-4111-8111-111111111111';
const ACC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = Date.parse('2026-10-13T14:00:00Z'); // a Tuesday

const oleg = (over: Partial<OptionLeg>): OptionLeg => ({
  accountId: ACC, securityId: 'sec', underlying: 'WWW', contractType: 'put', expiry: '2026-11-20',
  strike: 50, action: 'SHORT_OPEN', quantity: -100, amount: -250, fees: 0, postedOn: '2026-10-01', ...over,
});

type Row = Record<string, any>;
function fakeCtx(owner: string, tables: Record<string, Row[]>) {
  const fetcher = (async (input: any) => {
    const url = new URL(String(input));
    const table = url.pathname.split('/').pop()!;
    const rows = (tables[table] ?? []).filter((r) => {
      for (const [k, v] of url.searchParams) {
        if (['select', 'order', 'limit'].includes(k)) continue;
        if (v.startsWith('eq.')) { if (String(r[k]) !== v.slice(3)) return false; }
      }
      return true;
    });
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as any;
  return { database: 'https://db.test', key: 'k', ownerId: owner, role: 'owner', fetcher } as any;
}
const invRow = (over: Partial<Row>): Row => ({
  account_id: ACC, security_id: 's', posted_on: '2026-01-05', txn_type: 'buy', subtype: null,
  name: 'You bought 100 WWW', quantity: 100, amount: 15000, fees: 0, ticker: 'WWW',
  sec_type: 'equity', option_type: null, option_expiry: null, option_strike: null,
  option_underlying: null, owner_id: A, ...over,
});

// ---------- BUG-1: logout points at Cloudflare Access, button visible ----------
test('BUG-1: logout uses /cdn-cgi/access/logout (no dead /app-session/*), #museUser not hidden in prod build', async () => {
  const html = await readFile(new URL('../../preview/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('/cdn-cgi/access/logout'), 'logout must target the Access logout route');
  assert.ok(!html.includes('/app-session/logout'), 'dead /app-session/logout must be gone');
  assert.ok(!html.includes('/app-session/me'), 'dead /app-session/me must be gone');
  assert.ok(html.includes('/api/me'), 'identity comes from /api/me');
  const navy = await readFile(new URL('../../scripts/use-navy.mjs', import.meta.url), 'utf8');
  assert.ok(!navy.includes('#museUser'), 'production build must not hide #museUser');
});

// ---------- BUG-2: "All" (omitted from) is unbounded ----------
test('BUG-2: omitted from resolves to earliest transaction date, not 12 months', async () => {
  const tables = {
    pf_accounts: [{ id: ACC, owner_id: A, name: 'Brokerage', kind: 'brokerage' }],
    pf_investment_txns: [
      invRow({ posted_on: '2024-06-01', txn_type: 'buy', quantity: 10, amount: 1000, ticker: 'OLD' }),
      invRow({ posted_on: '2026-01-05' }),
    ],
    pf_holdings: [],
  };
  const s: any = await pnlSummary(fakeCtx(A, tables), new URL('http://x/api/pnl?to=2026-10-13'), NOW);
  assert.equal(s.from, '2024-06-01', 'All must start at earliest available data');
  // explicit from still honored
  const s2: any = await pnlSummary(fakeCtx(A, tables), new URL('http://x/api/pnl?from=2026-01-01&to=2026-10-13'), NOW);
  assert.equal(s2.from, '2026-01-01');
});

// ---------- BUG-3: series accepts >366-day ranges ----------
test('BUG-3: pnlSeries accepts multi-year ranges; unrealized stays null gaps', async () => {
  const tables = {
    pf_accounts: [{ id: ACC, owner_id: A, name: 'Brokerage', kind: 'brokerage' }],
    pf_investment_txns: [invRow({ posted_on: '2024-06-01', txn_type: 'buy', quantity: 10, amount: 1000, ticker: 'OLD' })],
    pf_holdings: [],
  };
  const s: any = await pnlSeries(fakeCtx(A, tables), new URL('http://x/api/pnl/series?from=2020-01-01&to=2026-10-13'), NOW);
  assert.ok(s.points.length > 366, 'no 366-day cap');
  assert.ok(s.points.every((p: any) => p.unrealized === null), 'AC-10: never backfilled');
});

// ---------- BUG-4: flags suppressed on expired_inferred ----------
test('BUG-4: expired_inferred positions stay listed but all action flags are suppressed', async () => {
  const txns = [
    invRow({ txn_type: 'sell', quantity: -100, amount: -250, fees: 1, ticker: null, sec_type: 'derivative',
      option_type: 'put', option_expiry: '2026-08-28', option_strike: 50, option_underlying: 'WWW',
      name: 'sell 100 WWW puts $50 to open - SOLD', posted_on: '2026-07-01' }),
  ];
  const tables = {
    pf_accounts: [{ id: ACC, owner_id: A, name: 'Brokerage', kind: 'brokerage' }],
    pf_investment_txns: txns,
    pf_holdings: [
      // broker mark makes pctCaptured 96% — would fire captured75 without suppression
      { account_id: ACC, owner_id: A, ticker: 'WWW260828P00050000', sec_type: 'derivative', quantity: -1, value: -10, cost_basis: -250, as_of: '2026-10-13', updated_at: null },
      // deep-ITM underlying price — would fire deepItm without suppression
      { account_id: ACC, owner_id: A, ticker: 'WWW', sec_type: 'equity', quantity: 0, value: 0, cost_basis: 0, as_of: '2026-10-13', updated_at: null },
    ],
  };
  // equity mark with price 40 vs strike 50 → deepItm would be true
  (tables.pf_holdings[1] as any).quantity = 10; (tables.pf_holdings[1] as any).value = 400;
  const o: any = await openOptions(fakeCtx(A, tables), new URL('http://x/api/options/open'), NOW);
  assert.equal(o.positions.length, 1, 'position stays listed');
  const p = o.positions[0];
  assert.equal(p.pctCaptured, 96, 'data still visible');
  assert.deepEqual(p.flags, { captured75: false, fastFlip: false, cheapClose: false }, 'action flags suppressed');
  assert.deepEqual(p.riskFlags, { deepItm: false, nearStrike: false, insufficientCash: false, quoteStale: false, highCostPct: false }, 'risk flags suppressed');
  assert.ok(String(p.note).includes('suppressed'), 'note discloses suppression');
});

// ---------- BUG-5: roll pairs legs by event date, not group totals ----------
test('BUG-5: partial roll reports the paired close leg debit, not the group total', () => {
  const legs = [
    oleg({ expiry: '2026-10-16', amount: -200, postedOn: '2026-09-01' }),
    oleg({ expiry: '2026-10-16', action: 'SHORT_CLOSE', quantity: 50, amount: 30, postedOn: '2026-09-18' }),
    oleg({ expiry: '2026-10-16', action: 'SHORT_CLOSE', quantity: 50, amount: 40, postedOn: '2026-09-20' }),
    oleg({ expiry: '2026-11-20', amount: -180, postedOn: '2026-09-21' }),
  ];
  const { rolls } = detectRolls(groupOptionLegs(legs, () => null, [], NOW));
  assert.equal(rolls.length, 1);
  assert.equal(rolls[0].closingDebit, 40, 'paired close leg only — not 30+40=70');
  assert.equal(rolls[0].openingCredit, 180);
  assert.equal(rolls[0].netCashFlow, 140);
});

// ---------- DISC-1: P&L gross of commissions + estimate line item ----------
test('DISC-1: option P&L is gross of commissions; estimate constant is $0.01', () => {
  assert.equal(COMMISSION_PER_TRADE_ESTIMATE, 0.01);
  const [g] = groupOptionLegs([
    oleg({ amount: -592, fees: 1.3, quantity: -200, postedOn: '2026-09-01' }),
    oleg({ action: 'SHORT_CLOSE', quantity: 200, amount: 296, fees: 1.3, postedOn: '2026-09-20' }),
  ], () => null, [], NOW);
  assert.equal(g.pnl, 296, 'gross: 592 - 296, fees NOT netted');
  assert.equal(g.fees, 2.6, 'fees still recorded on the group');
});
test('DISC-1: pnlSummary carries the commission estimate line item', async () => {
  const tables = {
    pf_accounts: [{ id: ACC, owner_id: A, name: 'Brokerage', kind: 'brokerage' }],
    pf_investment_txns: [
      invRow({ posted_on: '2026-01-05', txn_type: 'buy' }),
      invRow({ posted_on: '2026-03-10', txn_type: 'sell', quantity: -40, amount: -6800, ticker: 'WWW', name: 'You sold 40 WWW' }),
      invRow({ posted_on: '2026-04-01', txn_type: 'dividend', quantity: 0, amount: -50, name: 'WWW dividend' }),
    ],
    pf_holdings: [],
  };
  const s: any = await pnlSummary(fakeCtx(A, tables), new URL('http://x/api/pnl?from=2026-01-01&to=2026-10-13'), NOW);
  assert.deepEqual(
    { trades: s.commissionEstimate.trades, perTradeUsd: s.commissionEstimate.perTradeUsd, estimateUsd: s.commissionEstimate.estimateUsd },
    { trades: 2, perTradeUsd: 0.01, estimateUsd: 0.02 },
    '2 buy/sell trades × $0.01 (dividend excluded)',
  );
  assert.ok(String(s.commissionEstimate.note).toLowerCase().includes('estimate'), 'labeled an estimate');
});
