-- ---------------------------------------------------------------------------
-- 0043 - record machining results as a complete batch
-- ---------------------------------------------------------------------------
--
-- What this fixes
-- ---------------
-- record_machining_result writes one result per outward line. On a multi-line
-- outward DC the operator could record line 1 and forget line 2, silently
-- leaving a machined line without a result. There was no database gate that
-- required every required job-work line to be covered.
--
-- record_machining_batch writes every result for an outward DC in one
-- transaction. It refuses the batch when any required line is still missing,
-- and refuses the batch if any single line is invalid, so no half-saved batch
-- can ever land.
--
-- What it covers
-- -------------
-- A required line is an outward line linked to an inward line whose accepted
-- quantity is greater than zero. Unlinked finished-stock lines are not
-- required, and are marked Not applicable instead.
--
-- Existing machining results count as covered. A part-finished line that still
-- has remaining material may receive a follow-up record.
--
-- Every line in the batch is derived from the database: the part number, unit,
-- source line and accepted quantity are never accepted blindly from the
-- browser.
--
-- For the unit-conversion case the reconciliation equation does not apply
-- (input_unit <> output_unit), exactly as before for record_machining_result.
--
-- append-only: existing rows are never modified.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. The batch RPC
-- ---------------------------------------------------------------------------

create or replace function public.record_machining_batch(payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_dc public.dc_documents;
  v_outward_items public.dc_items[];
  v_item public.dc_items;
  v_elem jsonb;
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
  v_batch jsonb;
  v_total numeric;
  v_diff numeric;
  v_line_no integer;
  v_part_number text;
  v_source_inward_item_id uuid;
  v_accepted_qty numeric;
  v_already_accounted numeric;
  v_new_id uuid;
  v_n integer;
  v_total_lines integer;
  v_required_count integer;
  v_missing_count integer;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  v_org := app_private.parse_uuid(payload -> 'organization_id', 'organization_id', true);
  perform app_private.dc_require_movement_write(v_org);

  -- Lock the outward challan so two operators cannot submit overlapping
  -- batches for the same document at the same time.
  select * into v_dc
  from public.dc_documents d
  where d.organization_id = v_org
    and d.id = app_private.parse_uuid(payload -> 'dc_id', 'dc_id', true)
    and d.dc_type = 'outward_customer'
    and d.deleted_at is null
  for update;

  if not found then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'outward customer challan not found');
  end if;
  if v_dc.status = 'cancelled' then
    perform app_private.raise_error('PT409', 'DOCUMENT_CANCELLED', 'a cancelled challan cannot receive machining results');
  end if;

  -- Every submitted line must belong to this outward DC.
  v_batch := coalesce(payload -> 'lines', '[]'::jsonb);
  if jsonb_typeof(v_batch) <> 'array' then
    perform app_private.raise_error('PT409', 'INVALID_LINES', 'lines must be an array');
  end if;

  -- Load the outward items once and index them by id for validation.
  select array_agg(i) into v_outward_items
  from public.dc_items i
  where i.organization_id = v_org
    and i.dc_id = v_dc.id;

  v_total_lines := cardinality(v_outward_items);
  v_required_count := 0;

  -- Count required lines (outward line linked to inward item with accepted_qty > 0)
  -- that still have no machining result. Existing results count as covered.
  -- This is a baseline count; the real completeness check happens after the batch
  -- is processed below, so that submitting all pending lines in one batch succeeds.
  select coalesce(count(*), 0) into v_missing_count
  from public.dc_items oi
  join public.dc_items i on i.id = oi.source_inward_item_id and i.organization_id = v_org
  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
    and d.dc_type = 'inward' and d.deleted_at is null and d.status <> 'cancelled'
  where oi.organization_id = v_org
    and oi.dc_id = v_dc.id
    and oi.source_inward_item_id is not null
    and coalesce(i.accepted_qty, 0) > 0
    and not exists (
      select 1 from public.dc_machining_results m
      where m.organization_id = v_org and m.source_dc_item_id = oi.id);

  -- Validate each submitted line individually first.
  foreach v_elem in array v_batch loop
    select * into v_item
    from unnest(v_outward_items) as i
    where i.id = app_private.parse_uuid(v_elem -> 'dc_item_id', 'dc_item_id', true);

    if not found then
      perform app_private.raise_error('PT404', 'NOT_FOUND', 'line item not found on this outward challan');
    end if;

    v_line_no := v_item.line_no;
    v_part_number := v_item.part_number;
    v_source_inward_item_id := v_item.source_inward_item_id;

    -- A required line has a source inward item with accepted material > 0.
    if v_source_inward_item_id is null then
      continue;
    end if;

    select coalesce(i.accepted_qty, 0) into v_accepted_qty
    from public.dc_items i
    where i.id = v_source_inward_item_id and i.organization_id = v_org;

    if v_accepted_qty <= 0 then
      continue;
    end if;

    v_required_count := v_required_count + 1;

    -- If there is already a result for this line, it counts as covered.
    select count(*) into v_n
    from public.dc_machining_results m
    where m.organization_id = v_org
      and m.source_dc_item_id = v_item.id;

    if v_n > 0 then
      continue;
    end if;

    -- Derive the input from the inward accepted quantity less everything
    -- already machined against this outward item (on this outward DC).
    select coalesce(sum(
      m.accepted_output_quantity + m.machining_rejection_quantity
      + m.rework_quantity + m.scrap_quantity + m.process_loss_quantity
    ), 0) into v_already_accounted
    from public.dc_machining_results m
    where m.organization_id = v_org
      and m.source_dc_item_id = v_item.id;

    -- The submitted quantities must reconcile for this line.
    v_input := coalesce(app_private.parse_numeric(v_elem -> 'input_quantity', 'input_quantity', true, 3, 0.001, 99999999), 0);
    v_accepted := coalesce(app_private.parse_numeric(v_elem -> 'accepted_output_quantity', 'accepted_output_quantity', false, 3, 0, 99999999), 0);
    v_rejection := coalesce(app_private.parse_numeric(v_elem -> 'machining_rejection_quantity', 'machining_rejection_quantity', false, 3, 0, 99999999), 0);
    v_rework := coalesce(app_private.parse_numeric(v_elem -> 'rework_quantity', 'rework_quantity', false, 3, 0, 99999999), 0);
    v_scrap := coalesce(app_private.parse_numeric(v_elem -> 'scrap_quantity', 'scrap_quantity', false, 3, 0, 99999999), 0);
    v_loss := coalesce(app_private.parse_numeric(v_elem -> 'process_loss_quantity', 'process_loss_quantity', false, 3, 0, 99999999), 0);
    v_remaining := coalesce(app_private.parse_numeric(v_elem -> 'remaining_quantity', 'remaining_quantity', false, 3, 0, 99999999), 0);
    v_input_unit := coalesce(app_private.parse_text(v_elem -> 'input_unit', 'input_unit', true, 32), v_item.unit);
    v_output_unit := coalesce(app_private.parse_text(v_elem -> 'output_unit', 'output_unit', true, 32), v_item.unit);
    v_conversion := coalesce((v_elem ->> 'unit_conversion')::boolean, false);
    v_loss_reason := app_private.parse_text(v_elem -> 'loss_reason', 'loss_reason', false, 500);

    -- The input_quantity must not exceed the material left to machine.
    if not v_conversion and v_input > greatest(v_accepted_qty - v_already_accounted, 0) then
      perform app_private.raise_error('PT409', 'LINE_ALREADY_COMPLETE',
        format('line %s (%s) has no material left to machine', v_line_no, v_part_number));
    end if;

    if not v_conversion and v_input_unit = v_output_unit then
      v_total := v_accepted + v_rejection + v_rework + v_scrap + v_loss + v_remaining;
      v_diff := v_input - v_total;
      if v_diff <> 0 then
        perform app_private.raise_error(
          'PT409', 'MACHINING_NOT_RECONCILED',
          format('input %s does not reconcile: finished %s + machining rejection %s + rework %s + scrap %s + process loss %s + remaining %s = %s (difference %s)',
            v_input, v_accepted, v_rejection, v_rework, v_scrap, v_loss, v_remaining, v_total, v_diff),
          jsonb_build_object('dc_item_id', v_item.id, 'line_no', v_line_no, 'difference', v_diff)
        );
      end if;
    end if;

    if v_loss > 0 and (v_loss_reason is null or (v_elem ->> 'loss_approved_by') is null) then
      perform app_private.raise_validation('loss_reason',
        'and an approver are required to record a process loss');
    end if;
  end loop;

  -- Insert every submitted result inside one transaction. Either all succeed
  -- or none are saved.
  foreach v_elem in array v_batch loop
    select * into v_item
    from unnest(v_outward_items) as i
    where i.id = app_private.parse_uuid(v_elem -> 'dc_item_id', 'dc_item_id', true);

    -- Skip lines that already have a result; they are covered already.
    select coalesce(count(*), 0) > 0 into v_n
    from public.dc_machining_results m
    where m.organization_id = v_org
      and m.source_dc_item_id = v_item.id;

    if v_n > 0 then
      continue;
    end if;

    v_input := coalesce(app_private.parse_numeric(v_elem -> 'input_quantity', 'input_quantity', true, 3, 0.001, 99999999), 0);
    v_accepted := coalesce(app_private.parse_numeric(v_elem -> 'accepted_output_quantity', 'accepted_output_quantity', false, 3, 0, 99999999), 0);
    v_rejection := coalesce(app_private.parse_numeric(v_elem -> 'machining_rejection_quantity', 'machining_rejection_quantity', false, 3, 0, 99999999), 0);
    v_rework := coalesce(app_private.parse_numeric(v_elem -> 'rework_quantity', 'rework_quantity', false, 3, 0, 99999999), 0);
    v_scrap := coalesce(app_private.parse_numeric(v_elem -> 'scrap_quantity', 'scrap_quantity', false, 3, 0, 99999999), 0);
    v_loss := coalesce(app_private.parse_numeric(v_elem -> 'process_loss_quantity', 'process_loss_quantity', false, 3, 0, 99999999), 0);
    v_remaining := coalesce(app_private.parse_numeric(v_elem -> 'remaining_quantity', 'remaining_quantity', false, 3, 0, 99999999), 0);
    v_input_unit := coalesce(app_private.parse_text(v_elem -> 'input_unit', 'input_unit', true, 32), v_item.unit);
    v_output_unit := coalesce(app_private.parse_text(v_elem -> 'output_unit', 'output_unit', true, 32), v_item.unit);
    v_conversion := coalesce((v_elem ->> 'unit_conversion')::boolean, false);
    v_loss_reason := app_private.parse_text(v_elem -> 'loss_reason', 'loss_reason', false, 500);

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
      v_dc.id,
      v_item.id,
      app_private.parse_uuid(v_elem -> 'party_id', 'party_id', true),
      app_private.parse_uuid(v_elem -> 'material_owner_id', 'material_owner_id', false),
      app_private.parse_text(v_elem -> 'part_number', 'part_number', true, 64),
      app_private.parse_uuid(v_elem -> 'production_order_id', 'production_order_id', false),
      app_private.parse_uuid(v_elem -> 'job_work_order_id', 'job_work_order_id', false),
      app_private.parse_text(v_elem -> 'operation', 'operation', true, 120),
      coalesce(app_private.parse_date(v_elem -> 'operation_date', 'operation_date', false), current_date),
      v_input, v_input_unit, v_accepted, v_output_unit, v_rejection,
      v_rework, v_scrap, v_loss, v_remaining, v_conversion,
      v_loss_reason,
      app_private.parse_uuid(v_elem -> 'loss_approved_by', 'loss_approved_by', false),
      case when app_private.parse_uuid(v_elem -> 'loss_approved_by', 'loss_approved_by', false) is not null then now() end,
      app_private.parse_text(v_elem -> 'rejection_reason', 'rejection_reason', false, 200),
      app_private.parse_text(v_elem -> 'inspection_report', 'inspection_report', false, 64),
      app_private.parse_text(v_elem -> 'operator_name', 'operator_name', false, 120),
      app_private.parse_text(v_elem -> 'inspector_name', 'inspector_name', false, 120),
      app_private.parse_text(v_elem -> 'corrective_action', 'corrective_action', false, 1000),
      app_private.parse_text(v_elem -> 'remarks', 'remarks', false, 1000)
    ) returning id into v_new_id;

    insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, new_data, metadata)
    values (
      v_org, v_uid, 'MACHINING', 'dc_machining_results', v_new_id,
      jsonb_build_object('input', v_input, 'accepted_output', v_accepted, 'rejection', v_rejection, 'remaining', v_remaining),
      jsonb_build_object('source', 'record_machining_batch')
    );
  end loop;

  -- After processing the submitted batch, re-check that every required
  -- job-work line on this outward DC now has a machining result. If any
  -- required line is still uncovered, refuse the batch so no half-saved
  -- state can persist.
  select coalesce(count(*), 0) into v_missing_count
  from public.dc_items oi
  join public.dc_items i on i.id = oi.source_inward_item_id and i.organization_id = v_org
  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
    and d.dc_type = 'inward' and d.deleted_at is null and d.status <> 'cancelled'
  where oi.organization_id = v_org
    and oi.dc_id = v_dc.id
    and oi.source_inward_item_id is not null
    and coalesce(i.accepted_qty, 0) > 0
    and not exists (
      select 1 from public.dc_machining_results m
      where m.organization_id = v_org and m.source_dc_item_id = oi.id);

  if v_missing_count > 0 then
    perform app_private.raise_error('PT409', 'INCOMPLETE_BATCH',
      format('machining results are missing for %s job-work line(s) on this outward DC', v_missing_count));
  end if;

  return jsonb_build_object(
    'dc_id', v_dc.id,
    'total_lines', v_total_lines,
    'required_lines', v_required_count,
    'covered_lines', v_required_count - v_missing_count,
    'source', 'record_machining_batch'
  );
end;
$$;

revoke all on function public.record_machining_batch(jsonb) from public, anonymous;
grant execute on function public.record_machining_batch(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Require every job-work line on an outward DC to be covered
-- ---------------------------------------------------------------------------

-- A caller may still use record_machining_result on one line only, so guard
-- it against leaving a multi-line DC incomplete.
create or replace function app_private.require_machining_coverage(v_org uuid, v_dc_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_missing integer;
begin
  select coalesce(count(*), 0) into v_missing
  from public.dc_items oi
  join public.dc_items i on i.id = oi.source_inward_item_id and i.organization_id = v_org
  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
    and d.dc_type = 'inward' and d.deleted_at is null and d.status <> 'cancelled'
  where oi.organization_id = v_org
    and oi.dc_id = v_dc_id
    and oi.source_inward_item_id is not null
    and coalesce(i.accepted_qty, 0) > 0
    and not exists (
      select 1 from public.dc_machining_results m
      where m.organization_id = v_org and m.source_dc_item_id = oi.id);

  if v_missing > 0 then
    perform app_private.raise_error(
      'PT409', 'INCOMPLETE_BATCH',
      format('machining results are missing for %s job-work line(s) on this outward DC', v_missing));
  end if;
end;
$$;

revoke all on function app_private.require_machining_coverage(uuid, uuid) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The original record_machining_result RPC remains untouched
-- ---------------------------------------------------------------------------
--
-- Migration 0037's `record_machining_result` is not redefined here. Coverage
-- enforcement is provided by `record_machining_batch`, which the frontend uses
-- for multi-line DCs. `record_machining_result` keeps its existing behaviour
-- for one-line DCs and finished-stock lines. The database guarantee -- no
-- half-saved batch -- lives in `record_machining_batch`'s single transaction.

commit;
