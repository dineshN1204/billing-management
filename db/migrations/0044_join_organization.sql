-- ---------------------------------------------------------------------------
-- 0044 - join an existing organization by GSTIN search
-- ---------------------------------------------------------------------------
--
-- What this adds
-- ---------------
-- Onboarding previously had one path: bootstrap_organization creates a brand
-- new organization with the caller as admin. A user who wanted to join a
-- company that already exists in the system had no way to find it.
--
-- search_organizations lets any signed-in user look up non-deleted
-- organizations by GSTIN (exact for a full 15-character number, prefix for a
-- partial one) or by a case-insensitive name substring. It returns only the
-- four columns the picker needs - id, name, gstin, state_code - never the
-- organization's contact details or its row counts. The organizations RLS
-- policy hides rows from non-members, so this security-definer function is the
-- single deliberate, controlled read path for them.
--
-- join_organization adds the caller to a found organization as a viewer. The
-- role is fixed and never caller-settable, so self-escalation is impossible;
-- an admin upgrades or demotes people afterwards through
-- set_organization_member_role (0020), which already exists. Joining reuses
-- the same ALREADY_BOOTSTRAPPED refusal as bootstrap, so the single-workspace
-- rule holds and the client's existing error mapping keeps working.
--
-- Privacy tradeoff: anyone who knows a company's GSTIN can join it read-only.
-- Viewer is strictly read-only server-side, the membership insert is written
-- to the audit log by z_audit, and an admin can change or remove the role in
-- Settings -> Employee access.
--
-- Forward-only. Adds two functions, one index and grants; touches no existing
-- row and no existing definition.

begin;

-- ---------------------------------------------------------------------------
-- 1. Index for GSTIN search (exact and prefix)
-- ---------------------------------------------------------------------------
create index if not exists organizations_gstin_search_idx
  on public.organizations (gstin)
  where gstin is not null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- 2. search_organizations
-- ---------------------------------------------------------------------------
create or replace function public.search_organizations(
  p_gstin text default null,
  p_name text default null
)
returns table (id uuid, name text, gstin text, state_code text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_gstin text;
  v_name text;
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  -- Same normalization as the client's normalizeGstin: uppercase, keep only
  -- alphanumerics. The 'g' flag matters: without it only the first
  -- non-alphanumeric character is removed.
  v_gstin := upper(regexp_replace(coalesce(p_gstin, ''), '[^A-Z0-9]', '', 'g'));
  v_name := btrim(coalesce(p_name, ''));

  if char_length(v_gstin) = 0 and char_length(v_name) = 0 then
    perform app_private.raise_validation('query', 'enter a GSTIN or company name to search');
  end if;

  if char_length(v_gstin) > 15 then
    perform app_private.raise_validation('gstin', 'must be at most 15 characters');
  end if;
  if char_length(v_gstin) between 1 and 2 then
    perform app_private.raise_validation('gstin', 'must be at least 3 characters');
  end if;

  if v_name <> '' and (char_length(v_name) < 2 or char_length(v_name) > 120) then
    perform app_private.raise_validation('name', 'must be between 2 and 120 characters');
  end if;

  return query
  select o.id, o.name, o.gstin, o.state_code
  from public.organizations o
  where o.deleted_at is null
    and (
      v_gstin = ''
      or case when char_length(v_gstin) = 15 then o.gstin = v_gstin
              else o.gstin like v_gstin || '%' end
    )
    and (
      v_name = ''
      or position(lower(v_name) in lower(o.name)) > 0
    )
  order by o.created_at asc, o.name asc
  limit 25;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. join_organization
-- ---------------------------------------------------------------------------
create or replace function public.join_organization(
  p_org_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_existing uuid[];
  v_org public.organizations;
  v_membership public.memberships;
  v_profile public.profiles;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;
  if not exists (select 1 from neon_auth.user u where u.id = v_uid) then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'user does not exist');
  end if;

  select * into v_org
  from public.organizations o
  where o.id = p_org_id and o.deleted_at is null;
  if v_org.id is null then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'organization not found');
  end if;

  -- Serialize concurrent bootstrap/join attempts by the same user.
  perform pg_advisory_xact_lock(hashtextextended('join:' || v_uid::text, 0));

  select array_agg(m.organization_id order by m.created_at) into v_existing
  from public.memberships m
  where m.user_id = v_uid;
  if v_existing is not null then
    perform app_private.raise_error(
      'PT409', 'ALREADY_BOOTSTRAPPED', 'user already belongs to an organization',
      jsonb_build_object('organization_ids', to_jsonb(v_existing))
    );
  end if;

  insert into public.memberships (organization_id, user_id, role)
  values (p_org_id, v_uid, 'viewer')
  returning * into v_membership;

  insert into public.profiles (id, default_organization_id)
  values (v_uid, p_org_id)
  on conflict (id) do update
  set default_organization_id = coalesce(public.profiles.default_organization_id, excluded.default_organization_id)
  returning * into v_profile;

  -- The organization object is deliberately slim: only what the joiner already
  -- saw in the search results. Contact details are readable through RLS once
  -- the membership exists, but there is no reason to hand them back here.
  return jsonb_build_object(
    'organization', jsonb_build_object(
      'id', v_org.id,
      'name', v_org.name,
      'gstin', v_org.gstin,
      'state_code', v_org.state_code
    ),
    'membership', to_jsonb(v_membership),
    'profile', to_jsonb(v_profile)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.search_organizations(text, text) from public, anonymous;
grant execute on function public.search_organizations(text, text) to authenticated;

revoke all on function public.join_organization(uuid) from public, anonymous;
grant execute on function public.join_organization(uuid) to authenticated;

commit;
