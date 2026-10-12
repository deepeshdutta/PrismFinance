import handler, { type Env } from './index';

interface SiteEnv extends Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}
const BASE = '/PrismFinance';

export default {
  async fetch(request: Request, env: SiteEnv): Promise<Response> {
    const url = new URL(request.url);
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
