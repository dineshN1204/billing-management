-- 0034 - membership guards on the ten report functions.
--
-- The hole
-- =========
--
-- Ten report functions in this schema are SECURITY DEFINER, take p_org as their
-- first argument, and filter on organization_id internally - and none of them
-- checked whether the caller was a member of that organization. SECURITY DEFINER
-- runs as the function owner, so the RLS policies in 0015 do not apply to them:
-- any authenticated user could pass any p_org and read another workspace's
-- delivery challans, rejections, machining results and movement history.
--
-- The billing RPCs look identical on the surface - save_bill, update_bill,
-- soft_delete_bill and restore_bill are also SECURITY DEFINER with no guard of
-- their own - but each is a one-line delegate to app_private.upsert_bill or
-- app_private.soft_delete_state, and both of those do check. Nothing to change
-- there.
--
-- The fix
-- =======
--
-- Each function is rewritten as plpgsql with the same signature, the same RETURNS
-- TABLE and the same query, behind the guard customer_material_ledger was given
-- in 0033. CREATE OR REPLACE can change a function's language, so nothing is
-- dropped and no caller changes: the browser calls these by name with named
-- arguments (dcApi.register and friends in src/lib/dc-api.ts) and is unaffected.
--
-- The two error codes are not interchangeable. 0021 exists because
-- app_private.is_org_member() answers false when there is no caller at all, so a
-- function that tested only membership reported a lapsed session as "you are not
-- a member of this workspace" - PT403, which PostgREST surfaces as HTTP 500.
-- isSessionRejected() in src/lib/format.ts matches on 'unauthenticated' and
-- 'authentication required' to refresh the token and replay, and on 401/403, so
-- the wording below is identical to dc_dashboard_summary and must stay that way.
-- An absent token is PT401; a real token from the wrong workspace is PT403.
--
-- The query bodies are reproduced verbatim and, as in 0021, carry no comment
-- inside the function body so pg_get_functiondef stays diffable against the
-- original. Two of them mention an output column name where plpgsql does NOT
-- substitute a variable - dc_register as column aliases (count(i.id) as
-- line_count), dc_rejection_trend inside the string literal 'month' - so no body
-- needed rewriting. A body referencing one of its own output columns bare would
-- have broken, because returns table turns each column name into a plpgsql
-- variable; that is the trap 0033 hit with "column reference part_number is
-- ambiguous".
--
-- Scope was established by audit rather than by listing: every SECURITY DEFINER
-- function in public, in both languages, tested for any authorization reference.
-- These ten were the complete set, and the audit is what established it.
--
-- Forward-only: ten functions replaced by their previous logic behind a guard.
-- No table is touched and no row is read or written by this migration.

begin;

-- dc_acceptance_rate
-- ------------------

create or replace function public.dc_acceptance_rate(p_org uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
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
end;
$$;

revoke all on function public.dc_acceptance_rate(uuid, date, date) from public, anonymous;
grant execute on function public.dc_acceptance_rate(uuid, date, date) to authenticated;

-- dc_linked_bills
-- ---------------

create or replace function public.dc_linked_bills(p_org uuid, p_dc_id uuid)
returns table (
  bill_id uuid,
  bill_number text,
  bill_date date,
  customer_id uuid,
  customer_name text,
  grand_total numeric,
  payment_status text
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
    select b.id, b.bill_number, b.bill_date, b.customer_id, b.customer_name, b.grand_total, b.payment_status
    from public.bill_dc_links l
    join public.bills b
      on b.organization_id = l.organization_id and b.id = l.bill_id
    where l.organization_id = p_org
      and l.dc_id = p_dc_id
      and b.deleted_at is null
    order by b.bill_date desc, b.bill_number desc;
end;
$$;

revoke all on function public.dc_linked_bills(uuid, uuid) from public, anonymous;
grant execute on function public.dc_linked_bills(uuid, uuid) to authenticated;

-- dc_machining_rejections
-- -----------------------

create or replace function public.dc_machining_rejections(p_org uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
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
end;
$$;

revoke all on function public.dc_machining_rejections(uuid, date, date) from public, anonymous;
grant execute on function public.dc_machining_rejections(uuid, date, date) to authenticated;

-- dc_material_rejections
-- ----------------------

create or replace function public.dc_material_rejections(p_org uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
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

-- dc_movement_history
-- -------------------

create or replace function public.dc_movement_history(p_org uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_movement_type text DEFAULT NULL::text)
returns table (
  moved_at timestamp with time zone,
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
end;
$$;

revoke all on function public.dc_movement_history(uuid, date, date, text) from public, anonymous;
grant execute on function public.dc_movement_history(uuid, date, date, text) to authenticated;

-- dc_pending_customer_delivery
-- ----------------------------

create or replace function public.dc_pending_customer_delivery(p_org uuid)
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

-- dc_pending_inspection
-- ---------------------

create or replace function public.dc_pending_inspection(p_org uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
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
end;
$$;

revoke all on function public.dc_pending_inspection(uuid, date, date) from public, anonymous;
grant execute on function public.dc_pending_inspection(uuid, date, date) to authenticated;

-- dc_register
-- -----------

create or replace function public.dc_register(p_org uuid, p_dc_type text DEFAULT NULL::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_status text DEFAULT NULL::text)
returns table (
  id uuid,
  dc_number text,
  dc_type text,
  dc_date date,
  status text,
  party_id uuid,
  party_name text,
  party_gstin text,
  customer_dc_numbers jsonb,
  reference_inward_dc_id uuid,
  reference_inward_number text,
  vehicle_number text,
  line_count bigint,
  total_quantity numeric,
  total_declared numeric
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
    with lines as (
      select d.id as dc_id,
        count(i.id) as line_count,
        coalesce(sum(
          case when d.dc_type = 'inward' then i.received_qty
               when d.dc_type = 'outward_customer' then i.qty_dispatched
               when d.dc_type = 'material_return' then i.declared_qty
               else 0 end), 0) as total_quantity,
        coalesce(sum(i.declared_qty), 0) as total_declared
      from public.dc_documents d
      left join public.dc_items i on i.organization_id = d.organization_id and i.dc_id = d.id
      where d.organization_id = p_org
        and d.deleted_at is null
        and (p_dc_type is null or d.dc_type = p_dc_type)
        and (p_status is null or d.status = p_status)
        and (p_from is null or d.dc_date >= p_from)
        and (p_to is null or d.dc_date <= p_to)
      group by d.id
    ),
    nums as (
      select oi.dc_id, s.customer_dc_number
      from public.dc_items oi
      join public.dc_items s
        on s.organization_id = oi.organization_id and s.id = oi.source_inward_item_id
      where oi.organization_id = p_org and s.customer_dc_number is not null
      group by oi.dc_id, s.customer_dc_number
    ),
    own as (
      select i.dc_id, i.customer_dc_number
      from public.dc_items i
      where i.organization_id = p_org and i.customer_dc_number is not null
      group by i.dc_id, i.customer_dc_number
    )
    select
      d.id,
      d.dc_number,
      d.dc_type,
      d.dc_date,
      d.status,
      d.party_id,
      d.party_name,
      d.party_gstin,
      coalesce((
        select jsonb_agg(x.dc order by x.dc)
        from (
          select customer_dc_number as dc from own where own.dc_id = d.id
          union
          select customer_dc_number as dc from nums where nums.dc_id = d.id
        ) x
      ), '[]'::jsonb),
      d.reference_inward_dc_id,
      ref.dc_number,
      d.vehicle_number,
      l.line_count,
      l.total_quantity,
      l.total_declared
    from public.dc_documents d
    left join public.dc_documents ref
      on ref.organization_id = d.organization_id and ref.id = d.reference_inward_dc_id
    join lines l on l.dc_id = d.id
    order by d.dc_date desc, d.created_at desc;
end;
$$;

revoke all on function public.dc_register(uuid, text, date, date, text) from public, anonymous;
grant execute on function public.dc_register(uuid, text, date, date, text) to authenticated;

-- dc_rejection_trend
-- ------------------

create or replace function public.dc_rejection_trend(p_org uuid)
returns table (
  month date,
  material_rejected numeric,
  machining_rejected numeric,
  material_returned numeric,
  inspected_qty numeric
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
end;
$$;

revoke all on function public.dc_rejection_trend(uuid) from public, anonymous;
grant execute on function public.dc_rejection_trend(uuid) to authenticated;

-- dc_variance_report
-- ------------------

create or replace function public.dc_variance_report(p_org uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
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