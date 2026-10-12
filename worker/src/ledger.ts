// Private ledger routes. Every query is scoped to the owner resolved from the verified Access login.
export const KINDS = ['checking','savings','credit','brokerage','retirement','loan','property','other'] as const;
const LIABILITY = new Set(['credit', 'loan']);
type Fetcher = typeof fetch;
export class HttpError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Ctx { database: string; key: string; ownerId: string; role: 'owner' | 'viewer'; fetcher: Fetcher; }

async function db(ctx: Ctx, path: string, init: RequestInit = {}, query: Record<string, string> = {}) {
  const url = new URL(`${ctx.database}/rest/v1/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await ctx.fetcher(url, {
    ...init,
    headers: { apikey: ctx.key, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new HttpError(503, 'service_unavailable');
  return res.status === 204 ? [] : await res.json();
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
  throw new HttpError(parts.length >= 2 && ['accounts', 'summary', 'me'].includes(resource ?? '') ? 405 : 404,
    parts.length >= 2 && ['accounts', 'summary'].includes(resource ?? '') ? 'method_not_allowed' : 'not_found');
}
