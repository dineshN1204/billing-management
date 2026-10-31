-- ---------------------------------------------------------------------------
-- 0027 - the dispatch guard, corrected and tied to the inward line
--
-- The hole this closes
-- --------------------
-- app_private.dc_available_balance computed the customer_material pool as
--
--     sum(inward accepted_qty)
--   - sum(outward_self qty_sent - returned_qty)
--   + sum(outward_self accepted_return_qty)
--
-- and migration 0024 deleted the `outward_self` document type. Both deducting
-- terms were therefore permanently zero, so the pool was simply "everything
-- this customer has ever sent us" and **it never moved**. Dispatching did not
-- reduce it. The same 90 accepted pieces could be dispatched on outward DC
-- after outward DC, each dispatch individually inside the guard, for ever.
--
-- The finished_stock branch was correct all along - it does subtract
-- sum(qty_dispatched) over outward documents - which is why the bug was
-- invisible: anyone shipping their own stock saw sensible numbers, and anyone
-- returning customer material did not.
--
-- The fix
-- -------
--     sum(inward accepted_qty) - sum(outward_customer qty_dispatched)
--
-- Machining rejection is deliberately NOT subtracted here. It is subtracted
-- once, per inward line, by app_private.dc_inward_line_available (0026). A line
-- that has a source is guarded by that per-line figure, so deducting it again
-- from the pooled figure would count the same five rejected pieces twice.
--
-- record_dispatch now prefers the per-line figure whenever the outward line
-- names the inward line it came from, and falls back to the pooled figure for a
-- line with no source (finished stock bought outright, which has no inward
-- material behind it).
--
-- Existing history is untouched
-- ------------------------------
-- qty_dispatched is only ever incremented, and the guard runs against the
-- incremental amount. A challan dispatched under the old rule keeps whatever it
-- already dispatched; it simply cannot be increased past what is left. That is
-- the "block going forward, leave history" rule, and it needs no backfill.
--
-- Also corrected here: machining output was credited to no pool at all.
-- dc_available_balance counts sum(accepted_output_quantity) from
-- dc_machining_results only where material_owner_id equals the party, and the
-- machining panel sent material_owner_id as the item's, which is null unless
-- someone typed it. A machining result carrying a party but no owner is now
-- credited to that party, which is what a record made on an outward challan to
-- a customer always means.
-- ---------------------------------------------------------------------------

begin;

create or replace function app_private.dc_available_balance(
  p_org uuid,
  p_party uuid,
  p_part text,
  p_supply_source text
)
returns numeric
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_balance numeric := 0;
begin
  if p_supply_source = 'finished_stock' then
    select
      coalesce((select sum(m.accepted_output_quantity)
                from public.dc_machining_results m
                where m.organization_id = p_org
                  and m.part_number = p_part
                  and (m.material_owner_id = p_party
                       or (m.material_owner_id is null and m.party_id = p_party))), 0)
      + coalesce((select sum(i.accepted_qty)
                  from public.dc_items i
                  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
                  where i.organization_id = p_org
                    and d.party_id = p_party
                    and d.dc_type = 'inward'
                    and i.supply_source = 'finished_stock'
                    and d.status not in ('draft', 'cancelled')
                    and d.deleted_at is null), 0)
      - coalesce((select sum(i.qty_dispatched)
                  from public.dc_items i
                  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
                  where i.organization_id = p_org
                    and d.party_id = p_party
                    and d.dc_type = 'outward_customer'
                    and i.supply_source = 'finished_stock'
                    and d.status not in ('draft', 'cancelled')
                    and d.deleted_at is null), 0)
    into v_balance;

  elsif p_supply_source = 'customer_material' then
    -- The deduction that was missing. Everything this customer ever received
    -- and accepted, less everything already dispatched back to them.
    select
      coalesce((select sum(i.accepted_qty)
                from public.dc_items i
                join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
                where i.organization_id = p_org
                  and d.party_id = p_party
                  and d.dc_type = 'inward'
                  and i.supply_source = 'customer_material'
                  and i.part_number = p_part
                  and d.status not in ('draft', 'cancelled')
                  and d.deleted_at is null), 0)
      - coalesce((select sum(i.qty_dispatched)
                  from public.dc_items i
                  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
                  where i.organization_id = p_org
                    and d.party_id = p_party
                    and d.dc_type = 'outward_customer'
                    and i.supply_source = 'customer_material'
                    and i.part_number = p_part
                    and d.status not in ('draft', 'cancelled')
                    and d.deleted_at is null), 0)
    into v_balance;
  end if;

  return coalesce(v_balance, 0);
end;
$$;

revoke all on function app_private.dc_available_balance(uuid, uuid, text, text)
  from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- record_dispatch guards against the inward line when there is one
-- ---------------------------------------------------------------------------

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
-- Picker: the inward lines available to draw an outward line from
--
-- One row per inward line of this customer that still has something to give,
-- carrying the figure the guard will actually apply.
-- ---------------------------------------------------------------------------

create or replace function public.dc_inward_lines(
  p_org uuid,
  p_party uuid,
  p_query text default null
)
returns table (
  inward_dc_id uuid,
  inward_dc_number text,
  inward_dc_date date,
  inward_status text,
  item_id uuid,
  line_no integer,
  part_number text,
  customer_part_number text,
  customer_dc_number text,
  drawing_number text,
  drawing_revision text,
  batch_lot_no text,
  unit text,
  received_qty numeric,
  accepted_qty numeric,
  machining_rejection_qty numeric,
  dispatched_qty numeric,
  available_qty numeric
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

  if p_party is null then
    perform app_private.raise_validation('party_id', 'is required');
  end if;

  return query
  with src as (
    select
      i.id as item_id,
      i.line_no,
      i.part_number,
      i.customer_part_number,
      i.customer_dc_number,
      i.drawing_number,
      i.drawing_revision,
      i.batch_lot_no,
      i.unit,
      i.received_qty,
      i.accepted_qty,
      d.id as dc_id,
      d.dc_number,
      d.dc_date,
      d.status,
      d.external_dc_number
    from public.dc_items i
    join public.dc_documents d
      on d.organization_id = i.organization_id and d.id = i.dc_id
    where i.organization_id = p_org
      and d.party_id = p_party
      and d.dc_type = 'inward'
      and d.deleted_at is null
      and d.status not in ('draft', 'cancelled')
  ),
  filtered as (
    select s.*
    from src s
    where p_query is null or btrim(p_query) = '' or (
      s.part_number ilike '%' || p_query || '%'
      or coalesce(s.customer_dc_number, '') ilike '%' || p_query || '%'
      or coalesce(s.external_dc_number, '') ilike '%' || p_query || '%'
      or s.dc_number ilike '%' || p_query || '%'
      or coalesce(s.drawing_number, '') ilike '%' || p_query || '%'
    )
  )
  select
    f.dc_id,
    f.dc_number,
    f.dc_date,
    f.status,
    f.item_id,
    f.line_no,
    f.part_number,
    f.customer_part_number,
    f.customer_dc_number,
    f.drawing_number,
    f.drawing_revision,
    f.batch_lot_no,
    f.unit,
    f.received_qty,
    f.accepted_qty,
    coalesce((
      select sum(m.machining_rejection_quantity)
      from public.dc_machining_results m
      join public.dc_items oi
        on oi.organization_id = m.organization_id and oi.id = m.source_dc_item_id
      where m.organization_id = p_org and oi.source_inward_item_id = f.item_id
    ), 0),
    coalesce((
      select sum(oi.qty_dispatched)
      from public.dc_items oi
      join public.dc_documents od
        on od.organization_id = oi.organization_id and od.id = oi.dc_id
      where oi.organization_id = p_org
        and oi.source_inward_item_id = f.item_id
        and od.dc_type = 'outward_customer'
        and od.status not in ('draft', 'cancelled')
        and od.deleted_at is null
    ), 0),
    app_private.dc_inward_line_available(p_org, f.item_id)
  from filtered f
  where app_private.dc_inward_line_available(p_org, f.item_id) > 0
  order by f.dc_date desc, f.dc_number desc, f.line_no;
end;
$$;

revoke all on function public.dc_inward_lines(uuid, uuid, text) from public, anonymous;
grant execute on function public.dc_inward_lines(uuid, uuid, text) to authenticated;

commit;
