-- ---------------------------------------------------------------------------
-- 0059: close the four remaining report-guard gaps
--
-- Migration 0034 rewrote ten report functions as plpgsql with an
-- is_org_member guard. It failed (on any branch where it was recorded as
-- applied) because its fifth `CREATE OR REPLACE` statement,
-- dc_movement_history, dropped the `dc_id` column from its RETURNS TABLE and
-- PostgreSQL rejected the return-type change (42P13). The whole 0034
-- transaction rolled back, so none of its guards survived: every one of the
-- ten report functions remained `language sql` with no org-membership check.
--
-- Migration 0054 dropped and recreated five of them with the guard
-- (dc_machining_rejections, dc_material_rejections, dc_movement_history,
-- dc_pending_customer_delivery, dc_variance_report), and migration 0040
-- recreated dc_register with the guard. Four remain `language sql`,
-- SECURITY DEFINER, with no is_org_member check:
--
--   * dc_pending_inspection
--   * dc_acceptance_rate
--   * dc_rejection_trend
--   * dc_linked_bills
--
-- These are the same class of authorization gap KNOWN_ISSUES #26 describes:
-- a caller from another workspace can pass a foreign `p_org` to a SECURITY
-- DEFINER report function and read another workspace's challans, rejections,
-- and movement history, bypassing RLS.
--
-- Each function is dropped and recreated with the identical signature, return
-- type and body, wrapped in the same auth + is_org_member guard 0034 uses --
-- exactly the pattern 0054 proved. DROP+CREATE is required to switch from
-- `language sql` to `language plpgsql`. No data changes; forward-only.
-- ---------------------------------------------------------------------------
begin;

-- ---------------------------------------------------------------------------
-- dc_pending_inspection
-- ---------------------------------------------------------------------------
drop function if exists public.dc_pending_inspection(uuid, date, date);

create function public.dc_pending_inspection(p_org uuid, p_from date default null, p_to date default null)
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

-- ---------------------------------------------------------------------------
-- dc_acceptance_rate
-- ---------------------------------------------------------------------------
drop function if exists public.dc_acceptance_rate(uuid, date, date);

create function public.dc_acceptance_rate(p_org uuid, p_from date default null, p_to date default null)
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

-- ---------------------------------------------------------------------------
-- dc_rejection_trend
-- ---------------------------------------------------------------------------
drop function if exists public.dc_rejection_trend(uuid);

create function public.dc_rejection_trend(p_org uuid)
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

-- ---------------------------------------------------------------------------
-- dc_linked_bills
-- ---------------------------------------------------------------------------
drop function if exists public.dc_linked_bills(uuid, uuid);

create function public.dc_linked_bills(p_org uuid, p_dc_id uuid)
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

commit;
