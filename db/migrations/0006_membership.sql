create function public.add_organization_member(org_id uuid, member_email text, member_role text default 'viewer')
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user uuid;
  v_member public.memberships;
begin
  if auth.uid() is null or not app_private.is_org_admin(org_id) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'only admins can add members');
  end if;
  if member_role not in ('admin', 'staff', 'viewer') then
    perform app_private.raise_validation('member_role', 'must be admin, staff or viewer');
  end if;
  if member_email is null or length(btrim(member_email)) > 254 then
    perform app_private.raise_validation('member_email', 'must be a valid registered email address');
  end if;
  select u.id into v_user from neon_auth.user u where lower(u.email) = lower(btrim(member_email)) and coalesce(u."emailVerified", false) limit 1;
  if v_user is null then
    perform app_private.raise_validation('member_email', 'must belong to a confirmed account');
  end if;
  insert into public.memberships (organization_id, user_id, role)
  values (org_id, v_user, member_role)
  on conflict (organization_id, user_id) do nothing
  returning * into v_member;
  if v_member.id is null then
    perform app_private.raise_error('PT409', 'ALREADY_MEMBER', 'this user already belongs to the organization');
  end if;
  insert into public.profiles (id, default_organization_id)
  values (v_user, org_id)
  on conflict (id) do update
  set default_organization_id = coalesce(public.profiles.default_organization_id, excluded.default_organization_id);
  return to_jsonb(v_member);
end;
$$;
revoke all on function public.add_organization_member(uuid, text, text) from public, anonymous;
grant execute on function public.add_organization_member(uuid, text, text) to authenticated;
