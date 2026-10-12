-- Run once in the Supabase SQL editor (after supabase/policies.sql).
-- Only preapproved emails may pass the PrismFinance login gate.
-- The app checks this list right after the one-time code is verified;
-- anyone not on it is signed straight back out and meets the guard pup.

create table if not exists public.prism_allowlist (
  email text primary key,
  note text,
  added_at timestamptz not null default now()
);

alter table public.prism_allowlist enable row level security;

grant usage on schema public to authenticated;
grant select on table public.prism_allowlist to authenticated;

-- Each signed-in person may only look up their own email.
drop policy if exists prism_allowlist_own on public.prism_allowlist;
create policy prism_allowlist_own on public.prism_allowlist
  for select to authenticated
  using (lower(email) = lower((select auth.jwt() ->> 'email')));

-- Owner goes first. Add the rest of the circle with:
-- insert into public.prism_allowlist (email, note)
--   values ('name@example.com', '...')
--   on conflict (email) do nothing;
insert into public.prism_allowlist (email, note)
values ('deepesh.dutta@gmail.com', 'owner')
on conflict (email) do nothing;
