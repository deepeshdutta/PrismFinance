# Stage environment

Stage is a full copy of the private app that shares nothing with production: its own Worker, its own Supabase project, its own Access app, Plaid Sandbox, Tradier sandbox. Test data only.

## One-time setup (about 20 minutes)
1. **Supabase:** create a second project, "prismfinance-stage". In its SQL editor run, in order: `supabase/members.sql`, `ledger.sql`, `plaid.sql`, `holdings.sql`. Add two or three test members with `insert into prism_members(email, role) values (...)`.
2. **Cloudflare Access:** create a self-hosted application for `prismfinance-stage.<account>.workers.dev` with an allow policy for your own email only. Copy its AUD tag.
3. **Config:** put the Stage project URL in `SUPABASE_URL` and the AUD tag in `ACCESS_AUD` under `env.stage.vars` in `wrangler.jsonc`.
4. **Secrets, Stage values only:**
   `npx wrangler secret put SUPABASE_SECRET_KEY --env stage` (the Stage project's key, never production's)
   `npx wrangler secret put PLAID_SECRET --env stage` (Sandbox secret)
   `npx wrangler secret put PLAID_TOKEN_KEY --env stage` (a new random 32-byte base64 key)
   `npx wrangler secret put TRADIER_TOKEN --env stage` (a sandbox token, optional)
5. **Deploy:** `npm run build && npx wrangler deploy --env stage`.

## Safety rules
- Never copy production secrets or the production Supabase URL into Stage.
- With `SUPABASE_URL` or `ACCESS_AUD` empty, Stage answers 503 to everything. That is intentional.
- Run `cd worker && npm test` before each Stage deploy. `tests/isolation.test.ts` proves one member cannot read or change another's data.
