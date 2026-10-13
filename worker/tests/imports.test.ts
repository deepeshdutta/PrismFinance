import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { transactionFingerprint, normalizeDescription, route } from '../src/ledger';
import { plaidRoute } from '../src/plaid';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ACC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const plaid = { clientId: 'cid', secret: 'sec', env: 'sandbox', tokenKey: KEY };
const req = (m: string, p: string, b?: unknown) => new Request('https://x.dev' + p, { method: m, body: b === undefined ? undefined : JSON.stringify(b) });

// ---------- fingerprint unit tests ----------
test('fingerprint is stable and deterministic', () => {
  const a = transactionFingerprint(A, ACC, '2026-10-01', 'Coffee', -4.5);
  const b = transactionFingerprint(A, ACC, '2026-10-01', 'Coffee', -4.5);
  assert.equal(a, b); assert.match(a, /^[0-9a-f]{16}$/);
});
test('normalization: case, punctuation, and whitespace do not change the fingerprint', () => {
  assert.equal(normalizeDescription('  Starbucks #123! '), 'starbucks 123');
  assert.equal(normalizeDescription('STARBUCKS   123'), 'starbucks 123');
  assert.equal(normalizeDescription('Café — Münchën!!'), 'café münchën');
  const f = (d: string) => transactionFingerprint(A, ACC, '2026-10-01', d, -4.5);
  assert.equal(f('  Starbucks #123! '), f('starbucks 123'));
});
test('fingerprint is sensitive to amount, date, account, and owner', () => {
  const base = (o: string, a: string, d: string, amt: number) => transactionFingerprint(o, a, d, 'Coffee', amt);
  const b = base(A, ACC, '2026-10-01', -4.5);
  assert.notEqual(b, base(A, ACC, '2026-10-01', -4.51));
  assert.notEqual(b, base(A, ACC, '2026-10-02', -4.5));
  assert.notEqual(b, base(A, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-10-01', -4.5));
  assert.notEqual(b, base(B, ACC, '2026-10-01', -4.5));
  assert.equal(b, base(A, ACC, '2026-10-01', -4.50)); // cents, not float repr
});

// ---------- in-memory PostgREST fake ----------
function fakeDb(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = { pf_accounts: [], pf_transactions: [], pf_import_batches: [], pf_plaid_items: [], ...seed };
  const urls: string[] = [];
  const match = (r: any, q: URLSearchParams) => {
    for (const [k, v] of q) {
      if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
      if (v.startsWith('eq.')) { if (String(r[k]) !== v.slice(3)) return false; }
      else if (v.startsWith('in.')) { const l = v.slice(4, -1).split(',').map((x) => x.replace(/"/g, '')); if (!l.includes(String(r[k]))) return false; }
      // unknown operators: do not filter
    }
    return true;
  };
  const fetcher = (async (u: any, init: RequestInit = {}) => {
    const url = new URL(String(u)); urls.push(url.toString());
    const table = url.pathname.split('/').pop()!;
    const method = (init.method ?? 'GET').toUpperCase();
    const rows = tables[table] ?? [];
    if (method === 'GET') return new Response(JSON.stringify(rows.filter((r) => match(r, url.searchParams))), { status: 200 });
    if (method === 'POST') {
      const b = JSON.parse(String(init.body)); const list = Array.isArray(b) ? b : [b];
      const out = list.map((r) => ({ id: crypto.randomUUID(), ...r })); rows.push(...out); tables[table] = rows;
      return new Response(JSON.stringify(out), { status: 201 });
    }
    if (method === 'PATCH') {
      const hit = rows.filter((r) => match(r, url.searchParams)); const p = JSON.parse(String(init.body));
      hit.forEach((r) => Object.assign(r, p)); return new Response(JSON.stringify(hit), { status: 200 });
    }
    if (method === 'DELETE') { for (const r of rows.filter((x) => match(x, url.searchParams))) rows.splice(rows.indexOf(r), 1); return new Response(null, { status: 204 }); }
    return new Response('[]', { status: 200 });
  }) as any;
  return { tables, urls, fetcher };
}
const ctxFor = (ownerId: string, fetcher: any, role: 'owner' | 'viewer' = 'owner') =>
  ({ database: 'https://x.supabase.co', key: 'k', ownerId, role, fetcher });
const txBody = { account_id: ACC, posted_on: '2026-10-01', description: 'Coffee', amount: -4.5 };

// ---------- POST /api/transactions dedup ----------
test('reposting the same transaction returns the existing row and inserts nothing', async () => {
  const { tables, fetcher } = fakeDb({ pf_accounts: [{ id: ACC, owner_id: A, name: 'Chk', kind: 'checking' }] });
  const ctx = ctxFor(A, fetcher);
  const first: any = await route(req('POST', '/api/transactions', txBody), ctx);
  assert.ok(first.transaction.id); assert.equal(first.duplicate, undefined);
  const second: any = await route(req('POST', '/api/transactions', { ...txBody, description: '  COFFEE!! ' }), ctx);
  assert.equal(second.transaction.id, first.transaction.id); assert.equal(second.duplicate, true);
  assert.equal(tables.pf_transactions.length, 1);
  assert.ok(tables.pf_transactions[0].fingerprint);
  assert.equal(tables.pf_transactions[0].batch_id, tables.pf_import_batches[0].id);
  assert.deepEqual([tables.pf_import_batches[0].source, tables.pf_import_batches[0].added_count, tables.pf_import_batches[0].skipped_count], ['api', 1, 0]);
  assert.ok(tables.pf_import_batches[0].finished_at);
});
test('near-duplicates with different amounts are kept', async () => {
  const { tables, fetcher } = fakeDb({ pf_accounts: [{ id: ACC, owner_id: A, name: 'Chk', kind: 'checking' }] });
  const ctx = ctxFor(A, fetcher);
  await route(req('POST', '/api/transactions', txBody), ctx);
  await route(req('POST', '/api/transactions', { ...txBody, amount: -4.6 }), ctx);
  assert.equal(tables.pf_transactions.length, 2);
  assert.equal(tables.pf_import_batches.length, 2);
});
test('dedup is owner-scoped: identical details under another owner do not collide', async () => {
  const { tables, urls, fetcher } = fakeDb({ pf_accounts: [{ id: ACC, owner_id: A, name: 'Chk', kind: 'checking' }] });
  // B already holds the "same" coffee; A's post must still insert (owner is in the fingerprint).
  tables.pf_transactions.push({ id: 'b-tx', owner_id: B, account_id: ACC, posted_on: '2026-10-01', description: 'Coffee', amount: -4.5,
    fingerprint: transactionFingerprint(B, ACC, '2026-10-01', 'Coffee', -4.5) });
  const out: any = await route(req('POST', '/api/transactions', txBody), ctxFor(A, fetcher));
  assert.equal(out.duplicate, undefined);
  assert.equal(tables.pf_transactions.filter((t) => t.owner_id === A).length, 1);
  const dedupCall = urls.find((u) => u.includes('pf_transactions') && u.includes('fingerprint=eq.'))!;
  assert.ok(dedupCall.includes(`owner_id=eq.${A}`), 'dedup lookup carries the owner scope');
});

// ---------- GET /api/health ----------
test('health reports per-item status, staleness, and disconnected flags, owner-scoped', async () => {
  const now = Date.now();
  const iso = (ms: number) => new Date(now - ms).toISOString();
  const { fetcher } = fakeDb({ pf_plaid_items: [
    { id: 'i1', owner_id: A, institution_name: 'Fresh', status: 'ok', last_synced_at: iso(3600e3) },
    { id: 'i2', owner_id: A, institution_name: 'Old', status: 'ok', last_synced_at: iso(30 * 3600e3) },
    { id: 'i3', owner_id: A, institution_name: 'Never', status: 'error', last_synced_at: null },
    { id: 'i4', owner_id: A, institution_name: 'Dead', status: 'disconnected', last_synced_at: iso(100 * 3600e3) },
    { id: 'i5', owner_id: B, institution_name: 'Other', status: 'ok', last_synced_at: iso(0) },
  ] });
  const out: any = await route(req('GET', '/api/health'), ctxFor(A, fetcher));
  assert.equal(out.items.length, 4);
  const by = Object.fromEntries(out.items.map((i: any) => [i.institution_name, i]));
  assert.deepEqual([by.Fresh.stale, by.Fresh.disconnected], [false, false]);
  assert.equal(by.Fresh.last_sync_at, iso(3600e3));
  assert.deepEqual([by.Old.stale, by.Old.disconnected], [true, false]);
  assert.deepEqual([by.Never.stale, by.Never.disconnected], [true, false]);
  assert.equal(by.Never.last_sync_at, null);
  assert.deepEqual([by.Dead.stale, by.Dead.disconnected], [true, true]);
  assert.ok(out.checked_at);
});

// ---------- Plaid sync dedup + batches ----------
function syncWorld() {
  const { tables, fetcher: dbFetch } = fakeDb();
  const log: string[] = [];
  const fetcher = (async (u: any, init: RequestInit = {}) => {
    const url = String(u); log.push(url);
    if (url.includes('plaid.com/transactions/sync')) return new Response(JSON.stringify({
      accounts: [{ account_id: 'pa1', name: 'Plaid Checking', type: 'depository', subtype: 'checking', balances: { current: 110, iso_currency_code: 'USD' } }],
      added: [
        { transaction_id: 't1', account_id: 'pa1', date: '2026-10-01', amount: 4.5, name: 'Coffee', personal_finance_category: { primary: 'FOOD_AND_DRINK' } },
        { transaction_id: 't2', account_id: 'pa1', date: '2026-10-02', amount: -5000, name: 'Payroll', personal_finance_category: { primary: 'INCOME' } },
      ],
      modified: [], removed: [], next_cursor: 'c1', has_more: false }), { status: 200 });
    if (url.includes('plaid.com/investments/holdings/get')) return new Response(JSON.stringify({ accounts: [], securities: [], holdings: [] }), { status: 200 });
    if (url.includes('plaid.com/item/public_token/exchange')) return new Response(JSON.stringify({ access_token: 'access-x', item_id: 'pi1' }), { status: 200 });
    if (url.includes('plaid.com/item/remove')) return new Response('{}', { status: 200 });
    return dbFetch(u, init);
  }) as any;
  return { tables, log, ctx: { database: 'https://x.supabase.co', key: 'k', ownerId: A, role: 'owner' as const, fetcher, plaid } };
}
test('repeat plaid syncs skip known provider ids and record batch counts', async () => {
  const w = syncWorld();
  const first: any = await plaidRoute(req('POST', '/api/plaid/exchange', { public_token: 'public-sandbox-1234567890', institution_name: 'Bank' }), w.ctx);
  assert.equal(first.sync.added, 2);
  assert.equal(w.tables.pf_transactions.length, 2);
  for (const t of w.tables.pf_transactions) {
    assert.ok(t.provider_transaction_id); assert.ok(t.fingerprint); assert.ok(t.batch_id);
  }
  const second: any = await plaidRoute(req('POST', '/api/plaid/sync'), w.ctx);
  assert.equal(second.sync.added, 2); // Plaid-reported count is unchanged
  assert.equal(second.sync.inserted, 0);
  assert.equal(second.sync.skipped, 2);
  assert.equal(w.tables.pf_transactions.length, 2); // nothing duplicated
  const batches = w.tables.pf_import_batches;
  assert.equal(batches.length, 2);
  assert.deepEqual([batches[0].source, batches[0].added_count, batches[0].skipped_count], ['plaid', 2, 0]);
  assert.deepEqual([batches[1].source, batches[1].added_count, batches[1].skipped_count], ['plaid', 0, 2]);
  for (const b of batches) { assert.equal(b.owner_id, A); assert.ok(b.finished_at); assert.equal(b.error, null); }
});
test('plaid ITEM errors mark the item disconnected instead of a generic error', async () => {
  const w = syncWorld();
  const { encrypt } = await import('../src/plaid');
  w.tables.pf_plaid_items.push({ id: 'itm-dead', owner_id: A, plaid_item_id: 'pi-dead', access_token_enc: await encrypt('access-x', KEY), institution_name: 'Dead Bank', sync_cursor: null });
  const inner = w.ctx.fetcher;
  w.ctx.fetcher = (async (u: any, init: RequestInit = {}) => {
    if (String(u).includes('plaid.com/transactions/sync')) return new Response(JSON.stringify({ error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login required' }), { status: 400 });
    return inner(u, init);
  }) as any;
  const out: any = await plaidRoute(req('POST', '/api/plaid/sync'), w.ctx);
  assert.equal(out.sync.failed, 1);
  const item = w.tables.pf_plaid_items.find((i: any) => i.id === 'itm-dead');
  assert.equal(item.status, 'disconnected');
  const batch = w.tables.pf_import_batches.at(-1);
  assert.ok(batch.error.includes('1 item(s) failed'));
});

// ---------- SQL migration ----------
test('imports SQL: batches private, provenance columns, widened status, idempotent', async () => {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  for (const f of ['members', 'ledger', 'holdings', 'plaid', 'imports']) {
    const sql = await readFile(new URL(`../../supabase/${f}.sql`, import.meta.url), 'utf8');
    await db.exec(sql); await db.exec(sql);
  }
  for (const role of ['anon', 'authenticated']) for (const p of ['SELECT', 'INSERT'])
    assert.equal((await db.query<any>(`select has_table_privilege('${role}','pf_import_batches','${p}') as a`)).rows[0].a, false);
  for (const t of ['pf_transactions', 'pf_holdings']) {
    const cols = (await db.query<any>(`select column_name from information_schema.columns where table_name='${t}'`)).rows.map((r) => r.column_name);
    for (const c of ['provider_transaction_id', 'fingerprint', 'batch_id']) assert.ok(cols.includes(c), `${t}.${c}`);
  }
  const o = (await db.query<any>('select owner_id from prism_members limit 1')).rows[0].owner_id;
  await db.exec(`insert into pf_plaid_items(owner_id, plaid_item_id, access_token_enc, status) values ('${o}','p1','e','disconnected')`);
  await assert.rejects(db.exec(`insert into pf_plaid_items(owner_id, plaid_item_id, access_token_enc, status) values ('${o}','p2','e','bogus')`));
  await assert.rejects(db.exec(`insert into pf_import_batches(owner_id, source) values ('${o}','bogus')`));
  const acct = (await db.query<any>(`insert into pf_accounts(owner_id,name,kind) values ('${o}','a','checking') returning id`)).rows[0].id;
  const batch = (await db.query<any>(`insert into pf_import_batches(owner_id, source) values ('${o}','plaid') returning id`)).rows[0].id;
  await db.exec(`insert into pf_transactions(owner_id, account_id, posted_on, description, amount, fingerprint, batch_id) values ('${o}','${acct}','2026-10-01','x',-1,'fp1','${batch}')`);
  await assert.rejects(db.exec(`insert into pf_transactions(owner_id, account_id, posted_on, description, amount, batch_id) values ('${o}','${acct}','2026-10-01','x',-1,'00000000-0000-4000-8000-000000000000')`));
  await db.exec(`delete from pf_import_batches where id='${batch}'`);
  assert.equal((await db.query<any>(`select batch_id from pf_transactions where fingerprint='fp1'`)).rows[0].batch_id, null);
});
