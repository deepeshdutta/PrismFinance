import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { createHandler, type Env } from '../src/index';

const env: Env = { ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com', ACCESS_AUD: 'test-audience', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'test-only-not-a-secret' };
const { privateKey, publicKey } = await generateKeyPair('RS256');
const key = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' }] });
const member = { owner_id: 'owner-a', email: 'a@example.com', role: 'viewer', active: true, access_subject: 'subject-a' };
async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ email: 'a@example.com', sub: 'subject-a', iss: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+600, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(privateKey);
}
function handler(rows: unknown = [member], status = 200) {
  return createHandler({ key, fetch: async () => new Response(JSON.stringify(rows), { status }) });
}
function request(jwt?: string, path = '/api/me', method = 'GET') {
  return new Request(`https://app.example.com${path}`, { method, headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {} });
}
test('approved identity returns own scope and no-store response', async () => {
  const r = await handler()(request(await token()), env);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ownerId: 'owner-a', email: 'a@example.com', role: 'viewer' });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});
for (const [name, claims] of Object.entries({ expired: { exp: 1 }, issuer: { iss: 'https://other.cloudflareaccess.com' }, audience: { aud: 'other' }, noEmail: { email: undefined }, noExpiry: { exp: undefined }, noSubject: { sub: undefined }, noIssuedAt: { iat: undefined } })) {
  test(`denies ${name} JWT`, async () => assert.equal((await handler()(request(await token(claims)), env)).status, 401));
}
test('denies missing and malformed JWT without member lookup', async () => {
  const h = createHandler({ key, fetch: async () => { throw new Error('must not reach database'); } });
  for (const jwt of [undefined, 'bad.token.signature', 'x'.repeat(17000)]) assert.equal((await h(request(jwt), env)).status, 401);
});
test('denies altered signature and HS256 token', async () => {
  const jwt = await token();
  const parts = jwt.split('.'); parts[1] = Buffer.from(JSON.stringify({ email: 'b@example.com' })).toString('base64url');
  assert.equal((await handler()(request(parts.join('.')), env)).status, 401);
  const hs = await new SignJWT({ email: 'a@example.com' }).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32));
  assert.equal((await handler()(request(hs), env)).status, 401);
});
for (const [name, rows] of Object.entries({ unknown: [], revoked: [{ ...member, active: false }], mismatch: [{ ...member, access_subject: 'someone-else' }], duplicate: [member, member], role: [{ ...member, role: 'superuser' }], wrongEmail: [{ ...member, email: 'b@example.com' }] })) {
  test(`denies ${name} membership`, async () => assert.equal((await handler(rows)(request(await token()), env)).status, 403));
}
test('revocation is checked on every request and lookup uses signed email only', async () => {
  let active = true, calls = 0;
  const h = createHandler({ key, fetch: async (url) => {
    calls++; assert.equal(new URL(String(url)).searchParams.get('email'), 'eq.a@example.com');
    return new Response(JSON.stringify([{ ...member, active }]));
  } });
  const jwt = await token();
  assert.equal((await h(request(jwt, '/api/me?owner_id=owner-b&email=b@example.com'), env)).status, 200);
  active = false;
  assert.equal((await h(request(jwt), env)).status, 403); assert.equal(calls, 2);
});
test('different members resolve to separate owners, including admin', async () => {
  const a = await handler()(request(await token()), env);
  const b = await handler([{ ...member, owner_id: 'owner-b', email: 'b@example.com', access_subject: 'subject-b', role: 'owner' }])(request(await token({ email: 'b@example.com', sub: 'subject-b' })), env);
  assert.notEqual((await a.json() as any).ownerId, (await b.json() as any).ownerId);
});
test('database failures are redacted and closed', async () => {
  const r = await handler({ secret: 'sensitive-database-message' }, 500)(request(await token()), env);
  assert.equal(r.status, 503); assert.equal(await r.text(), '{"error":"service_unavailable"}');
});
test('missing/unsafe configuration fails closed', async () => {
  for (const bad of [{ ACCESS_AUD: '' }, { ACCESS_TEAM_DOMAIN: 'http://test.cloudflareaccess.com' }, { SUPABASE_URL: 'https://attacker.example' }, { ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com/path' }]) {
    assert.equal((await handler()(request(await token()), { ...env, ...bad })).status, 503);
  }
});
test('all routes and methods require auth; no financial or public debug route', async () => {
  for (const path of ['/api/accounts', '/health', '/', '/api/me']) assert.equal((await handler()(request(undefined, path), env)).status, 401);
  assert.equal((await handler()(request(await token(), '/api/accounts'), env)).status, 404);
  assert.equal((await handler()(request(await token(), '/api/me', 'POST'), env)).status, 405);
});
