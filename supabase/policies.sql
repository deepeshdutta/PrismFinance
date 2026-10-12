-- Run once in the Supabase SQL editor.
-- Lets each signed-in person read and write only their own rows.
-- The publishable key cannot bypass this.

grant usage on schema public to authenticated;

grant select, insert, update, delete on table public.prism_accounts to authenticated;
grant select, insert, update, delete on table public.prism_transactions to authenticated;
grant select, insert, update, delete on table public.prism_net_worth_points to authenticated;

alter table public.prism_accounts enable row level security;
alter table public.prism_transactions enable row level security;
alter table public.prism_net_worth_points enable row level security;

drop policy if exists prism_accounts_own on public.prism_accounts;
create policy prism_accounts_own on public.prism_accounts
  for all to authenticated
  using (user_id = (select auth.uid())::text)
  with check (user_id = (select auth.uid())::text);

drop policy if exists prism_transactions_own on public.prism_transactions;
create policy prism_transactions_own on public.prism_transactions
  for all to authenticated
  using (user_id = (select auth.uid())::text)
  with check (user_id = (select auth.uid())::text);

drop policy if exists prism_net_worth_points_own on public.prism_net_worth_points;
create policy prism_net_worth_points_own on public.prism_net_worth_points
  for all to authenticated
  using (user_id = (select auth.uid())::text)
  with check (user_id = (select auth.uid())::text);
