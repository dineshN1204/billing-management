-- 0020_employee_roles.sql
--
-- Changing an employee's role, and revoking access when someone leaves.
--
-- The gap this closes: add_organization_member (0006) can grant access, and
-- nothing anywhere could take it away or change it. For a workshop of about ten
-- people that is a real problem - an employee who leaves keeps full access to
-- invoices, customer GSTINs and material balances indefinitely, and correcting a
-- role means opening an admin database connection.
--
-- What already protects memberships, and is relied on rather than duplicated:
--   * c_guard_last_admin (0002) is a BEFORE UPDATE OR DELETE trigger on
--     public.memberships that refuses to remove or demote the last admin. The
--     checks in these functions run first so the person gets a sentence they can
--     act on instead of a raw trigger exception.
--   * z_audit (0002) is an AFTER trigger on public.memberships that already
--     records every role change and every removal in audit_logs. These functions
--     deliberately do NOT write their own audit row; a second one would double
--     every entry.
--
-- Forward-only and non-destructive. No existing row is modified, no column is
-- dropped, and the role check constraint is untouched, so applying this cannot
-- change how any existing member behaves. The frontend treats a missing RPC as
-- an ordinary error, so the app keeps working if it is not applied yet.

begin;

-- ---------------------------------------------------------------------------
-- set_organization_member_role
-- ---------------------------------------------------------------------------
create or replace function public.set_organization_member_role(
  target_user_id uuid,
  new_role text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid;
  v_member public.memberships;
  v_admins integer;
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  if new_role is null or new_role not in ('admin', 'staff', 'viewer') then
    perform app_private.raise_validation('new_role', 'must be admin, staff or viewer');
  end if;

  select * into v_member from public.memberships where user_id = target_user_id limit 1;
  if v_member.id is null then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'that person is not a member of this workspace');
  end if;
  v_org := v_member.organization_id;

  if not app_private.is_org_admin(v_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'only admins can change roles');
  end if;

  if v_member.role = new_role then
    return to_jsonb(v_member);
  end if;

  if v_member.role = 'admin' and new_role <> 'admin' then
    select count(*) into v_admins
    from public.memberships
    where organization_id = v_org and role = 'admin';
    if v_admins <= 1 then
      perform app_private.raise_error(
        'PT409', 'LAST_ADMIN',
        'this is the only admin; promote someone else to admin before changing this role'
      );
    end if;
  end if;

  -- z_audit records the before and after role.
  update public.memberships
  set role = new_role, updated_at = now()
  where id = v_member.id
  returning * into v_member;

  return jsonb_build_object(
    'user_id', v_member.user_id,
    'organization_id', v_org,
    'role', v_member.role,
    'changed', true
  );
end;
$$;

revoke all on function public.set_organization_member_role(uuid, text) from public, anonymous;
grant execute on function public.set_organization_member_role(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- deactivate_organization_member
--
-- The membership row is deleted rather than flagged, because every read path
-- already resolves the organization through public.memberships: removing the row
-- revokes access in one place, immediately, with no second code path to keep in
-- step. z_audit keeps the record of who had which role.
-- ---------------------------------------------------------------------------
create or replace function public.deactivate_organization_member(
  target_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid;
  v_member public.memberships;
  v_admins integer;
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  select * into v_member from public.memberships where user_id = target_user_id limit 1;
  if v_member.id is null then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'that person is not a member of this workspace');
  end if;
  v_org := v_member.organization_id;

  if not app_private.is_org_admin(v_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'only admins can remove members');
  end if;

  -- Removing your own access is how a single admin locks everyone out, and it is
  -- never what the person meant to do.
  if target_user_id = auth.uid() then
    perform app_private.raise_error(
      'PT409', 'CANNOT_REMOVE_SELF',
      'you cannot remove your own access; ask another admin to do it'
    );
  end if;

  if v_member.role = 'admin' then
    select count(*) into v_admins
    from public.memberships
    where organization_id = v_org and role = 'admin';
    if v_admins <= 1 then
      perform app_private.raise_error(
        'PT409', 'LAST_ADMIN',
        'this is the only admin; promote someone else before removing access'
      );
    end if;
  end if;

  delete from public.memberships where id = v_member.id;

  return jsonb_build_object('user_id', target_user_id, 'organization_id', v_org, 'removed', true);
end;
$$;

revoke all on function public.deactivate_organization_member(uuid) from public, anonymous;
grant execute on function public.deactivate_organization_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- list_organization_members
--
-- The members screen showed a UUID per person and no address, because
-- public.memberships carries no email column and neon_auth.user is not readable
-- over the Data API. This admin-only SECURITY DEFINER read resolves the address
-- the same way 0006 does, so an administrator can tell who has access and to
-- what.
--
-- Admin-only on purpose: a directory of staff email addresses is not something
-- every signed-in user needs in a workshop of ten.
-- ---------------------------------------------------------------------------
create or replace function public.list_organization_members(
  target_organization_id uuid default null
)
returns table (
  user_id uuid,
  email text,
  role text,
  member_since timestamptz,
  is_you boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  -- There is no app_private.current_org_id(): the organization is resolved from
  -- the caller's own membership, and the optional parameter only narrows it to a
  -- workspace the caller is already an admin of.
  select m.organization_id into v_org
  from public.memberships m
  where m.user_id = auth.uid()
    and (target_organization_id is null or m.organization_id = target_organization_id)
  limit 1;

  if v_org is null or not app_private.is_org_admin(v_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'only admins can list members');
  end if;

  return query
    select m.user_id,
           u.email,
           m.role,
           m.created_at,
           m.user_id = auth.uid()
    from public.memberships m
    left join neon_auth.user u on u.id = m.user_id
    where m.organization_id = v_org
    order by (m.user_id = auth.uid()) desc, m.role, coalesce(u.email, m.user_id::text);
end;
$$;

revoke all on function public.list_organization_members(uuid) from public, anonymous;
grant execute on function public.list_organization_members(uuid) to authenticated;

commit;