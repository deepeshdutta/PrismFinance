import handler, { type Env } from './index';
import { publicQuotes } from './quotes';

interface SiteEnv extends Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}
const BASE = '/PrismFinance';

export default {
  async fetch(request: Request, env: SiteEnv): Promise<Response> {
    const url = new URL(request.url);
    // Public, logged-out market page. Generic prices only: no cookies, no member data, no database access.
    if (url.pathname === '/public/quotes' && request.method === 'GET') {
      try {
        const body = await publicQuotes({ keyId: env.ALPACA_KEY_ID ?? '', secret: env.ALPACA_SECRET ?? '' }, fetch);
        return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=15', 'X-Content-Type-Options': 'nosniff' } });
      } catch { return new Response(JSON.stringify({ error: 'market_data_unavailable' }), { status: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
    }
    if (url.pathname === '/public/markets' || url.pathname === '/public/markets/') {
      let res = await env.ASSETS.fetch(new Request(new URL('/markets.html', url), { method: 'GET' }));
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) res = await env.ASSETS.fetch(new Request(new URL(res.headers.get('location')!, url), { method: 'GET' }));
      const h = new Headers(res.headers); h.set('Cache-Control', 'no-cache'); h.set('X-Content-Type-Options', 'nosniff');
      return new Response(res.body, { status: res.status, headers: h });
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handler.fetch(request, env);
    }
    // The built app is served under /PrismFinance/ for GitHub Pages; map it onto the asset root.
    if (url.pathname === '/') return Response.redirect(`${url.origin}${BASE}/`, 302);
    if (url.pathname === BASE) return Response.redirect(`${url.origin}${BASE}/`, 302);
    if (url.pathname.startsWith(`${BASE}/`)) url.pathname = url.pathname.slice(BASE.length);
    return env.ASSETS.fetch(new Request(url, request));
  },
};
