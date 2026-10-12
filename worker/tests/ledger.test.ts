import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { route } from '../src/ledger';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
function ctx(ownerId: string, role: 'owner' | 'viewer', calls: URL[] = []) {
  return { database: 'https://x.supabase.co', key: 'k', ownerId, role,
    fetcher: (async (u: URL, init: RequestInit) => { calls.push(u); return new Response(JSON.stringify(init.method === 'POST' ? [{ id: 'n' }] : init.method === 'PATCH' ? [{ id: 'p' }] : [
      { kind: 'checking', balance: '1000.50' }, { kind: 'brokerage', balance: '500' }, { kind: 'credit', balance: '-200.25' }, { kind: 'loan', balance: '300' }]), { status: 200 }); }) as any };
}
const req = (m: string, p: string, b?: unknown) => new Request('https://x.dev' + p, { method: m, body: b === undefined ? undefined : JSON.stringify(b) });

test('every read and write is scoped to the verified owner', async () => {
  const calls: URL[] = [];
  await route(req('GET', '/api/accounts'), ctx(A, 'owner', calls));
  await route(req('GET', '/api/summary'), ctx(A, 'owner', calls));
  await route(req('PATCH', '/api/accounts/' + B, { balance: 5 }), ctx(A, 'owner', calls));
  await route(req('DELETE', '/api/accounts/' + B), ctx(A, 'owner', calls));
  for (const u of calls) assert.equal(u.searchParams.get('owner_id'), `eq.${A}`);
  assert.equal(calls.length, 4);
});
test('owner_id in a request body cannot override the verified owner', async () => {
  let sent: any;
  const c = ctx(A, 'owner');
  const f = c.fetcher; c.fetcher = (async (u: URL, init: RequestInit) => { sent = JSON.parse(init.body as string); return f(u, init); }) as any;
  await route(req('POST', '/api/accounts', { name: 'Chk', kind: 'checking', balance: 10, owner_id: B }), c);
  assert.equal(sent.owner_id, A);
});
test('summary computes net worth with liabilities subtracted', async () => {
  const s: any = await route(req('GET', '/api/summary'), ctx(A, 'owner'));
  assert.deepEqual(s, { accounts: 4, assets: 1500.5, liabilities: 500.25, netWorth: 1000.25 });
});
test('viewers cannot write', async () => {
  for (const r of [req('POST', '/api/accounts', { name: 'x', kind: 'other' }), req('PATCH', '/api/accounts/' + B, { balance: 1 }), req('DELETE', '/api/accounts/' + B)])
    await assert.rejects(route(r, ctx(A, 'viewer')), (e: any) => e.status === 403);
});
test('invalid input is rejected before touching the database', async () => {
  const calls: URL[] = [];
  for (const b of [{}, { name: 'x', kind: 'bogus' }, { name: '', kind: 'other' }, { name: 'x', kind: 'other', balance: 'a' }, { name: 'x', kind: 'other', balance: 1e15 }, { name: 'x', kind: 'other', currency: 'usd' }])
    await assert.rejects(route(req('POST', '/api/accounts', b), ctx(A, 'owner', calls)), (e: any) => e.status === 400);
  await assert.rejects(route(req('PATCH', '/api/accounts/not-a-uuid', {}), ctx(A, 'owner', calls)));
  assert.equal(calls.length, 0);
});
test('unknown routes 404', async () => {
  await assert.rejects(route(req('GET', '/api/nope'), ctx(A, 'owner')), (e: any) => e.status === 404);
});
test('ledger SQL: owner-keyed, cascades, closed to browser roles', async () => {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  await db.exec(await readFile(new URL('../../supabase/members.sql', import.meta.url), 'utf8'));
  const sql = await readFile(new URL('../../supabase/ledger.sql', import.meta.url), 'utf8');
  await db.exec(sql); await db.exec(sql);
  for (const t of ['pf_accounts', 'pf_transactions']) {
    const rls = await db.query<any>(`select relrowsecurity from pg_class where oid='${t}'::regclass`);
    assert.equal(rls.rows[0].relrowsecurity, true);
    for (const role of ['anon', 'authenticated']) for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      const g = await db.query<any>(`select has_table_privilege('${role}','${t}','${p}') as a`);
      assert.equal(g.rows[0].a, false);
    }
  }
  const o = (await db.query<any>("select owner_id from prism_members limit 1")).rows[0].owner_id;
  await assert.rejects(db.exec("insert into pf_accounts(owner_id,name,kind) values (gen_random_uuid(),'x','checking')"));
  await assert.rejects(db.exec(`insert into pf_accounts(owner_id,name,kind) values ('${o}','x','crypto')`));
  await db.exec(`insert into pf_accounts(owner_id,name,kind) values ('${o}','ok','checking')`);
  await db.exec(`delete from prism_members where owner_id='${o}'`);
  assert.equal((await db.query("select 1 from pf_accounts")).rows.length, 0);
});

test('fetch is never invoked with the context object as `this` (Workers: Illegal invocation)', async () => {
  const c: any = ctx(A, 'owner');
  c.fetcher = function (this: unknown) {
    if (this === c) throw new TypeError('Illegal invocation');
    return new Response('[]', { status: 200 });
  };
  await route(req('GET', '/api/accounts'), c);
});
