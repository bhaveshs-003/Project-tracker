-- Local development only. NEVER applied to a Supabase project.
--
-- Supabase provides the `auth` schema and `auth.users`. A plain Postgres has
-- neither, so `people.user_id references auth.users(id)` would not apply. This
-- creates just enough of it to run the real migration unchanged against a local
-- database, so the schema being tested is the schema being deployed.
--
-- Usage:  psql -d functional_tool -f supabase/local-shim.sql
--         psql -d functional_tool -f supabase/migrations/0001_init.sql

create schema if not exists auth;

create table if not exists auth.users (
  id                uuid primary key default gen_random_uuid(),
  email             text unique,
  encrypted_password text,
  raw_app_meta_data  jsonb not null default '{}'::jsonb,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

-- Supabase exposes the current request's claims through these. Express uses the
-- service role and never relies on them, but RLS policies reference them, so
-- they have to resolve for the migration to apply.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
$$;
