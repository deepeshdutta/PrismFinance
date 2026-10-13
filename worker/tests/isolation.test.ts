import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { createHandler, type Env } from '../src/index';
import { resetQuoteCache } from '../src/quotes';

// Two approved members share one database. Whatever A does, B's rows must never be read, changed or deleted, and vice versa.
const env: Env = { ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com', ACCESS_AUD: 'aud', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'k', PLAID_CLIENT_ID: 'c', PLAID_SECRET: 's', PLAID_ENV: 'sandbox', PLAID_TOKEN_KEY: Buffer.from(new Uint8Array(32)).toString('base64') };
const { privateKey, publicKey } = await generateKeyPair('RS256');
const key = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 't', alg: 'RS256' }] });
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', V = '33333333-3333-4333-8333-333333333333';
const members = [
  { owner_id: A, email: 'a@example.com', role: 'owner', active: true, access_subject: 'sa' },
  { owner_id: B, email: 'b@example.com', role: 'owner', active: true, access_subject: 'sb' },
  { owner_id: V, email: 'v@example.com', role: 'viewer', active: true, access_subject: 'sv' },
];
const ACC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ACC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM_A = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', ITEM_B = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
const TX_A = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', TX_B = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';

type Row = Record<string, any>;
function seed(): Record<string, Row[]> {
  return {
    prism_members: members.map((m) => ({ ...m })),
    pf_accounts: [
      { id: ACC_A, owner_id: A, name: 'A-Brokerage', kind: 'brokerage', balance: 1000, currency: 'USD' },
      { id: ACC_B, owner_id: B, name: 'B-Brokerage', kind: 'brokerage', balance: 999999, currency: 'USD' },
    ],
    pf_transactions: [
      { id: TX_A, owner_id: A, account_id: ACC_A, posted_on: new Date().toISOString().slice(0, 10), description: 'A-coffee', amount: -5, category: 'Food' },
      { id: TX_B, owner_id: B, account_id: ACC_B, posted_on: new Date().toISOString().slice(0, 10), description: 'B-secret', amount: -777, category: 'Food' },
    ],
    pf_holdings: [
      { id: 'h1', owner_id: A, account_id: ACC_A, ticker: 'AAPL', name: 'Apple', sec_type: 'equity', quantity: 250, price: 200, value: 50000 },
      { id: 'h2', owner_id: B, account_id: ACC_B, ticker: 'NVDA', name: 'Nvidia', sec_type: 'equity', quantity: 900, price: 100, value: 90000 },
    ],
    pf_plaid_items: [
      { id: ITEM_A, owner_id: A, institution_name: 'A-Bank', status: 'ok', access_token_enc: 'enc-a' },
      { id: ITEM_B, owner_id: B, institution_name: 'B-Bank', status: 'ok', access_token_enc: 'enc-b' },
    ],
  };
}
// Minimal PostgREST emulation: eq./neq./in./not.is. filters, select, order ignored, limit honoured.
function fakeDb(tables: Record<string, Row[]>, log: { method: string; table: string; q: URLSearchParams }[]) {
  return (async (input: any, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const table = url.pathname.split('/').pop()!;
    const method = (init.method ?? 'GET').toUpperCase();
    log.push({ method, table, q: url.searchParams });
    const rows = tables[table];
    if (!rows) return new Response('[]', { status: 200 });
    const match = (r: Row) => {
      for (const [k, v] of url.searchParams) {
        if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
        if (v.startsWith('eq.')) { if (String(r[k]) !== v.slice(3)) return false; }
        else if (v.startsWith('neq.')) { if (String(r[k]) === v.slice(4)) return false; }
        else if (v.startsWith('not.is.')) { if (r[k] == null) return false; }
        else if (v.startsWith('in.')) { const l = v.slice(4, -1).split(',').map((x) => x.replace(/"/g, '')); if (!l.includes(String(r[k]))) return false; }
        else if (v.startsWith('gte.')) { if (String(r[k]) < v.slice(4)) return false; }
        else if (v.startsWith('lt.')) { if (String(r[k]) >= v.slice(3)) return false; }
      }
      return true;
    };
    if (method === 'GET') {
      const cols = (url.searchParams.get('select') ?? '*').split(',');
      const pick = (r: Row) => cols.includes('*') ? { ...r } : Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]]));
      return new Response(JSON.stringify(rows.filter(match).map(pick)), { status: 200 });
    }
    if (method === 'DELETE') { for (const r of rows.filter(match)) rows.splice(rows.indexOf(r), 1); return new Response(null, { status: 204 }); }
    if (method === 'PATCH') { const hit = rows.filter(match); const p = JSON.parse(String(init.body)); hit.forEach((r) => Object.assign(r, p)); return new Response(JSON.stringify(hit), { status: 200 }); }
    if (method === 'POST') { const b = JSON.parse(String(init.body)); const list = Array.isArray(b) ? b : [b]; list.forEach((r) => rows.push({ id: crypto.randomUUID(), ...r })); return new Response(JSON.stringify(list), { status: 201 }); }
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
}
async function jwt(email: string, sub: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, sub, iss: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, iat: now, exp: now + 600 })
    .setProtectedHeader({ alg: 'RS256', kid: 't' }).sign(privateKey);
}
const tokens = { A: await jwt('a@example.com', 'sa'), B: await jwt('b@example.com', 'sb'), V: await jwt('v@example.com', 'sv') };
function setup() {
  resetQuoteCache();
  const tables = seed(); const log: any[] = [];
  const h = createHandler({ key, fetch: fakeDb(tables, log) });
  const call = async (who: keyof typeof tokens, path: string, init: RequestInit = {}) => {
    const res = await h(new Request(`https://app.example.com${path}`, { ...init, headers: { 'Cf-Access-Jwt-Assertion': tokens[who], 'Content-Type': 'application/json', ...(init.headers ?? {}) } }), env);
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };
  return { tables, log, call };
}

test('each member reads only their own data on every read route', async () => {
  const { call } = setup();
  for (const [who, own, other] of [['A', 'A-', 'B-'], ['B', 'B-', 'A-']] as const) {
    for (const path of ['/api/accounts', '/api/transactions', '/api/holdings', '/api/summary', '/api/cashflow', '/api/plaid/items', '/api/ticker', '/api/options/calls']) {
      const r = await call(who, path);
      assert.equal(r.status, 200, `${who} ${path}`);
      assert.ok(!r.text.includes(other), `${who} saw the other member's data on ${path}`);
      assert.ok(!r.text.includes('enc-'), `${path} must never expose stored Plaid tokens`);
    }
    assert.ok((await call(who, '/api/accounts')).text.includes(own));
  }
  const sa = (await call('A', '/api/summary')).json, sb = (await call('B', '/api/summary')).json;
  assert.equal(sa.netWorth, 1000); assert.equal(sb.netWorth, 999999);
  assert.deepEqual((await call('A', '/api/options/calls')).json.eligible.map((e: any) => e.ticker), ['AAPL']);
  assert.deepEqual((await call('B', '/api/options/calls')).json.eligible.map((e: any) => e.ticker), ['NVDA']);
});

test("A cannot change or delete B's rows by guessing ids", async () => {
  const { call, tables } = setup();
  const patch = await call('A', `/api/accounts/${ACC_B}`, { method: 'PATCH', body: JSON.stringify({ balance: 1, name: 'pwned' }) });
  assert.equal(patch.status, 404);
  await call('A', `/api/accounts/${ACC_B}`, { method: 'DELETE' });
  await call('A', `/api/transactions/${TX_B}`, { method: 'DELETE' });
  assert.equal(tables.pf_accounts.find((r) => r.id === ACC_B)?.balance, 999999);
  assert.equal(tables.pf_accounts.find((r) => r.id === ACC_B)?.name, 'B-Brokerage');
  assert.ok(tables.pf_transactions.some((r) => r.id === TX_B));
  await call('A', `/api/plaid/items/${ITEM_B}`, { method: 'DELETE' });
  assert.ok(tables.pf_plaid_items.some((r) => r.id === ITEM_B), "B's bank link must survive");
});

test("A cannot attach a transaction to B's account", async () => {
  const { call, tables } = setup();
  const before = tables.pf_transactions.length;
  const r = await call('A', '/api/transactions', { method: 'POST', body: JSON.stringify({ account_id: ACC_B, posted_on: '2026-10-01', description: 'x', amount: -1 }) });
  assert.equal(r.status, 404); assert.equal(tables.pf_transactions.length, before);
});

test('created rows are stamped with the server-resolved owner, ignoring any owner in the body', async () => {
  const { call, tables } = setup();
  const r = await call('A', '/api/accounts', { method: 'POST', body: JSON.stringify({ name: 'New', kind: 'savings', balance: 5, owner_id: B }) });
  assert.equal(r.status, 200);
  assert.equal(r.json.account.owner_id, A);
  assert.ok(!(await call('B', '/api/accounts')).text.includes('"New"'));
  assert.equal(tables.pf_accounts.filter((x) => x.owner_id === B).length, 1);
});

test('spoofed owner parameters and headers are ignored', async () => {
  const { call } = setup();
  for (const path of [`/api/accounts?owner_id=eq.${B}`, `/api/accounts?owner_id=${B}`, `/api/holdings?ownerId=${B}`, `/api/transactions?owner_id=${B}&limit=500`]) {
    const r = await call('A', path, { headers: { 'X-Owner-Id': B, 'X-Forwarded-Email': 'b@example.com', 'Cf-Access-Authenticated-User-Email': 'b@example.com' } });
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes('B-') && !r.text.includes('999999') && !r.text.includes('NVDA'), path);
  }
  const me = await call('A', '/api/me', { headers: { 'X-Owner-Id': B } });
  assert.equal(me.json.ownerId, A);
});

test('every database read for member data is scoped to the caller', async () => {
  const { call, log } = setup();
  for (const who of ['A', 'B'] as const) {
    log.length = 0;
    for (const path of ['/api/accounts', '/api/transactions', '/api/holdings', '/api/summary', '/api/cashflow', '/api/plaid/items', '/api/ticker', '/api/options/calls']) await call(who, path);
    const want = `eq.${who === 'A' ? A : B}`;
    const data = log.filter((l) => l.table !== 'prism_members');
    assert.ok(data.length > 0);
    for (const l of data) assert.equal(l.q.get('owner_id'), want, `${who}: ${l.method} ${l.table} was not owner-scoped`);
  }
});

test('viewers can read their own data but cannot write anything', async () => {
  const { call, tables } = setup();
  assert.equal((await call('V', '/api/accounts')).status, 200);
  const snapshot = JSON.stringify(tables);
  for (const [m, p, b] of [['POST', '/api/accounts', { name: 'x', kind: 'other' }], ['PATCH', `/api/accounts/${ACC_A}`, { balance: 1 }], ['DELETE', `/api/accounts/${ACC_A}`, null], ['DELETE', `/api/transactions/${TX_A}`, null]] as const) {
    const r = await call('V', p, { method: m, body: b ? JSON.stringify(b) : undefined });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  assert.equal(JSON.stringify(tables), snapshot);
});

test('a revoked member is cut off on their very next request, and others are unaffected', async () => {
  const { call, tables } = setup();
  assert.equal((await call('B', '/api/accounts')).status, 200);
  tables.prism_members.find((m) => m.owner_id === B)!.active = false;
  assert.equal((await call('B', '/api/accounts')).status, 403);
  assert.equal((await call('A', '/api/accounts')).status, 200);
});

test('cross-site writes are refused', async () => {
  const { call, tables } = setup();
  const before = tables.pf_accounts.length;
  const r = await call('A', '/api/accounts', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify({ name: 'csrf', kind: 'other' }) });
  assert.equal(r.status, 403); assert.equal(tables.pf_accounts.length, before);
});

test('static audit: every query on a member table in the Worker source carries an owner scope', async () => {
  const dir = new URL('../src/', import.meta.url);
  const memberTables = /'(pf_accounts|pf_transactions|pf_holdings|pf_plaid_items)'/;
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.ts')) continue;
    const lines = (await readFile(new URL(f, dir), 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (!/\bdb\(ctx,/.test(line) || !memberTables.test(line)) return;
      const insertOk = /method: 'POST'/.test(line) && lines.slice(Math.max(0, i - 10), i).some((l) => /owner_id: ctx\.ownerId/.test(l));
      const scoped = /,\s*(scope|q)\)/.test(line) && lines.slice(Math.max(0, i - 6), i).some((l) => /const (scope|q)\b.*\.\.\.owned\(ctx\)/.test(l));
      const ok = insertOk || scoped || /owned\(ctx\)|owner_id: `eq\.\$\{ctx\.ownerId\}`|owner_id: ctx\.ownerId|on_conflict: 'owner_id,/.test(line);
      assert.ok(ok, `${f}:${i + 1} queries a member table without an owner scope: ${line.trim().slice(0, 120)}`);
    });
  }
});
