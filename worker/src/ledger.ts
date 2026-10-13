// Private ledger routes. Every query is scoped to the owner resolved from the verified Access login.
export const KINDS = ['checking','savings','credit','brokerage','retirement','loan','property','other'] as const;
const LIABILITY = new Set(['credit', 'loan']);
type Fetcher = typeof fetch;
export class HttpError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Ctx { database: string; key: string; ownerId: string; role: 'owner' | 'viewer'; fetcher: Fetcher; plaid?: import('./plaid').PlaidConfig; market?: import('./quotes').MarketConfig; }

export async function db(ctx: Ctx, path: string, init: RequestInit = {}, query: Record<string, string> = {}) {
  const url = new URL(`${ctx.database}/rest/v1/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const send = ctx.fetcher; // call detached: Workers throw "Illegal invocation" if fetch is invoked as a method
  const res = await send(url, {
    ...init,
    headers: { apikey: ctx.key, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new HttpError(503, 'service_unavailable');
  if (res.status === 204) return [];
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}
async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 8192) throw new HttpError(413, 'too_large');
  try { const v = JSON.parse(text); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* fallthrough */ }
  throw new HttpError(400, 'invalid_body');
}
function text(v: unknown, max: number, required = true): string | null {
  if (v == null || v === '') { if (required) throw new HttpError(400, 'invalid_body'); return null; }
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) throw new HttpError(400, 'invalid_body');
  return v.trim();
}
function money(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e12) throw new HttpError(400, 'invalid_body');
  return Math.round(v * 100) / 100;
}
function requireWriter(ctx: Ctx) { if (ctx.role !== 'owner') throw new HttpError(403, 'read_only'); }
const owned = (ctx: Ctx) => ({ owner_id: `eq.${ctx.ownerId}` });

// ---- import provenance: stable fingerprints for dedup (ING-03) ----
export function normalizeDescription(d: string): string {
  return d.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
/** Stable dedup fingerprint: owner + account + date + normalized description + amount in cents. */
export function transactionFingerprint(ownerId: string, accountId: string, postedOn: string, description: string, amount: number): string {
  return cyrb53([ownerId, accountId, postedOn, normalizeDescription(description), String(Math.round(amount * 100))].join('|'));
}

// ---- import batches (ING-03 provenance, ING-04 quality) ----
export type ImportSource = 'plaid' | 'api' | 'manual';
export async function startImportBatch(ctx: Ctx, source: ImportSource): Promise<string> {
  const rows = await db(ctx, 'pf_import_batches', { method: 'POST',
    body: JSON.stringify({ owner_id: ctx.ownerId, source, started_at: new Date().toISOString() }) });
  return rows[0]?.id ?? crypto.randomUUID();
}
export async function finishImportBatch(ctx: Ctx, batchId: string, added: number, skipped: number, error: string | null): Promise<void> {
  await db(ctx, 'pf_import_batches', { method: 'PATCH',
    body: JSON.stringify({ finished_at: new Date().toISOString(), added_count: added, skipped_count: skipped, error }) },
    { id: `eq.${batchId}`, ...owned(ctx) });
}
const inList = (ids: string[]) => `in.(${ids.map((x) => `"${x.replace(/"/g, '')}"`).join(',')})`;
/** Provider ids (e.g. Plaid transaction ids) already stored for this owner. Chunked for large syncs. */
export async function existingProviderIds(ctx: Ctx, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    if (!part.length) continue;
    const rows = await db(ctx, 'pf_transactions', {}, { select: 'provider_transaction_id', ...owned(ctx), provider_transaction_id: inList(part) });
    for (const r of rows) if (r.provider_transaction_id != null) found.add(String(r.provider_transaction_id));
  }
  return found;
}

export async function route(request: Request, ctx: Ctx): Promise<unknown> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, resource, id] = parts;
  const m = request.method;

  if (resource === 'summary' && parts.length === 2) {
    if (m !== 'GET') throw new HttpError(405, 'method_not_allowed');
    const accounts = await db(ctx, 'pf_accounts', {}, { select: 'kind,balance,currency', ...owned(ctx) });
    let assets = 0, liabilities = 0;
    for (const a of accounts) {
      const b = Number(a.balance);
      if (LIABILITY.has(a.kind)) liabilities += Math.abs(b); else assets += b;
    }
    const r = (n: number) => Math.round(n * 100) / 100;
    return { accounts: accounts.length, assets: r(assets), liabilities: r(liabilities), netWorth: r(assets - liabilities) };
  }
  if (resource === 'accounts') {
    if (parts.length === 2 && m === 'GET') {
      return { accounts: await db(ctx, 'pf_accounts', {}, { select: 'id,name,kind,institution,currency,balance,updated_at', ...owned(ctx), order: 'created_at.asc', limit: '500' }) };
    }
    if (parts.length === 2 && m === 'POST') {
      requireWriter(ctx);
      const b = await body(request);
      const kind = text(b.kind, 20)!;
      if (!(KINDS as readonly string[]).includes(kind)) throw new HttpError(400, 'invalid_body');
      const currency = b.currency == null ? 'USD' : text(b.currency, 3)!;
      if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, 'invalid_body');
      const row = { owner_id: ctx.ownerId, name: text(b.name, 80), kind, institution: text(b.institution, 80, false), currency, balance: money(b.balance ?? 0) };
      const [created] = await db(ctx, 'pf_accounts', { method: 'POST', body: JSON.stringify(row) });
      return { account: created };
    }
    if (parts.length === 3 && id && UUID.test(id) && (m === 'PATCH' || m === 'DELETE')) {
      requireWriter(ctx);
      const scope = { id: `eq.${id}`, ...owned(ctx) };
      if (m === 'DELETE') { await db(ctx, 'pf_accounts', { method: 'DELETE' }, scope); return { ok: true }; }
      const b = await body(request);
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (b.balance !== undefined) patch.balance = money(b.balance);
      if (b.name !== undefined) patch.name = text(b.name, 80);
      const rows = await db(ctx, 'pf_accounts', { method: 'PATCH', body: JSON.stringify(patch) }, scope);
      if (!rows.length) throw new HttpError(404, 'not_found');
      return { account: rows[0] };
    }
  }
  if (resource === 'transactions') {
    if (parts.length === 2 && m === 'GET') {
      const q: Record<string, string> = { select: 'id,account_id,posted_on,description,amount,category', ...owned(ctx), order: 'posted_on.desc,created_at.desc', limit: '500' };
      const lim = Number(url.searchParams.get('limit')); if (Number.isInteger(lim) && lim > 0 && lim <= 500) q.limit = String(lim);
      return { transactions: await db(ctx, 'pf_transactions', {}, q) };
    }
    if (parts.length === 2 && m === 'POST') {
      requireWriter(ctx);
      const b = await body(request);
      const accountId = text(b.account_id, 36)!;
      if (!UUID.test(accountId)) throw new HttpError(400, 'invalid_body');
      const date = text(b.posted_on, 10)!;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new HttpError(400, 'invalid_body');
      const amount = money(b.amount);
      if (amount === 0) throw new HttpError(400, 'invalid_body');
      const description = text(b.description, 200)!;
      const fingerprint = transactionFingerprint(ctx.ownerId, accountId, date, description, amount);
      const dup = await db(ctx, 'pf_transactions', {}, { select: 'id,account_id,posted_on,description,amount,category', ...owned(ctx), fingerprint: `eq.${fingerprint}`, limit: '1' });
      if (dup.length) return { transaction: dup[0], duplicate: true };
      const batchId = await startImportBatch(ctx, 'api');
      const mine = await db(ctx, 'pf_accounts', {}, { select: 'id', id: `eq.${accountId}`, ...owned(ctx), limit: '1' });
      if (!mine.length) { await finishImportBatch(ctx, batchId, 0, 0, 'account_not_found'); throw new HttpError(404, 'not_found'); }
      const row = { owner_id: ctx.ownerId, account_id: accountId, posted_on: date, description, amount, category: text(b.category, 60, false),
        provider_transaction_id: null, fingerprint, batch_id: batchId };
      const [created] = await db(ctx, 'pf_transactions', { method: 'POST', body: JSON.stringify(row) });
      await finishImportBatch(ctx, batchId, 1, 0, null);
      return { transaction: created };
    }
    if (parts.length === 3 && id && UUID.test(id) && m === 'DELETE') {
      requireWriter(ctx);
      await db(ctx, 'pf_transactions', { method: 'DELETE' }, { id: `eq.${id}`, ...owned(ctx) });
      return { ok: true };
    }
  }
  if (resource === 'holdings' && parts.length === 2) {
    if (m !== 'GET') throw new HttpError(405, 'method_not_allowed');
    const rows = await db(ctx, 'pf_holdings', {}, { select: 'id,account_id,ticker,name,sec_type,quantity,price,value,cost_basis,currency,as_of,updated_at', ...owned(ctx), order: 'value.desc', limit: '2000' });
    let value = 0, cost = 0, costKnown = 0;
    const types: Record<string, number> = {};
    for (const h of rows) { const v = Number(h.value); value += v; const t = String(h.sec_type || 'other'); types[t] = (types[t] ?? 0) + v;
      if (h.cost_basis != null) { cost += Number(h.cost_basis); costKnown += v; } }
    const r = (n: number) => Math.round(n * 100) / 100;
    return { holdings: rows, totals: { value: r(value), costBasis: costKnown ? r(cost) : null, gain: costKnown ? r(costKnown - cost) : null, positions: rows.length },
      allocation: Object.entries(types).map(([type, v]) => ({ type, value: r(v) })).sort((a, b) => b.value - a.value) };
  }
  if (resource === 'cashflow' && parts.length === 2) {
    if (m !== 'GET') throw new HttpError(405, 'method_not_allowed');
    return cashflow(ctx, url);
  }
  if (resource === 'health' && parts.length === 2) {
    if (m !== 'GET') throw new HttpError(405, 'method_not_allowed');
    return syncHealth(ctx);
  }
  throw new HttpError(parts.length >= 2 && ['accounts', 'summary', 'me', 'transactions', 'cashflow', 'holdings', 'health', 'pnl', 'options'].includes(resource ?? '') ? 405 : 404,
    parts.length >= 2 && ['accounts', 'summary', 'transactions', 'cashflow', 'holdings', 'health', 'pnl', 'options'].includes(resource ?? '') ? 'method_not_allowed' : 'not_found');
}

export const TRANSFER = 'transfer';
// ---- sync health per connected item (ING-04). A feed with no successful sync in 24h is stale.
const STALE_AFTER_MS = 24 * 3600 * 1000;
async function syncHealth(ctx: Ctx) {
  const items = await db(ctx, 'pf_plaid_items', {}, { select: 'id,institution_name,status,last_synced_at', ...owned(ctx), order: 'created_at.asc' });
  const now = Date.now();
  return {
    checked_at: new Date(now).toISOString(),
    items: items.map((it: any) => {
      const last = it.last_synced_at ? Date.parse(it.last_synced_at) : NaN;
      return {
        id: it.id,
        institution_name: it.institution_name,
        status: it.status,
        last_sync_at: it.last_synced_at ?? null,
        stale: !Number.isFinite(last) || now - last > STALE_AFTER_MS,
        disconnected: it.status === 'disconnected',
      };
    }),
  };
}
async function cashflow(ctx: Ctx, url: URL) {
  const months = Math.min(Math.max(Number(url.searchParams.get('months')) || 6, 1), 24);
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const rows = await db(ctx, 'pf_transactions', {}, { select: 'posted_on,amount,category', ...owned(ctx), posted_on: `gte.${start.toISOString().slice(0, 10)}`, limit: '10000' });
  const keys: string[] = [];
  for (let i = 0; i < months; i++) keys.push(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1)).toISOString().slice(0, 7));
  const by: Record<string, { income: number; expenses: number }> = Object.fromEntries(keys.map((k) => [k, { income: 0, expenses: 0 }]));
  const daily: Record<string, number> = {};
  const cats: Record<string, number> = {};
  const last = keys[keys.length - 1];
  for (const t of rows) {
    if (String(t.category ?? '').toLowerCase() === TRANSFER) continue; // transfers are neither income nor expense
    const k = String(t.posted_on).slice(0, 7); const a = Number(t.amount);
    if (!by[k]) continue;
    if (a > 0) by[k].income += a; else {
      by[k].expenses += -a;
      if (k === last) { daily[t.posted_on] = (daily[t.posted_on] ?? 0) + -a; const c = t.category || 'Uncategorized'; cats[c] = (cats[c] ?? 0) + -a; }
    }
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    months: keys.map((k) => ({ month: k, income: r(by[k].income), expenses: r(by[k].expenses), net: r(by[k].income - by[k].expenses) })),
    currentMonth: last,
    daily: Object.fromEntries(Object.entries(daily).map(([d, v]) => [d, r(v)])),
    categories: Object.entries(cats).map(([category, amount]) => ({ category, amount: r(amount) })).sort((a, b) => b.amount - a.amount),
  };
}
