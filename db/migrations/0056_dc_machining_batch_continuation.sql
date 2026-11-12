-- ---------------------------------------------------------------------------
-- 0056 - allow continuation machining results on lines with remaining material
-- ---------------------------------------------------------------------------
--
-- What this fixes
-- ---------------
-- Migration 0055 aligned the batch completeness gate with the material actually
-- left to machine, but record_machining_batch still dropped any submitted line
-- that already had a machining result (both in the validation loop and in the
-- insert loop). So once a line had a result that left a remaining quantity, the
-- continuation could never be recorded through the form.
--
-- The domain already supports multiple results per line: the single-line RPC
-- record_machining_result inserts continuations, and test 22d exercises them.
-- This migration gives the batch RPC the same behaviour.
--
-- What this changes
-- -----------------
-- A submitted line is now validated and inserted regardless of whether it
-- already has a result. The existing guards still enforce the rules:
--   - LINE_ALREADY_COMPLETE: input_quantity may not exceed the material left to
--     machine (accepted_qty less everything already accounted for on that line),
--     so a continuation's input is capped at the remaining amount.
--   - MACHINING_NOT_RECONCILED: input == finished + rejection + rework + scrap
--     + loss + remaining, so the equation on the new result must balance.
--
-- The completeness gate is unchanged: a line is only "required" while it has no
-- result yet and still has unmachined material. A started line with remaining
-- material is never forced to finish, so remaining material may legitimately
-- persist.
--
-- This is a forward-only migration: it supersedes the function from 0055
-- without touching historical migrations.
-- ---------------------------------------------------------------------------

begin;

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

  -- Count required lines (outward line linked to inward item with accepted_qty
  -- > 0 that still has material left to machine) that still have no machining
  -- result. Existing results count as covered. This is a baseline count; the
  -- real completeness check happens after the batch is processed below, so
  -- that submitting all pending lines in one batch succeeds.
  select coalesce(count(*), 0) into v_missing_count
  from public.dc_items oi
  join public.dc_items i on i.id = oi.source_inward_item_id and i.organization_id = v_org
  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
    and d.dc_type = 'inward' and d.deleted_at is null and d.status <> 'cancelled'
  where oi.organization_id = v_org
    and oi.dc_id = v_dc.id
    and oi.source_inward_item_id is not null
    and coalesce(i.accepted_qty, 0) > 0
    and app_private.dc_inward_line_unmachined(v_org, oi.source_inward_item_id) > 0
    and not exists (
      select 1 from public.dc_machining_results m
      where m.organization_id = v_org and m.source_dc_item_id = oi.id);

  -- Validate each submitted line individually first. A line that already has a
  -- result is still validated: its input is capped at what is left to machine,
  -- and its quantities must still reconcile.
  for v_elem in select value from jsonb_array_elements(v_batch) loop
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

    -- The input_quantity must not exceed the material left to machine on this
    -- line, nor may all outward lines drawing on the same inward source account
    -- for more than that source actually accepted. The pooled check uses the
    -- same figure as the completeness gate and the form (dc_inward_line_unmachined),
    -- so the server cannot accept more than the UI would offer even when two
    -- outward challans draw on one inward line.
    if not v_conversion and v_input > greatest(v_accepted_qty - v_already_accounted, 0) then
      perform app_private.raise_error('PT409', 'LINE_ALREADY_COMPLETE',
        format('line %s (%s) has no material left to machine', v_line_no, v_part_number));
    end if;

    if not v_conversion
       and v_input > greatest(app_private.dc_inward_line_unmachined(v_org, v_source_inward_item_id), 0) then
      perform app_private.raise_error('PT409', 'LINE_ALREADY_COMPLETE',
        format('line %s (%s) exceeds the material still left on the inward source', v_line_no, v_part_number));
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
  -- or none are saved. A line that already has a result is inserted again as a
  -- continuation (its input was validated against the material left above).
  for v_elem in select value from jsonb_array_elements(v_batch) loop
    select * into v_item
    from unnest(v_outward_items) as i
    where i.id = app_private.parse_uuid(v_elem -> 'dc_item_id', 'dc_item_id', true);

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
  -- job-work line on this outward DC (that still has material left to machine
  -- and still has no result) now has a machining result. If any is still
  -- uncovered, refuse the batch so no half-saved state can persist.
  select coalesce(count(*), 0) into v_missing_count
  from public.dc_items oi
  join public.dc_items i on i.id = oi.source_inward_item_id and i.organization_id = v_org
  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
    and d.dc_type = 'inward' and d.deleted_at is null and d.status <> 'cancelled'
  where oi.organization_id = v_org
    and oi.dc_id = v_dc.id
    and oi.source_inward_item_id is not null
    and coalesce(i.accepted_qty, 0) > 0
    and app_private.dc_inward_line_unmachined(v_org, oi.source_inward_item_id) > 0
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

commit;
