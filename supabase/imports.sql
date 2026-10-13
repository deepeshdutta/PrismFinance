-- Step 4: import provenance + dedup (ING-03) and sync health (ING-04).
-- Run AFTER holdings.sql. Only the Worker (service role) touches these tables;
-- browser roles get nothing. Every row is owned by prism_members.owner_id.
begin;
create table if not exists public.pf_import_batches (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.prism_members(owner_id) on delete cascade,
  source text not null check (source in ('plaid','api','manual')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  added_count integer not null default 0,
  skipped_count integer not null default 0,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists pf_import_batches_owner on public.pf_import_batches(owner_id);

-- ING-03 provenance columns: which provider row a record came from, its stable
-- dedup fingerprint, and the import batch that wrote it.
alter table public.pf_transactions add column if not exists provider_transaction_id text;
alter table public.pf_transactions add column if not exists fingerprint text;
alter table public.pf_transactions add column if not exists batch_id uuid references public.pf_import_batches(id) on delete set null;
create index if not exists pf_transactions_owner_fingerprint on public.pf_transactions(owner_id, fingerprint);
create index if not exists pf_transactions_owner_provider on public.pf_transactions(owner_id, provider_transaction_id);

alter table public.pf_holdings add column if not exists provider_transaction_id text;
alter table public.pf_holdings add column if not exists fingerprint text;
alter table public.pf_holdings add column if not exists batch_id uuid references public.pf_import_batches(id) on delete set null;

-- ING-04: widen sync status so a revoked/dead Plaid item ('disconnected') is
-- distinguishable from a transient sync failure ('error').
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'pf_plaid_items_status_check') then
    alter table public.pf_plaid_items drop constraint pf_plaid_items_status_check;
  end if;
end $$;
alter table public.pf_plaid_items add constraint pf_plaid_items_status_check check (status in ('ok','error','disconnected'));

alter table public.pf_import_batches enable row level security;
revoke all on public.pf_import_batches from public, anon, authenticated;
grant select, insert, update, delete on public.pf_import_batches to service_role;
commit;
notify pgrst, 'reload schema';
