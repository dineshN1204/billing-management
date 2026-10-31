-- ---------------------------------------------------------------------------
-- 0028 - is the job on this inward challan finished?
--
-- What the person asking wants to know
-- ------------------------------------
-- "The customer sent us material on three of their challans. We received it,
-- inspected it, machined it and sent finished parts back on our own outward
-- challans. When every one of those outward challans is delivered, I want the
-- inward challan to say the work is finished."
--
-- Why it is derived and not stored
-- --------------------------------
-- dc_documents.status already means something on an inward challan: the
-- *receipt* lifecycle. `delivered` there means the material arrived at our
-- gate. Writing `delivered` onto that column when the outward ships would say
-- "we received it" when the meaning is "our job on it is done", and it would
-- lie to every reader of the inward register and the pending-delivery report.
--
-- So this is a separate, computed value. Nothing is written, nothing can drift
-- out of step with the quantities underneath it, and no existing status, filter
-- or report changes meaning. The trade is deliberate: it cannot be filtered on
-- in the register without a join, which is why dc_search exposes it.
--
-- The vocabulary
-- --------------
--   not_started         accepted material that no outward line draws from yet
--   pending             linked to an outward line, nothing dispatched
--   dispatched          sent to the customer, not yet acknowledged
--   partially_delivered acknowledged in part
--   delivered           every linked outward line fully acknowledged
--
-- An inward line with material that was rejected outright, or accepted and
-- never machined, is still `not_started`. That is accurate: no outward work has
-- been raised against it. It is not this function's business to decide that
-- such material should have been scrapped or returned.
-- ---------------------------------------------------------------------------

begin;

create or replace function public.dc_job_progress(p_org uuid, p_dc_id uuid)
returns table (
  scope text,
  dc_id uuid,
  dc_number text,
  dc_type text,
  dc_status text,
  line_no integer,
  part_number text,
  customer_dc_number text,
  unit text,
  accepted_qty numeric,
  machining_rejection_qty numeric,
  dispatched_qty numeric,
  delivered_qty numeric,
  outstanding_qty numeric,
  linked_dc_count bigint,
  job_status text
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
  with inward_doc as (
    select d.id, d.dc_number, d.dc_type, d.status
    from public.dc_documents d
    where d.organization_id = p_org
      and d.id = p_dc_id
      and d.deleted_at is null
  ),
  -- Every outward line that draws from one inward line, with what it moved.
  linked as (
    select
      oi.source_inward_item_id as source_id,
      oi.dc_id as outward_dc_id,
      oi.qty_dispatched,
      oi.qty_delivered
    from public.dc_items oi
    join public.dc_documents od
      on od.organization_id = oi.organization_id and od.id = oi.dc_id
    where oi.organization_id = p_org
      and oi.source_inward_item_id is not null
      and od.dc_type = 'outward_customer'
      and od.status <> 'cancelled'
      and od.deleted_at is null
  ),
  per_line as (
    select
      i.id,
      i.dc_id as source_dc_id,
      i.line_no,
      i.part_number,
      i.customer_dc_number,
      i.unit,
      i.accepted_qty,
      coalesce((
        select sum(m.machining_rejection_quantity)
        from public.dc_machining_results m
        join public.dc_items oi
          on oi.organization_id = m.organization_id and oi.id = m.source_dc_item_id
        where m.organization_id = p_org and oi.source_inward_item_id = i.id
      ), 0) as machining_rejection_qty,
      count(distinct l.outward_dc_id) as linked_dc_count,
      coalesce(sum(l.qty_dispatched), 0) as dispatched_qty,
      coalesce(sum(l.qty_delivered), 0) as delivered_qty
    from public.dc_items i
    join public.dc_documents d
      on d.organization_id = i.organization_id and d.id = i.dc_id
    left join linked l on l.source_id = i.id
    where i.organization_id = p_org
      and i.dc_id = p_dc_id
      and d.dc_type = 'inward'
      and d.deleted_at is null
    group by i.id, i.dc_id, i.line_no, i.part_number, i.customer_dc_number, i.unit, i.accepted_qty
  ),
  graded as (
    select
      p.*,
      case
        when p.linked_dc_count = 0 then 'not_started'
        when p.dispatched_qty <= 0 then 'pending'
        when p.delivered_qty <= 0 then 'dispatched'
        when p.delivered_qty < p.dispatched_qty then 'partially_delivered'
        else 'delivered'
      end as job_status,
      greatest(p.accepted_qty - p.machining_rejection_qty - p.dispatched_qty, 0) as outstanding_qty
    from per_line p
  ),
  doc_agg as (
    select
      count(g.id) as line_count,
      count(*) filter (where g.job_status = 'delivered') as delivered_lines,
      count(*) filter (where g.job_status in ('dispatched', 'partially_delivered')) as moving_lines,
      count(*) filter (where g.linked_dc_count > 0) as linked_lines,
      coalesce(sum(g.accepted_qty), 0) as accepted_qty,
      coalesce(sum(g.machining_rejection_qty), 0) as machining_rejection_qty,
      coalesce(sum(g.dispatched_qty), 0) as dispatched_qty,
      coalesce(sum(g.delivered_qty), 0) as delivered_qty,
      coalesce(sum(g.outstanding_qty), 0) as outstanding_qty
    from graded g
  ),
  doc_links as (
    select count(distinct l.outward_dc_id) as n
    from linked l
    where l.source_id in (select g.id from graded g)
  )
  select
    'document'::text,
    d.id,
    d.dc_number,
    d.dc_type,
    d.status,
    0,
    null::text,
    null::text,
    null::text,
    a.accepted_qty,
    a.machining_rejection_qty,
    a.dispatched_qty,
    a.delivered_qty,
    a.outstanding_qty,
    dl.n,
    case
      -- Only an inward challan carries a job. For an outward one the figures
      -- above are its own dispatched and delivered quantities, and its document
      -- status already says everything there is to say.
      when d.dc_type <> 'inward' then null
      -- No line has ever been drawn from: nothing raised against it yet.
      when coalesce(a.linked_lines, 0) = 0 then 'not_started'
      -- Every linked line acknowledged in full. This is "the work is finished".
      when coalesce(a.delivered_lines, 0) = a.linked_lines then 'delivered'
      -- Something has been acknowledged by the customer, but not all of it.
      when coalesce(a.delivered_qty, 0) > 0 then 'partially_delivered'
      -- Gone out, nothing acknowledged yet.
      when coalesce(a.dispatched_qty, 0) > 0 then 'in_progress'
      else 'pending'
    end
  from inward_doc d
  cross join doc_agg a
  cross join doc_links dl
  union all
  select
    'line'::text,
    g.source_dc_id,
    d.dc_number,
    d.dc_type,
    d.status,
    g.line_no,
    g.part_number,
    g.customer_dc_number,
    g.unit,
    g.accepted_qty,
    g.machining_rejection_qty,
    g.dispatched_qty,
    g.delivered_qty,
    g.outstanding_qty,
    g.linked_dc_count,
    g.job_status
  from graded g
  cross join inward_doc d
  order by 1 desc, 6;
end;
$$;

revoke all on function public.dc_job_progress(uuid, uuid) from public, anonymous;
grant execute on function public.dc_job_progress(uuid, uuid) to authenticated;

commit;
