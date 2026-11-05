-- ---------------------------------------------------------------------------
-- 0052: revoke authenticated/anonymous from the identity views
--
-- 0050 created v_user_profiles and v_org_members as developer-only views and
-- revoked them from public and anonymous, on the assumption that the only
-- roles that could inherit access were those two. That assumption is false on
-- Neon branches that carry a default ACL granting the `authenticated` role
-- full DML on every new relation in `public` (neondb_owner -> authenticated
-- = arwd on new tables/views).The default ACL fires at creation time, so
-- both views came into existence already granted to `authenticated` — and
-- because views resolve base-table reads with the owner's privileges (bypassing
-- RLS), any signed-in user could read every email and every membership in the
-- system. Confirmed by direct query on the test branch:
--
--   as authenticated: select count(*) from v_user_profiles -> 2
--
-- This migration undoes the default-ACL grant on exactly these two objects.
-- It is forward-only; it does not alter 0050.
-- ---------------------------------------------------------------------------
begin;

revoke all on public.v_user_profiles from authenticated, anonymous, public;
revoke all on public.v_org_members from authenticated, anonymous, public;

-- Make the intent explicit for anyone re-applying or inspecting grants: the
-- views are owner-only, readable via the developer's psql as the DB owner.
grant select on public.v_user_profiles to neondb_owner;
grant select on public.v_org_members to neondb_owner;

commit;
