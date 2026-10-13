-- Step 5: investment transactions (MVP1 P&L + graphs).
-- Run AFTER imports.sql. Raw investment-transaction rows (cash legs AND option
-- markers), one row per provider transaction, owned by prism_members.owner_id.
--
-- Quantity is in NATIVE units: shares for cash legs (buy/sell), contracts for
-- marker legs (expiration/assignment). The worker converts via legContracts().
--
-- PLAID SIGN CONVENTION (the pnl engine relies on this): amount < 0 means cash
-- moved INTO the account (sale proceeds, premium received, dividends);
-- amount > 0 means cash moved OUT (purchases, premium paid, fees).
--
-- NOTE: Plaid investment-transactions sync wiring is a separate PR gated on
-- Plaid Production approval; this migration only creates the landing table.
-- Only the Worker (service role) touches this table; browser roles get nothing.
begin;
create table if not exists public.pf_investment_txns (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.prism_members(owner_id) on delete cascade,
  account_id uuid not null references public.pf_accounts(id) on delete cascade,
  security_id text,
  posted_on date not null,
  txn_type text not null check (txn_type in ('buy','sell','transfer','dividend','fee','interest')),
  subtype text,
  name text,
  quantity numeric(18,6),
  amount numeric(18,2),
  fees numeric(18,2) not null default 0,
  ticker text,
  sec_type text,
  option_type text check (option_type is null or option_type in ('call','put')),
  option_expiry date,
  option_strike numeric(18,4),
  option_underlying text,
  provider_transaction_id text,
  batch_id uuid references public.pf_import_batches(id) on delete set null,
  created_at timestamptz not null default now()
);
-- Dedup: one provider transaction per owner. NULL provider ids are allowed to
-- repeat (Postgres treats NULLs as distinct in unique indexes).
create unique index if not exists pf_investment_txns_owner_provider on public.pf_investment_txns(owner_id, provider_transaction_id);
create index if not exists pf_investment_txns_owner_account_posted on public.pf_investment_txns(owner_id, account_id, posted_on desc);

alter table public.pf_investment_txns enable row level security;
revoke all on public.pf_investment_txns from public, anon, authenticated;
grant all on public.pf_investment_txns to service_role;
commit;
notify pgrst, 'reload schema';
