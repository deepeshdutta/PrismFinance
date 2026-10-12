import { test } from 'node:test';
import assert from 'node:assert/strict';
import site from '../src/site';

function setup() {
  const seen: string[] = [];
  const env: any = {
    ASSETS: { fetch: async (r: Request) => { seen.push(new URL(r.url).pathname); return new Response('asset'); } },
    ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', SUPABASE_URL: '', SUPABASE_SECRET_KEY: '',
  };
  return { seen, env, get: (p: string, init?: RequestInit) => site.fetch(new Request('https://x.dev' + p, init), env) };
}

test('root redirects to the app base path', async () => {
  const { get } = setup();
  const res = await get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://x.dev/PrismFinance/');
});
test('static files are served from the asset root', async () => {
  const { get, seen } = setup();
  assert.equal((await get('/PrismFinance/assets/app.js')).status, 200);
  assert.equal(seen.at(-1), '/assets/app.js');
});
test('client routes fall through to the asset handler', async () => {
  const { get, seen } = setup();
  await get('/PrismFinance/books');
  assert.equal(seen.at(-1), '/books');
});
test('api paths never reach static assets and fail closed without a token', async () => {
  const { get, seen } = setup();
  for (const p of ['/api', '/api/me', '/api/anything']) {
    const res = await get(p);
    assert.ok([401, 403, 404, 503].includes(res.status), `${p} -> ${res.status}`);
  }
  assert.equal(seen.length, 0);
});
