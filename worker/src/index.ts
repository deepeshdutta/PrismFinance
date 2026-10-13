import { route, HttpError } from './ledger';
import { plaidRoute } from './plaid';
import { memberQuotes } from './quotes';
import { coveredCalls } from './options';
import { pnlSummary, openOptions, optionsHistory, pnlSeries } from './pnl';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface Env {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  PLAID_ENV?: string;
  PLAID_TOKEN_KEY?: string;
  ALPACA_KEY_ID?: string;
  ALPACA_SECRET?: string;
  TRADIER_TOKEN?: string;
  TRADIER_ENV?: string;
}
interface Member {
  owner_id: string;
  email: string;
  role: 'owner' | 'viewer';
  active: boolean;
  access_subject: string | null;
}
interface Dependencies {
  fetch?: typeof fetch;
  key?: JWTVerifyGetKey;
}
class AccessError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const keys = new Map<string, JWTVerifyGetKey>();
function configuration(env: Env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    throw new AccessError(503, 'service_unavailable');
  }
  const issuer = new URL(env.ACCESS_TEAM_DOMAIN);
  const database = new URL(env.SUPABASE_URL);
  if (issuer.protocol !== 'https:' || !issuer.hostname.endsWith('.cloudflareaccess.com') ||
      issuer.pathname !== '/' || issuer.search || issuer.hash || issuer.port || issuer.username || issuer.password ||
      database.protocol !== 'https:' || !database.hostname.endsWith('.supabase.co') ||
      database.pathname !== '/' || database.search || database.hash || database.port || database.username || database.password) {
    throw new AccessError(503, 'service_unavailable');
  }
  return { issuer: issuer.origin, database: database.origin };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  } });
}
export function createHandler(dependencies: Dependencies = {}) {
  return async (request: Request, env: Env): Promise<Response> => {
    try {
      const { issuer, database } = configuration(env);
      const token = request.headers.get('Cf-Access-Jwt-Assertion');
      if (!token || token.length > 16384) throw new AccessError(401, 'authentication_required');
      let key = dependencies.key ?? keys.get(issuer);
      if (!key) {
        key = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
        keys.set(issuer, key);
      }
      let identity;
      try {
        ({ payload: identity } = await jwtVerify(token, key, {
          issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'],
          requiredClaims: ['exp', 'sub', 'email', 'iat'],
        }));
      } catch { throw new AccessError(401, 'authentication_required'); }
      if (typeof identity.email !== 'string' || !identity.email.includes('@') ||
          typeof identity.sub !== 'string' || !identity.sub) {
        throw new AccessError(401, 'authentication_required');
      }
      const email = identity.email.trim().toLowerCase();
      const url = new URL(`${database}/rest/v1/prism_members`);
      url.searchParams.set('select', 'owner_id,email,role,active,access_subject');
      url.searchParams.set('email', `eq.${email}`);
      url.searchParams.set('limit', '2');
      let members: Member[];
      try {
        const response = await (dependencies.fetch ?? fetch)(url, {
          headers: { apikey: env.SUPABASE_SECRET_KEY },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('membership lookup failed');
        members = await response.json() as Member[];
      } catch { throw new AccessError(503, 'service_unavailable'); }
      const member = Array.isArray(members) && members.length === 1 ? members[0] : undefined;
      if (!member?.active || member.email !== email || !member.owner_id ||
          !['owner', 'viewer'].includes(member.role) ||
          (member.access_subject !== null && member.access_subject !== identity.sub)) {
        throw new AccessError(403, 'access_denied');
      }
      // Owner identity is resolved exclusively on the server, never from request parameters.
      const path = new URL(request.url).pathname;
      if (path === '/api/me') {
        if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
        return json({ ownerId: member.owner_id, email: member.email, role: member.role });
      }
      if (request.method !== 'GET' && request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new AccessError(403, 'access_denied');
      const ctx = { database, key: env.SUPABASE_SECRET_KEY, ownerId: member.owner_id, role: member.role, fetcher: dependencies.fetch ?? fetch,
        plaid: { clientId: env.PLAID_CLIENT_ID ?? '', secret: env.PLAID_SECRET ?? '', env: env.PLAID_ENV || 'sandbox', tokenKey: env.PLAID_TOKEN_KEY ?? '' },
        market: { keyId: env.ALPACA_KEY_ID ?? '', secret: env.ALPACA_SECRET ?? '', tradierToken: env.TRADIER_TOKEN ?? '', tradierEnv: env.TRADIER_ENV || 'production' } };
      if (path === '/api/ticker') { if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405); return json(await memberQuotes(ctx, ctx.market)); }
      if (path === '/api/options/calls') { if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405); return json(await coveredCalls(ctx, ctx.market, new URL(request.url))); }
      if (path === '/api/pnl') { if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405); return json(await pnlSummary(ctx, new URL(request.url))); }
      if (path === '/api/pnl/series') { if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405); return json(await pnlSeries(ctx, new URL(request.url))); }
      if (path === '/api/options/open') { if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405); return json(await openOptions(ctx, new URL(request.url))); }
      if (path === '/api/options/history') { if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405); return json(await optionsHistory(ctx, new URL(request.url))); }
      const result = path === '/api/plaid' || path.startsWith('/api/plaid/') ? await plaidRoute(request, ctx) : await route(request, ctx);
      return json(result);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.code }, error.status);
      return error instanceof AccessError
        ? json({ error: error.code }, error.status)
        : json({ error: 'service_unavailable' }, 503);
    }
  };
}
export default { fetch: createHandler() };
