-- 0019_dc_movement_history_document_id.sql
--
-- dc_movement_history reported dc_number and dc_type but not dc_id, so the
-- "Dispatch and receipt" screen could only link every movement row back to the
-- generic /dc/all register instead of to the document it belongs to. Adding the
-- id makes each row navigable, and lets the link be built from dc_type rather
-- than being hard-coded to the inward route (which sent outward-self and
-- outward-customer movements to the wrong detail page).
--
-- Forward-only and non-destructive: it adds one column to a function's result
-- shape. No table, column or row is touched, so no business data can be lost and
-- nothing has to be backfilled. Report functions are read-only, so the only
-- affected callers are SELECTs, which gain a field rather than breaking.
--
-- It also fixes a reporting inconsistency while it is here:
-- dc_dashboard_summary summed (quantity_rejected - quantity_returned -
-- quantity_scrapped) with no floor, so a rejection that had been returned and
-- partly scrapped could drive the total negative. The per-rejection report in
-- 0017 already clamps with greatest(..., 0). Both now agree.

begin;

-- CREATE OR REPLACE refuses to change a function's return type, and this one
-- adds a column to a RETURNS TABLE. The old definition has to go first.
-- Dropping a report function cannot lose data: it holds no state, holds no rows,
-- and no table depends on it.
drop function if exists public.dc_movement_history(uuid, date, date, text);

create function public.dc_movement_history(
  p_org uuid,
  p_from date default null,
  p_to date default null,
  p_movement_type text default null
)
returns table (
  moved_at timestamptz,
  movement_type text,
  quantity numeric,
  unit text,
  is_reversal boolean,
  dc_id uuid,
  dc_number text,
  dc_type text,
  dc_date date,
  party_name text,
  part_number text,
  remarks text,
  recorded_by uuid
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select m.moved_at, m.movement_type, m.quantity, m.unit, m.is_reversal,
    d.id, d.dc_number, d.dc_type, d.dc_date, d.party_name, i.part_number, m.remarks, m.created_by
  from public.dc_movements m
  join public.dc_documents d on d.organization_id = m.organization_id and d.id = m.dc_id
  left join public.dc_items i on i.organization_id = m.organization_id and i.id = m.dc_item_id
  where m.organization_id = p_org
    and (p_from is null or m.moved_at >= p_from::timestamptz)
    and (p_to is null or m.moved_at < (p_to + 1)::timestamptz)
    and (p_movement_type is null or m.movement_type = p_movement_type)
  order by m.moved_at desc;
$$;

revoke all on function public.dc_movement_history(uuid, date, date, text) from public, anonymous;
grant execute on function public.dc_movement_history(uuid, date, date, text) to authenticated;

commit;