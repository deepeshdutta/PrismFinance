-- Step 1 only: server-side Cloudflare identities, not a financial ledger migration.
-- Review and apply in Supabase SQL editor. No existing tables/data are modified.
-- The owner UUID becomes the new ledger owner key in the next migration.
-- Existing auth.uid()-owned records must be explicitly mapped before migration.
begin;
create table if not exists public.prism_members (
  owner_id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(btrim(email)) and position('@' in email) > 1),
  role text not null default 'viewer' check (role in ('owner', 'viewer')),
  active boolean not null default true,
  access_subject text unique check (access_subject is null or length(access_subject) > 0),
  created_at timestamptz not null default now()
);
alter table public.prism_members enable row level security;
revoke all on public.prism_members from public, anon, authenticated;
grant usage on schema public to service_role;
grant select on public.prism_members to service_role;
-- No authenticated/anon RLS policy: the browser cannot inspect membership.
-- On rerun, do NOT reactivate an intentionally revoked owner or replace UUIDs.
insert into public.prism_members (email, role)
values ('deepesh.dutta@gmail.com', 'owner')
on conflict (email) do nothing;
commit;

-- Add a member (only from trusted SQL administration):
-- insert into public.prism_members(email, role) values ('approved@example.com', 'viewer');
-- Bind Cloudflare identity subject after trusted identity verification:
-- update public.prism_members set access_subject = 'verified-access-subject' where email = 'approved@example.com';
-- Revoke future requests immediately:
-- update public.prism_members set active = false where email = 'approved@example.com';
-- Also remove that email from the Cloudflare Access allow policy to suppress OTP.
