-- ---------------------------------------------------------------------------
-- 0040 - the register stops being a wall of "issued"
--
-- What this changes
-- -----------------
-- The challan register shows the job status of an inward challan beside its
-- receipt status, and can be filtered on it. Before this, every inward challan
-- read `issued` in the register for ever, because the register only ever asked
-- for `dc_documents.status`.
--
-- Why it is shown beside, not instead of
-- ---------------------------------------
-- `dc_documents.status` on an inward challan is the *receipt* lifecycle: it is
-- written once, when the challan is issued, and it means the material arrived
-- at our gate. Migration 0028 explains why it is not moved when the work
-- finishes - writing `delivered` there when the outward ships would say "we
-- received it" when the meaning is "our job on it is done", and a stored value
-- would drift, because 0022 allows a receipt to be re-recorded until
-- inspection.
--
-- So the job progress stayed a separate, derived value, and this migration
-- brings that value to the screen where people were looking for it. The two
-- columns answer two different questions, which is why the search page has
-- always shown them side by side and the register now does too.
--
-- Why dc_register is dropped and recreated rather than replaced
-- ------------------------------------------------------------
-- PostgreSQL will not change the row type of an existing function under
-- `CREATE OR REPLACE`. And leaving the old five-parameter version in place
-- beside the new one would give PostgREST two candidates for the name, so
-- every call - including the ones that do not ask for a job status at all -
-- would fail with PGRST202. The drop and the create have to travel together.
--
-- Why the rule is stated again rather than taken out of dc_job_progress
-- --------------------------------------------------------------------
-- `public.dc_job_progress` computes the same rollup for a single document, and
-- it was rewritten by 0037 while this was being written. Moving the rule out
-- from under a function somebody else has just finished would be a worse trade
-- than stating it once more in the lean form the register needs - the register
-- asks for a whole workspace at a time and has no use for the machining
-- figures. The two are kept honest by the database test suite, which asserts
-- that the register and `dc_job_progress` report the same status for the same
-- challan in every state. If the rule ever changes, that test is what says so.
--
-- What is deliberately left alone
-- -------------------------------
-- - `dc_documents.status` is untouched. An inward challan still reads `issued`
--   in the receipt column, and still means what it meant.
-- - `public.dc_job_progress` is untouched, including its own document rollup.
-- - Outward challans have no job status. An outward challan *is* its own
--   delivery, and `confirm_delivery` already moves its stored status through
--   dispatched, partially delivered and delivered. The column is null for
--   those rows, exactly as `dc_job_progress` already does it.
-- - The existing `p_status` filter keeps meaning the receipt status. Nothing
--   that calls `dc_register` today has to change: the new parameter and the
--   new column arrive with defaults.
--
-- The vocabulary, from 0028 and kept by 0037
-- ------------------------------------------
--   not_started          no outward challan has ever been raised against it
--   in_progress          an outward challan exists: the work is under way
--   partially_delivered  the customer has acknowledged some of it
--   delivered            every linked line has been acknowledged in full
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- The job status of every inward challan in a workspace.
--
-- Lean on purpose: it looks only at the links between inward and outward lines
-- and what has been acknowledged, and not at the machining figures the
-- challan page also needs. `p_dc_id` narrows it to one document for the
-- challan page; it defaults to the whole workspace for the register.
-- ---------------------------------------------------------------------------
create or replace function app_private.dc_job_status_by_document(p_org uuid, p_dc_id uuid default null)
returns table (dc_id uuid, job_status text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  -- Every outward_customer line that draws from one inward line, with what it
  -- moved. A cancelled or deleted outward challan counts for nothing.
  with linked as (
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
  -- One row per inward line: how many challans draw from it, and how much of
  -- that has been acknowledged by the customer.
  per_line as (
    select
      i.id,
      i.dc_id as source_dc_id,
      count(distinct l.outward_dc_id) as linked_dc_count,
      coalesce(sum(l.qty_dispatched), 0) as dispatched_qty,
      coalesce(sum(l.qty_delivered), 0) as delivered_qty
    from public.dc_items i
    join public.dc_documents d
      on d.organization_id = i.organization_id and d.id = i.dc_id
    left join linked l on l.source_id = i.id
    where i.organization_id = p_org
      and d.dc_type = 'inward'
      and d.deleted_at is null
      and (p_dc_id is null or i.dc_id = p_dc_id)
    group by i.id, i.dc_id
  ),
  -- Rolled up to the document: the two counts and the acknowledged quantity
  -- that the four states are read from.
  per_doc as (
    select
      p.source_dc_id as inward_dc_id,
      count(*) filter (where p.linked_dc_count > 0) as linked_lines,
      -- The same predicate as a line reading `delivered`: at least one challan
      -- draws from it, something went, and everything that went was
      -- acknowledged.
      count(*) filter (
        where p.linked_dc_count > 0
          and p.dispatched_qty > 0
          and p.delivered_qty >= p.dispatched_qty
      ) as delivered_lines,
      coalesce(sum(p.delivered_qty), 0) as delivered_qty
    from per_line p
    group by p.source_dc_id
  ),
  -- The documents themselves, so that a challan with no lines at all still
  -- reports `not_started` rather than nothing.
  docs as (
    select d.id as inward_dc_id
    from public.dc_documents d
    where d.organization_id = p_org
      and d.dc_type = 'inward'
      and d.deleted_at is null
      and (p_dc_id is null or d.id = p_dc_id)
  )
  select
    docs.inward_dc_id,
    case
      -- Nothing has ever been raised against it: the work has not started.
      when coalesce(pd.linked_lines, 0) = 0 then 'not_started'
      -- Every linked line acknowledged in full. This is "the work is finished".
      when coalesce(pd.delivered_lines, 0) = pd.linked_lines then 'delivered'
      -- Something has been acknowledged by the customer, but not all of it.
      when coalesce(pd.delivered_qty, 0) > 0 then 'partially_delivered'
      -- An outward challan has been raised: the work is under way.
      else 'in_progress'
    end
  from docs
  left join per_doc pd on pd.inward_dc_id = docs.inward_dc_id;
$$;

-- Read only, and never handed to the browser: the register and the challan
-- page reach it through their own security definer functions.
revoke all on function app_private.dc_job_status_by_document(uuid, uuid) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- dc_register, with the job status in it.
--
-- The old signature is dropped rather than replaced: see the header.
-- ---------------------------------------------------------------------------
drop function if exists public.dc_register(uuid, text, date, date, text);

create or replace function public.dc_register(p_org uuid, p_dc_type text DEFAULT NULL::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_status text DEFAULT NULL::text, p_job_status text DEFAULT NULL::text)
returns table (
  id uuid,
  dc_number text,
  dc_type text,
  dc_date date,
  status text,
  job_status text,
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
      -- Null for everything that is not an inward challan: see the header.
      j.job_status,
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
    left join app_private.dc_job_status_by_document(p_org) j on j.dc_id = d.id
    -- Filtering on a job status is the same thing as asking for inward
    -- challans, so it also drops the outward rows, which have none.
    where (p_job_status is null or j.job_status = p_job_status)
    order by d.dc_date desc, d.created_at desc;
end;
$$;

revoke all on function public.dc_register(uuid, text, date, date, text, text) from public, anonymous;
grant execute on function public.dc_register(uuid, text, date, date, text, text) to authenticated;

commit;
