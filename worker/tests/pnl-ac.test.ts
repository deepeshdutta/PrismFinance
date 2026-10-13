// Phase-1 delta acceptance tests (PutSell_RequirementsSpec v1.0, AC-01…AC-12).
// All fixtures are synthetic. Pure-engine tests use fixtures directly; route
// tests use a minimal fake PostgREST. Does not touch worker/tests/pnl.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { createHandler, type Env } from '../src/index';
import {
  groupOptionLegs, premiumAccountingFor, detectRolls, buildWheelCycles,
  computeCollateral, evaluateRiskFlags, previousTradingDay,
  openOptions, optionsHistory, pnlSeries, pnlSummary,
  type OptionLeg, type EquityLeg, type GroupException,
} from '../src/pnl';

const A = '11111111-1111-4111-8111-111111111111';
const ACC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROTH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = Date.parse('2026-10-13T14:00:00Z'); // a Tuesday

const oleg = (over: Partial<OptionLeg>): OptionLeg => ({
  accountId: ACC, securityId: 'sec', underlying: 'WWW', contractType: 'put', expiry: '2026-11-20',
  strike: 50, action: 'SHORT_OPEN', quantity: -100, amount: -250, fees: 0, postedOn: '2026-10-01', ...over,
});
const eleg = (over: Partial<EquityLeg>): EquityLeg => ({
  accountId: ACC, securityId: 'e', ticker: 'WWW', postedOn: '2026-10-01',
  quantity: 0, amount: 0, fees: 0, ...over,
});

// ---------- AC-01 / AC-02: premium accounting ----------
test('AC-01: open put — $250 credit, $40 liability, $210 unrealized gain; never realized profit', () => {
  const [g] = groupOptionLegs([oleg({})], () => null, [], NOW);
  assert.equal(g.outcome, 'open');
  const pa = premiumAccountingFor(g, { costToClose: 40, source: 'delayed', asOf: '2026-10-13' });
  assert.equal(pa.grossCredit, 250);
  assert.equal(pa.currentLiability, 40);
  assert.equal(pa.unrealizedGain, 210);
  assert.equal(pa.realizedPnl, null, 'opening credit must NOT be presented as realized profit');
  assert.equal(pa.presentedAs, 'unrealized');
  assert.equal(pa.quote.method, 'mark');
  assert.equal(pa.quote.asOf, '2026-10-13');
});
test('AC-01b: open put without a mark — liability/gain null, still not realized', () => {
  const [g] = groupOptionLegs([oleg({})], () => null, [], NOW);
  const pa = premiumAccountingFor(g, null);
  assert.equal(pa.grossCredit, 250);
  assert.equal(pa.currentLiability, null);
  assert.equal(pa.unrealizedGain, null);
  assert.equal(pa.realizedPnl, null);
  assert.equal(pa.quote.source, 'unavailable');
});
test('AC-02: close at $40 — $210 realized option profit, no remaining liability', () => {
  const [g] = groupOptionLegs([
    oleg({}),
    oleg({ action: 'SHORT_CLOSE', quantity: 100, amount: 40, fees: 0, postedOn: '2026-10-10' }),
  ], () => null, [], NOW);
  assert.equal(g.outcome, 'closed');
  const pa = premiumAccountingFor(g, null);
  assert.equal(pa.realizedPnl, 210);
  assert.equal(pa.currentLiability, 0);
  assert.equal(pa.unrealizedGain, null);
  assert.equal(pa.presentedAs, 'realized');
});

// ---------- AC-03 / AC-04 / AC-07: wheel ----------
const wheelLegs = (): { legs: OptionLeg[]; equity: EquityLeg[] } => ({
  legs: [
    oleg({ amount: -150, postedOn: '2026-08-01', expiry: '2026-09-18' }),
    oleg({ action: 'ASSIGN', quantity: 1, amount: 0, fees: 0, postedOn: '2026-09-19', expiry: '2026-09-18' }),
    oleg({ contractType: 'call', strike: 52, expiry: '2026-10-16', amount: -120, postedOn: '2026-09-25' }),
    oleg({ contractType: 'call', strike: 52, expiry: '2026-10-16', action: 'ASSIGN', quantity: 1, amount: 0, postedOn: '2026-10-17' }),
  ],
  equity: [
    eleg({ quantity: 100, amount: 5000, postedOn: '2026-09-19', name: 'You bought 100 shares of WWW due to assignment of 1 WWW puts with strike of $50' }),
    eleg({ quantity: -100, amount: -5200, postedOn: '2026-10-17', name: 'You sold 100 shares of WWW due to assignment of 1 WWW calls with strike of $52' }),
  ],
});
test('AC-03: $50 assigned put, $150 premium, 100 shares → $48.50 economic entry; tax basis separate', () => {
  const { legs, equity } = wheelLegs();
  const [w] = buildWheelCycles(groupOptionLegs(legs, () => 100, equity, NOW), equity);
  assert.equal(w.economicEntryPerShare, 48.5);
  assert.equal(w.caveat, 'Economic entry is a strategy-level reference, not tax basis.');
  assert.ok(!('taxBasis' in w), 'no field may masquerade as tax basis');
});
test('AC-04: full wheel ($50 put $150 → assign → $52 call $120 → assign) → $470 economic profit', () => {
  const { legs, equity } = wheelLegs();
  const [w] = buildWheelCycles(groupOptionLegs(legs, () => 100, equity, NOW), equity);
  assert.equal(w.economicPnl, 470); // 150 + 120 + (5200 − 5000), before fees/tax
  assert.equal(w.economicEntryPerShare, 48.5);
  assert.equal(w.status, 'complete');
  assert.equal(w.sharesAssigned, 100);
  assert.equal(w.sharesDisposed, 100);
});
test('AC-07: assignment links option + equity legs as separate line items; no double count', async () => {
  const { c } = fakeCtx(A, seedWheel());
  const h: any = await optionsHistory(c, new URL('http://x/api/options/history?from=2026-01-01&to=2026-10-31'), NOW);
  assert.ok(Array.isArray(h.wheels) && h.wheels.length === 1);
  assert.ok(Array.isArray(h.exceptions));
  const w = h.wheels[0];
  const kinds = w.events.map((e: any) => e.kind);
  for (const k of ['put_sold', 'assigned', 'call_sold', 'called_away']) assert.ok(kinds.includes(k), `missing event ${k}`);
  // Sum integrity: economicPnl must equal the sum of its separate line items.
  const premSum = w.events.filter((e: any) => e.premium != null).reduce((a: number, e: any) => a + e.premium, 0);
  const gainSum = w.events.filter((e: any) => e.gain != null).reduce((a: number, e: any) => a + e.gain, 0);
  assert.equal(Math.round((premSum + gainSum) * 100) / 100, w.economicPnl);
  assert.equal(w.economicPnl, 470);
});

// ---------- AC-05 / AC-06: action-center flags ----------
test('AC-05: 75% capture flag fires exactly at threshold; deterministic rounding; quote timestamp', async () => {
  const { c } = fakeCtx(A, seedAC(-62.5));
  const o: any = await openOptions(c, new URL('http://x/api/options/open'), NOW);
  assert.equal(o.positions.length, 1);
  const p = o.positions[0];
  assert.equal(p.pctCaptured, 75);
  assert.equal(p.flags.captured75, true);
  assert.ok(p.evaluatedAt, 'evaluatedAt present');
  assert.equal(p.quote.method, 'mark');
  assert.equal(p.quote.asOf, '2026-10-13');
  // Just below the threshold the flag stays off (deterministic r1 rounding).
  const { c: c2 } = fakeCtx(A, seedAC(-62.75));
  const p2: any = (await openOptions(c2, new URL('http://x/api/options/open'), NOW)).positions[0];
  assert.equal(p2.pctCaptured, 74.9);
  assert.equal(p2.flags.captured75, false);
});
test('AC-06: $0.01 mark with ≤2 DTE is flagged for review, never "guaranteed"', async () => {
  const { c } = fakeCtx(A, seedAC(-0.01, '2026-10-14'));
  const o: any = await openOptions(c, new URL('http://x/api/options/open'), NOW);
  const p = o.positions[0];
  assert.ok(p.dte <= 2);
  assert.equal(p.costToClosePerContract, 0.01);
  assert.equal(p.flags.cheapClose, true);
  const text = JSON.stringify(o);
  assert.ok(!/guarantee/i.test(text), 'output must never imply a guarantee');
  assert.ok(!/risk-free/i.test(text), 'output must never imply risk-free expiry');
});

// ---------- AC-08: rolls ----------
test('AC-08: roll renders closingDebit, openingCredit, netCashFlow, cumulativeCredit, newExpiry separately', () => {
  const legs = [
    oleg({ expiry: '2026-10-16', amount: -200, postedOn: '2026-09-01' }),
    oleg({ expiry: '2026-10-16', action: 'SHORT_CLOSE', quantity: 100, amount: 40, postedOn: '2026-09-20' }),
    oleg({ expiry: '2026-11-20', amount: -180, postedOn: '2026-09-21' }),
  ];
  const { rolls, links } = detectRolls(groupOptionLegs(legs, () => null, [], NOW));
  assert.equal(rolls.length, 1);
  const r = rolls[0];
  assert.equal(r.closingDebit, 40);
  assert.equal(r.openingCredit, 180);
  assert.equal(r.netCashFlow, 140);
  assert.equal(r.cumulativeCredit, 180);
  assert.equal(r.oldExpiry, '2026-10-16');
  assert.equal(r.newExpiry, '2026-11-20');
  assert.notEqual(r.closeGroupKey, r.openGroupKey);
  assert.equal(links.get(r.closeGroupKey)?.rollTo, r.openGroupKey);
  assert.equal(links.get(r.openGroupKey)?.rollFrom, r.closeGroupKey);
});
test('AC-08b: roll chains (roll of a roll) accumulate cumulativeCredit; >2 days is not a roll', () => {
  const legs = [
    oleg({ expiry: '2026-10-16', amount: -200, postedOn: '2026-09-01' }),
    oleg({ expiry: '2026-10-16', action: 'SHORT_CLOSE', quantity: 100, amount: 40, postedOn: '2026-09-20' }),
    oleg({ expiry: '2026-11-20', amount: -180, postedOn: '2026-09-21' }),
    oleg({ expiry: '2026-11-20', action: 'SHORT_CLOSE', quantity: 100, amount: 60, postedOn: '2026-10-05' }),
    oleg({ expiry: '2026-12-18', amount: -160, postedOn: '2026-10-06' }),
  ];
  const { rolls } = detectRolls(groupOptionLegs(legs, () => null, [], NOW));
  assert.equal(rolls.length, 2);
  assert.equal(rolls[0].cumulativeCredit, 180);
  assert.equal(rolls[1].cumulativeCredit, 340, 'chain accumulates gross credits: 180 + 160');
  assert.equal(rolls[1].netCashFlow, 100);
  const late = [
    oleg({ expiry: '2026-10-16', amount: -200, postedOn: '2026-09-01' }),
    oleg({ expiry: '2026-10-16', action: 'SHORT_CLOSE', quantity: 100, amount: 40, postedOn: '2026-09-20' }),
    oleg({ expiry: '2026-11-20', amount: -180, postedOn: '2026-09-23' }), // 3 calendar days later
  ];
  assert.equal(detectRolls(groupOptionLegs(late, () => null, [], NOW)).rolls.length, 0);
});

// ---------- AC-09: account reconciliation ----------
test('AC-09: individual + Roth groups reconcile to combined totals; attribution intact', () => {
  const legs = [
    oleg({ accountId: ACC, amount: -200, postedOn: '2026-09-01', expiry: '2026-10-16' }),
    oleg({ accountId: ACC, action: 'SHORT_CLOSE', quantity: 100, amount: 50, postedOn: '2026-09-20', expiry: '2026-10-16' }),
    oleg({ accountId: ROTH, amount: -300, postedOn: '2026-09-05', expiry: '2026-10-16' }),
    oleg({ accountId: ROTH, action: 'SHORT_CLOSE', quantity: 100, amount: 100, postedOn: '2026-09-25', expiry: '2026-10-16' }),
  ];
  const groups = groupOptionLegs(legs, () => null, [], NOW);
  const byAcct = new Map<string, number>();
  for (const g of groups) {
    assert.ok(g.accountId === ACC || g.accountId === ROTH, 'account attribution intact');
    byAcct.set(g.accountId, (byAcct.get(g.accountId) ?? 0) + g.pnl);
  }
  assert.equal(byAcct.get(ACC), 150);
  assert.equal(byAcct.get(ROTH), 200);
  assert.equal([...byAcct.values()].reduce((a, b) => a + b, 0), 350);
  assert.equal(groups.reduce((a, g) => a + g.pnl, 0), 350);
});

// ---------- AC-10: series gaps ----------
test('AC-10: series without historical marks → unrealized null gaps, no fabricated points', async () => {
  const { c } = fakeCtx(A, seedAC());
  const s: any = await pnlSeries(c, new URL('http://x/api/pnl/series?from=2026-10-10&to=2026-10-13'), NOW);
  assert.ok(s.points.length > 0);
  for (const p of s.points) assert.equal(p.unrealized, null, 'no backfill with current marks');
  assert.ok(typeof s.gaps === 'string' && s.gaps.length > 0, 'explicit gaps note');
});

// ---------- AC-11: adjusted contracts / partial fills ----------
test('AC-11: QQX1 adjusted marker + partial close → single group with explicit exception', () => {
  const legs = [
    oleg({ underlying: 'QQX', securityId: 'sec-q', contractType: 'call', strike: 100, expiry: '2026-10-30', quantity: -200, amount: -400, fees: 1.3, postedOn: '2026-09-01' }),
    oleg({ underlying: 'QQX', securityId: 'sec-q', contractType: 'call', strike: 100, expiry: '2026-10-30', action: 'SHORT_CLOSE', quantity: 100, amount: 100, fees: 0, postedOn: '2026-09-10' }),
    oleg({ underlying: 'QQX1', securityId: 'sec-q1', contractType: 'call', strike: 100, expiry: '2026-10-30', action: 'EXPIRE', quantity: -2, amount: 0, fees: 0, postedOn: '2026-10-31' }),
  ];
  const exceptions: GroupException[] = [];
  const groups = groupOptionLegs(legs, () => null, [], NOW, exceptions);
  assert.equal(groups.length, 1, 'adjusted underlying collapses to one group');
  assert.equal(groups[0].underlying, 'QQX');
  const pf = exceptions.find((e) => e.type === 'partial_fill');
  assert.ok(pf, 'partial marker surfaces as an explicit exception');
  assert.equal(pf.groupKey, groups[0].key);
  assert.ok(exceptions.some((e) => e.type === 'multi_security_id'), 'merged security_ids are disclosed');
});

// ---------- collateral (§8) ----------
test('collateral: required, cash-secured label rule, utilization, return on collateral', () => {
  const [g] = groupOptionLegs([oleg({ strike: 50, amount: -250, expiry: '2026-11-20' })], () => null, [], NOW);
  const m = computeCollateral({
    openPuts: [g], coveredCalls: [], closedGroups: [],
    accounts: [{ id: ACC, balance: 100000 }],
    holdings: [{ accountId: ACC, value: 60000 }],
    equityMarks: [], now: NOW,
  });
  assert.equal(m.puts[0].required, 5000); // 50 × 100 × 1
  assert.equal(m.puts[0].label, 'cash-secured'); // 40000 ≥ 5000
  assert.equal(m.cashAvailable, 40000);
  assert.equal(m.idleCash, 35000);
  assert.equal(m.utilizationPct, 12.5);
  assert.equal(m.netPremium, 250);
  assert.equal(m.returnOnCollateralPct, 5);
  assert.equal(m.collateralDenominator, 5000);
  assert.equal(m.netPremiumPer10k, 500);
  assert.ok(m.cashMethod.length > 0 && m.annualizedNote.includes('not a forecast'));
  const poor = computeCollateral({
    openPuts: [g], coveredCalls: [], closedGroups: [],
    accounts: [{ id: ACC, balance: 1000 }], holdings: [], equityMarks: [], now: NOW,
  });
  assert.equal(poor.puts[0].label, 'margin-secured', 'never cash-secured without covering cash');
});
test('collateral: covered-call capital denominator is share_market_value and shown', () => {
  const [g] = groupOptionLegs([oleg({ contractType: 'call', strike: 55, amount: -120, expiry: '2026-11-20' })], () => 100, [], NOW);
  assert.equal(g.kind, 'covered_call');
  const m = computeCollateral({
    openPuts: [], coveredCalls: [g], closedGroups: [],
    accounts: [], holdings: [],
    equityMarks: [{ accountId: ACC, ticker: 'WWW', quantity: 100, price: 52, asOf: '2026-10-13' }],
    now: NOW,
  });
  assert.equal(m.coveredCalls[0].capitalDenominator, 'share_market_value');
  assert.equal(m.coveredCalls[0].capitalValue, 5200);
});

// ---------- risk flags (§6.1) ----------
test('previousTradingDay skips weekends', () => {
  assert.equal(previousTradingDay(Date.parse('2026-10-13T14:00:00Z')), '2026-10-12'); // Tue → Mon
  assert.equal(previousTradingDay(Date.parse('2026-10-12T14:00:00Z')), '2026-10-09'); // Mon → Fri
  assert.equal(previousTradingDay(Date.parse('2026-10-18T14:00:00Z')), '2026-10-16'); // Sun → Fri
});
test('risk flags: deepItm / nearStrike / quoteStale / highCostPct / insufficientCash', () => {
  const [g] = groupOptionLegs([oleg({ strike: 50, amount: -250, fees: 15, expiry: '2026-11-20' })], () => null, [], NOW);
  const base = { group: g, markAsOf: '2026-10-13', markSource: 'delayed', cashAvailable: 100000, now: NOW };
  const deep = evaluateRiskFlags({ ...base, underlying: { price: 44, source: 'delayed', asOf: '2026-10-13' } });
  assert.equal(deep.flags.deepItm, true); // (50−44)/50 = 12% ≥ 10%
  assert.equal(deep.flags.nearStrike, false);
  const near = evaluateRiskFlags({ ...base, underlying: { price: 49, source: 'delayed', asOf: '2026-10-13' } });
  assert.equal(near.flags.nearStrike, true); // |49−50|/50 = 2% ≤ 3%
  assert.equal(near.flags.deepItm, false);
  const stale = evaluateRiskFlags({ ...base, markAsOf: '2026-10-10', underlying: { price: 49, source: 'delayed', asOf: '2026-10-10' } });
  assert.equal(stale.flags.quoteStale, true); // 2026-10-10 < prev trading day 2026-10-12
  const fresh = evaluateRiskFlags({ ...base, markAsOf: '2026-10-12', underlying: { price: 49, source: 'delayed', asOf: '2026-10-12' } });
  assert.equal(fresh.flags.quoteStale, false);
  assert.equal(deep.flags.highCostPct, true); // 15/250 = 6% ≥ 5%
  const poor = evaluateRiskFlags({ ...base, cashAvailable: 4000, underlying: { price: 49, source: 'delayed', asOf: '2026-10-13' } });
  assert.equal(poor.flags.insufficientCash, true); // 4000 < 50×100×1
  const nopx = evaluateRiskFlags({ ...base, underlying: { price: null, source: 'unavailable', asOf: null } });
  assert.equal(nopx.flags.deepItm, false);
  assert.equal(nopx.flags.nearStrike, false);
  assert.ok(nopx.notes.some((n) => n.includes('Underlying price unavailable')));
  assert.ok(deep.evaluatedAt);
  assert.equal(deep.quote.method, 'mark');
});

// ---------- AC-12: evaluatedAt + quote on every flag; routes read-only ----------
test('AC-12: every flag evaluation carries evaluatedAt + quote methodology', async () => {
  const { c } = fakeCtx(A, seedAC());
  const o: any = await openOptions(c, new URL('http://x/api/options/open'), NOW);
  assert.ok(o.positions.length > 0);
  for (const p of o.positions) {
    assert.ok(p.evaluatedAt, 'evaluatedAt present');
    assert.equal(p.quote.method, 'mark');
    assert.ok('source' in p.quote && 'asOf' in p.quote, 'quote methodology present');
    assert.ok(p.riskFlags && typeof p.riskFlags.deepItm === 'boolean');
  }
});
test('AC-12: pnl routes reject POST/PUT/DELETE with 405 (read-only)', async () => {
  const env: Env = {
    ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com', ACCESS_AUD: 'aud',
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'k',
  };
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 't', alg: 'RS256' }] });
  const tables: Record<string, any[]> = {
    prism_members: [{ owner_id: A, email: 'a@example.com', role: 'owner', active: true, access_subject: 'sa' }],
    pf_accounts: [], pf_investment_txns: [], pf_holdings: [],
  };
  const fakeFetch = (async (input: any) => {
    const url = new URL(String(input));
    const rows = (tables[url.pathname.split('/').pop()!] ?? []).filter((r: any) => {
      for (const [k, v] of url.searchParams) {
        if (['select', 'order', 'limit'].includes(k)) continue;
        if (v.startsWith('eq.')) { if (String(r[k]) !== v.slice(3)) return false; }
        else if (v.startsWith('in.')) { const l = v.slice(4, -1).split(','); if (!l.includes(String(r[k]))) return false; }
      }
      return true;
    });
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as unknown as typeof fetch;
  const h = createHandler({ key, fetch: fakeFetch });
  const nowS = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ email: 'a@example.com', sub: 'sa', iss: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, iat: nowS, exp: nowS + 600 })
    .setProtectedHeader({ alg: 'RS256', kid: 't' }).sign(privateKey);
  for (const path of ['/api/pnl', '/api/pnl/series', '/api/options/open', '/api/options/history']) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await h(new Request(`https://app.example.com${path}`, {
        method, headers: { 'Cf-Access-Jwt-Assertion': token, 'Content-Type': 'application/json' }, body: '{}',
      }), env);
      assert.equal(res.status, 405, `${method} ${path} must be read-only`);
    }
    const get = await h(new Request(`https://app.example.com${path}`, { headers: { 'Cf-Access-Jwt-Assertion': token } }), env);
    assert.equal(get.status, 200, `GET ${path} keeps working`);
  }
});

// ---------- pnlSummary collateral wiring ----------
test('pnlSummary exposes collateral metrics built from owner-scoped rows', async () => {
  const { c } = fakeCtx(A, seedAC());
  const s: any = await pnlSummary(c, new URL('http://x/api/pnl?from=2026-01-01&to=2026-10-13'), NOW);
  assert.ok(s.collateral, 'collateral key present');
  assert.equal(s.collateral.puts[0].required, 5000);
  assert.equal(s.collateral.puts[0].label, 'cash-secured');
  assert.ok(s.collateral.cashMethod.includes('estimate'));
});

// ============================================================================
// Fixtures
// ============================================================================
type Row = Record<string, any>;
function fakeCtx(owner: string, tables: Record<string, Row[]>) {
  const fetcher = (async (input: any) => {
    const url = new URL(String(input));
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
  return { c: { database: 'https://db.test', key: 'k', ownerId: owner, role: 'owner', fetcher } as any };
}
/** One open short put (WWW $50) with a broker mark. markValue is the signed holding value (negative = short). */
function seedAC(markValue = -62.5, expiry = '2026-11-20') {
  const occ = `WWW${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}P00050000`;
  return {
    pf_accounts: [{ id: ACC, owner_id: A, name: 'Brokerage', kind: 'brokerage', balance: 100000 }],
    pf_investment_txns: [{
      owner_id: A, account_id: ACC, security_id: 'o1', posted_on: '2026-10-01', txn_type: 'sell', subtype: null,
      name: 'sell 100 WWW puts with strike of $50 for $2.50 each to open - SOLD',
      quantity: -100, amount: -250, fees: 0, ticker: null, sec_type: 'derivative',
      option_type: 'put', option_expiry: expiry, option_strike: 50, option_underlying: 'WWW',
    }],
    pf_holdings: [
      { owner_id: A, account_id: ACC, ticker: occ, sec_type: 'derivative', quantity: -1, value: markValue, cost_basis: -250, as_of: '2026-10-13', updated_at: null },
    ],
  };
}
function seedWheel() {
  const tx = (over: Row): Row => ({
    owner_id: A, account_id: ACC, security_id: 's', subtype: null, fees: 0,
    ticker: null, sec_type: 'derivative', option_type: null, option_expiry: null, option_strike: null, option_underlying: null, ...over,
  });
  return {
    pf_accounts: [{ id: ACC, owner_id: A, name: 'Brokerage', kind: 'brokerage', balance: 50000 }],
    pf_investment_txns: [
      tx({ security_id: 'o1', posted_on: '2026-08-01', txn_type: 'sell', name: 'sell 100 WWW puts with strike of $50 for $1.50 each to open - SOLD', quantity: -100, amount: -150, option_type: 'put', option_expiry: '2026-09-18', option_strike: 50, option_underlying: 'WWW' }),
      tx({ security_id: 'o1', posted_on: '2026-09-19', txn_type: 'transfer', name: 'assignment of 1 WWW puts with strike of $50 - OPTIONEXERCISE', quantity: 1, amount: 0, option_type: 'put', option_expiry: '2026-09-18', option_strike: 50, option_underlying: 'WWW' }),
      tx({ security_id: 'o2', posted_on: '2026-09-25', txn_type: 'sell', name: 'sell 100 WWW calls with strike of $52 for $1.20 each to open - SOLD', quantity: -100, amount: -120, option_type: 'call', option_expiry: '2026-10-16', option_strike: 52, option_underlying: 'WWW' }),
      tx({ security_id: 'o2', posted_on: '2026-10-17', txn_type: 'transfer', name: 'assignment of 1 WWW calls with strike of $52 - OPTIONEXERCISE', quantity: 1, amount: 0, option_type: 'call', option_expiry: '2026-10-16', option_strike: 52, option_underlying: 'WWW' }),
      tx({ security_id: 'e1', posted_on: '2026-09-19', txn_type: 'buy', name: 'You bought 100 shares of WWW due to assignment of 1 WWW puts with strike of $50', quantity: 100, amount: 5000, ticker: 'WWW', sec_type: 'equity' }),
      tx({ security_id: 'e1', posted_on: '2026-10-17', txn_type: 'sell', name: 'You sold 100 shares of WWW due to assignment of 1 WWW calls with strike of $52', quantity: -100, amount: -5200, ticker: 'WWW', sec_type: 'equity' }),
    ],
    pf_holdings: [],
  };
}
