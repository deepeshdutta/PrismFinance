# PrismFinance — Step 1: private access foundation

Final baseline: BRS v2.0, October 12, 2026, approved by Deepesh Dutta. Every member has separate private financial data. Owner/admin controls membership/configuration, not other members' financial records.

## Built in this increment

- Cloudflare Worker checks signed RS256 Access JWT, issuer, audience, expiration, subject and email.
- Server-only member lookup on **every** request. Inactive/unknown members are denied; provisioned subject mismatches are denied.
- GET `/api/me` returns the caller's server-resolved owner UUID, email and role. Caller-supplied owner/email parameters cannot override identity.
- No financial endpoints, public debug endpoints, browser credential files, or frontend migration yet.
- Additive `supabase/members.sql`: private RLS-enabled registry, no anon/authenticated table privileges, stable owner IDs, role constraints and idempotent owner seed.
- Generic errors and no-store responses. No credentials or account records logged.

## Verify (Node 22 or later)

From `worker/`:

```sh
npm ci
npm test
npm run typecheck
npm run bundle
```

The SQL test uses a disposable in-memory PostgreSQL-compatible PGlite instance, not live Supabase. JWT tests use actual RSA signatures, with local signing keys and mocked member HTTP transport. These tests are not proof of deployed Cloudflare OTP or live Supabase permissions.

## Live activation requirements — not performed

1. GitHub write access must be enabled before pushing reviewed changes. Do not merge the older login-gate PR as a substitute for this architecture.
2. Confirm Cloudflare account access and the intended protected application hostname. This package intentionally uses a distinct undeployed Worker name; it does not replace the existing Worker.
3. Create Cloudflare Access self-hosted application covering the eventual frontend and API; enable email OTP and exact approved-email allow policy. No bypass rules. Set its team-domain issuer and application AUD in Wrangler vars.
4. Review/apply `supabase/members.sql`. This does not apply `allowlist.sql`, change existing financial policies, or migrate existing financial data. Add only approved member emails; bind Access subjects after trusted verification. The nullable subject supports initial controlled provisioning through Access, not an open registration endpoint.
5. Supply the Supabase backend secret through Cloudflare secret configuration only (`wrangler secret put SUPABASE_SECRET_KEY`). Never put it into vars, source, build artifacts, browser code or GitHub. Secret rotation remains deferred by owner request.
6. Configure protected routing and verify real signed tokens reach the API. `workers_dev` and preview URLs are disabled. Unknown/static routes return authenticated 404; no frontend asset handler exists yet.
7. Next increment must add owner-scoped financial database enforcement and Worker data routes, explicitly mapping any existing Supabase-auth owner IDs. The service credential used for membership lookup must never become the sole protection for financial queries.
8. Removing a user requires disabling the database membership and removing their email from Access policy. Database active state is checked per request, even while an Access session remains valid.

## Still required before Phase 0 / production acceptance

Actual Cloudflare login/logout/session revocation; puppy denial page and no-navigation browser states; protected frontend assets; live direct-origin/API tests; financial cross-user isolation in database and API; auditable member administration; backup/restore trial, retention/region decisions and upload controls. Plaid entitlements and source coverage are later tasks. No trade execution will be implemented.

The current Pages app, its workflow, and its database policies remain unchanged. The existing app is not retroactively secured by these new files. Do not call this increment a deployed login gate or complete financial isolation.
