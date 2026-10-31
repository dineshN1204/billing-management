-- ---------------------------------------------------------------------------
-- 0042 - allow dispatch on a delivered outward challan
--
-- What this fixes
-- ---------------
-- A delivered outward challan cannot be dispatched again, because record_dispatch
-- refused status = 'delivered' with ALREADY_DELIVERED.
--
-- That blocks a real workflow. A machining result for 85 finished pieces, a
-- dispatch of 50, a delivery confirmation of 50 — the challan closes on 'delivered'
-- even though 35 finished pieces are still at the plant. The inward line still
-- reports 35 available, but there is no way to send it without raising a second
-- challan.
--
-- The guard was added in 0025 to prevent dispatching *more material onto a closed
-- document*, but it also prevented sending material that genuinely was still in
-- stock. The balance checks (dc_inward_line_available / dc_available_balance)
-- already cap the dispatch at what is eligible; the status check was redundant
-- with that guard and is now removed.
--
-- What re-dispatching does
-- ------------------------
--
-- 1. It is allowed only when the inward line still has material: the same
--    dc_inward_line_available / dc_available_balance guard runs as before.
--    The balance on a closed challenged is already zero for everything that was
--    dispatched, so a re-dispatch can only add what the inward line still has.
--
-- 2. The status is re-derived from the line quantities after the loop, the same
--    CASE that confirm_delivery uses in 0025. A delivered challan that receives
--    another dispatch lands on 'partially_delivered' (some acknowledged, some
--    not), not back on 'dispatched'. 'dispatched' is only used when nothing has
--    been acknowledged at all.
--
-- 3. actual_delivery_at is cleared when the challan is reopened from 'delivered'.
--    That timestamp means "the customer has taken delivery of everything we sent",
--    and dispatching more means it no longer does. confirm_delivery re-sets it
--    when the challengan is fully acknowledged again; until then it is blank so
--    the Delivery summary does not report a past delivery as the current state.
--    proof_of_delivery_ref and receiver_name are preserved as the history of the
--    first delivery.
--
-- confirm_delivery is unchanged. It still refuses a second close on a 'delivered'
-- challan; the difference is that record_dispatch can now reopen one to
-- 'partially_delivered', after which confirm_delivery will accept the remaining
-- quantity.
-- ---------------------------------------------------------------------------

begin;

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
  v_linked boolean;
  v_was_delivered boolean;
  v_any_delivered boolean;
  v_all_delivered boolean;
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
  -- A delivered challan can be dispatched against again when the inward line
  -- it draws from still has material. The balance guard below is the real
  -- protection; the status check only blocked legitimate re-dispatch.

  v_was_delivered := v_dc.status = 'delivered';

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

    -- The advisory lock still serialises on (party, part, pool), because two
    -- unlinked lines competing for the same pooled balance must not both read
    -- it before either writes.
    perform app_private.dc_lock_material(v_org, v_dc.party_id, v_item.part_number, v_item.supply_source);

    v_linked := v_item.source_inward_item_id is not null;

    if v_linked then
      -- Accepted on the inward line, less what machining threw away, less what
      -- this line's own source has already given to other outward challans.
      v_balance := app_private.dc_inward_line_available(v_org, v_item.source_inward_item_id);
    else
      v_balance := app_private.dc_available_balance(v_org, v_dc.party_id, v_item.part_number, v_item.supply_source);
    end if;

    if v_qty > v_balance then
      perform app_private.raise_error(
        'PT409', 'QUANTITY_EXCEEDED',
        case when v_linked then
          format('cannot dispatch %s of %s: inward line %s has %s left of it',
            v_qty, v_item.part_number, v_item.source_inward_item_id, v_balance)
        else
          format('cannot dispatch %s of %s: only %s is eligible for this customer',
            v_qty, v_item.part_number, v_balance)
        end,
        jsonb_build_object(
          'part_number', v_item.part_number,
          'requested', v_qty,
          'available', v_balance,
          'supply_source', v_item.supply_source,
          'source_inward_item_id', v_item.source_inward_item_id
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

  -- Derive the document status from the lines, the same way confirm_delivery
  -- (0025) does. A line that was never dispatched does not hold the document
  -- open: dispatched <= 0 or delivered >= dispatched.
  select
    coalesce(bool_or(i.qty_delivered > 0), false),
    coalesce(bool_and(i.qty_dispatched <= 0 or i.qty_delivered >= i.qty_dispatched), true)
  into v_any_delivered, v_all_delivered
  from public.dc_items i
  where i.organization_id = v_org and i.dc_id = v_dc.id;

  update public.dc_documents d
  set status = case
         when v_all_delivered then 'delivered'
         when v_any_delivered then 'partially_delivered'
         else 'dispatched'
       end,
       -- The challan is no longer closed the moment more material leaves it.
       -- confirm_delivery re-sets this when the customer acknowledges the
       -- remaining quantity.
       actual_delivery_at = case
         when v_was_delivered then null
         else d.actual_delivery_at
       end,
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

commit;
