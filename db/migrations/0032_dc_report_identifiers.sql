-- ---------------------------------------------------------------------------
-- 0032 - the identifiers the reports were missing
--
-- The class of bug this fixes
-- --------------------------
-- Several report functions returned a DC **number** but not its **id**. The
-- pages that render those rows build a link out of the id:
--
--   <Link to={`/dc/inward/${row.dc_id}`}>{row.dc_number}</Link>
--
-- With no dc_id in the row that is `/dc/inward/undefined`, which matches the
-- route, loads the challan screen, and reports "Challan not found". The
-- operator clicks a real, correct DC number and gets told the challan does not
-- exist.
--
-- Three were affected:
--
--   dc_material_rejections  returned dc_number, no dc_id   -> link to /dc/inward/undefined
--   dc_variance_report      returned dc_number, no dc_id   -> no link at all
--   dc_machining_rejections returned neither               -> no DC column to click
--
-- Two more were incomplete rather than broken:
--
--   dc_pending_customer_delivery  returns dc_id but no dc_type, so the page has
--     to hardcode `/dc/outward/customer/...` to get the right route
--   dc_inward_lines                returns no inspection state, so the outward
--     picker cannot tell a fully judged line from one with material still
--     sitting un-inspected
--
-- CREATE OR REPLACE refuses to change a RETURNS TABLE, so each is dropped and
-- recreated - the same way 0019 handled dc_movement_history and 0025 handled
-- dc_pending_customer_delivery. Dropping a report function cannot lose anything:
-- it holds no state and no row.
--
-- Forward-only: report functions only. No table is touched and no row is
-- rewritten.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. dc_material_rejections gains the challan it came from
-- ---------------------------------------------------------------------------

drop function if exists public.dc_material_rejections(uuid, date, date);

create function public.dc_material_rejections(p_org uuid, p_from date default null, p_to date default null)
returns table (
  dc_id uuid,
  dc_number text,
  dc_date date,
  dc_type text,
  party_id uuid,
  party_name text,
  part_number text,
  batch_lot_no text,
  quantity_received numeric,
  quantity_inspected numeric,
  quantity_accepted numeric,
  quantity_rejected numeric,
  quantity_returned numeric,
  quantity_scrapped numeric,
  outstanding numeric,
  rejection_date date,
  rejection_reason text,
  disposition text,
  status text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select d.id, d.dc_number, d.dc_date, d.dc_type, d.party_id, d.party_name, r.part_number, r.batch_lot_no,
    r.quantity_received, r.quantity_inspected, r.quantity_accepted, r.quantity_rejected,
    r.quantity_returned, r.quantity_scrapped,
    greatest(r.quantity_rejected - r.quantity_returned - r.quantity_scrapped, 0),
    r.rejection_date, r.rejection_reason, r.disposition, r.status
  from public.dc_rejections r
  join public.dc_documents d on d.organization_id = r.organization_id and d.id = r.dc_id
  where r.organization_id = p_org
    and d.deleted_at is null
    and (p_from is null or r.rejection_date >= p_from)
    and (p_to is null or r.rejection_date <= p_to)
  order by r.rejection_date desc, r.created_at desc;
$$;

revoke all on function public.dc_material_rejections(uuid, date, date) from public, anonymous;
grant execute on function public.dc_material_rejections(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. dc_machining_rejections gains the challan it was recorded on
--
-- A machining result is filed against the OUTWARD challan whose work it
-- describes (source_dc_id), which is what a person reading a rejection wants
-- to open. The inward challan the material came from is reported too, but only
-- so the row can say which inward line the loss belongs to - the link itself
-- goes to the outward challan.
-- ---------------------------------------------------------------------------

drop function if exists public.dc_machining_rejections(uuid, date, date);

create function public.dc_machining_rejections(p_org uuid, p_from date default null, p_to date default null)
returns table (
  id uuid,
  source_dc_id uuid,
  source_dc_number text,
  source_dc_type text,
  source_dc_item_id uuid,
  inward_dc_id uuid,
  inward_dc_number text,
  operation_date date,
  operation text,
  party_id uuid,
  party_name text,
  material_owner_id uuid,
  part_number text,
  input_quantity numeric,
  input_unit text,
  accepted_output_quantity numeric,
  output_unit text,
  machining_rejection_quantity numeric,
  rework_quantity numeric,
  scrap_quantity numeric,
  process_loss_quantity numeric,
  unit_conversion boolean,
  rejection_reason text,
  operator_name text,
  inspector_name text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    r.id,
    d.id,
    d.dc_number,
    d.dc_type,
    r.source_dc_item_id,
    inw.id,
    inw.dc_number,
    r.operation_date,
    r.operation,
    r.party_id,
    c.name,
    r.material_owner_id,
    r.part_number,
    r.input_quantity,
    r.input_unit,
    r.accepted_output_quantity,
    r.output_unit,
    r.machining_rejection_quantity,
    r.rework_quantity,
    r.scrap_quantity,
    r.process_loss_quantity,
    r.unit_conversion,
    r.rejection_reason,
    r.operator_name,
    r.inspector_name
  from public.dc_machining_results r
  left join public.dc_documents d
    on d.organization_id = r.organization_id and d.id = r.source_dc_id
  -- The outward line the result was filed against, and through it the inward
  -- line the material was drawn from (0026).
  left join public.dc_items oi
    on oi.organization_id = r.organization_id and oi.id = r.source_dc_item_id
  left join public.dc_items si
    on si.organization_id = oi.organization_id and si.id = oi.source_inward_item_id
  left join public.dc_documents inw
    on inw.organization_id = si.organization_id and inw.id = si.dc_id
  left join public.customers c on c.organization_id = r.organization_id and c.id = r.party_id
  where r.organization_id = p_org
    and (p_from is null or r.operation_date >= p_from)
    and (p_to is null or r.operation_date <= p_to)
  order by r.operation_date desc, r.created_at desc;
$$;

revoke all on function public.dc_machining_rejections(uuid, date, date) from public, anonymous;
grant execute on function public.dc_machining_rejections(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. dc_variance_report gains the challan it summarises
-- ---------------------------------------------------------------------------

drop function if exists public.dc_variance_report(uuid, date, date);

create function public.dc_variance_report(p_org uuid, p_from date default null, p_to date default null)
returns table (
  dc_id uuid,
  dc_number text,
  dc_date date,
  dc_type text,
  party_id uuid,
  party_name text,
  part_number text,
  batch_lot_no text,
  unit text,
  declared_qty numeric,
  received_qty numeric,
  shortage_qty numeric,
  excess_qty numeric,
  rejected_qty numeric
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select d.id, d.dc_number, d.dc_date, d.dc_type, d.party_id, d.party_name, i.part_number, i.batch_lot_no, i.unit,
    i.declared_qty, i.received_qty, i.shortage_qty, i.excess_qty, i.rejected_qty
  from public.dc_items i
  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
  where i.organization_id = p_org
    and d.dc_type = 'inward'
    and d.status not in ('draft', 'cancelled')
    and d.deleted_at is null
    and (i.shortage_qty > 0 or i.excess_qty > 0 or i.rejected_qty > 0)
    and (p_from is null or d.dc_date >= p_from)
    and (p_to is null or d.dc_date <= p_to)
  order by d.dc_date desc, d.dc_number, i.line_no;
$$;

revoke all on function public.dc_variance_report(uuid, date, date) from public, anonymous;
grant execute on function public.dc_variance_report(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. dc_pending_customer_delivery gains its document type
--
-- Without it the page has to hardcode `/dc/outward/customer/...` to reach the
-- right screen. That route still resolves as an alias, so nothing is broken -
-- it is one hardcoded path away from being wrong.
-- ---------------------------------------------------------------------------

drop function if exists public.dc_pending_customer_delivery(uuid);

create function public.dc_pending_customer_delivery(p_org uuid)
returns table (
  dc_id uuid,
  dc_number text,
  dc_date date,
  dc_type text,
  party_id uuid,
  party_name text,
  party_gstin text,
  delivery_purpose text,
  qty_dispatched numeric,
  qty_delivered numeric,
  qty_outstanding numeric,
  dispatch_at timestamptz,
  expected_arrival_at timestamptz,
  status text,
  proof_of_delivery_ref text,
  receiver_name text,
  actual_delivery_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select d.id, d.dc_number, d.dc_date, d.dc_type, d.party_id, d.party_name, d.party_gstin, d.delivery_purpose,
    coalesce((select sum(i.qty_dispatched) from public.dc_items i
              where i.organization_id = d.organization_id and i.dc_id = d.id), 0),
    coalesce((select sum(i.qty_delivered) from public.dc_items i
              where i.organization_id = d.organization_id and i.dc_id = d.id), 0),
    coalesce((select sum(greatest(i.qty_dispatched - i.qty_delivered, 0)) from public.dc_items i
              where i.organization_id = d.organization_id and i.dc_id = d.id), 0),
    d.dispatch_at, d.expected_arrival_at, d.status, d.proof_of_delivery_ref, d.receiver_name, d.actual_delivery_at
  from public.dc_documents d
  where d.organization_id = p_org
    and d.dc_type = 'outward_customer'
    and d.status in ('issued', 'dispatched', 'partially_delivered')
    and d.deleted_at is null
  order by d.dc_date desc, d.dc_number desc;
$$;

revoke all on function public.dc_pending_customer_delivery(uuid) from public, anonymous;
grant execute on function public.dc_pending_customer_delivery(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. dc_inward_lines gains the inspection state
--
-- The outward picker has to be able to say "fully received and inspected"
-- before material is put on a delivery. It could not: the function returned
-- received and accepted but neither what is still pending inspection nor the
-- inspection status, so a line with 100 received, 90 accepted and 10 awaiting
-- inspection was indistinguishable from a finished one - and both offered
-- 90 as available.
--
-- `fully_inspected` is the flag the picker reads. It is true once nothing is
-- left awaiting a decision, which is not the same as "no material was
-- rejected": 90 accepted and 10 rejected is fully inspected, and the 90 is
-- exactly what can go back.
-- ---------------------------------------------------------------------------

drop function if exists public.dc_inward_lines(uuid, uuid, text);

create function public.dc_inward_lines(
  p_org uuid,
  p_party uuid,
  p_query text default null
)
returns table (
  inward_dc_id uuid,
  inward_dc_number text,
  inward_dc_date date,
  inward_status text,
  item_id uuid,
  line_no integer,
  part_number text,
  customer_part_number text,
  customer_dc_number text,
  drawing_number text,
  drawing_revision text,
  batch_lot_no text,
  unit text,
  received_qty numeric,
  accepted_qty numeric,
  rejected_qty numeric,
  pending_inspection_qty numeric,
  inspection_status text,
  fully_inspected boolean,
  machining_rejection_qty numeric,
  dispatched_qty numeric,
  available_qty numeric
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

  if p_party is null then
    perform app_private.raise_validation('party_id', 'is required');
  end if;

  return query
  with src as (
    select
      i.id as item_id,
      i.line_no,
      i.part_number,
      i.customer_part_number,
      i.customer_dc_number,
      i.drawing_number,
      i.drawing_revision,
      i.batch_lot_no,
      i.unit,
      i.received_qty,
      i.accepted_qty,
      i.rejected_qty,
      i.pending_inspection_qty,
      i.inspection_status,
      d.id as dc_id,
      d.dc_number,
      d.dc_date,
      d.status,
      d.external_dc_number
    from public.dc_items i
    join public.dc_documents d
      on d.organization_id = i.organization_id and d.id = i.dc_id
    where i.organization_id = p_org
      and d.party_id = p_party
      and d.dc_type = 'inward'
      and d.deleted_at is null
      and d.status not in ('draft', 'cancelled')
  ),
  filtered as (
    select s.*
    from src s
    where p_query is null or btrim(p_query) = '' or (
      s.part_number ilike '%' || p_query || '%'
      or coalesce(s.customer_dc_number, '') ilike '%' || p_query || '%'
      or coalesce(s.external_dc_number, '') ilike '%' || p_query || '%'
      or s.dc_number ilike '%' || p_query || '%'
      or coalesce(s.drawing_number, '') ilike '%' || p_query || '%'
    )
  )
  select
    f.dc_id,
    f.dc_number,
    f.dc_date,
    f.status,
    f.item_id,
    f.line_no,
    f.part_number,
    f.customer_part_number,
    f.customer_dc_number,
    f.drawing_number,
    f.drawing_revision,
    f.batch_lot_no,
    f.unit,
    f.received_qty,
    f.accepted_qty,
    f.rejected_qty,
    f.pending_inspection_qty,
    f.inspection_status,
    (f.pending_inspection_qty <= 0 and f.inspection_status <> 'not_required')
      or f.inspection_status = 'not_required',
    coalesce((
      select sum(m.machining_rejection_quantity)
      from public.dc_machining_results m
      join public.dc_items oi
        on oi.organization_id = m.organization_id and oi.id = m.source_dc_item_id
      where m.organization_id = p_org and oi.source_inward_item_id = f.item_id
    ), 0),
    coalesce((
      select sum(oi.qty_dispatched)
      from public.dc_items oi
      join public.dc_documents od
        on od.organization_id = oi.organization_id and od.id = oi.dc_id
      where oi.organization_id = p_org
        and oi.source_inward_item_id = f.item_id
        and od.dc_type = 'outward_customer'
        and od.status not in ('draft', 'cancelled')
        and od.deleted_at is null
    ), 0),
    app_private.dc_inward_line_available(p_org, f.item_id)
  from filtered f
  where app_private.dc_inward_line_available(p_org, f.item_id) > 0
  order by (f.pending_inspection_qty <= 0) desc, f.dc_date desc, f.dc_number desc, f.line_no;
end;
$$;

revoke all on function public.dc_inward_lines(uuid, uuid, text) from public, anonymous;
grant execute on function public.dc_inward_lines(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Finding a bill from a customer DC number
--
-- The bill list searches bill_number. Since 0029 a bill can be linked to the
-- challans it bills for, so a customer DC number can identify a bill - but
-- only by leaving the bill number and opening a challan to find it.
--
-- A small function returning just the ids, rather than a second bill query, so
-- the list keeps its own date, financial-year and payment-status filters.
-- ---------------------------------------------------------------------------

create or replace function public.bill_ids_for_customer_dc(p_org uuid, p_query text)
returns table (
  bill_id uuid,
  bill_number text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_term text;
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  if not app_private.is_org_member(p_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'you are not a member of this workspace');
  end if;

  v_term := btrim(coalesce(p_query, ''));
  if v_term = '' then
    return;
  end if;

  return query
  select distinct b.id, b.bill_number
  from public.bills b
  join public.bill_dc_links l
    on l.organization_id = b.organization_id and l.bill_id = b.id
  join public.dc_documents d
    on d.organization_id = l.organization_id and d.id = l.dc_id
  where b.organization_id = p_org
    and b.deleted_at is null
    -- Two places the customer's number can sit, and on an OUTWARD challan it is
    -- always the second: the challan is linked to the bill, and its own lines
    -- carry no customer number at all - the number is on the inward line the
    -- material was drawn from (0026). Checking only d's own items would find
    -- nothing for exactly the challans a job-work bill is raised against.
    and (
      exists (
        select 1 from public.dc_items i
        where i.organization_id = b.organization_id and i.dc_id = d.id
          and coalesce(i.customer_dc_number, '') ilike '%' || v_term || '%'
      )
      or exists (
        select 1
        from public.dc_items oi
        join public.dc_items si
          on si.organization_id = oi.organization_id and si.id = oi.source_inward_item_id
        where oi.organization_id = b.organization_id and oi.dc_id = d.id
          and coalesce(si.customer_dc_number, '') ilike '%' || v_term || '%'
      )
    )
  order by b.bill_number;
end;
$$;

revoke all on function public.bill_ids_for_customer_dc(uuid, text) from public, anonymous;
grant execute on function public.bill_ids_for_customer_dc(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. The challans a bill pays for
--
-- One bill can cover several outward challans (a customer invoiced for a
-- month's deliveries together) and one challan can be billed across several
-- bills (part settlement). So the bill side is a list, not a reference, and it
-- has to be read the same way `dc_billable_lines` is written.
-- ---------------------------------------------------------------------------

create or replace function public.bills_for_dc_summary(p_org uuid, p_bill_id uuid)
returns table (
  dc_id uuid,
  dc_number text,
  dc_date date,
  dc_type text,
  dc_status text,
  customer_dc_numbers jsonb,
  line_count bigint,
  total_dispatched numeric,
  total_delivered numeric
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
    d.id,
    d.dc_number,
    d.dc_date,
    d.dc_type,
    d.status,
    coalesce((
      select jsonb_agg(x.dc order by x.dc)
      from (
        select i.customer_dc_number as dc
        from public.dc_items i
        where i.organization_id = p_org and i.dc_id = d.id and i.customer_dc_number is not null
        union
        select s.customer_dc_number as dc
        from public.dc_items oi
        join public.dc_items s
          on s.organization_id = oi.organization_id and s.id = oi.source_inward_item_id
        where oi.organization_id = p_org and oi.dc_id = d.id and s.customer_dc_number is not null
      ) x
    ), '[]'::jsonb),
    count(i.id),
    coalesce(sum(i.qty_dispatched), 0),
    coalesce(sum(i.qty_delivered), 0)
  from public.bill_dc_links l
  join public.dc_documents d
    on d.organization_id = l.organization_id and d.id = l.dc_id
  left join public.dc_items i
    on i.organization_id = d.organization_id and i.dc_id = d.id
  where l.organization_id = p_org
    and l.bill_id = p_bill_id
    and d.deleted_at is null
  group by d.id, d.dc_number, d.dc_date, d.dc_type, d.status
  order by d.dc_date desc, d.dc_number desc;
end;
$$;

revoke all on function public.bills_for_dc_summary(uuid, uuid) from public, anonymous;
grant execute on function public.bills_for_dc_summary(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Everything a delivery can be billed from
--
-- `dc_search` already returns the challan and its quantities, but a bill needs
-- the LINES: part, quantity, unit, and the product and HSN codes the billing
-- module bills by. `dc_items` carries no rate and no amount - a challan is a
-- record of movement, not of money - so every price on the resulting bill is
-- left for the operator to type. That is stated here because it is the one
-- thing this function deliberately does not supply.
-- ---------------------------------------------------------------------------

create or replace function public.dc_billable_lines(p_org uuid, p_dc_id uuid)
returns table (
  dc_number text,
  dc_date date,
  dc_type text,
  party_id uuid,
  party_name text,
  party_gstin text,
  party_state_code text,
  party_address text,
  customer_dc_numbers jsonb,
  item_id uuid,
  line_no integer,
  product_id uuid,
  part_number text,
  customer_part_number text,
  description text,
  unit text,
  qty_dispatched numeric,
  qty_delivered numeric
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
  with doc as (
    select d.id, d.dc_number, d.dc_date, d.dc_type, d.party_id, d.party_name, d.party_gstin,
      d.party_state_code, d.party_address
    from public.dc_documents d
    where d.organization_id = p_org
      and d.id = p_dc_id
      and d.dc_type = 'outward_customer'
      and d.deleted_at is null
  )
  select
    doc.dc_number,
    doc.dc_date,
    doc.dc_type,
    doc.party_id,
    doc.party_name,
    doc.party_gstin,
    doc.party_state_code,
    doc.party_address,
    coalesce((
      select jsonb_agg(x.dc order by x.dc)
      from (
        select s.customer_dc_number as dc
        from public.dc_items oi
        join public.dc_items s
          on s.organization_id = oi.organization_id and s.id = oi.source_inward_item_id
        where oi.organization_id = p_org and oi.dc_id = doc.id and s.customer_dc_number is not null
      ) x
    ), '[]'::jsonb),
    i.id,
    i.line_no,
    i.product_id,
    i.part_number,
    i.customer_part_number,
    i.description,
    i.unit,
    i.qty_dispatched,
    i.qty_delivered
  from doc
  join public.dc_items i on i.organization_id = p_org and i.dc_id = doc.id
  where i.qty_dispatched > 0
  order by i.line_no;
end;
$$;

revoke all on function public.dc_billable_lines(uuid, uuid) from public, anonymous;
grant execute on function public.dc_billable_lines(uuid, uuid) to authenticated;

commit;
