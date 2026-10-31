-- 0021_dc_unauthenticated_guard.sql
--
-- Fix: "FORBIDDEN: you are not a member of this workspace" appearing on a
-- Delivery Challan screen for someone who *is* a member, in a tab left open
-- long enough for the access token to lapse.
--
-- Root cause
-- ----------
-- app_private.is_org_member() answers a plain question - "is auth.uid() the
-- owner of a membership row in this organization" - and answers **false** when
-- auth.uid() is null. It cannot report "there was no caller", because a boolean
-- has nowhere to put that.
--
-- Every function that checks membership was expected to distinguish the two
-- cases itself, by testing auth.uid() *before* calling the helper:
--
--     if v_uid is null then
--       perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
--     end if;
--
-- dc_update_settings (0016), set_organization_member_role, deactivate_organization_member
-- and list_organization_members (0020) all do exactly that. Two functions did not:
--
--     public.dc_dashboard_summary   (0017)   'you are not a member of this workspace'
--     public.dc_available_balance   (0016)   'you are not a member of this workspace'
--
-- Both went straight to `if not app_private.is_org_member(p_org)`, so an expired
-- or absent JWT - "not signed in" - was reported as "signed in as somebody who
-- does not belong here". The membership was never actually in question.
--
-- Why it also never recovered
-- ---------------------------
-- app_private.raise_error raises with SQLSTATE 'PT403', a custom code PostgREST
-- does not map, so it arrives at the browser as HTTP **500**, not 401/403. The
-- client's isSessionRejected() in src/lib/format.ts does not match that text,
-- so queryWithRetry treated it as a genuine permissions failure: it refreshed
-- nothing and replayed nothing. The tab stayed broken until it was reloaded by
-- hand. The same happened for a genuinely valid token that the server had
-- stopped accepting, which is what the retry path exists for.
--
-- The fix
-- -------
-- Add the missing guard so an expired session says UNAUTHENTICATED, using the
-- same wording as the functions that already do this. That wording matters:
-- isSessionRejected() already matches on both 'unauthenticated' and
-- 'authentication required', so once these two functions report it the existing
-- client-side retry re-reads the token and replays the call automatically. No
-- frontend change is needed, and none of the successful paths move.
--
-- The membership check stays, immediately after, and is unchanged - a caller
-- with a valid token who genuinely is not a member still gets PT403.
--
-- Both bodies below are byte-for-byte the originals from 0016 and 0017 with the
-- four guard lines added and nothing else - no comment inside a function body,
-- so pg_get_functiondef stays diffable against the original.
--
-- Forward-only and non-destructive: two functions are replaced with their
-- previous logic plus two lines. No table, row or grant is touched. Safe to
-- re-run.

begin;

-- ---------------------------------------------------------------------------
-- dc_dashboard_summary
-- ---------------------------------------------------------------------------
create or replace function public.dc_dashboard_summary(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  if not app_private.is_org_member(p_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'you are not a member of this workspace');
  end if;

  return jsonb_build_object(
    'inward_this_month', (
      select count(*) from public.dc_documents d
      where d.organization_id = p_org and d.dc_type = 'inward'
        and d.status <> 'cancelled' and d.deleted_at is null
        and d.dc_date >= date_trunc('month', current_date)::date),
    'outward_self_open', (
      select count(*) from public.dc_documents d
      where d.organization_id = p_org and d.dc_type = 'outward_self'
        and d.status in ('issued', 'dispatched') and d.deleted_at is null),
    'outward_customer_open', (
      select count(*) from public.dc_documents d
      where d.organization_id = p_org and d.dc_type = 'outward_customer'
        and d.status in ('issued', 'dispatched', 'partially_delivered') and d.deleted_at is null),
    'drafts', (
      select count(*) from public.dc_documents d
      where d.organization_id = p_org and d.status = 'draft' and d.deleted_at is null),
    'cancelled', (
      select count(*) from public.dc_documents d
      where d.organization_id = p_org and d.status = 'cancelled' and d.deleted_at is null),
    'pending_inspection_lines', (
      select count(*) from public.dc_items i
      join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
      where i.organization_id = p_org and d.dc_type = 'inward'
        and d.status not in ('draft', 'cancelled') and d.deleted_at is null
        and i.inspection_required and i.pending_inspection_qty > 0),
    'pending_inspection_quantity', (
      select coalesce(sum(i.pending_inspection_qty), 0) from public.dc_items i
      join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
      where i.organization_id = p_org and d.dc_type = 'inward'
        and d.status not in ('draft', 'cancelled') and d.deleted_at is null
        and i.inspection_required),
    'open_material_rejections', (
      select count(*) from public.dc_rejections r
      where r.organization_id = p_org and r.status in ('open', 'partially_returned')),
    'pending_return_quantity', (
      select coalesce(sum(r.quantity_rejected - r.quantity_returned - r.quantity_scrapped), 0)
      from public.dc_rejections r
      where r.organization_id = p_org and r.status in ('open', 'partially_returned')),
    'material_at_vendors', (
      select count(*) from public.dc_documents d
      where d.organization_id = p_org and d.dc_type = 'outward_self'
        and d.status in ('issued', 'dispatched') and d.deleted_at is null),
    'machining_rejections_this_month', (
      select coalesce(sum(r.machining_rejection_quantity), 0) from public.dc_machining_results r
      where r.organization_id = p_org
        and r.operation_date >= date_trunc('month', current_date)::date),
    'machining_results_recorded', (
      select count(*) from public.dc_machining_results r where r.organization_id = p_org)
  );
end;
$$;

revoke all on function public.dc_dashboard_summary(uuid) from public, anonymous;
grant execute on function public.dc_dashboard_summary(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- dc_available_balance
-- ---------------------------------------------------------------------------
create or replace function public.dc_available_balance(
  p_org uuid,
  p_customer_id uuid,
  p_part text,
  p_supply_source text
)
returns numeric
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  if not app_private.is_org_member(p_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'you are not a member of this workspace');
  end if;

  return app_private.dc_available_balance(
    p_org, p_customer_id, coalesce(nullif(btrim(p_part), ''), ''), coalesce(p_supply_source, 'customer_material')
  );
end;
$$;

revoke all on function public.dc_available_balance(uuid, uuid, text, text) from public, anonymous;
grant execute on function public.dc_available_balance(uuid, uuid, text, text) to authenticated;

commit;