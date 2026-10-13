-- MVP2: investment holdings synced from Plaid. Only the Worker (service role) can touch this table.
begin;
create table if not exists public.pf_holdings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.prism_members(owner_id) on delete cascade,
  account_id uuid not null references public.pf_accounts(id) on delete cascade,
  security_id text not null,
  ticker text check (ticker is null or length(ticker) <= 30),
  name text not null check (length(name) <= 200),
  sec_type text check (sec_type is null or length(sec_type) <= 40),
  quantity numeric(24,8) not null,
  price numeric(20,6) not null default 0,
  value numeric(20,2) not null default 0,
  cost_basis numeric(20,2),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  as_of date,
  updated_at timestamptz not null default now(),
  unique (owner_id, account_id, security_id)
);
create index if not exists pf_holdings_owner on public.pf_holdings(owner_id);
alter table public.pf_holdings enable row level security;
revoke all on public.pf_holdings from public, anon, authenticated;
grant select, insert, update, delete on public.pf_holdings to service_role;
commit;
notify pgrst, 'reload schema';
