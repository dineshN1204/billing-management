-- ---------------------------------------------------------------------------
-- 0058 - enforce multi-line machining completeness on the single-line RPC
-- ---------------------------------------------------------------------------
--
-- What this fixes
-- ---------------
-- Migrations 0043 and 0055 create app_private.require_machining_coverage with
-- comments stating it guards the single-line path (record_machining_result)
-- against leaving a multi-line outward DC incomplete. The helper was never
-- wired in: it has zero call sites, so an authenticated API caller could still
-- record a result for one line of a multi-line outward DC with no database error
-- while the batch RPC refused the same half-state.
--
-- This migration gives record_machining_result the same guarantee as
-- record_machining_batch: after inserting, if the result belongs to an outward
-- challan (it has a source_dc_id), it verifies every job-work line on that
-- challan that still has material left to machine now has a machining result.
-- Rows with no source DC (finished-stock / unlinked lines) are exempt, exactly
-- as the helper's own query treats them.
--
-- This is a forward-only migration: it supersedes the function from 0037
-- without touching the historical migration.
-- ---------------------------------------------------------------------------

begin;

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
  v_source_dc_id uuid;
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

  v_source_dc_id := app_private.parse_uuid(payload -> 'source_dc_id', 'source_dc_id', false);

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
    v_source_dc_id,
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

  -- Enforce multi-line completeness, matching the batch RPC. A result that
  -- belongs to an outward challan (has a source DC) must not leave another
  -- job-work line on that challan without a result while it still has material
  -- left to machine. Finished-stock / unlinked rows (no source DC) are exempt.
  if v_source_dc_id is not null then
    perform app_private.require_machining_coverage(v_org, v_source_dc_id);
  end if;

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

commit;
