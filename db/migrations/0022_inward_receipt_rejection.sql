-- 0022_inward_receipt_rejection.sql
--
-- Six defects in how an inward challan records what arrived and what was
-- judged, plus the retirement of the damaged quantity. Each is called out where
-- it is fixed; the list here is why the file exists.
--
--   1. Re-recording a receipt left the inspection results in place while
--      resetting pending_inspection_qty to the full received quantity. A line
--      could end up reporting 960 accepted AND 990 pending against 990 received,
--      and the inspection form would then pre-fill a figure the database is
--      guaranteed to refuse.
--   2. inspected_qty counted pending material, so it could exceed received_qty
--      and did so in dc_acceptance_rate and dc_rejection_trend.
--   3. accepted + rejected + rework + pending did not have to reconcile against
--      the quantity still to be inspected; the pending field had no effect on any
--      balance check.
--   4. Every recorded receipt inserted another receipt movement, so three
--      receipts of 990 produced a movement history of 2970.
--   5. inspection_status reported 'rejected' while most material was still
--      uninspected, because the rejected branch was tested before the
--      partially-inspected branch and ignored what remained.
--   6. The browser's "quantities cannot be negative" check could never fire.
--
-- What this migration changes
-- ---------------------------
-- * record_inward_receipt takes rejected_qty per line and records it as a real
--   dc_rejections row, so material refused at the gate can be returned or
--   scrapped through the existing flow.
-- * Unchecking "inspection required" is final: the material is auto-accepted
--   (accepted = received - rejected) instead of sitting at zero accepted
--   forever, which is what made such lines invisible to the stock balance.
-- * A receipt may be re-recorded freely until an inspection exists. After that
--   the whole call is refused rather than silently overwriting a quality record.
-- * record_material_inspection reconciles exactly and accumulates only judged
--   material into inspected_qty.
-- * damaged_qty is retired. Nothing reads it: it was written only by this
--   function and appeared on no report, no ledger and no challan. The column is
--   left in place and simply stays zero - dropping it is a separate,
--   irreversible decision and is not taken here.
--
-- Forward-only. No table is dropped, no existing column is removed or retyped,
-- and no row is rewritten retroactively. The one new constraint is added NOT
-- VALID so a legacy row that already over-reports inspected material cannot
-- fail the migration, while every future write is checked.
--
-- Permissions are unchanged: both functions keep security definer, the same
-- search_path and the same grants.

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

    -- The receipt owns a gate rejection: no inspection has run on this line, so
    -- nothing can have been returned or scrapped against one. Replacing it stops
    -- a corrected receipt leaving two conflicting rejection records behind.
    delete from public.dc_rejections x
    where x.organization_id = v_org
      and x.dc_item_id = v_item.id
      and x.quantity_inspected = 0
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
        v_received, 0, 0, v_rejected,
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

-- ---------------------------------------------------------------------------
-- Material inspection (Rule 2)
-- ---------------------------------------------------------------------------

create or replace function public.record_material_inspection(payload jsonb)
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
  v_inspected numeric;
  v_accepted numeric;
  v_rejected numeric;
  v_rework numeric;
  v_pending numeric;
  v_balance numeric;
  v_disposition text;
  v_total_inspected numeric;
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
    perform app_private.raise_error('PT409', 'DOCUMENT_CANCELLED', 'a cancelled challan cannot be inspected');
  end if;

  if payload -> 'lines' is null or jsonb_typeof(payload -> 'lines') <> 'array' then
    perform app_private.raise_validation('lines', 'must be an array of inspection results');
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

    v_accepted := coalesce(app_private.parse_numeric(v_elem -> 'accepted_qty', 'accepted_qty', false, 3, 0, 99999999), 0);
    v_rejected := coalesce(app_private.parse_numeric(v_elem -> 'rejected_qty', 'rejected_qty', false, 3, 0, 99999999), 0);
    v_rework := coalesce(app_private.parse_numeric(v_elem -> 'rework_qty', 'rework_qty', false, 3, 0, 99999999), 0);
    v_pending := coalesce(app_private.parse_numeric(v_elem -> 'pending_qty', 'pending_qty', false, 3, 0, 99999999), 0);
    v_inspected := v_accepted + v_rejected + v_rework + v_pending;

    if v_inspected = 0 then
      perform app_private.raise_validation('lines', 'each inspected line must record at least one non-zero quantity');
    end if;

    v_balance := v_item.received_qty - (v_item.accepted_qty + v_item.rejected_qty + v_item.rework_qty);

    -- Cumulative, not incremental: a second inspection must be measured against
    -- what has already been judged, or 960 accepted plus another 500 would pass
    -- while exceeding the 990 physically received.
    if v_accepted + v_rejected + v_rework > v_balance then
      perform app_private.raise_error(
        'PT409', 'INSPECTION_EXCEEDS_RECEIPT',
        format('inspected outcomes (%s) exceed the quantity still to be inspected (%s) for line %s',
          v_item.accepted_qty + v_item.rejected_qty + v_item.rework_qty + v_accepted + v_rejected + v_rework,
          v_item.received_qty, v_item.part_number),
        jsonb_build_object('dc_item_id', v_item.id, 'received_qty', v_item.received_qty)
      );
    end if;

    -- Fix 3: the four outcomes must account for the whole balance, not merely
    -- stay under it.
    --
    -- The ceiling above is a "<=", and "<=" let a line submit accepted 960 and
    -- pending 500 against 990 received: the judged total passed, nothing
    -- checked the rest, and pending contributed to inspected_qty while doing
    -- nothing to any balance. Requiring the four to sum to exactly what remains
    -- is what makes "pending" mean "not judged yet" instead of "whatever was
    -- left over".
    if v_inspected <> v_balance then
      perform app_private.raise_validation(
        'lines',
        format('accepted, rejected, rework and pending (%s) must add up to the %s still to be inspected on line %s',
          v_inspected, v_balance, v_item.part_number)
      );
    end if;

    v_disposition := app_private.parse_enum(v_elem -> 'disposition', 'disposition',
      array['return_to_customer', 'return_to_supplier', 'rework', 'hold_for_decision', 'scrap', 'other'], null);

    insert into public.dc_inspections (
      organization_id, dc_id, dc_item_id, inspected_by, inspected_quantity,
      accepted_quantity, rejected_quantity, rework_quantity, pending_quantity,
      rejection_reason, disposition, inspection_report_no, remarks
    ) values (
      v_org, v_dc.id, v_item.id, v_uid, v_inspected,
      v_accepted, v_rejected, v_rework, v_pending,
      app_private.parse_text(v_elem -> 'rejection_reason', 'rejection_reason', false, 200),
      v_disposition,
      app_private.parse_text(v_elem -> 'inspection_report_no', 'inspection_report_no', false, 64),
      app_private.parse_text(v_elem -> 'remarks', 'remarks', false, 1000)
    );

    update public.dc_items i
    set
      -- Fix 2: pending is recorded on the inspection event but is not material
      -- that has been examined, so it must not accumulate into the line's
      -- inspected total. With it included, two inspections could drive
      -- inspected_qty above received_qty and dc_acceptance_rate and
      -- dc_rejection_trend would report more inspected than was ever received.
      inspected_qty = i.inspected_qty + v_accepted + v_rejected + v_rework,
        accepted_qty = i.accepted_qty + v_accepted,
        rejected_qty = i.rejected_qty + v_rejected,
        rework_qty = i.rework_qty + v_rework,
        pending_inspection_qty = i.pending_inspection_qty - (v_accepted + v_rejected + v_rework),
        -- Fix 5: what is still awaiting inspection decides the status first.
        -- The rejected and rework branches used to be tested first and ignored
        -- it, so rejecting 20 of 990 reported 'rejected' on a line with 970
        -- still uninspected.
        inspection_status = case
          when i.pending_inspection_qty - (v_accepted + v_rejected + v_rework) > 0
            and (i.accepted_qty + v_accepted) + (i.rejected_qty + v_rejected) + (i.rework_qty + v_rework) = 0
            then 'pending'
          when i.pending_inspection_qty - (v_accepted + v_rejected + v_rework) > 0 then 'partially_inspected'
          when (i.accepted_qty + v_accepted) > 0 and (i.rejected_qty + v_rejected) > 0 then 'partially_accepted'
          when (i.rejected_qty + v_rejected) > 0 and (i.accepted_qty + v_accepted) = 0 then 'rejected'
          when (i.rework_qty + v_rework) > 0 then 'rework_required'
          when (i.accepted_qty + v_accepted) > 0 then 'accepted'
          else 'partially_inspected'
        end,
        inspection_date = coalesce(app_private.parse_date(v_elem -> 'inspection_date', 'inspection_date', false), current_date),
        inspected_by = v_uid,
        rejection_reason = coalesce(
          app_private.parse_text(v_elem -> 'rejection_reason', 'rejection_reason', false, 200), i.rejection_reason),
        inspection_report_no = coalesce(
          app_private.parse_text(v_elem -> 'inspection_report_no', 'inspection_report_no', false, 64), i.inspection_report_no),
        inspection_remarks = coalesce(
          app_private.parse_text(v_elem -> 'remarks', 'remarks', false, 1000), i.inspection_remarks)
    where i.id = v_item.id;

    if v_rejected > 0 then
      insert into public.dc_rejections (
        organization_id, dc_id, dc_item_id, party_id, part_number, batch_lot_no,
        quantity_received, quantity_inspected, quantity_accepted, quantity_rejected,
        rejection_date, rejection_reason, inspection_report_no, disposition,
        responsible_person, remarks
      ) values (
        v_org, v_dc.id, v_item.id, v_dc.party_id, v_item.part_number, v_item.batch_lot_no,
        v_item.received_qty, v_inspected, v_accepted, v_rejected,
        coalesce(app_private.parse_date(v_elem -> 'inspection_date', 'inspection_date', false), current_date),
        app_private.parse_text(v_elem -> 'rejection_reason', 'rejection_reason', false, 200),
        app_private.parse_text(v_elem -> 'inspection_report_no', 'inspection_report_no', false, 64),
        coalesce(v_disposition, 'hold_for_decision'),
        app_private.parse_text(payload -> 'responsible_person', 'responsible_person', false, 120),
        app_private.parse_text(v_elem -> 'remarks', 'remarks', false, 1000)
      );
    end if;
  end loop;

  select coalesce(sum(i.inspected_qty), 0) into v_total_inspected
  from public.dc_items i where i.organization_id = v_org and i.dc_id = v_dc.id;

  insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, metadata)
  values (v_org, v_uid, 'INSPECT', 'dc_documents', v_dc.id,
    jsonb_build_object('source', 'record_material_inspection', 'total_inspected', v_total_inspected));

  return app_private.dc_document_json(v_dc.id);
end;
$$;

revoke all on function public.record_material_inspection(jsonb) from public, anonymous;
grant execute on function public.record_material_inspection(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Shortage / excess / rejection
-- ---------------------------------------------------------------------------

-- CREATE OR REPLACE refuses to change a function's return type, and this one
-- drops a column from a RETURNS TABLE. The old definition has to go first.
-- Dropping a read-only report function cannot lose data: it holds no state, no
-- rows, and no table depends on it.
drop function if exists public.dc_variance_report(uuid, date, date);

create function public.dc_variance_report(p_org uuid, p_from date default null, p_to date default null)
returns table (
  dc_number text,
  dc_date date,
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
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select d.dc_number, d.dc_date, d.party_name, i.part_number, i.batch_lot_no, i.unit,
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
$$;

revoke all on function public.dc_variance_report(uuid, date, date) from public, anonymous;
grant execute on function public.dc_variance_report(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- inspected_qty can never exceed received_qty
-- ---------------------------------------------------------------------------

-- Added NOT VALID on purpose. A check constraint would be the natural guard, but
-- a line inspected before this migration may already over-report, and validating
-- would fail the whole deploy over history this change cannot rewrite. NOT VALID
-- still enforces every new row and every update from here on; the existing rows
-- are left for the audit rather than blocked.
alter table public.dc_items
  drop constraint if exists dc_items_inspected_within_receipt_check;

alter table public.dc_items
  add constraint dc_items_inspected_within_receipt_check
  check (inspected_qty <= received_qty) not valid;

comment on constraint dc_items_inspected_within_receipt_check on public.dc_items is
  'inspected_qty counts judged material only (accepted + rejected + rework). Added NOT VALID in 0022 so pre-existing over-reported rows do not block the deploy; it still guards every write from that point on.';

commit;