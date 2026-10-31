-- 0023_gate_rejection_records.sql
--
-- A gate rejection could never be recorded. 0022 made record_inward_receipt
-- write one, and the values it wrote are refused by the table's own constraint:
--
--   dc_rejections_inspection_check (0014)
--     check (quantity_accepted + quantity_rejected <= quantity_inspected)
--
-- 0022 inserted quantity_inspected = 0, quantity_accepted = 0 and
-- quantity_rejected = N, which evaluates to 0 + N <= 0 - false for every
-- N > 0. So recording any rejected quantity at the gate always failed.
--
-- The insert sits in the same transaction as the rest of the receipt, so the
-- failure rolled back everything: the received quantity, the shortage and
-- excess, the receipt movement and the audit entry all went with it. An
-- operator typing a rejected quantity lost the whole receipt, not just the
-- rejection.
--
-- What this migration changes
-- ---------------------------
-- * A gate rejection records quantity_inspected = quantity_rejected. Only the
--   refused pieces were judged at the gate; the material that survived is
--   untouched and stays in dc_items.pending_inspection_qty until somebody
--   inspects it. Claiming the survivors were accepted here would make
--   dc_material_rejections and dc_acceptance_rate count the same material
--   twice, and would contradict the "receiving is not accepting" rule the rest
--   of the module is built on.
-- * The receipt's "replace the previous gate rejection" predicate no longer
--   keys on quantity_inspected = 0, which the fix above would otherwise have
--   destroyed. Without this, correcting a receipt would stack a second,
--   conflicting rejection row every time.
-- * RECEIPT_AFTER_RETURN: a receipt is refused once material refused at the
--   gate has been returned or scrapped against it, for the same reason
--   RECEIPT_AFTER_INSPECTION exists. Re-recording would otherwise zero the
--   line's rejected_qty while the rejection row still reported material
--   already sent back - two records of the same fact, disagreeing.
--
-- Forward-only. No table is altered, no column is added, dropped or retyped, no
-- constraint is touched and no existing row is read or rewritten. Same
-- signature, same security definer, same search_path, same grants.
--
-- No production row can already violate the constraint: every write to
-- dc_rejections goes through these two RPCs, and neither could ever have
-- inserted a row that failed. There is nothing to repair.

begin;

-- ---------------------------------------------------------------------------
-- Physical receipt (Rule 1: declared != received)
-- ---------------------------------------------------------------------------

create or replace function public.record_inward_receipt(payload jsonb)
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
  v_elem jsonb;
  v_item public.dc_items;
  v_declared numeric;
  v_previous_received numeric;
  v_received numeric;
  v_rejected numeric;
  v_remaining numeric;
  v_inspection_required boolean;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  v_org := app_private.parse_uuid(payload -> 'organization_id', 'organization_id', true);
  perform app_private.dc_require_movement_write(v_org);

  select * into v_dc
  from public.dc_documents d
  where d.organization_id = v_org
    and d.id = app_private.parse_uuid(payload -> 'dc_id', 'dc_id', true)
    and d.dc_type = 'inward'
    and d.deleted_at is null
  for update;

  if not found then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'inward delivery challan not found');
  end if;
  if v_dc.status = 'cancelled' then
    perform app_private.raise_error('PT409', 'DOCUMENT_CANCELLED', 'a cancelled challan cannot receive material');
  end if;

  if payload -> 'lines' is null or jsonb_typeof(payload -> 'lines') <> 'array' then
    perform app_private.raise_validation('lines', 'must be an array of received quantities');
  end if;

  -- Fix 1: refuse rather than overwrite.
  --
  -- Re-recording a receipt used to reset pending_inspection_qty to the full
  -- received quantity while leaving accepted/rejected/rework in place, which let
  -- a single line report more material accounted for than ever arrived. The
  -- arithmetic could have been fixed in place, but the audit trail could not: a
  -- quality result is a record, and silently discarding one because a quantity
  -- was typed wrong is worse than refusing. Correcting the challan means
  -- cancelling it and raising a new one.
  if exists (
    select 1 from public.dc_inspections s
    where s.organization_id = v_org
      and s.dc_id = v_dc.id
      and not s.is_reversal
  ) then
    perform app_private.raise_error(
      'PT409', 'RECEIPT_AFTER_INSPECTION',
      'this challan has already been inspected, so the received quantities can no longer be changed; cancel it and raise a new one');
  end if;

  -- Fix 3: the same rule, one step further along.
  --
  -- A rejection that already has material returned against it, or scrapped, has
  -- had a return DC raised against it and the money and the paperwork have both
  -- moved. Re-recording the receipt here would leave dc_items.rejected_qty at
  -- zero while dc_rejections still reported the returned quantity - the same
  -- quantity, stated two ways, disagreeing, with no record of which is right.
  -- Refusing keeps the correction on the cancel-and-re-raise path the
  -- inspection guard already established.
  if exists (
    select 1 from public.dc_rejections x
    where x.organization_id = v_org
      and x.dc_id = v_dc.id
      and (x.quantity_returned > 0 or x.quantity_scrapped > 0 or x.return_dc_id is not null)
  ) then
    perform app_private.raise_error(
      'PT409', 'RECEIPT_AFTER_RETURN',
      'this challan already has rejected material returned or scrapped against it, so the received quantities can no longer be changed; cancel it and raise a new one');
  end if;

  for v_elem in select value from jsonb_array_elements(payload -> 'lines') loop
    select * into v_item
    from public.dc_items i
    where i.organization_id = v_org
      and i.id = app_private.parse_uuid(v_elem -> 'dc_item_id', 'dc_item_id', true)
      and i.dc_id = v_dc.id
    for update;

    if not found then
      perform app_private.raise_error('PT404', 'NOT_FOUND', 'line item not found on this challan');
    end if;

    v_declared := coalesce(v_item.declared_qty, 0);
    -- Captured before the update, because the movement below has to know
    -- whether anything physically arrived or this is a correction.
    v_previous_received := coalesce(v_item.received_qty, 0);
    v_received := coalesce(app_private.parse_numeric(v_elem -> 'received_qty', 'received_qty', true, 3, 0, 99999999), 0);
    v_rejected := coalesce(app_private.parse_numeric(v_elem -> 'rejected_qty', 'rejected_qty', false, 3, 0, 99999999), 0);
    v_inspection_required := coalesce(
      (v_elem ->> 'inspection_required')::boolean, v_item.inspection_required
    );

    if v_rejected > v_received then
      perform app_private.raise_error(
        'PT409', 'REJECTION_EXCEEDS_RECEIPT',
        format('rejected quantity (%s) cannot exceed the quantity physically received (%s) for line %s',
          v_rejected, v_received, v_item.part_number),
        jsonb_build_object('dc_item_id', v_item.id, 'received_qty', v_received)
      );
    end if;

    v_remaining := v_received - v_rejected;

    update public.dc_items i
    set received_qty = v_received,
        shortage_qty = greatest(v_declared - v_received, 0),
        excess_qty = greatest(v_received - v_declared, 0),
        inspection_required = v_inspection_required,
        -- The receipt is the authority on what arrived and what was refused at
        -- the gate, so the inspection outcome is re-derived from scratch rather
        -- than adjusted. Rework and inspected_qty go to zero because no
        -- inspection can have run - the guard above proved it.
        accepted_qty = case when v_inspection_required then 0 else v_remaining end,
        rejected_qty = v_rejected,
        rework_qty = 0,
        inspected_qty = 0,
        pending_inspection_qty = case when v_inspection_required then v_remaining else 0 end,
        inspection_status = case
          -- Unchecking "inspection required" means nobody is going to judge this
          -- material, so it is accepted on arrival. Leaving accepted at zero made
          -- received material invisible to available_customer_material forever.
          when not v_inspection_required then 'not_required'
          when v_remaining > 0 then 'pending'
          when v_rejected > 0 then 'rejected'
          else 'pending'
        end,
        storage_location = coalesce(app_private.parse_text(v_elem -> 'storage_location', 'storage_location', false, 120), i.storage_location)
    where i.id = v_item.id;

    -- Fix 4: only record a movement when material actually moved.
    --
    -- The insert was unconditional, so re-recording a receipt to fix a typo added
    -- another full-quantity movement row and the movement history no longer
    -- agreed with received_qty.
    if v_received <> v_previous_received then
      insert into public.dc_movements (organization_id, dc_id, dc_item_id, movement_type, quantity, unit, supply_source, moved_at, reference, remarks)
      values (
        v_org, v_dc.id, v_item.id, 'receipt', v_received, v_item.unit, v_item.supply_source,
        coalesce(app_private.parse_timestamp(payload -> 'received_at', 'received_at'), now()),
        coalesce(app_private.parse_text(payload -> 'lr_number', 'lr_number', false, 64),
                 app_private.parse_text(v_elem -> 'receipt_reference', 'receipt_reference', false, 64)),
        app_private.parse_text(v_elem -> 'receipt_remarks', 'receipt_remarks', false, 500)
      );
    end if;

    -- Fix 2: the receipt owns a gate rejection. Replacing it stops a corrected
    -- receipt leaving two conflicting rejection records behind.
    --
    -- 0022 identified "a gate rejection, not yet inspected" by
    -- quantity_inspected = 0. Fix 1 above makes that value impossible to write,
    -- so the predicate would never have matched again and every correction would
    -- have appended a second row. The marker was redundant anyway: the
    -- RECEIPT_AFTER_INSPECTION guard above has already proved that no
    -- inspection exists on this challan, so every rejection row on the line is
    -- receipt-owned by definition.
    --
    -- The remaining conditions are still load-bearing. A rejection that has
    -- already been returned, scrapped or had a return DC raised against it has
    -- paperwork behind it and is deliberately left alone.
    delete from public.dc_rejections x
    where x.organization_id = v_org
      and x.dc_item_id = v_item.id
      and x.quantity_returned = 0
      and x.quantity_scrapped = 0
      and x.return_dc_id is null;

    if v_rejected > 0 then
      insert into public.dc_rejections (
        organization_id, dc_id, dc_item_id, party_id, part_number, batch_lot_no,
        quantity_received, quantity_inspected, quantity_accepted, quantity_rejected,
        rejection_date, rejection_reason, inspection_report_no, disposition,
        responsible_person, remarks
      ) values (
        v_org, v_dc.id, v_item.id, v_dc.party_id, v_item.part_number, v_item.batch_lot_no,
        -- Fix 1: quantity_inspected is the quantity actually judged, which at the
        -- gate is exactly the quantity refused. 0 + v_rejected <= v_rejected
        -- satisfies dc_rejections_inspection_check; the 0 that 0022 wrote here
        -- could never be inserted.
        --
        -- quantity_received still records the whole delivery, and
        -- quantity_accepted stays 0: the surviving material has not been judged
        -- and is sitting in dc_items.pending_inspection_qty waiting for somebody
        -- to inspect it. Accepting it here would double-count it in
        -- dc_material_rejections and dc_acceptance_rate.
        v_received, v_rejected, 0, v_rejected,
        coalesce(app_private.parse_date(payload -> 'receipt_date', 'receipt_date', false), current_date),
        app_private.parse_text(v_elem -> 'rejection_reason', 'rejection_reason', false, 200),
        app_private.parse_text(v_elem -> 'inspection_report_no', 'inspection_report_no', false, 64),
        'hold_for_decision',
        app_private.parse_text(payload -> 'responsible_person', 'responsible_person', false, 120),
        app_private.parse_text(v_elem -> 'rejection_remarks', 'rejection_remarks', false, 1000)
      );
    end if;
  end loop;

  update public.dc_documents d
  set status = case when d.status = 'draft' then 'issued' else d.status end,
      actual_arrival_at = coalesce(
        app_private.parse_timestamp(payload -> 'arrived_at', 'arrived_at'), d.actual_arrival_at),
      received_by = coalesce(
        app_private.parse_text(payload -> 'received_by', 'received_by', false, 120), d.received_by),
      unloading_remarks = coalesce(
        app_private.parse_text(payload -> 'unloading_remarks', 'unloading_remarks', false, 2000), d.unloading_remarks),
      updated_by = v_uid
  where d.id = v_dc.id;

  insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, metadata)
  values (v_org, v_uid, 'RECEIPT', 'dc_documents', v_dc.id, jsonb_build_object('source', 'record_inward_receipt'));

  return app_private.dc_document_json(v_dc.id);
end;
$$;

revoke all on function public.record_inward_receipt(jsonb) from public, anonymous;
grant execute on function public.record_inward_receipt(jsonb) to authenticated;

comment on function public.record_inward_receipt(jsonb) is
  'Records what physically arrived against an inward challan, including material refused at the gate. A gate rejection is stored with quantity_inspected = quantity_rejected, because only the refused pieces were judged. The call is refused once an inspection exists on the challan (RECEIPT_AFTER_INSPECTION) or once rejected material has been returned or scrapped (RECEIPT_AFTER_RETURN).';

commit;
