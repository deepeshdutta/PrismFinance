-- Step 3: Plaid connectivity. Access tokens are stored ENCRYPTED (AES-GCM, key held only as a Worker secret).
-- Only the Worker (service role) can touch these tables.
begin;
create table if not exists public.pf_plaid_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.prism_members(owner_id) on delete cascade,
  plaid_item_id text not null,
  access_token_enc text not null,
  institution_name text check (institution_name is null or length(institution_name) <= 120),
  sync_cursor text,
  status text not null default 'ok' check (status in ('ok','error')),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (owner_id, plaid_item_id)
);
create index if not exists pf_plaid_items_owner on public.pf_plaid_items(owner_id);
alter table public.pf_accounts add column if not exists plaid_account_id text;
alter table public.pf_accounts add column if not exists plaid_item_id uuid references public.pf_plaid_items(id) on delete set null;
alter table public.pf_transactions add column if not exists plaid_transaction_id text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'pf_accounts_owner_plaid_unique') then
    alter table public.pf_accounts add constraint pf_accounts_owner_plaid_unique unique (owner_id, plaid_account_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pf_transactions_owner_plaid_unique') then
    alter table public.pf_transactions add constraint pf_transactions_owner_plaid_unique unique (owner_id, plaid_transaction_id);
  end if;
end $$;
alter table public.pf_plaid_items enable row level security;
revoke all on public.pf_plaid_items from public, anon, authenticated;
grant select, insert, update, delete on public.pf_plaid_items to service_role;
commit;
