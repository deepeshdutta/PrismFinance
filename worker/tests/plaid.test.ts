import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { plaidRoute, encrypt, decrypt, mapKind, mapCategory } from '../src/plaid';

const A = '11111111-1111-4111-8111-111111111111';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const plaid = { clientId: 'cid', secret: 'sec', env: 'sandbox', tokenKey: KEY };
const req = (m: string, p: string, b?: unknown) => new Request('https://x.dev' + p, { method: m, body: b === undefined ? undefined : JSON.stringify(b) });

function world() {
  const log: { url: string; method: string; body: any }[] = [];
  const stored: any = { items: [] };
  const fetcher = (async (u: any, init: RequestInit = {}) => {
    const url = String(u); const body = init.body ? JSON.parse(init.body as string) : undefined; const method = init.method ?? 'GET';
    log.push({ url, method, body });
    const J = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (url.includes('plaid.com/link/token/create')) return J({ link_token: 'link-sandbox-abc' });
    if (url.includes('plaid.com/item/public_token/exchange')) return J({ access_token: 'access-sandbox-SECRET', item_id: 'item1' });
    if (url.includes('plaid.com/item/remove')) return J({});
    if (url.includes('plaid.com/transactions/sync')) return J({ accounts: [{ account_id: 'pa1', name: 'Plaid Checking', type: 'depository', subtype: 'checking', balances: { current: 110, iso_currency_code: 'USD' } },
        { account_id: 'pa2', name: 'Card', type: 'credit', subtype: 'credit card', balances: { current: 410 } }],
      added: [{ transaction_id: 't1', account_id: 'pa1', date: '2026-10-01', amount: 4.5, name: 'Coffee', personal_finance_category: { primary: 'FOOD_AND_DRINK' } },
              { transaction_id: 't2', account_id: 'pa1', date: '2026-10-02', amount: -5000, name: 'Payroll', personal_finance_category: { primary: 'INCOME' } },
              { transaction_id: 't3', account_id: 'pa1', date: '2026-10-03', amount: 500, name: 'To savings', personal_finance_category: { primary: 'TRANSFER_OUT' } },
              { transaction_id: 't4', account_id: 'pa1', date: '2026-10-04', amount: 9, name: 'Pending thing', pending: true }],
      modified: [], removed: [{ transaction_id: 'old1' }], next_cursor: 'cur2', has_more: false });
    if (url.includes('/rest/v1/pf_plaid_items') && method === 'POST') { stored.items.push(JSON.parse(init.body as string)); return J([{ id: 'itm-uuid', ...JSON.parse(init.body as string) }]); }
    if (url.includes('/rest/v1/pf_plaid_items') && method === 'GET') return J(stored.items.map((i: any) => ({ id: 'itm-uuid', plaid_item_id: i.plaid_item_id, access_token_enc: i.access_token_enc, institution_name: i.institution_name, sync_cursor: null })));
    if (url.includes('/rest/v1/pf_accounts') && method === 'POST') return J(JSON.parse(init.body as string).map((a: any, i: number) => ({ id: 'acct-' + i, plaid_account_id: a.plaid_account_id })));
    return J([]);
  }) as any;
  return { log, stored, ctx: { database: 'https://x.supabase.co', key: 'k', ownerId: A, role: 'owner' as const, fetcher, plaid } };
}

test('tokens round-trip through AES-GCM and ciphertext never contains the secret', async () => {
  const blob = await encrypt('access-sandbox-SECRET', KEY);
  assert.ok(!blob.includes('SECRET')); assert.ok(blob.startsWith('v1.'));
  assert.equal(await decrypt(blob, KEY), 'access-sandbox-SECRET');
  assert.notEqual(await encrypt('x', KEY), await encrypt('x', KEY));
  const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
  await assert.rejects(decrypt(blob, other));
  await assert.rejects(encrypt('x', btoa('short')));
});
test('mapping: kinds and categories (transfers are excluded from spending)', () => {
  assert.equal(mapKind('depository', 'savings'), 'savings'); assert.equal(mapKind('depository', 'checking'), 'checking');
  assert.equal(mapKind('credit', null), 'credit'); assert.equal(mapKind('loan', 'mortgage'), 'loan');
  assert.equal(mapKind('investment', 'roth'), 'retirement'); assert.equal(mapKind('investment', 'brokerage'), 'brokerage');
  assert.equal(mapCategory({ personal_finance_category: { primary: 'TRANSFER_OUT' } }), 'Transfer');
  assert.equal(mapCategory({ personal_finance_category: { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' } }), 'Transfer');
  assert.equal(mapCategory({ personal_finance_category: { primary: 'FOOD_AND_DRINK' } }), 'Food And Drink');
  assert.equal(mapCategory({ personal_finance_category: { primary: 'INCOME' } }), 'Income');
});
test('link token is created for the verified owner only', async () => {
  const w = world();
  const out: any = await plaidRoute(req('POST', '/api/plaid/link-token'), w.ctx);
  assert.equal(out.link_token, 'link-sandbox-abc');
  const sent = w.log.find((l) => l.url.includes('link/token/create'))!.body;
  assert.equal(sent.user.client_user_id, A); assert.deepEqual(sent.products, ['transactions']);
});
test('exchange stores an encrypted token, syncs, flips sign, skips pending, and never returns the token', async () => {
  const w = world();
  const out: any = await plaidRoute(req('POST', '/api/plaid/exchange', { public_token: 'public-sandbox-1234567890', institution_name: 'First Platypus' }), w.ctx);
  assert.equal(out.linked, true); assert.equal(out.sync.added, 4); assert.equal(out.sync.removed, 1);
  assert.ok(!JSON.stringify(out).includes('SECRET'));
  const item = w.stored.items[0];
  assert.equal(item.owner_id, A); assert.ok(!item.access_token_enc.includes('SECRET'));
  assert.equal(await decrypt(item.access_token_enc, KEY), 'access-sandbox-SECRET');
  const txPost = w.log.find((l) => l.url.includes('pf_transactions') && l.method === 'POST')!.body;
  assert.equal(txPost.length, 3); // pending skipped
  const by = Object.fromEntries(txPost.map((t: any) => [t.plaid_transaction_id, t]));
  assert.equal(by.t1.amount, -4.5); assert.equal(by.t2.amount, 5000); assert.equal(by.t3.category, 'Transfer');
  for (const t of txPost) assert.equal(t.owner_id, A);
  const acctPost = w.log.find((l) => l.url.includes('pf_accounts') && l.method === 'POST')!.body;
  assert.deepEqual(acctPost.map((a: any) => a.kind), ['checking', 'credit']);
  for (const a of acctPost) assert.equal(a.owner_id, A);
  const del = w.log.find((l) => l.method === 'DELETE' && l.url.includes('pf_transactions'))!;
  assert.ok(del.url.includes(`owner_id=eq.${A}`));
});
test('bad public tokens, viewers, and missing config are rejected before any call', async () => {
  const w = world();
  for (const b of [{}, { public_token: 'nope' }, { public_token: 5 }]) await assert.rejects(plaidRoute(req('POST', '/api/plaid/exchange', b), w.ctx), (e: any) => e.status === 400);
  await assert.rejects(plaidRoute(req('POST', '/api/plaid/sync'), { ...w.ctx, role: 'viewer' as const }), (e: any) => e.status === 403);
  await assert.rejects(plaidRoute(req('POST', '/api/plaid/link-token'), { ...w.ctx, plaid: { ...plaid, secret: '' } }), (e: any) => e.status === 503);
  assert.equal(w.log.length, 0);
  const st: any = await plaidRoute(req('GET', '/api/plaid/status'), { ...w.ctx, plaid: { ...plaid, secret: '' } });
  assert.equal(st.configured, false);
});
test('plaid SQL: private, idempotent, unique per owner', async () => {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  for (const f of ['members', 'ledger']) await db.exec(await readFile(new URL(`../../supabase/${f}.sql`, import.meta.url), 'utf8'));
  const sql = await readFile(new URL('../../supabase/plaid.sql', import.meta.url), 'utf8');
  await db.exec(sql); await db.exec(sql);
  for (const role of ['anon', 'authenticated']) for (const p of ['SELECT', 'INSERT']) assert.equal((await db.query<any>(`select has_table_privilege('${role}','pf_plaid_items','${p}') as a`)).rows[0].a, false);
  const o = (await db.query<any>('select owner_id from prism_members limit 1')).rows[0].owner_id;
  await db.exec(`insert into pf_accounts(owner_id,name,kind,plaid_account_id) values ('${o}','a','checking','p1')`);
  await assert.rejects(db.exec(`insert into pf_accounts(owner_id,name,kind,plaid_account_id) values ('${o}','b','checking','p1')`));
});
