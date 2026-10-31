-- ---------------------------------------------------------------------------
-- 0026 - the customer's own DC number, recorded on the line it belongs to
--
-- The workflow this supports
-- --------------------------
-- A customer does not send one challan. They send several of their own, each
-- with its own number, each carrying different parts and drawings. What arrives
-- at our gate is then recorded as ONE inward challan of ours, whose lines come
-- from several of theirs:
--
--   INW-0021 (ours)
--     line 1  part A  drawing X  <- customer CUST-4411
--     line 2  part B  drawing Y  <- customer CUST-4412
--     line 3  part C  drawing Z  <- customer CUST-4413
--
--     receipt      100 received -> 90 accepted, 10 rejected
--     machining    input 90 -> 5 machining rejection -> 85 accepted output
--
--   OUT-0034 / OUT-0035 (ours, one or many) carry source_inward_item_id on
--   each line, so every outward line names the inward line it came from.
--
-- What was missing
-- ----------------
-- `dc_documents.external_dc_number` holds ONE customer DC number for the whole
-- challan, so it cannot express the case above, and nothing in the application
-- ever set it per line. `dc_items.source_inward_item_id` already existed with
-- its foreign key (0014) but had no UI at all, so it was always null: outward
-- lines had no link back to the inward material they were made from.
--
-- What this migration changes
-- ---------------------------
--  1. dc_items gains `customer_dc_number`, so a line can say which of the
--     customer's own challans it arrived on. Indexed, because it becomes a
--     search key.
--  2. app_private.dc_require_inward_source validates a source link: the line
--     must belong to an active inward challan of the SAME customer, and must
--     carry the same part number. Without the part check an outward line for
--     part A could be fed by an inward line for part B, and the balance guard
--     below would then be answering a question about the wrong material.
--  3. app_private.dc_save_document carries customer_dc_number and validates
--     every source link on save.
--  4. app_private.dc_document_json reports, per line, where it came from and
--     how much of that source is still available, plus a document-level list of
--     every customer DC number the challan touches.
--
-- dc_documents.external_dc_number is left exactly as it is. It is a single
-- header value with a single meaning, it may be set on documents that predate
-- this migration, and nothing downstream of the quantity rules reads it. The
-- per-line column is the authoritative one; keeping both avoids a silent
-- rewrite of history.
--
-- Forward-only: one column added, one check added, three functions replaced.
-- No row is deleted or rewritten. Existing lines take customer_dc_number =
-- null, which correctly reads as "the customer's challan number was not
-- recorded on this line".
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------

alter table public.dc_items
  add column if not exists customer_dc_number text;

alter table public.dc_items
  drop constraint if exists dc_items_customer_dc_number_check;

alter table public.dc_items
  add constraint dc_items_customer_dc_number_check
  check (customer_dc_number is null or char_length(btrim(customer_dc_number)) between 1 and 64);

-- Searched by the DC picker and by dc_search, so it needs its own index. No
-- customer-DC column in this schema was indexed before.
create index if not exists dc_items_customer_dc_number_idx
  on public.dc_items (organization_id, customer_dc_number)
  where customer_dc_number is not null;

-- The outward form resolves "what is left of inward line X", and the job
-- progress walk goes outward line -> inward line, on every open challan.
create index if not exists dc_items_source_inward_idx
  on public.dc_items (organization_id, source_inward_item_id)
  where source_inward_item_id is not null;

-- The header-level customer number is searched too, so it gets the same
-- treatment it never had.
create index if not exists dc_documents_external_dc_number_idx
  on public.dc_documents (organization_id, lower(btrim(external_dc_number)))
  where external_dc_number is not null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- 2. What is left of one inward line
--
--   accepted            what inspection passed
-- - machining rejection what machining threw away
-- - dispatched          what outward lines have already taken
--
-- Machining is reached through the outward line, because record_machining_result
-- is filed against the outward challan: source_dc_id is the outward document and
-- source_dc_item_id is the outward line. Joining outward line -> its
-- source_inward_item_id is what puts a machining rejection back on the inward
-- line whose material was consumed.
-- ---------------------------------------------------------------------------

create or replace function app_private.dc_inward_line_available(p_org uuid, p_inward_item uuid)
returns numeric
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with src as (
    select i.id, i.accepted_qty
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
    select coalesce(sum(m.machining_rejection_quantity), 0) as rejected
    from public.dc_machining_results m
    join public.dc_items oi
      on oi.organization_id = m.organization_id and oi.id = m.source_dc_item_id
    where m.organization_id = p_org
      and oi.source_inward_item_id = p_inward_item
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
    coalesce((select accepted_qty from src), 0)
    - (select rejected from machined)
    - (select dispatched from dispatched),
    0
  );
$$;

revoke all on function app_private.dc_inward_line_available(uuid, uuid) from public, anonymous, authenticated;

create or replace function public.dc_inward_line_availability(p_org uuid, p_inward_item_id uuid)
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

  return app_private.dc_inward_line_available(p_org, p_inward_item_id);
end;
$$;

revoke all on function public.dc_inward_line_availability(uuid, uuid) from public, anonymous;
grant execute on function public.dc_inward_line_availability(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The source link guard
-- ---------------------------------------------------------------------------

create or replace function app_private.dc_require_inward_source(
  p_org uuid,
  p_party uuid,
  p_source_item uuid,
  p_part text
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item_id uuid;
  v_party uuid;
  v_part text;
begin
  -- An outward line with no source is legitimate: finished stock the customer
  -- bought outright has no inward line behind it.
  if p_source_item is null then
    return null;
  end if;

  select i.id, d.party_id, i.part_number
  into v_item_id, v_party, v_part
  from public.dc_items i
  join public.dc_documents d
    on d.organization_id = i.organization_id and d.id = i.dc_id
  where i.organization_id = p_org
    and i.id = p_source_item
    and d.dc_type = 'inward'
    and d.deleted_at is null
    and d.status <> 'cancelled';

  if not found then
    perform app_private.raise_error(
      'PT409', 'INVALID_SOURCE',
      'the source line is not an active inward challan line in this workspace'
    );
  end if;

  if v_party <> p_party then
    perform app_private.raise_error(
      'PT409', 'SOURCE_PARTY_MISMATCH',
      'the source inward challan belongs to a different customer'
    );
  end if;

  -- Compared on the trimmed, lowercased form so a trailing space or a different
  -- case is not the difference between a valid link and a refused save.
  if lower(btrim(v_part)) <> lower(btrim(coalesce(p_part, ''))) then
    perform app_private.raise_error(
      'PT409', 'SOURCE_PART_MISMATCH',
      format('the source inward line is for %s, not %s', v_part, p_part),
      jsonb_build_object('source_part_number', v_part, 'line_part_number', p_part)
    );
  end if;

  return v_item_id;
end;
$$;

revoke all on function app_private.dc_require_inward_source(uuid, uuid, uuid, text)
  from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- 4. dc_save_document carries customer_dc_number and validates source links
-- ---------------------------------------------------------------------------

create or replace function app_private.dc_save_document(
  p_org uuid,
  p_uid uuid,
  p_payload jsonb,
  p_dc_type text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_dc_id uuid := app_private.parse_uuid(p_payload -> 'dc_id', 'dc_id', false);
  v_is_create boolean := (v_dc_id is null);
  v_existing public.dc_documents;
  v_party jsonb;
  v_date date;
  v_number text;
  v_status text;
  v_finalize boolean := coalesce((p_payload ->> 'finalize')::boolean, false);
  v_items jsonb;
  v_elem jsonb;
  v_ord integer := 0;
  v_part text;
  v_source text;
  v_prev jsonb;
  v_result jsonb;
  v_expected_version integer;
  v_party_id uuid;
  v_source_item uuid;
begin
  perform app_private.dc_require_movement_write(p_org);

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    perform app_private.raise_validation('payload', 'must be a JSON object');
  end if;

  v_date := app_private.parse_date(p_payload -> 'dc_date', 'dc_date', true);
  v_expected_version := app_private.parse_numeric(p_payload -> 'expected_version', 'expected_version', false, 0, 1, 2147483647)::integer;
  v_party_id := app_private.parse_uuid(p_payload -> 'party_id', 'party_id', true);
  v_party := app_private.dc_party_snapshot(p_org, v_party_id);

  if not v_is_create then
    select * into v_existing
    from public.dc_documents d
    where d.organization_id = p_org and d.id = v_dc_id and d.deleted_at is null
    for update;

    if not found then
      perform app_private.raise_error('PT404', 'NOT_FOUND', 'delivery challan not found');
    end if;
    if v_existing.dc_type <> p_dc_type then
      perform app_private.raise_validation('dc_type', 'does not match the document being edited');
    end if;
    if v_existing.status = 'cancelled' then
      perform app_private.raise_error('PT409', 'DOCUMENT_CANCELLED', 'a cancelled challan cannot be edited');
    end if;
    if v_finalize and v_existing.status <> 'draft' then
      perform app_private.raise_error('PT409', 'ALREADY_FINALIZED', 'this challan is already finalized');
    end if;
    if v_expected_version is not null and v_expected_version <> v_existing.version then
      perform app_private.raise_error('PT409', 'VERSION_CONFLICT', 'this challan changed elsewhere; reload it before saving');
    end if;
    v_prev := to_jsonb(v_existing);
    v_number := v_existing.dc_number;
  else
    perform app_private.dc_seed_options(p_org);
    v_number := app_private.dc_reserve_number(p_org, p_dc_type, v_date);
  end if;

  v_status := case when v_finalize then 'issued' else 'draft' end;

  insert into public.dc_documents (
    id, organization_id, dc_type, dc_number, dc_date, financial_year, status,
    party_id, party_type, party_name, party_gstin, party_phone, party_email,
    party_address, party_state_code, party_pincode, party_contact_person, party_ship_to,
    receipt_type, movement_type, delivery_purpose, purpose,
    external_dc_number, external_dc_date, external_notes,
    purchase_order_no, job_work_order_id, production_order_id, reference_inward_dc_id,
    customer_order_reference, delivery_schedule_reference,
    mode_of_transport, transporter_name, transporter_gstin, vehicle_number,
    driver_name, driver_contact, lr_number, docket_number, eway_bill_number,
    package_count, package_type, gross_weight, net_weight,
    dispatch_at, expected_arrival_at, actual_arrival_at, expected_return_at, actual_delivery_at,
    receipt_date, receipt_time,
    received_by, prepared_by, authorized_by, receiver_name, proof_of_delivery_ref,
    unloading_remarks, dispatch_remarks, remarks, internal_remarks,
    finalized_at, finalized_by, version, created_by, updated_by
  ) values (
    coalesce(v_dc_id, gen_random_uuid()),
    p_org, p_dc_type, v_number, v_date, app_private.dc_financial_year(v_date), v_status,
    v_party_id,
    coalesce(app_private.parse_enum(v_party -> 'party_type', 'party_type',
      array['customer', 'supplier', 'vendor', 'other'], null), 'customer'),
    coalesce(app_private.parse_text(v_party -> 'name', 'party_name', true, 200), '—'),
    nullif(upper(regexp_replace(coalesce(v_party ->> 'gstin', ''), '\s+', '', 'g')), ''),
    app_private.parse_text(v_party -> 'phone', 'party_phone', false, 32),
    app_private.parse_text(v_party -> 'email', 'party_email', false, 254),
    app_private.parse_text(v_party -> 'party_address', 'party_address', false, 500),
    app_private.parse_text(v_party -> 'state_code', 'party_state_code', false, 2),
    app_private.parse_text(v_party -> 'pincode', 'party_pincode', false, 6),
    app_private.parse_text(p_payload -> 'party_contact_person', 'party_contact_person', false, 120),
    app_private.parse_text(p_payload -> 'party_ship_to', 'party_ship_to', false, 500),

    app_private.parse_enum(p_payload -> 'receipt_type', 'receipt_type',
      array['raw_material', 'customer_owned', 'semi_finished', 'inspection_rework', 'return_from_processing', 'other'], null),
    app_private.parse_enum(p_payload -> 'movement_type', 'movement_type',
      array['subcontracting', 'inter_company', 'return_to_supplier', 'testing', 'inspection', 'other'], null),
    app_private.parse_enum(p_payload -> 'delivery_purpose', 'delivery_purpose',
      array['finished_goods', 'partially_processed', 'sample', 'customer_inspection', 'replacement', 'rework', 'other'], null),
    app_private.parse_text(p_payload -> 'purpose', 'purpose', false, 500),

    app_private.parse_text(p_payload -> 'external_dc_number', 'external_dc_number', false, 64),
    app_private.parse_date(p_payload -> 'external_dc_date', 'external_dc_date', false),
    app_private.parse_text(p_payload -> 'external_notes', 'external_notes', false, 2000),

    app_private.parse_text(p_payload -> 'purchase_order_no', 'purchase_order_no', false, 64),
    app_private.parse_uuid(p_payload -> 'job_work_order_id', 'job_work_order_id', false),
    app_private.parse_uuid(p_payload -> 'production_order_id', 'production_order_id', false),
    app_private.parse_uuid(p_payload -> 'reference_inward_dc_id', 'reference_inward_dc_id', false),
    app_private.parse_text(p_payload -> 'customer_order_reference', 'customer_order_reference', false, 64),
    app_private.parse_text(p_payload -> 'delivery_schedule_reference', 'delivery_schedule_reference', false, 64),

    app_private.parse_text(p_payload -> 'mode_of_transport', 'mode_of_transport', false, 64),
    app_private.parse_text(p_payload -> 'transporter_name', 'transporter_name', false, 120),
    nullif(upper(regexp_replace(coalesce(p_payload ->> 'transporter_gstin', ''), '\s+', '', 'g')), ''),
    app_private.parse_text(p_payload -> 'vehicle_number', 'vehicle_number', false, 32),
    app_private.parse_text(p_payload -> 'driver_name', 'driver_name', false, 120),
    app_private.parse_text(p_payload -> 'driver_contact', 'driver_contact', false, 32),
    app_private.parse_text(p_payload -> 'lr_number', 'lr_number', false, 64),
    app_private.parse_text(p_payload -> 'docket_number', 'docket_number', false, 64),
    app_private.parse_text(p_payload -> 'eway_bill_number', 'eway_bill_number', false, 64),

    app_private.parse_numeric(p_payload -> 'package_count', 'package_count', false, 3, 0, 99999999),
    app_private.parse_text(p_payload -> 'package_type', 'package_type', false, 64),
    app_private.parse_numeric(p_payload -> 'gross_weight', 'gross_weight', false, 3, 0, 99999999),
    app_private.parse_numeric(p_payload -> 'net_weight', 'net_weight', false, 3, 0, 99999999),

    app_private.parse_timestamp(p_payload -> 'dispatch_at', 'dispatch_at'),
    app_private.parse_timestamp(p_payload -> 'expected_arrival_at', 'expected_arrival_at'),
    app_private.parse_timestamp(p_payload -> 'actual_arrival_at', 'actual_arrival_at'),
    app_private.parse_timestamp(p_payload -> 'expected_return_at', 'expected_return_at'),
    app_private.parse_timestamp(p_payload -> 'actual_delivery_at', 'actual_delivery_at'),
    app_private.parse_date(p_payload -> 'receipt_date', 'receipt_date', false),
    nullif(btrim(p_payload ->> 'receipt_time'), '')::time,

    app_private.parse_text(p_payload -> 'received_by', 'received_by', false, 120),
    app_private.parse_text(p_payload -> 'prepared_by', 'prepared_by', false, 120),
    app_private.parse_text(p_payload -> 'authorized_by', 'authorized_by', false, 120),
    app_private.parse_text(p_payload -> 'receiver_name', 'receiver_name', false, 120),
    app_private.parse_text(p_payload -> 'proof_of_delivery_ref', 'proof_of_delivery_ref', false, 120),
    app_private.parse_text(p_payload -> 'unloading_remarks', 'unloading_remarks', false, 2000),
    app_private.parse_text(p_payload -> 'dispatch_remarks', 'dispatch_remarks', false, 2000),
    app_private.parse_text(p_payload -> 'remarks', 'remarks', false, 5000),
    app_private.parse_text(p_payload -> 'internal_remarks', 'internal_remarks', false, 5000),

    case when v_finalize then now() end,
    case when v_finalize then p_uid end,
    case when v_finalize then 1 else 1 end,
    case when v_is_create then p_uid else null end,
    p_uid
  )
  on conflict (organization_id, id) do update set
    dc_date = excluded.dc_date,
    financial_year = excluded.financial_year,
    status = excluded.status,
    party_id = excluded.party_id,
    party_type = excluded.party_type,
    party_name = excluded.party_name,
    party_gstin = excluded.party_gstin,
    party_phone = excluded.party_phone,
    party_email = excluded.party_email,
    party_address = excluded.party_address,
    party_state_code = excluded.party_state_code,
    party_pincode = excluded.party_pincode,
    party_contact_person = excluded.party_contact_person,
    party_ship_to = excluded.party_ship_to,
    receipt_type = excluded.receipt_type,
    movement_type = excluded.movement_type,
    delivery_purpose = excluded.delivery_purpose,
    purpose = excluded.purpose,
    external_dc_number = excluded.external_dc_number,
    external_dc_date = excluded.external_dc_date,
    external_notes = excluded.external_notes,
    purchase_order_no = excluded.purchase_order_no,
    job_work_order_id = excluded.job_work_order_id,
    production_order_id = excluded.production_order_id,
    reference_inward_dc_id = excluded.reference_inward_dc_id,
    customer_order_reference = excluded.customer_order_reference,
    delivery_schedule_reference = excluded.delivery_schedule_reference,
    mode_of_transport = excluded.mode_of_transport,
    transporter_name = excluded.transporter_name,
    transporter_gstin = excluded.transporter_gstin,
    vehicle_number = excluded.vehicle_number,
    driver_name = excluded.driver_name,
    driver_contact = excluded.driver_contact,
    lr_number = excluded.lr_number,
    docket_number = excluded.docket_number,
    eway_bill_number = excluded.eway_bill_number,
    package_count = excluded.package_count,
    package_type = excluded.package_type,
    gross_weight = excluded.gross_weight,
    net_weight = excluded.net_weight,
    dispatch_at = excluded.dispatch_at,
    expected_arrival_at = excluded.expected_arrival_at,
    actual_arrival_at = excluded.actual_arrival_at,
    expected_return_at = excluded.expected_return_at,
    actual_delivery_at = excluded.actual_delivery_at,
    receipt_date = excluded.receipt_date,
    receipt_time = excluded.receipt_time,
    received_by = excluded.received_by,
    prepared_by = excluded.prepared_by,
    authorized_by = excluded.authorized_by,
    receiver_name = excluded.receiver_name,
    proof_of_delivery_ref = excluded.proof_of_delivery_ref,
    unloading_remarks = excluded.unloading_remarks,
    dispatch_remarks = excluded.dispatch_remarks,
    remarks = excluded.remarks,
    internal_remarks = excluded.internal_remarks,
    finalized_at = excluded.finalized_at,
    finalized_by = excluded.finalized_by,
    version = public.dc_documents.version + 1,
    updated_by = p_uid
  returning id into v_dc_id;

  -- An update re-reads the party snapshot, so a finalized document keeps the
  -- details it was finalized with only if the party itself is unchanged. Every
  -- edit here is a new save of a draft, which is the point at which the party is
  -- captured.
  v_items := p_payload -> 'items';
  if v_items is null or jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
    perform app_private.raise_validation('items', 'must contain at least one line item');
  end if;

  delete from public.dc_items where organization_id = p_org and dc_id = v_dc_id;

  for v_elem in select value from jsonb_array_elements(v_items) loop
    v_ord := v_ord + 1;
    v_part := app_private.parse_text(v_elem -> 'part_number', 'part_number', true, 64);
    v_source := app_private.parse_enum(v_elem -> 'supply_source', 'supply_source',
      array['customer_material', 'finished_stock', 'other'], null);

    if v_source is null then
      v_source := case when p_dc_type = 'outward_customer' then 'finished_stock' else 'customer_material' end;
    end if;

    -- Validated before the insert rather than by a table constraint, so the
    -- refusal names the reason instead of surfacing as a foreign key violation.
    v_source_item := app_private.dc_require_inward_source(
      p_org, v_party_id,
      app_private.parse_uuid(v_elem -> 'source_inward_item_id', 'source_inward_item_id', false),
      v_part
    );

    insert into public.dc_items (
      organization_id, dc_id, line_no, product_id, part_number, customer_part_number,
      customer_dc_number, description, drawing_number, drawing_revision, batch_lot_no,
      heat_no, material_grade, unit, supply_source, declared_qty, processing_operation,
      ordered_qty, source_inward_item_id, material_owner_id, production_order_id,
      storage_location, item_remarks
    ) values (
      p_org, v_dc_id, v_ord,
      app_private.parse_uuid(v_elem -> 'product_id', 'product_id', false),
      v_part,
      app_private.parse_text(v_elem -> 'customer_part_number', 'customer_part_number', false, 64),
      app_private.parse_text(v_elem -> 'customer_dc_number', 'customer_dc_number', false, 64),
      app_private.parse_text(v_elem -> 'description', 'description', false, 500),
      app_private.parse_text(v_elem -> 'drawing_number', 'drawing_number', false, 64),
      app_private.parse_text(v_elem -> 'drawing_revision', 'drawing_revision', false, 32),
      app_private.parse_text(v_elem -> 'batch_lot_no', 'batch_lot_no', false, 64),
      app_private.parse_text(v_elem -> 'heat_no', 'heat_no', false, 64),
      app_private.parse_text(v_elem -> 'material_grade', 'material_grade', false, 64),
      coalesce(app_private.parse_text(v_elem -> 'unit', 'unit', true, 32), 'NOS'),
      v_source,
      app_private.parse_numeric(v_elem -> 'declared_qty', 'declared_qty', false, 3, 0, 99999999),
      app_private.parse_text(v_elem -> 'processing_operation', 'processing_operation', false, 120),
      app_private.parse_numeric(v_elem -> 'ordered_qty', 'ordered_qty', false, 3, 0, 99999999),
      v_source_item,
      app_private.parse_uuid(v_elem -> 'material_owner_id', 'material_owner_id', false),
      app_private.parse_uuid(v_elem -> 'production_order_id', 'production_order_id', false),
      app_private.parse_text(v_elem -> 'storage_location', 'storage_location', false, 120),
      app_private.parse_text(v_elem -> 'item_remarks', 'item_remarks', false, 500)
    );
  end loop;

  insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, old_data, new_data, metadata)
  values (
    p_org, p_uid, case when v_is_create then 'CREATE' else 'UPDATE' end, 'dc_documents', v_dc_id,
    v_prev,
    (select to_jsonb(d) from public.dc_documents d where d.id = v_dc_id),
    jsonb_build_object('dc_type', p_dc_type, 'finalized', v_finalize)
  );

  v_result := app_private.dc_document_json(v_dc_id);
  return v_result;
end;
$$;

revoke all on function app_private.dc_save_document(uuid, uuid, jsonb, text)
  from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The read model reports the source of every line
-- ---------------------------------------------------------------------------

create or replace function app_private.dc_document_json(p_dc_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'document', to_jsonb(d) - 'created_at' - 'updated_at',
    -- Every customer DC number this document touches: the ones written on its
    -- own lines (an inward challan) and the ones behind the lines it drew from
    -- (an outward challan). One inward can reference several of the customer's
    -- challans, and one outward can be fed by several of ours, so this is
    -- always a list.
    'customer_dc_numbers', coalesce((
      select jsonb_agg(n.dc order by n.dc)
      from (
        select distinct customer_dc_number as dc
        from (
          select i.customer_dc_number
          from public.dc_items i
          where i.organization_id = d.organization_id
            and i.dc_id = d.id
            and i.customer_dc_number is not null
          union
          select s.customer_dc_number
          from public.dc_items oi
          join public.dc_items s
            on s.organization_id = oi.organization_id and s.id = oi.source_inward_item_id
          where oi.organization_id = d.organization_id
            and oi.dc_id = d.id
            and s.customer_dc_number is not null
        ) nums
      ) n
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(
        to_jsonb(i) - 'created_at' - 'updated_at'
        || jsonb_build_object(
             'source_inward_dc_id', src_d.id,
             'source_inward_dc_number', src_d.dc_number,
             'source_inward_line_no', src_i.line_no,
             'source_inward_customer_dc_number', src_i.customer_dc_number,
             'source_inward_accepted_qty', src_i.accepted_qty,
             'source_available_qty', app_private.dc_inward_line_available(d.organization_id, src_i.id)
           )
        order by i.line_no)
      from public.dc_items i
      left join public.dc_items src_i
        on src_i.organization_id = i.organization_id and src_i.id = i.source_inward_item_id
      left join public.dc_documents src_d
        on src_d.organization_id = src_i.organization_id and src_d.id = src_i.dc_id
      where i.organization_id = d.organization_id and i.dc_id = d.id
    ), '[]'::jsonb),
    'movements', coalesce((
      select jsonb_agg(to_jsonb(m) - 'created_at' order by m.moved_at)
      from public.dc_movements m
      where m.organization_id = d.organization_id and m.dc_id = d.id
    ), '[]'::jsonb),
    'inspections', coalesce((
      select jsonb_agg(to_jsonb(s) - 'created_at' order by s.inspected_at)
      from public.dc_inspections s
      where s.organization_id = d.organization_id and s.dc_id = d.id
    ), '[]'::jsonb),
    'machining_results', coalesce((
      select jsonb_agg(to_jsonb(r) - 'created_at' order by r.operation_date, r.created_at)
      from public.dc_machining_results r
      where r.organization_id = d.organization_id and r.source_dc_id = d.id
    ), '[]'::jsonb),
    'rejections', coalesce((
      select jsonb_agg(to_jsonb(x) - 'created_at' - 'updated_at' order by x.rejection_date, x.created_at)
      from public.dc_rejections x
      where x.organization_id = d.organization_id and x.dc_id = d.id
    ), '[]'::jsonb)
  )
  from public.dc_documents d
  where d.id = p_dc_id;
$$;

revoke all on function app_private.dc_document_json(uuid) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- 6. The register carries the customer DC numbers
--
-- GSTIN stays on the register: the search spans both, and the list page is
-- where a row is compared against paperwork. It is the printed challan and the
-- customer record that carry the GSTIN as a display field.
-- ---------------------------------------------------------------------------

drop function if exists public.dc_register(uuid, text, date, date, text);

create function public.dc_register(
  p_org uuid,
  p_dc_type text default null,
  p_from date default null,
  p_to date default null,
  p_status text default null
)
returns table (
  id uuid,
  dc_number text,
  dc_type text,
  dc_date date,
  status text,
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
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
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
  order by d.dc_date desc, d.created_at desc;
$$;

revoke all on function public.dc_register(uuid, text, date, date, text) from public, anonymous;
grant execute on function public.dc_register(uuid, text, date, date, text) to authenticated;

commit;
