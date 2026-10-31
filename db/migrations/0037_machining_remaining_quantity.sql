-- ---------------------------------------------------------------------------
-- 0037 - what has not been machined yet
--
-- What this changes
-- -----------------
-- 1. A machining record can be part finished. The input is split into finished
--    machining, machining rejection, rework, scrap, any authorised loss and
--    whatever is left over - and the left-over quantity is now part of the
--    record instead of a shortfall the database refused.
--
--    Before this, `record_machining_result` demanded that the input balanced
--    to the piece, so a batch of 2000 with 1900 finished, 10 rejected, 5 for
--    rework and 5 scrapped could not be recorded at all: the 80 that had not
--    been machined yet had nowhere to go.
--
-- 2. The material that has not been machined is held back. An inward line
--    with machining records can send back only what came out finished; the
--    rest is still at the vendor. A line with no machining record is
--    unchanged: the whole accepted quantity can be dispatched, as before.
--
-- 3. The next machining record starts from what is left. The input of a
--    follow-up record is the material still to be machined on that line, not
--    the whole accepted quantity again, so 2000 - 1920 = 80 is what the second
--    record takes.
--
-- Why the cap is the finished quantity
-- -------------------------------------
-- The old cap was `accepted - machining rejection - dispatched`. It never
-- looked at what the process actually produced, so 2000 accepted with 1900
-- finished and 10 rejected still offered 1990 to send back - the 10 that were
-- rejected, scrapped or sent for rework included. Now the cap is what came out
-- finished, less what has already gone, and the unmachined remainder is held
-- back until a later record finishes it.
--
-- The unit conversion is deliberately left out of all of this. A process that
-- turns weight into pieces produces an output in a different unit, so neither
-- the finished total nor the remainder can be compared with a quantity in the
-- line's own unit. A line carrying a conversion record keeps the old
-- behaviour, and the form says the equation does not apply.
--
-- Existing records are unaffected: their input already balanced without a
-- remaining, so the new column is zero on all of them and the numbers they
-- produced are the numbers they still produce - except on a line that carries
-- machining records, where the cap is now the finished quantity.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------

alter table public.dc_machining_results add column if not exists remaining_quantity numeric(14, 3) not null default 0;

alter table public.dc_machining_results drop constraint if exists dc_machining_results_remaining_check;
alter table public.dc_machining_results add constraint dc_machining_results_remaining_check
  check (remaining_quantity >= 0);

-- The reconciliation constraint, taught about the remaining. The old one read
-- `input = accepted + rejection + rework + scrap + loss`, so a record that left
-- material behind could not be written at all - and the remaining is exactly
-- that material.
--
-- Existing records are unaffected: their input already balanced without a
-- remaining, and the column is zero on all of them.
alter table public.dc_machining_results drop constraint if exists dc_machining_results_balance_check;
alter table public.dc_machining_results add constraint dc_machining_results_balance_check
  check (
    unit_conversion
    or input_unit <> output_unit
    or input_quantity =
       accepted_output_quantity
       + machining_rejection_quantity
       + rework_quantity + scrap_quantity + process_loss_quantity
       + remaining_quantity
  );

comment on column public.dc_machining_results.remaining_quantity is
  'What was left of the input when the record was made: the material that has not been machined yet.';

-- ---------------------------------------------------------------------------
-- 2. What is still to be machined on an inward line
-- ---------------------------------------------------------------------------
--
-- The accepted quantity less everything a machining record has already
-- accounted for. Derived rather than stored, so it cannot drift away from the
-- records: a second record on the same line starts from what is left, and a
-- line with several records in parallel still adds up.
--
-- The remaining quantity stored on each record is the snapshot the operator
-- saw at the time. This is the current figure, and the two agree when the
-- records are made one after another.

create or replace function app_private.dc_inward_line_unmachined(p_org uuid, p_inward_item uuid)
returns numeric
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with src as (
    select i.accepted_qty
    from public.dc_items i
    join public.dc_documents d
      on d.organization_id = i.organization_id and d.id = i.dc_id
    where i.organization_id = p_org
      and i.id = p_inward_item
      and d.dc_type = 'inward'
      and d.deleted_at is null
      and d.status <> 'cancelled'
  ),
  machined as (
    select
      count(*) filter (where m.unit_conversion) as conversions,
      coalesce(sum(
        m.accepted_output_quantity
        + m.machining_rejection_quantity
        + m.rework_quantity
        + m.scrap_quantity
        + m.process_loss_quantity
      ) filter (where not m.unit_conversion and m.output_unit = i.unit), 0) as accounted
    from public.dc_machining_results m
    join public.dc_items oi
      on oi.organization_id = m.organization_id and oi.id = m.source_dc_item_id
    join public.dc_items i
      on i.organization_id = oi.organization_id and i.id = oi.source_inward_item_id
    where m.organization_id = p_org and i.id = p_inward_item
  )
  select greatest(
    case
      -- A conversion changes the unit, so what is left of the input cannot be
      -- worked out from the output. The whole accepted quantity is offered, and
      -- the form says the equation does not apply to that record.
      when (select conversions from machined) > 0
        then coalesce((select accepted_qty from src), 0)
      else coalesce((select accepted_qty from src), 0) - (select accounted from machined)
    end,
    0
  );
$$;

revoke all on function app_private.dc_inward_line_unmachined(uuid, uuid) from public, anonymous, authenticated;

create or replace function public.dc_inward_line_unmachined(p_org uuid, p_inward_item_id uuid)
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

  return app_private.dc_inward_line_unmachined(p_org, p_inward_item_id);
end;
$$;

revoke all on function public.dc_inward_line_unmachined(uuid, uuid) from public, anonymous;
grant execute on function public.dc_inward_line_unmachined(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. What can be sent back
-- ---------------------------------------------------------------------------
--
-- A line with machining records can send back only what came out finished.
-- A line with none is unchanged: the whole accepted quantity, less what has
-- already gone. A line carrying a unit conversion keeps the old rule, because
-- its output is in another unit and cannot be counted here.

create or replace function app_private.dc_inward_line_available(p_org uuid, p_inward_item uuid)
returns numeric
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with src as (
    select i.id, i.accepted_qty, i.unit
    from public.dc_items i
    join public.dc_documents d
      on d.organization_id = i.organization_id and d.id = i.dc_id
    where i.organization_id = p_org
      and i.id = p_inward_item
      and d.dc_type = 'inward'
      and d.deleted_at is null
      and d.status <> 'cancelled'
  ),
  machined as (
    select
      count(*) as results,
      count(*) filter (where m.unit_conversion) as conversions,
      coalesce(sum(m.machining_rejection_quantity), 0) as rejected,
      -- The finished output, counted only where it is in the line's own unit.
      -- A conversion (weight to pieces) produces a different unit, so its
      -- output cannot be counted against a quantity in the line's unit.
      coalesce(sum(m.accepted_output_quantity)
        filter (where not m.unit_conversion and m.output_unit = i.unit), 0) as finished
    from public.dc_machining_results m
    join public.dc_items oi
      on oi.organization_id = m.organization_id and oi.id = m.source_dc_item_id
    join public.dc_items i
      on i.organization_id = oi.organization_id and i.id = oi.source_inward_item_id
    where m.organization_id = p_org and i.id = p_inward_item
  ),
  dispatched as (
    select coalesce(sum(oi.qty_dispatched), 0) as dispatched
    from public.dc_items oi
    join public.dc_documents od
      on od.organization_id = oi.organization_id and od.id = oi.dc_id
    where oi.organization_id = p_org
      and oi.source_inward_item_id = p_inward_item
      and od.dc_type = 'outward_customer'
      and od.status not in ('draft', 'cancelled')
      and od.deleted_at is null
  )
  select greatest(
    case
      when (select results from machined) > 0 and (select conversions from machined) = 0
        then (select finished from machined)
      else coalesce((select accepted_qty from src), 0) - (select rejected from machined)
    end
    - (select dispatched from dispatched),
    0
  );
$$;

revoke all on function app_private.dc_inward_line_available(uuid, uuid) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Writing a machining record
-- ---------------------------------------------------------------------------
--
-- The reconciliation now includes the remaining, so a part-finished batch is a
-- record that balances. The rule that the input must add up is unchanged: a
-- caller that sends a shortfall without a remaining is still refused, exactly
-- as before.

create or replace function public.record_machining_result(payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_input numeric;
  v_accepted numeric;
  v_rejection numeric;
  v_rework numeric;
  v_scrap numeric;
  v_loss numeric;
  v_remaining numeric;
  v_input_unit text;
  v_output_unit text;
  v_conversion boolean;
  v_loss_reason text;
  v_total numeric;
  v_diff numeric;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  v_org := app_private.parse_uuid(payload -> 'organization_id', 'organization_id', true);
  perform app_private.dc_require_movement_write(v_org);

  v_input := app_private.parse_numeric(payload -> 'input_quantity', 'input_quantity', true, 3, 0.001, 99999999);
  v_accepted := coalesce(app_private.parse_numeric(payload -> 'accepted_output_quantity', 'accepted_output_quantity', false, 3, 0, 99999999), 0);
  v_rejection := coalesce(app_private.parse_numeric(payload -> 'machining_rejection_quantity', 'machining_rejection_quantity', false, 3, 0, 99999999), 0);
  v_rework := coalesce(app_private.parse_numeric(payload -> 'rework_quantity', 'rework_quantity', false, 3, 0, 99999999), 0);
  v_scrap := coalesce(app_private.parse_numeric(payload -> 'scrap_quantity', 'scrap_quantity', false, 3, 0, 99999999), 0);
  v_loss := coalesce(app_private.parse_numeric(payload -> 'process_loss_quantity', 'process_loss_quantity', false, 3, 0, 99999999), 0);
  -- What was left of the input: the material that has not been machined yet.
  v_remaining := coalesce(app_private.parse_numeric(payload -> 'remaining_quantity', 'remaining_quantity', false, 3, 0, 99999999), 0);
  v_input_unit := coalesce(app_private.parse_text(payload -> 'input_unit', 'input_unit', true, 32), 'NOS');
  v_output_unit := coalesce(app_private.parse_text(payload -> 'output_unit', 'output_unit', true, 32), 'NOS');
  v_conversion := coalesce((payload ->> 'unit_conversion')::boolean, false);
  v_loss_reason := app_private.parse_text(payload -> 'loss_reason', 'loss_reason', false, 500);

  if v_loss > 0 and (v_loss_reason is null or (payload ->> 'loss_approved_by') is null) then
    perform app_private.raise_validation('loss_reason',
      'and an approver are required to record a process loss');
  end if;

  -- Rule 5: the difference is never silently ignored.
  if not v_conversion and v_input_unit = v_output_unit then
    v_total := v_accepted + v_rejection + v_rework + v_scrap + v_loss + v_remaining;
    v_diff := v_input - v_total;
    if v_diff <> 0 then
      perform app_private.raise_error(
        'PT409', 'MACHINING_NOT_RECONCILED',
        format(
          'input %s does not reconcile: finished %s + machining rejection %s + rework %s + scrap %s + process loss %s + remaining %s = %s (difference %s)',
          v_input, v_accepted, v_rejection, v_rework, v_scrap, v_loss, v_remaining, v_total, v_diff),
        jsonb_build_object('input', v_input, 'accounted', v_total, 'difference', v_diff)
      );
    end if;
  end if;

  insert into public.dc_machining_results (
    organization_id, source_dc_id, source_dc_item_id, party_id, material_owner_id,
    part_number, production_order_id, job_work_order_id,
    operation, operation_date, input_quantity, input_unit,
    accepted_output_quantity, output_unit, machining_rejection_quantity,
    rework_quantity, scrap_quantity, process_loss_quantity, remaining_quantity, unit_conversion,
    loss_reason, loss_approved_by, loss_approved_at, rejection_reason, inspection_report,
    operator_name, inspector_name, corrective_action, remarks
  ) values (
    v_org,
    app_private.parse_uuid(payload -> 'source_dc_id', 'source_dc_id', false),
    app_private.parse_uuid(payload -> 'source_dc_item_id', 'source_dc_item_id', false),
    app_private.parse_uuid(payload -> 'party_id', 'party_id', true),
    app_private.parse_uuid(payload -> 'material_owner_id', 'material_owner_id', false),
    app_private.parse_text(payload -> 'part_number', 'part_number', true, 64),
    app_private.parse_uuid(payload -> 'production_order_id', 'production_order_id', false),
    app_private.parse_uuid(payload -> 'job_work_order_id', 'job_work_order_id', false),
    app_private.parse_text(payload -> 'operation', 'operation', true, 120),
    coalesce(app_private.parse_date(payload -> 'operation_date', 'operation_date', false), current_date),
    v_input, v_input_unit, v_accepted, v_output_unit, v_rejection,
    v_rework, v_scrap, v_loss, v_remaining, v_conversion,
    v_loss_reason,
    app_private.parse_uuid(payload -> 'loss_approved_by', 'loss_approved_by', false),
    case when app_private.parse_uuid(payload -> 'loss_approved_by', 'loss_approved_by', false) is not null then now() end,
    app_private.parse_text(payload -> 'rejection_reason', 'rejection_reason', false, 200),
    app_private.parse_text(payload -> 'inspection_report', 'inspection_report', false, 64),
    app_private.parse_text(payload -> 'operator_name', 'operator_name', false, 120),
    app_private.parse_text(payload -> 'inspector_name', 'inspector_name', false, 120),
    app_private.parse_text(payload -> 'corrective_action', 'corrective_action', false, 1000),
    app_private.parse_text(payload -> 'remarks', 'remarks', false, 1000)
  );

  insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, new_data, metadata)
  values (
    v_org, v_uid, 'MACHINING', 'dc_machining_results',
    (select id from public.dc_machining_results r where r.organization_id = v_org order by r.created_at desc limit 1),
    jsonb_build_object('input', v_input, 'accepted_output', v_accepted, 'rejection', v_rejection, 'loss', v_loss, 'remaining', v_remaining),
    jsonb_build_object('source', 'record_machining_result'));

  return jsonb_build_object(
    'input_quantity', v_input,
    'accepted_output_quantity', v_accepted,
    'machining_rejection_quantity', v_rejection,
    'rework_quantity', v_rework,
    'scrap_quantity', v_scrap,
    'process_loss_quantity', v_loss,
    'remaining_quantity', v_remaining
  );
end;
$$;

revoke all on function public.record_machining_result(jsonb) from public, anonymous;
grant execute on function public.record_machining_result(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The outstanding on an inward challan
-- ---------------------------------------------------------------------------
--
-- The job progress reads the same balance the dispatch guard reads, so the
-- "Outstanding" column on the inward challan cannot say one thing while the
-- picker offers another.

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
    where d.organization_id = p_org and d.id = p_dc_id and d.deleted_at is null
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
      -- What came out finished, in the line's own unit. A conversion produces
      -- another unit, so it is left out of this sum.
      coalesce((
        select sum(m.accepted_output_quantity)
        from public.dc_machining_results m
        join public.dc_items oi
          on oi.organization_id = m.organization_id and oi.id = m.source_dc_item_id
        where m.organization_id = p_org and oi.source_inward_item_id = i.id
          and not m.unit_conversion and m.output_unit = i.unit
      ), 0) as finished_qty,
      coalesce((
        select count(*)
        from public.dc_machining_results m
        join public.dc_items oi
          on oi.organization_id = m.organization_id and oi.id = m.source_dc_item_id
        where m.organization_id = p_org and oi.source_inward_item_id = i.id
      ), 0) as result_count,
      coalesce((
        select count(*)
        from public.dc_machining_results m
        join public.dc_items oi
          on oi.organization_id = m.organization_id and oi.id = m.source_dc_item_id
        where m.organization_id = p_org and oi.source_inward_item_id = i.id and m.unit_conversion
      ), 0) as conversion_count,
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
        when p.dispatched_qty > 0 and p.delivered_qty >= p.dispatched_qty then 'delivered'
        when p.delivered_qty > 0 then 'partially_delivered'
        else 'in_progress'
      end as job_status,
      -- The same balance the dispatch guard reads: what came out finished, less
      -- what has already gone. A line with no machining record is unchanged.
      greatest(
        case
          when p.result_count > 0 and p.conversion_count = 0 then p.finished_qty
          else p.accepted_qty - p.machining_rejection_qty
        end
        - p.dispatched_qty,
        0
      ) as outstanding_qty
    from per_line p
  ),
  doc_agg as (
    select
      count(g.id) as line_count,
      count(*) filter (where g.job_status = 'delivered') as delivered_lines,
      count(*) filter (where g.job_status = 'partially_delivered') as moving_lines,
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
      -- Nothing has ever been raised against it: the work has not started.
      when coalesce(a.linked_lines, 0) = 0 then 'not_started'
      -- Every linked line acknowledged in full. This is "the work is finished".
      when coalesce(a.delivered_lines, 0) = a.linked_lines then 'delivered'
      -- Something has been acknowledged by the customer, but not all of it.
      when coalesce(a.delivered_qty, 0) > 0 then 'partially_delivered'
      -- An outward challan has been raised: the work is under way.
      else 'in_progress'
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
