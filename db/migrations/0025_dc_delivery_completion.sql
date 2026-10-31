-- ---------------------------------------------------------------------------
-- 0025 - complete the outward customer delivery lifecycle
--
-- An outward challan could never reach `delivered`. public.confirm_delivery
-- existed and worked, and the browser had a wrapper for it
-- (src/lib/dc-api.ts), but nothing in the application ever called it: the DC
-- detail page offered Dispatch, Record machining result and Cancel, and no
-- more. Dispatching was the end of the road. Every outward challan sat at
-- `dispatched` for ever, which also meant
--
--   - `dc_pending_customer_delivery` (0017) filtered on
--     issued | dispatched | partially_delivered and could only ever grow;
--   - the "Delivered" filter on the DC register matched nothing a human made;
--   - `partially_delivered` was in dc_documents_status_check and in that
--     report, but no function had ever written it.
--
-- What this migration changes
-- ---------------------------
--  1. dc_items gains `qty_delivered`, so a delivery is recorded per line rather
--     than as a tick on the document.
--  2. confirm_delivery is rewritten to take quantities, enforce that a
--     delivery can never exceed what was dispatched, and derive the status
--     from the lines instead of trusting the caller.
--  3. record_dispatch is corrected so the proof-of-delivery reference the
--     operator types reaches dc_documents, and so a draft or already-delivered
--     challan cannot be dispatched.
--  4. dc_movements can record a `delivery` event, distinct from the
--     `customer_delivery` row the dispatch writes.
--  5. dc_pending_customer_delivery reports what is outstanding, not just a
--     status string.
--
-- Two decisions worth stating, because both were judgement calls:
--
-- **Confirming a delivery never touches qty_dispatched.** Stock leaves at
-- dispatch - dc_available_balance subtracts sum(qty_dispatched) over outward
-- documents that are not draft or cancelled (0016). Re-deducting on delivery
-- would remove every finished-stock balance twice. Delivery confirmation
-- records *arrival at the customer*, which is a fact about the paperwork, not a
-- second movement of material.
--
-- **The status is derived from the lines.** `delivered` means every dispatched
-- quantity on the challan has been acknowledged. A line that was never
-- dispatched is not outstanding, so it does not hold the document open. This is
-- the same reasoning as inwardCompletion() in src/lib/dc-quantities.ts: a
-- derived status cannot drift out of step with the numbers underneath it.
--
-- Forward-only and non-destructive: one column added, one check widened, three
-- functions replaced. No row is deleted or rewritten. Existing `dispatched`
-- documents take qty_delivered = 0, which correctly reads as "nothing has been
-- acknowledged yet" - they were never confirmed, because confirming was not
-- reachable.
--
-- The `qty_delivered <= qty_dispatched` ceiling is deliberately NOT a table
-- check. qty_dispatched is raised by later dispatches, so a row that was
-- legitimately delivered against an earlier dispatch would fail the constraint
-- the moment a second dispatch increased the figure. The ceiling is enforced in
-- confirm_delivery, under the item's row lock, which is where the two values
-- are compared at the same instant.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. Per-line delivered quantity
-- ---------------------------------------------------------------------------

alter table public.dc_items
  add column if not exists qty_delivered numeric(14, 3) not null default 0;

alter table public.dc_items
  drop constraint if exists dc_items_qty_delivered_check;
alter table public.dc_items
  add constraint dc_items_qty_delivered_check check (qty_delivered >= 0);

-- ---------------------------------------------------------------------------
-- 2. A delivery is its own movement, not a second customer_delivery
-- ---------------------------------------------------------------------------
--
-- Reusing 'customer_delivery' would leave dc_movement_history showing two rows
-- per line with nothing to tell which one was the dispatch from the truck and
-- which one was the acknowledgement at the gate.

alter table public.dc_movements
  drop constraint if exists dc_movements_type_check;
alter table public.dc_movements
  add constraint dc_movements_type_check
    check (movement_type in ('dispatch', 'receipt', 'vendor_return', 'material_return', 'customer_delivery', 'delivery'));

-- ---------------------------------------------------------------------------
-- 3. record_dispatch
-- ---------------------------------------------------------------------------
--
-- Two corrections and one behaviour change, called out here rather than buried
-- in the body:
--
--   * proof_of_delivery_ref was written only to dc_movements.reference. The
--     operator typed it on the dispatch form expecting it to be on the
--     challan, and it was not there. It is now set on the document too; the
--     movement keeps its copy.
--
--   * A dispatch on a `draft` was permitted. That is a behaviour change, not a
--     bug fix. Nothing legitimately relied on it: scripts/seed-dc.mjs and the
--     concurrency case in tests/run-dc-tests.mjs both finalize first. An inward
--     challan auto-issues on its receipt (0023), so refusing a draft dispatch
--     brings the outward side in line with it.
--
--   * A `delivered` challan cannot be dispatched again. There is nothing left
--     to deliver on it, and dispatching more material onto a closed document
--     would silently reopen the balance without reopening the paperwork.

create or replace function public.record_dispatch(payload jsonb)
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
  v_qty numeric;
  v_balance numeric;
  v_pod text;
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
    and d.dc_type = 'outward_customer'
    and d.deleted_at is null
  for update;

  if not found then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'outward customer challan not found');
  end if;
  if v_dc.status = 'cancelled' then
    perform app_private.raise_error('PT409', 'DOCUMENT_CANCELLED', 'a cancelled challan cannot be dispatched');
  end if;
  if v_dc.status = 'draft' then
    perform app_private.raise_error('PT409', 'NOT_ISSUED', 'finalize the challan before dispatching it');
  end if;
  if v_dc.status = 'delivered' then
    perform app_private.raise_error('PT409', 'ALREADY_DELIVERED', 'this challan is already fully delivered');
  end if;

  v_pod := app_private.parse_text(payload -> 'proof_of_delivery_ref', 'proof_of_delivery_ref', false, 120);

  for v_elem in select value from jsonb_array_elements(coalesce(payload -> 'lines', '[]'::jsonb)) loop
    select * into v_item
    from public.dc_items i
    where i.organization_id = v_org
      and i.id = app_private.parse_uuid(v_elem -> 'dc_item_id', 'dc_item_id', true)
      and i.dc_id = v_dc.id
    for update;

    if not found then
      perform app_private.raise_error('PT404', 'NOT_FOUND', 'line item not found on this challan');
    end if;

    v_qty := coalesce(app_private.parse_numeric(v_elem -> 'dispatched_qty', 'dispatched_qty', true, 3, 0.001, 99999999), 0);

    perform app_private.dc_lock_material(v_org, v_dc.party_id, v_item.part_number, v_item.supply_source);
    v_balance := app_private.dc_available_balance(v_org, v_dc.party_id, v_item.part_number, v_item.supply_source);

    if v_qty > v_balance then
      perform app_private.raise_error(
        'PT409', 'QUANTITY_EXCEEDED',
        format('cannot dispatch %s of %s: only %s is eligible for this customer',
          v_qty, v_item.part_number, v_balance),
        jsonb_build_object(
          'part_number', v_item.part_number,
          'requested', v_qty,
          'available', v_balance,
          'supply_source', v_item.supply_source
        )
      );
    end if;

    update public.dc_items i
    set qty_dispatched = i.qty_dispatched + v_qty
    where i.id = v_item.id;

    insert into public.dc_movements (
      organization_id, dc_id, dc_item_id, movement_type, quantity, unit, supply_source, moved_at, reference, remarks
    ) values (
      v_org, v_dc.id, v_item.id, 'customer_delivery', v_qty, v_item.unit, v_item.supply_source,
      coalesce(app_private.parse_timestamp(payload -> 'dispatched_at', 'dispatched_at'), now()),
      v_pod,
      app_private.parse_text(v_elem -> 'remarks', 'remarks', false, 500)
    );
  end loop;

  update public.dc_documents d
  set status = 'dispatched',
      dispatch_at = coalesce(app_private.parse_timestamp(payload -> 'dispatched_at', 'dispatched_at'), d.dispatch_at),
      mode_of_transport = coalesce(app_private.parse_text(payload -> 'mode_of_transport', 'mode_of_transport', false, 64), d.mode_of_transport),
      transporter_name = coalesce(app_private.parse_text(payload -> 'transporter_name', 'transporter_name', false, 120), d.transporter_name),
      vehicle_number = coalesce(app_private.parse_text(payload -> 'vehicle_number', 'vehicle_number', false, 32), d.vehicle_number),
      lr_number = coalesce(app_private.parse_text(payload -> 'lr_number', 'lr_number', false, 64), d.lr_number),
      eway_bill_number = coalesce(app_private.parse_text(payload -> 'eway_bill_number', 'eway_bill_number', false, 64), d.eway_bill_number),
      proof_of_delivery_ref = coalesce(v_pod, d.proof_of_delivery_ref),
      prepared_by = coalesce(app_private.parse_text(payload -> 'prepared_by', 'prepared_by', false, 120), d.prepared_by),
      authorized_by = coalesce(app_private.parse_text(payload -> 'authorized_by', 'authorized_by', false, 120), d.authorized_by),
      dispatch_remarks = coalesce(app_private.parse_text(payload -> 'dispatch_remarks', 'dispatch_remarks', false, 2000), d.dispatch_remarks)
  where d.id = v_dc.id;

  insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, metadata)
  values (v_org, v_uid, 'DISPATCH', 'dc_documents', v_dc.id, jsonb_build_object('source', 'record_dispatch'));

  return app_private.dc_document_json(v_dc.id);
end;
$$;

revoke all on function public.record_dispatch(jsonb) from public, anonymous;
grant execute on function public.record_dispatch(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. confirm_delivery
-- ---------------------------------------------------------------------------

create or replace function public.confirm_delivery(payload jsonb)
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
  v_qty numeric;
  v_outstanding numeric;
  v_delivered boolean;
  v_pod text;
  v_receiver text;
  v_at timestamptz;
  v_any_delivered boolean;
  v_all_delivered boolean;
  v_complete boolean;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  v_org := app_private.parse_uuid(payload -> 'organization_id', 'organization_id', true);
  perform app_private.dc_require_movement_write(v_org);

  -- Restricted to outward_customer. The function used to accept any document,
  -- which meant an inward challan or a material return could be stamped
  -- "delivered" and given a customer delivery timestamp that meant nothing.
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
    perform app_private.raise_error('PT409', 'DOCUMENT_CANCELLED', 'a cancelled challan cannot be delivered');
  end if;
  if v_dc.status = 'draft' then
    perform app_private.raise_error('PT409', 'NOT_ISSUED', 'finalize the challan before recording a delivery');
  end if;
  if v_dc.status = 'issued' then
    perform app_private.raise_error('PT409', 'NOT_DISPATCHED', 'dispatch this challan before recording a delivery');
  end if;
  if v_dc.status = 'delivered' then
    perform app_private.raise_error('PT409', 'ALREADY_DELIVERED', 'this challan is already fully delivered');
  end if;

  v_delivered := coalesce((payload ->> 'delivered')::boolean, true);
  v_pod := app_private.parse_text(payload -> 'proof_of_delivery_ref', 'proof_of_delivery_ref', false, 120);
  v_receiver := app_private.parse_text(payload -> 'receiver_name', 'receiver_name', false, 120);
  v_at := app_private.parse_timestamp(payload -> 'delivered_at', 'delivered_at');

  for v_elem in select value from jsonb_array_elements(coalesce(payload -> 'lines', '[]'::jsonb)) loop
    -- Minimum 0, not 0.001 as record_dispatch uses. The form sends every line,
    -- and a line with nothing left to deliver is a legitimate zero rather than a
    -- mistake. dc_movements requires quantity > 0, so zero lines are skipped
    -- below rather than written.
    v_qty := coalesce(app_private.parse_numeric(v_elem -> 'delivered_qty', 'delivered_qty', true, 3, 0, 99999999), 0);

    if v_qty <= 0 then
      continue;
    end if;

    select * into v_item
    from public.dc_items i
    where i.organization_id = v_org
      and i.id = app_private.parse_uuid(v_elem -> 'dc_item_id', 'dc_item_id', true)
      and i.dc_id = v_dc.id
    for update;

    if not found then
      perform app_private.raise_error('PT404', 'NOT_FOUND', 'line item not found on this challan');
    end if;

    v_outstanding := greatest(v_item.qty_dispatched - v_item.qty_delivered, 0);

    if v_qty > v_outstanding then
      perform app_private.raise_error(
        'PT409', 'QUANTITY_EXCEEDED',
        format('cannot confirm delivery of %s of %s: only %s of %s dispatched has not yet been delivered',
          v_qty, v_item.part_number, v_outstanding, v_item.qty_dispatched),
        jsonb_build_object(
          'part_number', v_item.part_number,
          'requested', v_qty,
          'outstanding', v_outstanding,
          'unit', v_item.unit
        )
      );
    end if;

    update public.dc_items i
    set qty_delivered = i.qty_delivered + v_qty
    where i.id = v_item.id;

    insert into public.dc_movements (
      organization_id, dc_id, dc_item_id, movement_type, quantity, unit, supply_source, moved_at, reference, remarks
    ) values (
      v_org, v_dc.id, v_item.id, 'delivery', v_qty, v_item.unit, v_item.supply_source,
      coalesce(v_at, now()),
      v_pod,
      app_private.parse_text(v_elem -> 'remarks', 'remarks', false, 500)
    );
  end loop;

  -- Derived from the lines, after the loop, so the status is a fact about the
  -- quantities rather than something the caller asserted. A line that was never
  -- dispatched is not outstanding, so it does not hold the document open.
  select
    coalesce(bool_or(i.qty_delivered > 0), false),
    coalesce(bool_and(i.qty_dispatched <= 0 or i.qty_delivered >= i.qty_dispatched), true)
  into v_any_delivered, v_all_delivered
  from public.dc_items i
  where i.organization_id = v_org and i.dc_id = v_dc.id;

  v_complete := v_any_delivered and v_all_delivered;

  -- Proof of delivery is required whenever the challan is being closed, which
  -- is a stronger rule than the old `delivered` flag: a caller cannot pass
  -- delivered = false to close a challan without a POD reference.
  if (v_delivered or v_complete) and v_pod is null then
    perform app_private.raise_validation('proof_of_delivery_ref', 'is required to mark a delivery as delivered');
  end if;

  update public.dc_documents d
  set status = case
        when not v_any_delivered then 'dispatched'
        when v_all_delivered then 'delivered'
        else 'partially_delivered'
      end,
      actual_delivery_at = case
        when v_complete then coalesce(v_at, now())
        else null
      end,
      proof_of_delivery_ref = coalesce(v_pod, d.proof_of_delivery_ref),
      receiver_name = coalesce(v_receiver, d.receiver_name),
      updated_by = v_uid
  where d.id = v_dc.id;

  insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, new_data, metadata)
  values (v_org, v_uid,
    case when v_complete then 'DELIVERED'
         when v_any_delivered then 'PARTIALLY_DELIVERED'
         else 'DELIVERY_PENDING' end,
    'dc_documents', v_dc.id,
    jsonb_build_object(
      'status', case when not v_any_delivered then 'dispatched'
                     when v_all_delivered then 'delivered'
                     else 'partially_delivered' end,
      'pod', v_pod,
      'receiver_name', v_receiver,
      'delivered_at', v_at
    ), '{}'::jsonb);

  return app_private.dc_document_json(v_dc.id);
end;
$$;

revoke all on function public.confirm_delivery(jsonb) from public, anonymous;
grant execute on function public.confirm_delivery(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. dc_pending_customer_delivery gains the outstanding quantity
-- ---------------------------------------------------------------------------
--
-- CREATE OR REPLACE refuses to change a RETURNS TABLE, so this one is dropped
-- first - the same way 0019 handled dc_movement_history. Dropping a report
-- function cannot lose data: it holds no state, holds no rows, and no table
-- depends on it.

drop function if exists public.dc_pending_customer_delivery(uuid);

create function public.dc_pending_customer_delivery(p_org uuid)
returns table (
  dc_id uuid,
  dc_number text,
  dc_date date,
  party_id uuid,
  party_name text,
  party_gstin text,
  delivery_purpose text,
  qty_dispatched numeric,
  qty_delivered numeric,
  qty_outstanding numeric,
  dispatch_at timestamptz,
  expected_arrival_at timestamptz,
  status text,
  proof_of_delivery_ref text,
  receiver_name text,
  actual_delivery_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select d.id, d.dc_number, d.dc_date, d.party_id, d.party_name, d.party_gstin, d.delivery_purpose,
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
$$;

revoke all on function public.dc_pending_customer_delivery(uuid) from public, anonymous;
grant execute on function public.dc_pending_customer_delivery(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. dc_dashboard_summary
-- ---------------------------------------------------------------------------
--
-- Two counters - outward_self_open and material_at_vendors - filter on
-- dc_type = 'outward_self', which 0024 deleted. They are permanently zero and
-- 0024 left them alone deliberately. Neither is rendered anywhere, so they are
-- simply removed from the result here rather than left to mislead the next
-- reader. The two counters the dashboard actually shows are unchanged:
-- outward_customer_open already included partially_delivered.

create or replace function public.dc_dashboard_summary(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not app_private.is_org_member(p_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'you are not a member of this workspace');
  end if;

  return jsonb_build_object(
    'inward_this_month', (
      select count(*) from public.dc_documents d
      where d.organization_id = p_org and d.dc_type = 'inward'
        and d.status <> 'cancelled' and d.deleted_at is null
        and d.dc_date >= date_trunc('month', current_date)::date),
    'outward_customer_open', (
      select count(*) from public.dc_documents d
      where d.organization_id = p_org and d.dc_type = 'outward_customer'
        and d.status in ('issued', 'dispatched', 'partially_delivered') and d.deleted_at is null),
    'drafts', (
      select count(*) from public.dc_documents d
      where d.organization_id = p_org and d.status = 'draft' and d.deleted_at is null),
    'cancelled', (
      select count(*) from public.dc_documents d
      where d.organization_id = p_org and d.status = 'cancelled' and d.deleted_at is null),
    'pending_inspection_lines', (
      select count(*) from public.dc_items i
      join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
      where i.organization_id = p_org and d.dc_type = 'inward'
        and d.status not in ('draft', 'cancelled') and d.deleted_at is null
        and i.inspection_required and i.pending_inspection_qty > 0),
    'pending_inspection_quantity', (
      select coalesce(sum(i.pending_inspection_qty), 0) from public.dc_items i
      join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
      where i.organization_id = p_org and d.dc_type = 'inward'
        and d.status not in ('draft', 'cancelled') and d.deleted_at is null
        and i.inspection_required),
    'open_material_rejections', (
      select count(*) from public.dc_rejections r
      where r.organization_id = p_org and r.status in ('open', 'partially_returned')),
    'pending_return_quantity', (
      select coalesce(sum(r.quantity_rejected - r.quantity_returned - r.quantity_scrapped), 0)
      from public.dc_rejections r
      where r.organization_id = p_org and r.status in ('open', 'partially_returned')),
    'machining_rejections_this_month', (
      select coalesce(sum(r.machining_rejection_quantity), 0) from public.dc_machining_results r
      where r.organization_id = p_org
        and r.operation_date >= date_trunc('month', current_date)::date),
    'machining_results_recorded', (
      select count(*) from public.dc_machining_results r where r.organization_id = p_org)
  );
end;
$$;

revoke all on function public.dc_dashboard_summary(uuid) from public, anonymous;
grant execute on function public.dc_dashboard_summary(uuid) to authenticated;

commit;