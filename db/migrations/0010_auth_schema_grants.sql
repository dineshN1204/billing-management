-- 0010_auth_schema_grants.sql
-- Fix: the `authenticated` role had no USAGE on the `auth` schema, so every call to
-- auth.uid() from SECURITY DEFINER RLS helper functions failed with
--   "42501 permission denied for schema auth"
-- which the Neon Data API surfaced as the generic
--   "The request could not be completed. Please try again."
-- Reproduced as: SELECT/INSERT on public.customers worked (they did not evaluate
-- auth.uid() inside a trigger), but UPDATE failed because the BEFORE UPDATE trigger
-- chain (a_set_updated_at -> b_immutable_columns -> a_normalize_fields -> z_audit)
-- runs as the invoker's privileges and therefore hits auth.uid().

grant usage on schema auth to authenticated;
grant execute on all functions in schema auth to authenticated;

-- Keep this working for any future function Neon Auth adds to the auth schema.
-- The default privilege below covers new functions created by cloud_admin (owner of auth).
alter default privileges for role cloud_admin in schema auth
  grant execute on functions to authenticated;
