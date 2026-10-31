-- 0011: Make auth-dependent trigger functions SECURITY DEFINER.
--
-- Root cause of "The request could not be completed. Please try again." on
-- customer save/edit:
--   * Neon's `auth` schema is owned by `cloud_admin` and the `authenticated`
--     role has NO USAGE on it (attempts to `grant usage on schema auth`
--     do not persist -- Neon manages that schema).
--   * Several BEFORE/AFTER trigger functions on public.customers called
--     auth.uid() while running with the caller's privileges (NOT SECURITY
--     DEFINER). When the Data API ran them as role=authenticated, the
--     auth.uid() call raised `permission denied for schema auth`, which
--     aborted the whole INSERT/UPDATE. SELECT and INSERT sometimes worked
--     because the offending trigger (guard_soft_delete) only fires on
--     UPDATE, which is exactly why editing a customer always failed.
--
-- Fix: run these trigger functions as SECURITY DEFINER (owner neondb_owner,
-- which has USAGE on auth) and route every auth.uid() call through a small
-- SECURITY DEFINER helper app_private.current_uid().

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

-- guard_soft_delete: fires before UPDATE on public.customers (among others)
-- and calls auth.uid() to verify the actor is an org admin.
create or replace function app_private.guard_soft_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.deleted_at is distinct from old.deleted_at
    and app_private.current_uid() is not null
    and not app_private.is_org_admin(old.organization_id)
  then
    raise exception using errcode = '42501', message = 'FORBIDDEN: only organization admins can delete or restore records';
  end if;
  return new;
end;
$$;

revoke all on function app_private.guard_soft_delete() from public;

-- write_audit_row: AFTER trigger that records auth.uid() as the actor.
create or replace function app_private.write_audit_row()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    v_row := v_new;
    v_action := 'INSERT';
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    if v_old = v_new then
      return null;
    end if;
    v_row := v_new;
    v_action := 'UPDATE';
    if (v_old ->> 'deleted_at') is null and (v_new ->> 'deleted_at') is not null then
      v_action := 'SOFT_DELETE';
    elsif (v_old ->> 'deleted_at') is not null and (v_new ->> 'deleted_at') is null then
      v_action := 'RESTORE';
    end if;
  else
    v_old := to_jsonb(old);
    v_row := v_old;
    v_action := 'DELETE';
  end if;

  insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, old_data, new_data)
  values (
    case when tg_table_name = 'organizations' then (v_row ->> 'id')::uuid else (v_row ->> 'organization_id')::uuid end,
    app_private.current_uid(),
    v_action,
    tg_table_name,
    (v_row ->> 'id')::uuid,
    v_old,
    v_new
  );
  return null;
end;
$$;

revoke all on function app_private.write_audit_row() from public;

-- normalize_customer_fields: BEFORE trigger that stamps verified_by = auth.uid()
-- when verification_status = 'verified'. Now references current_uid().
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

revoke all on function app_private.normalize_customer_fields() from public;
