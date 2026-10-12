// Plaid connectivity. Every query is scoped to the verified owner; access tokens never leave the Worker.
import { HttpError, type Ctx, db } from './ledger';

export interface PlaidConfig { clientId: string; secret: string; env: string; tokenKey: string; }
const BASES: Record<string, string> = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' };

// ---- token encryption (AES-GCM, 256-bit key supplied as a base64 Worker secret) ----
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function key(k: string) {
  const raw = unb64(k);
  if (raw.length !== 32) throw new HttpError(503, 'plaid_not_configured');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(plain: string, k: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(k), new TextEncoder().encode(plain)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}
export async function decrypt(blob: string, k: string): Promise<string> {
  const [v, iv, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !ct) throw new HttpError(503, 'service_unavailable');
  try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await key(k), unb64(ct))); }
  catch { throw new HttpError(503, 'service_unavailable'); }
}

// ---- Plaid API ----
async function call(ctx: Ctx, path: string, payload: Record<string, unknown>) {
  const cfg = ctx.plaid!;
  const base = BASES[cfg.env];
  if (!base) throw new HttpError(503, 'plaid_not_configured');
  const send = ctx.fetcher;
  let res: Response;
  try {
    res = await send(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: cfg.clientId, secret: cfg.secret, ...payload }), signal: AbortSignal.timeout(15000) });
  } catch { throw new HttpError(502, 'plaid_unreachable'); }
  if (!res.ok) throw new HttpError(502, 'plaid_error');
  return res.json() as Promise<any>;
}
function configured(ctx: Ctx) {
  const p = ctx.plaid;
  if (!p || !p.clientId || !p.secret || !p.tokenKey || !BASES[p.env]) throw new HttpError(503, 'plaid_not_configured');
}

// ---- mapping ----
const RETIREMENT = new Set(['401k', '403b', 'ira', 'roth', 'roth 401k', 'sep ira', 'simple ira', 'pension', 'retirement', '529', 'hsa']);
export function mapKind(type: string, subtype: string | null): string {
  const st = (subtype ?? '').toLowerCase();
  if (type === 'depository') return st === 'savings' || st === 'cd' || st === 'money market' ? 'savings' : 'checking';
  if (type === 'credit') return 'credit';
  if (type === 'loan') return 'loan';
  if (type === 'investment') return RETIREMENT.has(st) ? 'retirement' : 'brokerage';
  return 'other';
}
export function mapCategory(t: any): string | null {
  const pfc = t.personal_finance_category;
  const primary: string = pfc?.primary ?? '';
  const detailed: string = pfc?.detailed ?? '';
  if (primary.startsWith('TRANSFER') || detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') return 'Transfer'; // not income or spending
  if (primary === 'INCOME') return 'Income';
  if (!primary) return null;
  return primary.toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 60);
}
const chunk = <T,>(a: T[], n = 400): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const round2 = (n: number) => Math.round(n * 100) / 100;
const owned = (ctx: Ctx) => ({ owner_id: `eq.${ctx.ownerId}` });

// ---- sync one item ----
async function syncItem(ctx: Ctx, item: any) {
  const accessToken = await decrypt(item.access_token_enc, ctx.plaid!.tokenKey);
  let cursor: string | null = item.sync_cursor ?? null;
  const first = cursor;
  let added = 0, modified = 0, removed = 0;
  const accountIds = new Map<string, string>(); // plaid_account_id -> our uuid
  for (let page = 0; page < 30; page++) {
    const data = await call(ctx, '/transactions/sync', { access_token: accessToken, ...(cursor ? { cursor } : {}), count: 500 });
    // accounts (with current balances)
    const accts = (data.accounts ?? []).map((a: any) => {
      const bal = a.balances?.current ?? 0;
      return { owner_id: ctx.ownerId, plaid_item_id: item.id, plaid_account_id: String(a.account_id),
        name: String(a.name ?? 'Account').slice(0, 80) || 'Account', kind: mapKind(String(a.type), a.subtype ?? null),
        institution: (item.institution_name ?? null), currency: /^[A-Z]{3}$/.test(a.balances?.iso_currency_code ?? '') ? a.balances.iso_currency_code : 'USD',
        balance: round2(Number(bal) || 0), updated_at: new Date().toISOString() };
    });
    if (accts.length) {
      const rows = await db(ctx, 'pf_accounts', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(accts) }, { on_conflict: 'owner_id,plaid_account_id' });
      for (const r of rows) accountIds.set(r.plaid_account_id, r.id);
    }
    const toRow = (t: any) => {
      const acct = accountIds.get(String(t.account_id));
      if (!acct || t.pending) return null;
      return { owner_id: ctx.ownerId, account_id: acct, plaid_transaction_id: String(t.transaction_id), posted_on: String(t.date),
        description: String(t.merchant_name || t.name || 'Transaction').trim().slice(0, 200) || 'Transaction',
        amount: round2(-Number(t.amount)), category: mapCategory(t) };
    };
    const upserts = [...(data.added ?? []), ...(data.modified ?? [])].map(toRow).filter((r): r is NonNullable<ReturnType<typeof toRow>> => !!r && r.amount !== 0);
    for (const part of chunk(upserts)) await db(ctx, 'pf_transactions', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(part) }, { on_conflict: 'owner_id,plaid_transaction_id' });
    const gone: string[] = (data.removed ?? []).map((r: any) => String(r.transaction_id));
    for (const part of chunk(gone, 100)) await db(ctx, 'pf_transactions', { method: 'DELETE' }, { ...owned(ctx), plaid_transaction_id: `in.(${part.map((x: string) => `"${x.replace(/"/g, '')}"`).join(',')})` });
    added += (data.added ?? []).length; modified += (data.modified ?? []).length; removed += gone.length;
    cursor = data.next_cursor ?? cursor;
    if (!data.has_more) break;
    if (page === 29) { cursor = first; throw new HttpError(502, 'plaid_error'); }
  }
  await db(ctx, 'pf_plaid_items', { method: 'PATCH', body: JSON.stringify({ sync_cursor: cursor, status: 'ok', last_synced_at: new Date().toISOString() }) }, { id: `eq.${item.id}`, ...owned(ctx) });
  return { added, modified, removed };
}
async function syncAll(ctx: Ctx, only?: string) {
  const items = await db(ctx, 'pf_plaid_items', {}, { select: 'id,plaid_item_id,access_token_enc,institution_name,sync_cursor', ...owned(ctx), ...(only ? { id: `eq.${only}` } : {}) });
  const total = { added: 0, modified: 0, removed: 0, failed: 0 };
  for (const item of items) {
    try { const r = await syncItem(ctx, item); total.added += r.added; total.modified += r.modified; total.removed += r.removed; }
    catch { total.failed++; await db(ctx, 'pf_plaid_items', { method: 'PATCH', body: JSON.stringify({ status: 'error' }) }, { id: `eq.${item.id}`, ...owned(ctx) }).catch(() => {}); }
  }
  return total;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function plaidRoute(request: Request, ctx: Ctx): Promise<unknown> {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean); // ['api','plaid',...]
  const [, , action, id] = parts;
  const m = request.method;
  if (action === 'status' && m === 'GET') {
    const p = ctx.plaid;
    return { configured: !!(p && p.clientId && p.secret && p.tokenKey && BASES[p.env]), environment: p?.env ?? null };
  }
  configured(ctx);
  if (m !== 'GET' && ctx.role !== 'owner') throw new HttpError(403, 'read_only');
  if (action === 'items' && !id && m === 'GET') {
    return { items: await db(ctx, 'pf_plaid_items', {}, { select: 'id,institution_name,status,last_synced_at', ...owned(ctx), order: 'created_at.asc' }) };
  }
  if (action === 'link-token' && m === 'POST') {
    const data = await call(ctx, '/link/token/create', { client_name: 'PrismFinance', language: 'en', country_codes: ['US'],
      user: { client_user_id: ctx.ownerId }, products: ['transactions'], transactions: { days_requested: 730 } });
    return { link_token: data.link_token };
  }
  if (action === 'exchange' && m === 'POST') {
    const text = await request.text();
    if (text.length > 4096) throw new HttpError(413, 'too_large');
    let b: any; try { b = JSON.parse(text); } catch { throw new HttpError(400, 'invalid_body'); }
    if (!b || typeof b.public_token !== 'string' || !/^public-[A-Za-z0-9-]{10,200}$/.test(b.public_token)) throw new HttpError(400, 'invalid_body');
    const institution = typeof b.institution_name === 'string' && b.institution_name.trim() ? b.institution_name.trim().slice(0, 120) : null;
    const ex = await call(ctx, '/item/public_token/exchange', { public_token: b.public_token });
    const row = { owner_id: ctx.ownerId, plaid_item_id: String(ex.item_id), access_token_enc: await encrypt(String(ex.access_token), ctx.plaid!.tokenKey), institution_name: institution };
    const [item] = await db(ctx, 'pf_plaid_items', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(row) }, { on_conflict: 'owner_id,plaid_item_id' });
    // Plaid may need a few seconds before transactions are ready; an early empty sync is fine, the next sync fills in.
    const sync = await syncAll(ctx, item.id);
    return { linked: true, institution, sync };
  }
  if (action === 'sync' && m === 'POST') return { sync: await syncAll(ctx) };
  if (action === 'items' && id && UUID.test(id) && m === 'DELETE') {
    const [item] = await db(ctx, 'pf_plaid_items', {}, { select: 'id,access_token_enc', id: `eq.${id}`, ...owned(ctx), limit: '1' });
    if (!item) throw new HttpError(404, 'not_found');
    try { await call(ctx, '/item/remove', { access_token: await decrypt(item.access_token_enc, ctx.plaid!.tokenKey) }); } catch { /* still remove locally */ }
    await db(ctx, 'pf_plaid_items', { method: 'DELETE' }, { id: `eq.${id}`, ...owned(ctx) });
    return { ok: true };
  }
  throw new HttpError(404, 'not_found');
}
