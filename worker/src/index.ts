import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface Env {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
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
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      if (new URL(request.url).pathname !== '/api/me') return json({ error: 'not_found' }, 404);
      return json({ ownerId: member.owner_id, email: member.email, role: member.role });
    } catch (error) {
      return error instanceof AccessError
        ? json({ error: error.code }, error.status)
        : json({ error: 'service_unavailable' }, 503);
    }
  };
}
export default { fetch: createHandler() };
