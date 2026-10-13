import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import {
  classifyOptionAction, normalizeUnderlying, optionGroupKey, legContracts,
  groupOptionLegs, fifoEquity, parseOccTicker,
  pnlSummary, openOptions, optionsHistory, pnlSeries,
  type OptionLeg, type EquityLeg,
} from '../src/pnl';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const ACC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = Date.parse('2026-10-13T14:00:00Z');

// ---------- classifyOptionAction ----------
test('classify: sell-to-open / buy-to-close / buy-to-open / sell-to-close', () => {
  assert.equal(classifyOptionAction('sell', 'x', 'sell 200 ZZZ puts with strike of $84 for $2.96 each to open - SOLD'), 'SHORT_OPEN');
  assert.equal(classifyOptionAction('buy', 'x', 'buy 200 ZZZ puts with strike of $84 for $1.48 each to close - PURCHASED'), 'SHORT_CLOSE');
  assert.equal(classifyOptionAction('buy', 'x', 'buy 1 WWW call with strike of $150 to open - PURCHASED'), 'LONG_OPEN');
  assert.equal(classifyOptionAction('sell', 'x', 'sell 1 WWW call with strike of $150 for $3.00 each to close - SOLD'), 'LONG_CLOSE');
});
test('classify: expiration and assignment markers', () => {
  assert.equal(classifyOptionAction('transfer', 'x', 'expiration of 2 VVV puts with strike of $5 - OPTIONEXPIRATION'), 'EXPIRE');
  assert.equal(classifyOptionAction('transfer', 'x', 'assignment of 1 YYY calls with strike of $50 - OPTIONEXERCISE'), 'ASSIGN');
});
test('classify: unknown inputs and garbage never throw', () => {
  assert.equal(classifyOptionAction('buy', 'x', 'You bought 100 shares of WWW'), 'UNKNOWN');
  assert.equal(classifyOptionAction('sell', 'x', 'sell 2 WWW calls with strike of $150 - SOLD'), 'UNKNOWN'); // missing to open/close
  assert.equal(classifyOptionAction(null, null, null), 'UNKNOWN');
  assert.equal(classifyOptionAction(undefined, undefined, undefined), 'UNKNOWN');
});

// ---------- normalization / keys / contracts ----------
test('normalizeUnderlying strips trailing digits', () => {
  assert.equal(normalizeUnderlying('CWVX1'), 'CWVX');
  assert.equal(normalizeUnderlying('UVXY1'), 'UVXY');
  assert.equal(normalizeUnderlying('WWW'), 'WWW');
});
test('optionGroupKey never keys on security_id alone', () => {
  const k1 = optionGroupKey(ACC, 'CWVX1', 'put', '2026-10-16', 10);
  const k2 = optionGroupKey(ACC, 'CWVX', 'put', '2026-10-16', 10);
  assert.equal(k1, k2); // adjusted underlying collapses
  assert.notEqual(optionGroupKey(ACC, 'WWW', 'call', '2026-10-16', 150), optionGroupKey(B, 'WWW', 'call', '2026-10-16', 150));
  assert.notEqual(optionGroupKey(ACC, 'WWW', 'call', '2026-10-16', 150), optionGroupKey(ACC, 'WWW', 'put', '2026-10-16', 150));
});
test('legContracts: cash legs in shares, marker legs in contracts with unreliable sign', () => {
  assert.equal(legContracts('SHORT_OPEN', -200), 2);
  assert.equal(legContracts('SHORT_CLOSE', 100), 1);
  assert.equal(legContracts('EXPIRE', -1), 1); // marker sign ignored
  assert.equal(legContracts('ASSIGN', 1), 1);
  assert.equal(legContracts('UNKNOWN', 100), 0);
});

// ---------- grouping ----------
const oleg = (over: Partial<OptionLeg>): OptionLeg => ({
  accountId: ACC, securityId: 'sec', underlying: 'ZZZ', contractType: 'put', expiry: '2026-10-16',
  strike: 84, action: 'SHORT_OPEN', quantity: -200, amount: -592, fees: 1.3, postedOn: '2026-09-01', ...over,
});
test('group: sold put opened then closed -> closed, R4 sign math', () => {
  const [g] = groupOptionLegs([
    oleg({}),
    oleg({ action: 'SHORT_CLOSE', quantity: 200, amount: 296, fees: 1.3, postedOn: '2026-09-20' }),
  ], () => null, [], NOW);
  assert.equal(g.outcome, 'closed');
  assert.equal(g.premiumCollected, 592);   // -(amount of sells)
  assert.equal(g.premiumPaid, 296);        // amount of buys
  assert.equal(g.pnl, 293.4);              // 592 - 296 - 2.6
  assert.equal(g.win, true);
  assert.equal(g.kind, 'sold_put');
  assert.equal(g.coverage, null);          // puts: no coverage label
  assert.equal(g.contracts, 2);
  assert.equal(g.openedOn, '2026-09-01');
  assert.equal(g.closedOn, '2026-09-20');
});
test('group: expiration marker -> expired, premium kept', () => {
  const [g] = groupOptionLegs([
    oleg({ underlying: 'VVV', strike: 5, expiry: '2026-09-18', quantity: -100, amount: -20, fees: 0, postedOn: '2026-08-01' }),
    oleg({ underlying: 'VVV', strike: 5, expiry: '2026-09-18', action: 'EXPIRE', quantity: -1, amount: 0, fees: 0, postedOn: '2026-09-19' }),
  ], () => null, [], NOW);
  assert.equal(g.outcome, 'expired');
  assert.equal(g.pnl, 20);
  assert.equal(g.win, true);
});
test('group: assignment with equity leg -> assigned, no flag; without -> flagged', () => {
  const legs = [
    oleg({ underlying: 'YYY', contractType: 'call', strike: 50, expiry: '2026-09-18', quantity: -100, amount: -100, fees: 0.65, postedOn: '2026-08-05' }),
    oleg({ underlying: 'YYY', contractType: 'call', strike: 50, expiry: '2026-09-18', action: 'ASSIGN', quantity: 1, amount: 0, fees: 0, postedOn: '2026-09-19' }),
  ];
  const equity: EquityLeg = { accountId: ACC, securityId: 'e', ticker: 'YYY', postedOn: '2026-09-20', quantity: 100, amount: 5000, fees: 0, name: 'You bought 100 shares of YYY due to assignment of 1 YYY calls with strike of $50' };
  const [withEq] = groupOptionLegs(legs, () => 100, [equity], NOW);
  assert.equal(withEq.outcome, 'assigned');
  assert.ok(!withEq.flags.includes('assign_marker_without_equity_leg'));
  assert.equal(withEq.kind, 'covered_call'); // 100 shares >= 100*1
  assert.equal(withEq.coverage, 'covered');
  const [withoutEq] = groupOptionLegs(legs, () => null, [], NOW);
  assert.ok(withoutEq.flags.includes('assign_marker_without_equity_leg'));
  assert.ok(withoutEq.flags.includes('coverage_unknown'));
  assert.equal(withoutEq.kind, 'naked_call'); // unknown coverage labels naked per spec
});
test('group: future expiry with net != 0 -> open; past expiry without marker -> expired_inferred', () => {
  const [open] = groupOptionLegs([oleg({ underlying: 'QQX', strike: 54, expiry: '2026-10-23', quantity: -100, amount: -178, fees: 0.65, postedOn: '2026-10-01' })], () => null, [], NOW);
  assert.equal(open.outcome, 'open');
  assert.equal(open.win, null);
  assert.equal(open.openContracts, 1);
  const [inf] = groupOptionLegs([oleg({ underlying: 'OLD', strike: 5, expiry: '2026-09-01', quantity: -100, amount: -20, fees: 0, postedOn: '2026-08-01' })], () => null, [], NOW);
  assert.equal(inf.outcome, 'expired_inferred');
  assert.ok(inf.flags.includes('no_terminal_marker'));
});
test('group: pre-window (close legs only) -> incomplete, flagged, pnl incomplete', () => {
  const [g] = groupOptionLegs([oleg({ action: 'SHORT_CLOSE', quantity: 200, amount: 296, fees: 0, postedOn: '2026-09-20' })], () => null, [], NOW);
  assert.equal(g.outcome, 'incomplete');
  assert.ok(g.flags.includes('pre_window_open'));
  assert.equal(g.win, null);
  assert.equal(g.kind, 'sold_put'); // buy-to-close implies was short
});
test('group: partial close + partial expiry -> closed+expired', () => {
  const [g] = groupOptionLegs([
    oleg({ quantity: -200, amount: -400, fees: 0, postedOn: '2026-08-01', expiry: '2026-09-18' }),
    oleg({ action: 'SHORT_CLOSE', quantity: 100, amount: 100, fees: 0, postedOn: '2026-08-10', expiry: '2026-09-18' }),
    oleg({ action: 'EXPIRE', quantity: 1, amount: 0, fees: 0, postedOn: '2026-09-19', expiry: '2026-09-18' }),
  ], () => null, [], NOW);
  assert.equal(g.outcome, 'closed+expired');
  assert.equal(g.win, true);
  assert.equal(g.pnl, 300);
});

// ---------- FIFO ----------
test('fifoEquity: matches sells against earliest lots, partial lots, byMonth', () => {
  const legs: EquityLeg[] = [
    { accountId: ACC, securityId: 's', ticker: 'WWW', postedOn: '2026-01-05', quantity: 100, amount: 15000, fees: 0 },
    { accountId: ACC, securityId: 's', ticker: 'WWW', postedOn: '2026-02-05', quantity: 100, amount: 16000, fees: 0 },
    { accountId: ACC, securityId: 's', ticker: 'WWW', postedOn: '2026-03-10', quantity: -150, amount: -25500, fees: 0 },
  ];
  const f = fifoEquity(legs);
  // 100 @150 + 50 @160 sold @170: 100*20 + 50*10 = 2500
  assert.equal(f.realized, 2500);
  assert.deepEqual(f.byMonth, [{ month: '2026-03', pnl: 2500 }]);
  assert.equal(f.openLots.length, 1);
  assert.equal(f.openLots[0].quantity, 50);
  assert.equal(f.openLots[0].perShare, 160);
});
test('fifoEquity: unmatched pre-window sells are excluded (basis unknown)', () => {
  const f = fifoEquity([{ accountId: ACC, securityId: 's', ticker: 'UUU', postedOn: '2026-03-10', quantity: -10, amount: -2000, fees: 0 }]);
  assert.equal(f.realized, 0);
  assert.deepEqual(f.openLots, []);
});

// ---------- OCC ----------
test('parseOccTicker: standard OCC and garbage', () => {
  assert.deepEqual(parseOccTicker('WWW260116C00150000'), { underlying: 'WWW', expiry: '2026-01-16', contractType: 'call', strike: 150 });
  assert.deepEqual(parseOccTicker('QQX261023P00054000'), { underlying: 'QQX', expiry: '2026-10-23', contractType: 'put', strike: 54 });
  assert.equal(parseOccTicker('WWW'), null);
  assert.equal(parseOccTicker(''), null);
  assert.equal(parseOccTicker('WWW260116X00150000'), null);
});

// ---------- route handlers (fake PostgREST) ----------
type Row = Record<string, any>;
function fakeCtx(owner: string, tables: Record<string, Row[]>) {
  const seen: string[] = [];
  const fetcher = (async (input: any) => {
    const url = new URL(String(input));
    seen.push(url.pathname + url.search);
    const table = url.pathname.split('/').pop()!;
    const rows = (tables[table] ?? []).filter((r) => {
      for (const [k, v] of url.searchParams) {
        if (['select', 'order', 'limit'].includes(k)) continue;
        if (v.startsWith('eq.')) { if (String(r[k]) !== v.slice(3)) return false; }
        else if (v.startsWith('in.')) { const l = v.slice(4, -1).split(','); if (!l.includes(String(r[k]))) return false; }
      }
      return true;
    });
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as any;
  return { c: { database: 'https://db.test', key: 'k', ownerId: owner, role: 'owner', fetcher } as any, seen };
}
function seedTables() {
  const txns: Row[] = [
    { account_id: ACC, security_id: 's1', posted_on: '2026-01-05', txn_type: 'buy', subtype: null, name: 'You bought 100 WWW', quantity: 100, amount: 15000, fees: 0, ticker: 'WWW', sec_type: 'equity', option_type: null, option_expiry: null, option_strike: null, option_underlying: null },
    { account_id: ACC, security_id: 's1', posted_on: '2026-03-10', txn_type: 'sell', subtype: null, name: 'You sold 40 WWW', quantity: -40, amount: -6800, fees: 0, ticker: 'WWW', sec_type: 'equity', option_type: null, option_expiry: null, option_strike: null, option_underlying: null },
    { account_id: ACC, security_id: 's1', posted_on: '2026-04-01', txn_type: 'dividend', subtype: null, name: 'WWW dividend', quantity: 0, amount: -50, fees: 0, ticker: 'WWW', sec_type: 'equity', option_type: null, option_expiry: null, option_strike: null, option_underlying: null },
    { account_id: ACC, security_id: 'o1', posted_on: '2026-09-01', txn_type: 'sell', subtype: null, name: 'sell 200 ZZZ puts with strike of $84 for $2.96 each to open - SOLD', quantity: -200, amount: -592, fees: 1.3, ticker: null, sec_type: 'derivative', option_type: 'put', option_expiry: '2026-10-16', option_strike: 84, option_underlying: 'ZZZ' },
    { account_id: ACC, security_id: 'o1', posted_on: '2026-09-20', txn_type: 'buy', subtype: null, name: 'buy 200 ZZZ puts with strike of $84 for $1.48 each to close - PURCHASED', quantity: 200, amount: 296, fees: 1.3, ticker: null, sec_type: 'derivative', option_type: 'put', option_expiry: '2026-10-16', option_strike: 84, option_underlying: 'ZZZ' },
    { account_id: ACC, security_id: 'o2', posted_on: '2026-10-01', txn_type: 'sell', subtype: null, name: 'sell 100 QQX puts with strike of $54 for $1.78 each to open - SOLD', quantity: -100, amount: -178, fees: 0.65, ticker: null, sec_type: 'derivative', option_type: 'put', option_expiry: '2026-10-23', option_strike: 54, option_underlying: 'QQX' },
  ];
  const holdings: Row[] = [
    { account_id: ACC, ticker: 'WWW', sec_type: 'equity', quantity: 60, value: 10200, cost_basis: 9000, as_of: '2026-10-13', updated_at: null },
    { account_id: ACC, ticker: 'QQX261023P00054000', sec_type: 'derivative', quantity: -1, value: -120, cost_basis: -178, as_of: '2026-10-13', updated_at: null },
  ];
  return {
    pf_accounts: [{ id: ACC, owner_id: A, name: 'Brokerage', kind: 'brokerage' }],
    pf_investment_txns: txns.map((t) => ({ owner_id: A, ...t })),
    pf_holdings: holdings.map((h) => ({ owner_id: A, ...h })),
  };
}

test('pnlSummary: realized split, dividends, fees, unrealized, owner-scoped', async () => {
  const { c, seen } = fakeCtx(A, seedTables());
  const s: any = await pnlSummary(c, new URL('http://x/api/pnl?from=2026-01-01&to=2026-10-13'), NOW);
  assert.deepEqual(s.accounts, [{ id: ACC, name: 'Brokerage' }]);
  assert.equal(s.realized.stocks, 800);            // 40 sh: (170-150)*40
  assert.equal(s.realized.options, 293.4);         // ZZZ closed put
  assert.equal(s.realized.total, 1093.4);
  assert.equal(s.dividends, 50);
  assert.equal(s.fees, 3.25);                      // 1.3+1.3+0.65
  assert.equal(s.unrealized.stocks, 1200);
  assert.equal(s.unrealized.options, 58);          // -120 - (-178)
  assert.equal(s.unrealized.total, 1258);
  assert.equal(s.unrealized.priceSource, 'delayed');
  assert.equal(s.dataStatus, 'live');
  const sep = s.realized.byMonth.find((m: any) => m.month === '2026-09');
  assert.equal(sep.options, 293.4);
  assert.ok(seen.some((q) => q.includes(`owner_id=eq.${A}`) && q.includes('pf_investment_txns')));
});
test('pnlSummary: empty database -> dataStatus empty', async () => {
  const { c } = fakeCtx(A, { pf_accounts: [], pf_investment_txns: [], pf_holdings: [] });
  const s: any = await pnlSummary(c, new URL('http://x/api/pnl'), NOW);
  assert.equal(s.dataStatus, 'empty');
  assert.equal(s.realized.total, 0);
});
test('pnlSummary: bad account_id and inverted range rejected', async () => {
  const { c } = fakeCtx(A, seedTables());
  await assert.rejects(() => pnlSummary(c, new URL('http://x/api/pnl?account_id=nope'), NOW), /invalid_body/);
  await assert.rejects(() => pnlSummary(c, new URL('http://x/api/pnl?from=2026-10-13&to=2026-01-01'), NOW), /invalid_date/);
  await assert.rejects(() => pnlSummary(c, new URL('http://x/api/pnl?account_id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), NOW), /not_found/);
});

test('openOptions: open short put with OCC mark, delayed labels, flags', async () => {
  const { c } = fakeCtx(A, seedTables());
  const o: any = await openOptions(c, new URL('http://x/api/options/open'), NOW);
  assert.equal(o.priceSource, 'delayed');
  assert.equal(o.positions.length, 1); // only QQX open; ZZZ closed
  const p = o.positions[0];
  assert.equal(p.underlying, 'QQX');
  assert.equal(p.contracts, 1);
  assert.equal(p.premiumReceived, 178);
  assert.equal(p.costToClose, 120);                       // -(-120)
  assert.equal(p.costToClosePerContract, 120);
  assert.equal(p.pctCaptured, 32.6);                      // (1-120/178)*100
  assert.equal(p.dte, 10);
  assert.equal(p.markSource, 'delayed');
  assert.equal(p.markAsOf, '2026-10-13');
  assert.deepEqual(p.flags, { captured75: false, fastFlip: false, cheapClose: false });
  assert.equal(p.coverage, null);                          // puts: no coverage label
  assert.ok(o.note.includes('delayed'));
});
test('optionsHistory: groups, kind summary, cumulative premium', async () => {
  const { c } = fakeCtx(A, seedTables());
  const h: any = await optionsHistory(c, new URL('http://x/api/options/history?from=2026-01-01&to=2026-10-13'), NOW);
  assert.equal(h.groups.length, 2);
  const zzz = h.groups.find((g: any) => g.underlying === 'ZZZ');
  assert.equal(zzz.outcome, 'closed');
  assert.equal(zzz.pnl, 293.4);
  assert.equal(zzz.win, true);
  assert.equal(zzz.kind, 'sold_put');
  assert.equal(h.summary.soldPuts.groups, 1);      // only completed ZZZ; QQX still open
  assert.equal(h.summary.soldPuts.pnl, 293.4);
  assert.equal(h.summary.soldPuts.winRate, 1);
  assert.equal(h.summary.soldPuts.premium, 592);
  assert.deepEqual(h.cumulativePremium, [
    { date: '2026-09-01', cumulative: 592 },
    { date: '2026-10-01', cumulative: 770 },
  ]);
});
test('pnlSeries: cumulative realized + dividends, unrealized null gaps per AC-10 (never backfilled)', async () => {
  const { c } = fakeCtx(A, seedTables());
  const s: any = await pnlSeries(c, new URL('http://x/api/pnl/series?from=2026-10-10&to=2026-10-13'), NOW);
  assert.equal(s.priceSource, 'delayed');
  assert.equal(s.points.length, 4);
  assert.ok(s.note.includes('MVP2'));
  const last = s.points[s.points.length - 1];
  assert.equal(last.unrealized, null); // AC-10: no contemporaneous marks → explicit gap, never backfilled
  assert.ok(s.gaps || s.note.includes('gap') || s.note.includes('unavailable'), 'series must disclose the gap');
  assert.equal(last.dividendsCumulative, 0); // dividend was 2026-04-01, outside range
  await assert.rejects(() => pnlSeries(c, new URL('http://x/api/pnl/series?from=2020-01-01&to=2026-10-13'), NOW), /range_too_large/);
});
test('isolation: member B sees none of A\'s investment data', async () => {
  const tables = seedTables();
  const { c } = fakeCtx(B, tables);
  const s: any = await pnlSummary(c, new URL('http://x/api/pnl'), NOW);
  assert.equal(s.realized.total, 0);
  assert.deepEqual(s.accounts, []);
  const o: any = await openOptions(c, new URL('http://x/api/options/open'), NOW);
  assert.deepEqual(o.positions, []);
});

// ============================================================================
// Spec-completeness additions (test engineer). All fixtures synthetic.
// ============================================================================

test('legContracts: EXPIRE/ASSIGN markers use abs(quantity) regardless of sign', () => {
  assert.equal(legContracts('EXPIRE', -6), 6);
  assert.equal(legContracts('EXPIRE', 1), 1);
  assert.equal(legContracts('ASSIGN', -2), 2);
  assert.equal(legContracts('ASSIGN', 2), 2);
});

test('group: open on QQX + expire marker on QQX1 → single group (normalizeUnderlying)', () => {
  const legs = [
    oleg({ underlying: 'QQX', securityId: 'sec-q', contractType: 'call', strike: 100, expiry: '2026-10-30',
      quantity: -200, amount: -400, fees: 1.3, postedOn: '2026-09-01' }),
    oleg({ underlying: 'QQX1', securityId: 'sec-q1', contractType: 'call', strike: 100, expiry: '2026-10-30',
      action: 'EXPIRE', quantity: -2, amount: 0, fees: 0, postedOn: '2026-10-31' }),
  ];
  const groups = groupOptionLegs(legs, () => null, [], NOW);
  assert.equal(groups.length, 1, 'different security_ids must not split the group');
  assert.equal(groups[0].underlying, 'QQX');
  assert.equal(groups[0].outcome, 'expired');
  assert.equal(groups[0].pnl, 398.7); // 400 - 1.3 fees
});

test('group: covered-call coverage thresholds via getShares', () => {
  const legs = () => [oleg({ underlying: 'QQX', contractType: 'call', strike: 100, expiry: '2026-11-20',
    quantity: -100, amount: -250, fees: 1, postedOn: '2026-10-01' })];
  assert.equal(groupOptionLegs(legs(), () => 250, [], NOW)[0].kind, 'covered_call'); // ≥100×contracts
  assert.equal(groupOptionLegs(legs(), () => 100, [], NOW)[0].kind, 'covered_call'); // exactly 100×contracts
  assert.equal(groupOptionLegs(legs(), () => 7, [], NOW)[0].kind, 'naked_call');
  assert.equal(groupOptionLegs(legs(), () => 99, [], NOW)[0].kind, 'naked_call');
  assert.equal(groupOptionLegs(legs(), () => 0, [], NOW)[0].kind, 'naked_call');
});

test('fifoEquity: buy 100 @10, buy 100 @12, sell 150 @15 → realized 650', () => {
  const legs: EquityLeg[] = [
    { accountId: ACC, securityId: 's', ticker: 'ZZZ', postedOn: '2026-08-05', quantity: 100, amount: 1000, fees: 0 },
    { accountId: ACC, securityId: 's', ticker: 'ZZZ', postedOn: '2026-08-20', quantity: 100, amount: 1200, fees: 0 },
    { accountId: ACC, securityId: 's', ticker: 'ZZZ', postedOn: '2026-09-10', quantity: -150, amount: -2250, fees: 0 },
  ];
  const f = fifoEquity(legs);
  assert.equal(f.realized, 650); // 150*15 − (100*10 + 50*12)
  assert.deepEqual(f.byMonth, [{ month: '2026-09', pnl: 650 }]);
  assert.equal(f.openLots.length, 1);
  assert.equal(f.openLots[0].quantity, 50);
  assert.equal(f.openLots[0].perShare, 12);
});

test('isolation: B decoy rows never leak into A responses, B sees only B', async () => {
  const tables: Record<string, Row[]> = seedTables();
  const B_ACC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  tables.pf_accounts.push({ id: B_ACC, owner_id: B, name: 'B-Brokerage', kind: 'brokerage' });
  tables.pf_investment_txns.push(
    { owner_id: B, account_id: B_ACC, security_id: 'qb1', posted_on: '2026-09-01', txn_type: 'sell', subtype: null,
      name: 'B-secret: sell 200 VVV puts with strike of $100 for $388.88 each to open - SOLD', quantity: -200,
      amount: -77777, fees: 0, ticker: null, sec_type: 'derivative',
      option_type: 'put', option_expiry: '2026-11-20', option_strike: 100, option_underlying: 'VVV' },
    { owner_id: B, account_id: B_ACC, security_id: 'qb1', posted_on: '2026-04-01', txn_type: 'dividend', subtype: null,
      name: 'B-secret dividend', quantity: 0, amount: -88888, fees: 0, ticker: 'VVV', sec_type: 'equity',
      option_type: null, option_expiry: null, option_strike: null, option_underlying: null },
  );
  tables.pf_holdings.push(
    { owner_id: B, account_id: B_ACC, ticker: 'VVV261120P00100000', sec_type: 'derivative', quantity: -2,
      value: -70000, cost_basis: -77777, as_of: '2026-10-13', updated_at: null },
  );
  const a = fakeCtx(A, tables);
  for (const [fn, path] of [[pnlSummary, 'http://x/api/pnl'], [openOptions, 'http://x/api/options/open'],
      [optionsHistory, 'http://x/api/options/history'], [pnlSeries, 'http://x/api/pnl/series']] as const) {
    const out: any = await (fn as any)(a.c, new URL(path), NOW);
    const text = JSON.stringify(out);
    assert.ok(!text.includes('77777') && !text.includes('88888'), `B amounts leak via ${path}`);
    assert.ok(!text.includes('B-secret') && !text.includes('VVV'), `B rows leak via ${path}`);
  }
  const b = fakeCtx(B, tables);
  const sb: any = await pnlSummary(b.c, new URL('http://x/api/pnl'), NOW);
  assert.equal(sb.realized.total, 0, 'A realized must not leak into B');
  assert.equal(sb.dividends, 88888, 'B must see own dividend');
  const ob: any = await openOptions(b.c, new URL('http://x/api/options/open'), NOW);
  assert.equal(ob.positions.length, 1, 'B must see own open position');
  assert.equal(ob.positions[0].underlying, 'VVV');
  assert.equal(ob.positions[0].premiumReceived, 77777);
});

// ---------- SQL migration (PGlite) ----------
test('investments SQL: pf_investment_txns, unique owner+provider index, private, idempotent', async () => {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  // minimal stubs for the tables investments.sql references
  await db.exec(`create table public.prism_members (
    owner_id uuid primary key default gen_random_uuid(),
    email text not null unique
  );`);
  await db.exec(`create table public.pf_accounts (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references public.prism_members(owner_id) on delete cascade
  );`);
  await db.exec(`create table public.pf_import_batches (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references public.prism_members(owner_id) on delete cascade
  );`);
  const sql = await readFile(new URL('../../supabase/investments.sql', import.meta.url), 'utf8');
  await db.exec(sql);
  await db.exec(sql); // idempotent
  const tbl = await db.query(`select 1 from pg_tables where schemaname='public' and tablename='pf_investment_txns'`);
  assert.equal(tbl.rows.length, 1, 'pf_investment_txns exists');
  const uidx = await db.query(`select indexname from pg_indexes where schemaname='public'
    and tablename='pf_investment_txns' and indexname='pf_investment_txns_owner_provider'`);
  assert.equal(uidx.rows.length, 1, 'unique (owner_id, provider_transaction_id) index');
  const cols = (await db.query<any>(`select column_name from information_schema.columns
    where table_name='pf_investment_txns'`)).rows.map((r) => r.column_name);
  for (const c of ['owner_id', 'account_id', 'posted_on', 'txn_type', 'quantity', 'amount', 'fees', 'option_underlying'])
    assert.ok(cols.includes(c), `missing column ${c}`);
  for (const role of ['anon', 'authenticated']) for (const priv of ['SELECT', 'INSERT'])
    assert.equal((await db.query<any>(`select has_table_privilege('${role}','pf_investment_txns','${priv}') as a`)).rows[0].a, false);
  // the unique index actually dedups; NULL provider ids may repeat
  const o = (await db.query<any>(`insert into public.prism_members(email) values ('a@x.test') returning owner_id`)).rows[0].owner_id;
  const acct = (await db.query<any>(`insert into public.pf_accounts(owner_id) values ('${o}') returning id`)).rows[0].id;
  await db.exec(`insert into public.pf_investment_txns(owner_id, account_id, posted_on, txn_type, provider_transaction_id, quantity, amount)
    values ('${o}','${acct}','2026-10-01','sell','p1',-200,-592)`);
  await assert.rejects(db.exec(`insert into public.pf_investment_txns(owner_id, account_id, posted_on, txn_type, provider_transaction_id, quantity, amount)
    values ('${o}','${acct}','2026-10-01','sell','p1',-200,-592)`), /duplicate key/);
  await db.exec(`insert into public.pf_investment_txns(owner_id, account_id, posted_on, txn_type, quantity, amount)
    values ('${o}','${acct}','2026-10-01','sell',-200,-592)`);
  await db.exec(`insert into public.pf_investment_txns(owner_id, account_id, posted_on, txn_type, quantity, amount)
    values ('${o}','${acct}','2026-10-01','sell',-200,-592)`);
  assert.equal((await db.query<any>(`select count(*)::int as n from public.pf_investment_txns`)).rows[0].n, 3);
});
