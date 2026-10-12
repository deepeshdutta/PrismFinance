# PrismFinance

Static site for GitHub Pages. Balances live in Supabase. Each signed-in person only sees their own rows.

Live URL, after the Pages workflow finishes: https://deepeshdutta.github.io/PrismFinance/

## One-time Supabase step

In the Supabase SQL editor, run [supabase/policies.sql](supabase/policies.sql).

Also turn on Email sign-in (Authentication → Providers → Email). If “Confirm email” is on, new people must open the confirmation mail before they can sign in.

The publishable key is public. The secret key is not in this repo.
