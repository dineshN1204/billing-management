-- 0010_fix_auth_uid_in_triggers.sql
--
-- Fix: "The request could not be completed. Please try again." when creating or
-- editing a customer.
--
-- Root cause
-- ----------
-- On Neon the managed role `cloud_admin` owns the `auth` schema, and Neon does not
-- allow the application role `neondb_owner` to GRANT USAGE on it. A
-- `grant usage on schema auth to authenticated` is accepted but silently rolled
-- back, so `authenticated` can never call `auth.uid()` directly:
--
--     ERROR 42501: permission denied for schema auth
--
-- Every RLS policy is safe because it calls `auth.uid()` *inside* a SECURITY
-- DEFINER helper (app_private.is_org_member / can_write / is_org_admin), which
-- runs as the function owner (neondb_owner) and therefore can read `auth`.
--
-- One trigger was not: app_private.normalize_customer_fields() is a plain
-- (non SECURITY DEFINER) BEFORE INSERT OR UPDATE trigger on public.customers and
-- it called `auth.uid()` directly at `verified_by := auth.uid()`.
-- It therefore executed with the privileges of the *caller* (authenticated),
-- hit "permission denied for schema auth", and Postgres aborted the statement.
-- The Neon Data API surfaces that as the generic message above.
--
-- Fix
-- ---
-- Route the one offending call through the SECURITY DEFINER helper
-- app_private.current_uid(), and make the trigger itself SECURITY DEFINER so that
-- any future direct use of auth.* inside it also resolves as neondb_owner.
-- Behaviour is unchanged: the uid is read from the same JWT of the same session.
--
-- Safe to re-run.

set search_path = pg_catalog, public;

-- Helper: reads auth.uid() with definer rights so any role can use it.
create or replace function app_private.current_uid()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select auth.uid();
$$;

revoke all on function app_private.current_uid() from public;
grant execute on function app_private.current_uid() to authenticated;

-- Recreate the trigger function as SECURITY DEFINER and replace the direct call.
create or replace function app_private.normalize_customer_fields()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  new.gstin := nullif(upper(regexp_replace(coalesce(new.gstin, ''), '\s+', '', 'g')), '');
  new.address_line_1 := nullif(btrim(new.address_line_1), '');
  new.address_line_2 := nullif(btrim(new.address_line_2), '');
  new.city := nullif(btrim(new.city), '');
  new.state := nullif(btrim(new.state), '');
  new.country := nullif(btrim(new.country), '');
  new.pincode := nullif(regexp_replace(coalesce(new.pincode, ''), '\s+', '', 'g'), '');

  if new.verification_status = 'verified' then
    if tg_op = 'INSERT' or old.verification_status is distinct from 'verified' then
      new.verified_at := coalesce(new.verified_at, now());
      new.verified_by := coalesce(new.verified_by, app_private.current_uid());
    end if;
  else
    new.verified_at := null;
    new.verified_by := null;
  end if;

  return new;
end;
$$;

revoke all on function app_private.normalize_customer_fields() from public, anonymous, authenticated;

-- The other BEFORE-trigger functions are already SECURITY DEFINER in the current
-- schema, but re-assert the flag so a database that ran an older revision is
-- repaired too. Each one only uses auth.uid() to bail out when there is no JWT.
create or replace function app_private.guard_soft_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.deleted_at is distinct from old.deleted_at
    and auth.uid() is not null
    and not app_private.is_org_admin(old.organization_id)
  then
    raise exception using
      errcode = '42501',
      message = 'FORBIDDEN: only organization admins can delete or restore records';
  end if;
  return new;
end;
$$;

revoke all on function app_private.guard_soft_delete() from public, anonymous, authenticated;

-- set_updated_at() does not touch auth.*, make it definer anyway for consistency
-- with the rest of the audit chain.
create or replace function app_private.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function app_private.set_updated_at() from public, anonymous, authenticated;

-- enforce_immutable_columns() does not use auth.* but runs on every UPDATE of
-- every table; making it definer removes any future dependency on the auth schema.
create or replace function app_private.enforce_immutable_columns()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.id is distinct from old.id
    or new.created_at is distinct from old.created_at
    or (to_jsonb(new) ->> 'organization_id') is distinct from (to_jsonb(old) ->> 'organization_id')
  then
    raise exception using
      errcode = '42501',
      message = 'IMMUTABLE_COLUMN: id, organization_id and created_at cannot be changed';
  end if;
  return new;
end;
$$;

revoke all on function app_private.enforce_immutable_columns() from public, anonymous, authenticated;
