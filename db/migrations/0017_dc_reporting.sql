-- 0017: Delivery Challan reporting.
--
-- Every function here reads real source rows. Where a figure cannot exist -
-- machining results recorded before this module existed, for instance - the
-- query returns zero rows for that report rather than an invented number, and
-- the screen says so.
--
-- The ledger is deliberately column-per-bucket rather than one "balance".
-- "600 issued, 570 accepted back" is 600 at the vendor AND 570 finished. Those
-- are different facts and collapsing them into a single remaining-quantity
-- figure is exactly the mistake this module exists to prevent.

-- ---------------------------------------------------------------------------
-- Shared date predicate
--
-- Defined first: a SQL-language function body is validated when it is created,
-- so every function below may call this one.
-- ---------------------------------------------------------------------------

create or replace function public._dc_in_range(p_value date, p_from date, p_to date)
returns boolean
language sql
immutable
as $$
  select (p_from is null or p_value >= p_from) and (p_to is null or p_value <= p_to);
$$;

revoke all on function public._dc_in_range(date, date, date) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- Customer material ledger
-- ---------------------------------------------------------------------------

create or replace function public.customer_material_ledger(
  p_org uuid,
  p_customer_id uuid,
  p_part text default null,
  p_from date default null,
  p_to date default null
)
returns table (
  part_number text,
  unit text,
  declared_total numeric,
  received_total numeric,
  shortage_total numeric,
  excess_total numeric,
  damaged_total numeric,
  accepted_material numeric,
  rejected_material numeric,
  pending_inspection numeric,
  issued_for_processing numeric,
  returned_from_processing numeric,
  still_at_vendor numeric,
  accepted_return numeric,
  accepted_output numeric,
  machining_rejection numeric,
  rework_total numeric,
  scrap_total numeric,
  process_loss_total numeric,
  dispatched_to_customer numeric,
  ordered_quantity numeric,
  remaining_to_order numeric,
  available_customer_material numeric,
  available_finished_stock numeric
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
with parts as (
  select distinct i.part_number, i.unit
  from public.dc_items i
  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
  where i.organization_id = p_org
    and d.party_id = p_customer_id
    and d.deleted_at is null
    and (p_part is null or i.part_number = p_part)
),
inward as (
  select
    i.part_number,
    sum(i.declared_qty) filter (where _dc_in_range(d.dc_date, p_from, p_to)) as declared,
    sum(i.received_qty) filter (where _dc_in_range(d.dc_date, p_from, p_to)) as received,
    sum(i.shortage_qty) filter (where _dc_in_range(d.dc_date, p_from, p_to)) as shortage,
    sum(i.excess_qty) filter (where _dc_in_range(d.dc_date, p_from, p_to)) as excess,
    sum(i.damaged_qty) filter (where _dc_in_range(d.dc_date, p_from, p_to)) as damaged,
    sum(i.accepted_qty) filter (where _dc_in_range(d.dc_date, p_from, p_to) and i.supply_source = 'customer_material') as accepted_material,
    sum(i.accepted_qty) filter (where _dc_in_range(d.dc_date, p_from, p_to) and i.supply_source = 'finished_stock') as accepted_finished,
    sum(i.rejected_qty) filter (where _dc_in_range(d.dc_date, p_from, p_to)) as rejected,
    sum(i.pending_inspection_qty) filter (where _dc_in_range(d.dc_date, p_from, p_to)) as pending
  from public.dc_items i
  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
  where i.organization_id = p_org
    and d.party_id = p_customer_id
    and d.dc_type = 'inward'
    and d.status not in ('draft', 'cancelled')
    and d.deleted_at is null
    and (p_part is null or i.part_number = p_part)
  group by i.part_number
),
-- Issued and returned material belongs to the CUSTOMER, not to the destination
-- vendor. dc_items.material_owner_id records that owner; it is null only for
-- lines created before the column existed, where the header party is the best
-- available answer.
outward_self as (
  select
    i.part_number,
    coalesce(i.material_owner_id, d.party_id) as owner_id,
    sum(i.qty_sent) as issued,
    sum(i.returned_qty) as returned,
    sum(i.accepted_return_qty) as accepted_return,
    sum(greatest(i.qty_sent - i.returned_qty, 0)) as at_vendor
  from public.dc_items i
  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
  where i.organization_id = p_org
    and d.dc_type = 'outward_self'
    and d.status not in ('draft', 'cancelled')
    and d.deleted_at is null
    and (p_part is null or i.part_number = p_part)
  group by i.part_number, coalesce(i.material_owner_id, d.party_id)
),
outward_customer as (
  select i.part_number, sum(i.qty_dispatched) as dispatched
  from public.dc_items i
  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
  where i.organization_id = p_org
    and d.party_id = p_customer_id
    and d.dc_type = 'outward_customer'
    and d.status not in ('draft', 'cancelled')
    and d.deleted_at is null
    and (p_part is null or i.part_number = p_part)
  group by i.part_number
),
machining as (
  select
    r.part_number,
    sum(r.accepted_output_quantity) as accepted_output,
    sum(r.machining_rejection_quantity) as machining_rejection,
    sum(r.rework_quantity) as rework,
    sum(r.scrap_quantity) as scrap,
    sum(r.process_loss_quantity) as loss
  from public.dc_machining_results r
  where r.organization_id = p_org
    and r.material_owner_id = p_customer_id
    and (p_part is null or r.part_number = p_part)
    and _dc_in_range(r.operation_date, p_from, p_to)
  group by r.part_number
),
orders as (
  select poi.part_number, sum(poi.ordered_quantity) as ordered
  from public.production_order_items poi
  join public.production_orders po on po.organization_id = poi.organization_id and po.id = poi.production_order_id
  where poi.organization_id = p_org
    and po.customer_id = p_customer_id
    and po.deleted_at is null
    and (p_part is null or poi.part_number = p_part)
  group by poi.part_number
)
select
  p.part_number,
  p.unit,
  coalesce(nw.declared, 0),
  coalesce(nw.received, 0),
  coalesce(nw.shortage, 0),
  coalesce(nw.excess, 0),
  coalesce(nw.damaged, 0),
  coalesce(nw.accepted_material, 0),
  coalesce(nw.rejected, 0),
  coalesce(nw.pending, 0),
  coalesce(os.issued, 0),
  coalesce(os.returned, 0),
  coalesce(os.at_vendor, 0),
  coalesce(os.accepted_return, 0),
  coalesce(m.accepted_output, 0) + coalesce(nw.accepted_finished, 0),
  coalesce(m.machining_rejection, 0),
  coalesce(m.rework, 0),
  coalesce(m.scrap, 0),
  coalesce(m.loss, 0),
  coalesce(oc.dispatched, 0),
  coalesce(o.ordered, 0),
  greatest(coalesce(o.ordered, 0) - coalesce(oc.dispatched, 0), 0),
  coalesce(nw.accepted_material, 0) - coalesce(os.issued, 0) + coalesce(os.returned, 0),
  coalesce(m.accepted_output, 0) + coalesce(nw.accepted_finished, 0) - coalesce(oc.dispatched, 0)
from parts p
left join inward nw on nw.part_number = p.part_number
left join outward_self os on os.part_number = p.part_number and os.owner_id = p_customer_id
left join outward_customer oc on oc.part_number = p.part_number
left join machining m on m.part_number = p.part_number
left join orders o on o.part_number = p.part_number
order by p.part_number;
$$;

revoke all on function public.customer_material_ledger(uuid, uuid, text, date, date) from public, anonymous;
grant execute on function public.customer_material_ledger(uuid, uuid, text, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Dashboard
-- ---------------------------------------------------------------------------

create or replace function public.dc_dashboard_summary(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
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
-- Registers
-- ---------------------------------------------------------------------------

create or replace function public.dc_register(
  p_org uuid,
  p_dc_type text default null,
  p_from date default null,
  p_to date default null,
  p_status text default null
)
returns table (
  id uuid,
  dc_number text,
  dc_type text,
  dc_date date,
  status text,
  party_id uuid,
  party_name text,
  party_gstin text,
  reference_inward_dc_id uuid,
  reference_inward_number text,
  vehicle_number text,
  line_count bigint,
  total_quantity numeric,
  total_declared numeric
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    d.id,
    d.dc_number,
    d.dc_type,
    d.dc_date,
    d.status,
    d.party_id,
    d.party_name,
    d.party_gstin,
    d.reference_inward_dc_id,
    ref.dc_number,
    d.vehicle_number,
    count(i.id),
    coalesce(sum(
      case when d.dc_type = 'inward' then i.received_qty
           when d.dc_type = 'outward_customer' then i.qty_dispatched
           when d.dc_type = 'outward_self' then i.qty_sent
           when d.dc_type = 'material_return' then i.declared_qty
           else 0 end), 0),
    coalesce(sum(i.declared_qty), 0)
  from public.dc_documents d
  left join public.dc_documents ref on ref.organization_id = d.organization_id and ref.id = d.reference_inward_dc_id
  left join public.dc_items i on i.organization_id = d.organization_id and i.dc_id = d.id
  where d.organization_id = p_org
    and d.deleted_at is null
    and (p_dc_type is null or d.dc_type = p_dc_type)
    and (p_status is null or d.status = p_status)
    and (p_from is null or d.dc_date >= p_from)
    and (p_to is null or d.dc_date <= p_to)
  group by d.id, ref.dc_number
  order by d.dc_date desc, d.created_at desc;
$$;

revoke all on function public.dc_register(uuid, text, date, date, text) from public, anonymous;
grant execute on function public.dc_register(uuid, text, date, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Pending inspection
-- ---------------------------------------------------------------------------

create or replace function public.dc_pending_inspection(p_org uuid, p_from date default null, p_to date default null)
returns table (
  dc_id uuid,
  dc_number text,
  dc_date date,
  party_name text,
  part_number text,
  batch_lot_no text,
  unit text,
  received_qty numeric,
  pending_inspection_qty numeric,
  accepted_qty numeric,
  rejected_qty numeric,
  inspection_status text,
  inspection_date date
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select d.id, d.dc_number, d.dc_date, d.party_name, i.part_number, i.batch_lot_no, i.unit,
    i.received_qty, i.pending_inspection_qty, i.accepted_qty, i.rejected_qty,
    i.inspection_status, i.inspection_date
  from public.dc_items i
  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
  where i.organization_id = p_org
    and d.dc_type = 'inward'
    and d.status not in ('draft', 'cancelled')
    and d.deleted_at is null
    and i.inspection_required
    and i.pending_inspection_qty > 0
    and (p_from is null or d.dc_date >= p_from)
    and (p_to is null or d.dc_date <= p_to)
  order by d.dc_date, d.dc_number, i.line_no;
$$;

revoke all on function public.dc_pending_inspection(uuid, date, date) from public, anonymous;
grant execute on function public.dc_pending_inspection(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Material rejections
-- ---------------------------------------------------------------------------

create or replace function public.dc_material_rejections(p_org uuid, p_from date default null, p_to date default null)
returns table (
  id uuid,
  dc_number text,
  dc_date date,
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
  select r.id, d.dc_number, d.dc_date, r.party_id, d.party_name, r.part_number, r.batch_lot_no,
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
-- Machining rejections (kept separate from material rejection on purpose)
-- ---------------------------------------------------------------------------

create or replace function public.dc_machining_rejections(p_org uuid, p_from date default null, p_to date default null)
returns table (
  id uuid,
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
  select r.id, r.operation_date, r.operation, r.party_id, c.name, r.material_owner_id, r.part_number,
    r.input_quantity, r.input_unit, r.accepted_output_quantity, r.output_unit,
    r.machining_rejection_quantity, r.rework_quantity, r.scrap_quantity, r.process_loss_quantity,
    r.unit_conversion, r.rejection_reason, r.operator_name, r.inspector_name
  from public.dc_machining_results r
  left join public.customers c on c.organization_id = r.organization_id and c.id = r.party_id
  where r.organization_id = p_org
    and (p_from is null or r.operation_date >= p_from)
    and (p_to is null or r.operation_date <= p_to)
  order by r.operation_date desc, r.created_at desc;
$$;

revoke all on function public.dc_machining_rejections(uuid, date, date) from public, anonymous;
grant execute on function public.dc_machining_rejections(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Shortage / excess / damage
-- ---------------------------------------------------------------------------

create or replace function public.dc_variance_report(p_org uuid, p_from date default null, p_to date default null)
returns table (
  dc_number text,
  dc_date date,
  party_name text,
  part_number text,
  batch_lot_no text,
  unit text,
  declared_qty numeric,
  received_qty numeric,
  shortage_qty numeric,
  excess_qty numeric,
  damaged_qty numeric
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select d.dc_number, d.dc_date, d.party_name, i.part_number, i.batch_lot_no, i.unit,
    i.declared_qty, i.received_qty, i.shortage_qty, i.excess_qty, i.damaged_qty
  from public.dc_items i
  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
  where i.organization_id = p_org
    and d.dc_type = 'inward'
    and d.status not in ('draft', 'cancelled')
    and d.deleted_at is null
    and (i.shortage_qty > 0 or i.excess_qty > 0 or i.damaged_qty > 0)
    and (p_from is null or d.dc_date >= p_from)
    and (p_to is null or d.dc_date <= p_to)
  order by d.dc_date desc, d.dc_number, i.line_no;
$$;

revoke all on function public.dc_variance_report(uuid, date, date) from public, anonymous;
grant execute on function public.dc_variance_report(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Material still at vendors
-- ---------------------------------------------------------------------------

create or replace function public.dc_pending_at_vendors(p_org uuid)
returns table (
  dc_id uuid,
  dc_number text,
  dc_date date,
  party_id uuid,
  party_name text,
  part_number text,
  processing_operation text,
  unit text,
  qty_sent numeric,
  returned_qty numeric,
  at_vendor numeric,
  expected_return_at timestamptz,
  status text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select d.id, d.dc_number, d.dc_date, d.party_id, d.party_name, i.part_number,
    i.processing_operation, i.unit, i.qty_sent, i.returned_qty,
    greatest(i.qty_sent - i.returned_qty, 0), d.expected_return_at, d.status
  from public.dc_items i
  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
  where i.organization_id = p_org
    and d.dc_type = 'outward_self'
    and d.status not in ('draft', 'cancelled')
    and d.deleted_at is null
    and i.qty_sent > i.returned_qty
  order by d.dc_date, d.dc_number, i.line_no;
$$;

revoke all on function public.dc_pending_at_vendors(uuid) from public, anonymous;
grant execute on function public.dc_pending_at_vendors(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Customer deliveries awaiting confirmation
-- ---------------------------------------------------------------------------

create or replace function public.dc_pending_customer_delivery(p_org uuid)
returns table (
  dc_id uuid,
  dc_number text,
  dc_date date,
  party_id uuid,
  party_name text,
  party_gstin text,
  delivery_purpose text,
  qty_dispatched numeric,
  dispatch_at timestamptz,
  expected_arrival_at timestamptz,
  status text,
  proof_of_delivery_ref text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select d.id, d.dc_number, d.dc_date, d.party_id, d.party_name, d.party_gstin, d.delivery_purpose,
    coalesce((select sum(i.qty_dispatched) from public.dc_items i
              where i.organization_id = d.organization_id and i.dc_id = d.id), 0),
    d.dispatch_at, d.expected_arrival_at, d.status, d.proof_of_delivery_ref
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
-- Acceptance rate per part
-- ---------------------------------------------------------------------------

create or replace function public.dc_acceptance_rate(p_org uuid, p_from date default null, p_to date default null)
returns table (
  part_number text,
  unit text,
  received_qty numeric,
  inspected_qty numeric,
  accepted_qty numeric,
  rejected_qty numeric,
  rework_qty numeric,
  pending_qty numeric,
  acceptance_rate numeric
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    i.part_number,
    min(i.unit),
    sum(i.received_qty),
    sum(i.inspected_qty),
    sum(i.accepted_qty),
    sum(i.rejected_qty),
    sum(i.rework_qty),
    sum(i.pending_inspection_qty),
    case when sum(i.accepted_qty + i.rejected_qty) > 0
      then round(sum(i.accepted_qty) * 100 / sum(i.accepted_qty + i.rejected_qty), 2)
      else null end
  from public.dc_items i
  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
  where i.organization_id = p_org
    and d.dc_type = 'inward'
    and d.status not in ('draft', 'cancelled')
    and d.deleted_at is null
    and (p_from is null or d.dc_date >= p_from)
    and (p_to is null or d.dc_date <= p_to)
  group by i.part_number
  order by i.part_number;
$$;

revoke all on function public.dc_acceptance_rate(uuid, date, date) from public, anonymous;
grant execute on function public.dc_acceptance_rate(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Rejection trend by month
-- ---------------------------------------------------------------------------

create or replace function public.dc_rejection_trend(p_org uuid)
returns table (
  month date,
  material_rejected numeric,
  machining_rejected numeric,
  material_returned numeric,
  inspected_qty numeric
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with material as (
    select date_trunc('month', r.rejection_date)::date as m,
      sum(r.quantity_rejected) as rejected,
      sum(r.quantity_returned) as returned
    from public.dc_rejections r
    where r.organization_id = p_org
    group by 1
  ),
  machining as (
    select date_trunc('month', r.operation_date)::date as m,
      sum(r.machining_rejection_quantity) as rejected
    from public.dc_machining_results r
    where r.organization_id = p_org
    group by 1
  ),
  inspected as (
    select date_trunc('month', d.dc_date)::date as m, sum(i.inspected_qty) as inspected
    from public.dc_items i
    join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
    where i.organization_id = p_org and d.dc_type = 'inward'
      and d.status not in ('draft', 'cancelled') and d.deleted_at is null
    group by 1
  )
  select
    coalesce(material.m, machining.m, inspected.m),
    coalesce(material.rejected, 0),
    coalesce(machining.rejected, 0),
    coalesce(material.returned, 0),
    coalesce(inspected.inspected, 0)
  from material
  full outer join machining on machining.m = material.m
  full outer join inspected on inspected.m = coalesce(material.m, machining.m)
  order by 1 desc
  limit 24;
$$;

revoke all on function public.dc_rejection_trend(uuid) from public, anonymous;
grant execute on function public.dc_rejection_trend(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Dispatch and receipt history (the movement log, per document)
-- ---------------------------------------------------------------------------

create or replace function public.dc_movement_history(
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
    d.dc_number, d.dc_type, d.dc_date, d.party_name, i.part_number, m.remarks, m.created_by
  from public.dc_movements m
  join public.dc_documents d on d.organization_id = m.organization_id and d.id = m.dc_id
  left join public.dc_items i on i.organization_id = m.organization_id and i.id = m.dc_item_id
  where m.organization_id = p_org
    and d.deleted_at is null
    and (p_movement_type is null or m.movement_type = p_movement_type)
    and (p_from is null or m.moved_at::date >= p_from)
    and (p_to is null or m.moved_at::date <= p_to)
  order by m.moved_at desc
  limit 500;
$$;

revoke all on function public.dc_movement_history(uuid, date, date, text) from public, anonymous;
grant execute on function public.dc_movement_history(uuid, date, date, text) to authenticated;