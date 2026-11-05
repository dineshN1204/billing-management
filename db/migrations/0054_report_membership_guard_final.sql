-- ---------------------------------------------------------------------------
-- 0054: close the five remaining report-guard gaps
--
-- Migration 0034 rewrote ten report functions as plpgsql with an
-- is_org_member guard. Six of them were created earlier as `language sql`
-- (dc_acceptance_rate and dc_register by 0017/0026, dc_machining_rejections,
-- dc_material_rejections and dc_variance_report by 0028, dc_movement_history and
-- dc_pending_customer_delivery by 0019/0030). `CREATE OR REPLACE` cannot change
-- a function's language, so the five below remained `language sql` with no
-- guard: SECURITY DEFINER reports that a caller from another workspace could
-- read by passing a foreign p_org. This is the live authorization gap described
-- in KNOWN_ISSUES #26.
--
-- Each function is dropped and recreated with the identical signature, return
-- type and body, wrapped in the same auth + is_org_member guard 0034 uses.
-- DROP+CREATE (not CREATE OR REPLACE) is required to switch from `language sql`
-- to `language plpgsql`. No data changes; forward-only.
-- ---------------------------------------------------------------------------
begin;

-- ---------------------------------------------------------------------------
-- dc_machining_rejections
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
end;
$$;

revoke all on function public.dc_machining_rejections(uuid, date, date) from public, anonymous;
grant execute on function public.dc_machining_rejections(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- dc_material_rejections
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
end;
$$;

revoke all on function public.dc_material_rejections(uuid, date, date) from public, anonymous;
grant execute on function public.dc_material_rejections(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- dc_movement_history
-- ---------------------------------------------------------------------------
drop function if exists public.dc_movement_history(uuid, date, date, text);

create function public.dc_movement_history(p_org uuid, p_from date default null, p_to date default null, p_movement_type text default null)
returns table (
  moved_at timestamp with time zone,
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
end;
$$;

revoke all on function public.dc_movement_history(uuid, date, date, text) from public, anonymous;
grant execute on function public.dc_movement_history(uuid, date, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- dc_pending_customer_delivery
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
  dispatch_at timestamp with time zone,
  expected_arrival_at timestamp with time zone,
  status text,
  proof_of_delivery_ref text,
  receiver_name text,
  actual_delivery_at timestamp with time zone
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
end;
$$;

revoke all on function public.dc_pending_customer_delivery(uuid) from public, anonymous;
grant execute on function public.dc_pending_customer_delivery(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- dc_variance_report
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
end;
$$;

revoke all on function public.dc_variance_report(uuid, date, date) from public, anonymous;
grant execute on function public.dc_variance_report(uuid, date, date) to authenticated;

commit;
