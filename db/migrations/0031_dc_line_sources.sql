-- ---------------------------------------------------------------------------
-- 0031 - reading where each line came from
--
-- Why a function and not a column join
-- ------------------------------------
-- `dc_document_json` (0026) resolves the source of every line, but the browser
-- does not read a challan through it. `loadDcBundle` in src/lib/dc-api.ts
-- reads dc_documents and dc_items directly over the Data API, in parallel, and
-- reports a partial failure as a warning rather than showing an empty challan.
-- Replacing that with a single RPC would trade a resilient read for a single
-- point of failure.
--
-- So the resolution is a separate read that merges into the items the page
-- already has. It is additive: if it fails, the lines still render, without the
-- source columns, and the failure is reported the same way any other partial
-- read is.
--
-- One row per line of the document that has a source.
-- ---------------------------------------------------------------------------

begin;

create or replace function public.dc_line_sources(p_org uuid, p_dc_id uuid)
returns table (
  item_id uuid,
  line_no integer,
  source_inward_item_id uuid,
  source_inward_dc_id uuid,
  source_inward_dc_number text,
  source_inward_line_no integer,
  source_inward_customer_dc_number text,
  source_inward_accepted_qty numeric,
  source_available_qty numeric
)
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

  return query
  select
    oi.id,
    oi.line_no,
    oi.source_inward_item_id,
    si.id,
    sd.dc_number,
    si.line_no,
    si.customer_dc_number,
    si.accepted_qty,
    app_private.dc_inward_line_available(p_org, si.id)
  from public.dc_items oi
  join public.dc_documents d
    on d.organization_id = oi.organization_id and d.id = oi.dc_id
  left join public.dc_items si
    on si.organization_id = oi.organization_id and si.id = oi.source_inward_item_id
  left join public.dc_documents sd
    on sd.organization_id = si.organization_id and sd.id = si.dc_id
  where oi.organization_id = p_org
    and oi.dc_id = p_dc_id
    and d.deleted_at is null
    and oi.source_inward_item_id is not null
  order by oi.line_no;
end;
$$;

revoke all on function public.dc_line_sources(uuid, uuid) from public, anonymous;
grant execute on function public.dc_line_sources(uuid, uuid) to authenticated;

commit;
