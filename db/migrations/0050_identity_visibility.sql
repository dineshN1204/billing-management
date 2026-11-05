-- ---------------------------------------------------------------------------
-- 0050: identity visibility
--
-- The database exposed users only as UUIDs. public.profiles stores a full_name
-- (set only for the company creator, so invited/joined members are NULL) and no
-- email; public.memberships stores just user_id + role. Email lives only in
-- neon_auth.user, which carries no grants to the authenticated role, so the
-- only way to see who a person is was the admin-only list_organization_members
-- RPC (which returned email but not name).
--
-- This migration makes identity visible without duplicating email:
--   * list_organization_members now also returns full_name (joined from
--     public.profiles), so the Settings -> Employee access list shows a name.
--   * current_user_identity() is a new SECURITY DEFINER RPC that returns the
--     signed-in caller's own email + full_name.
--   * v_user_profiles and v_org_members are developer-only read-only views that
--     join profiles/memberships to neon_auth.user. They are deliberately NOT
--     granted to authenticated/anonymous: views run with the owner's privileges
--     and bypass RLS, so granting them to signed-in users would expose every
--     email to everyone. The developer reaches them via psql as the DB owner.
-- ---------------------------------------------------------------------------
begin;

-- ---------------------------------------------------------------------------
-- 1. list_organization_members: also return full_name.
--
-- The return-column set changes, which CREATE OR REPLACE refuses (Postgres
-- requires the exact same return shape), so the function is dropped and
-- recreated. It is a leaf RPC — only the Settings screen calls it via
-- db.rpc — so there are no dependents to cascade to.
-- ---------------------------------------------------------------------------
drop function if exists public.list_organization_members(uuid);

create or replace function public.list_organization_members(
  target_organization_id uuid default null
)
returns table (
  user_id uuid,
  email text,
  full_name text,
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
           p.full_name,
           m.role,
           m.created_at,
           m.user_id = auth.uid()
    from public.memberships m
    left join public.profiles p on p.id = m.user_id
    left join neon_auth.user u on u.id = m.user_id
    where m.organization_id = v_org
    order by (m.user_id = auth.uid()) desc, m.role, coalesce(u.email, m.user_id::text);
end;
$$;

revoke all on function public.list_organization_members(uuid) from public, anonymous;
grant execute on function public.list_organization_members(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. current_user_identity(): the signed-in caller's own identity.
--
-- SECURITY DEFINER because neon_auth.user (and its email) is not readable over
-- the Data API. Revoking EXECUTE from anonymous makes an unauthenticated call
-- fail with 42501, consistent with the other anonymous-RPC guards.
-- ---------------------------------------------------------------------------
create or replace function public.current_user_identity()
returns table (user_id uuid, email text, full_name text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select au.id, nu.email, pf.full_name
  from (select auth.uid()) au(id)
  left join public.profiles pf on pf.id = au.id
  left join neon_auth.user nu on nu.id = au.id
  limit 1;
$$;

revoke all on function public.current_user_identity() from public, anonymous;
grant execute on function public.current_user_identity() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Developer-only read-only identity views.
--
-- NOT granted to authenticated or anonymous. Views resolve base-table reads
-- with the owner's privileges, so a grant here would let any signed-in user
-- read every email for every organization, bypassing RLS. The developer reads
-- them as the database owner.
-- ---------------------------------------------------------------------------
create or replace view public.v_user_profiles as
  select p.id as user_id, u.email, p.full_name, p.default_organization_id, p.created_at
  from public.profiles p
  left join neon_auth.user u on u.id = p.id;

create or replace view public.v_org_members as
  select m.organization_id, m.user_id, u.email, p.full_name, m.role, m.created_at as member_since
  from public.memberships m
  left join public.profiles p on p.id = m.user_id
  left join neon_auth.user u on u.id = m.user_id;

revoke all on public.v_user_profiles from public, anonymous;
revoke all on public.v_org_members from public, anonymous;

commit;
