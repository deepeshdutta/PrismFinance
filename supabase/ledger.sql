-- Step 2: private per-member ledger. Every row is owned by prism_members.owner_id.
-- Only the Worker (service role) can touch these tables; browser roles get nothing.
begin;
create table if not exists public.pf_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.prism_members(owner_id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  kind text not null check (kind in ('checking','savings','credit','brokerage','retirement','loan','property','other')),
  institution text check (institution is null or length(institution) <= 80),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  balance numeric(18,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pf_accounts_owner on public.pf_accounts(owner_id);
create table if not exists public.pf_transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.prism_members(owner_id) on delete cascade,
  account_id uuid not null references public.pf_accounts(id) on delete cascade,
  posted_on date not null,
  description text not null check (length(btrim(description)) between 1 and 200),
  amount numeric(18,2) not null,
  category text check (category is null or length(category) <= 60),
  created_at timestamptz not null default now()
);
create index if not exists pf_transactions_owner_date on public.pf_transactions(owner_id, posted_on desc);
alter table public.pf_accounts enable row level security;
alter table public.pf_transactions enable row level security;
revoke all on public.pf_accounts, public.pf_transactions from public, anon, authenticated;
grant select, insert, update, delete on public.pf_accounts, public.pf_transactions to service_role;
commit;
