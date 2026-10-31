-- ---------------------------------------------------------------------------
-- 0035 - the outward challan that answers an inward one
--
-- What this changes
-- -----------------
-- 1. An outward customer challan raised against an inward challan is numbered
--    with the *same serial*: inward KI/IN/2026-27/0005 is answered by outward
--    KI/OUT-C/2026-27/0005. A second outward for the same inward is
--    KI/OUT-C/2026-27/0005-2, and a third is 0005-3.
-- 2. The inward challan says so. The receipt status on an inward challan means
--    "the material arrived at our gate" and must keep meaning that, so the
--    progress of the *work* stays a separate, derived value - but that value now
--    reads "Work in process" from the moment an outward challan is raised,
--    instead of "Pending" until the truck leaves.
-- 3. The outward challan may name the inward challan it answers
--    (dc_documents.reference_inward_dc_id, a column that has existed since
--    0014 and had no writer). When it does, every linked line must come from
--    that one inward challan and the customer must be the same, because the
--    number now claims that relationship.
--
-- Why the serial is borrowed rather than copied
-- ---------------------------------------------
-- A shop that takes in a customer's material on their challan 500 and returns
-- the finished parts wants to see the two documents sit next to each other in
-- the register. Two independent sequences put KI/IN/.../0005 next to
-- KI/OUT-C/.../0031 and force the reader to look up the link every time.
--
-- The number is a promise, so it is made once and kept: a challan's number
-- never changes after it is issued, and no existing challan is renumbered by
-- this migration. The outward sequence also skips any number a mirrored
-- challan has already taken, so the two can never collide.
--
-- The financial year is the outward document's own year, taken from its date.
-- An inward received in March and answered in April therefore reads
-- KI/IN/2025-26/0005 and KI/OUT-C/2026-27/0005, which is correct: the second
-- document is dated in the second year.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. The normal sequence, made collision-proof
-- ---------------------------------------------------------------------------
--
-- The upsert on the sequence row was already the concurrency control, but it
-- only protected the sequence. Now that a mirrored number can sit outside the
-- sequence, the sequence has to look before it hands a number out: if the
-- number it produced is already on a document, it takes the next one.
--
-- The advisory lock is taken on (organization, document type, financial year)
-- so the mirrored path and the sequential path cannot pick the same number at
-- the same moment. It is released when the transaction ends.

create or replace function app_private.dc_reserve_number(
  p_org uuid,
  p_dc_type text,
  p_date date
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_fy text;
  v_value bigint;
  v_prefix text;
  v_segment text;
  v_padding integer;
  v_number text;
begin
  v_fy := app_private.dc_financial_year(p_date);

  perform pg_advisory_xact_lock(
    hashtextextended(p_org::text || ':dcnum:' || p_dc_type || ':' || v_fy, 0)
  );

  insert into public.dc_settings (organization_id, dc_type, prefix, segment_code, padding)
  values (p_org, p_dc_type, 'KI', app_private.dc_default_segment(p_dc_type), 4)
  on conflict (organization_id, dc_type) do nothing;

  select prefix, segment_code, padding into v_prefix, v_segment, v_padding
  from public.dc_settings
  where organization_id = p_org and dc_type = p_dc_type;

  loop
    insert into public.dc_number_sequences (organization_id, dc_type, financial_year, next_value)
    values (p_org, p_dc_type, v_fy, 2)
    on conflict (organization_id, dc_type, financial_year)
      do update set next_value = public.dc_number_sequences.next_value + 1, updated_at = now()
    returning next_value - 1 into v_value;

    v_number := format('%s/%s/%s/%s', v_prefix, v_segment, v_fy, lpad(v_value::text, v_padding, '0'));

    exit when not exists (
      select 1
      from public.dc_documents d
      where d.organization_id = p_org
        and d.dc_type = p_dc_type
        and d.dc_number_normalized = lower(btrim(v_number))
    );
  end loop;

  return v_number;
end;
$$;

revoke all on function app_private.dc_reserve_number(uuid, text, date) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The mirrored number
-- ---------------------------------------------------------------------------
--
-- Reads the serial off the inward challan (the last "/"-separated part of its
-- number) and answers with the outward prefix and segment. If that number is
-- already taken by another outward for the same inward, -2, -3 and so on are
-- tried.
--
-- An inward number that does not end in a number - a manually typed reference,
-- say - falls back to the ordinary outward sequence rather than producing
-- something like KI/OUT-C/2026-27/REF12.

create or replace function app_private.dc_reserve_outward_number(
  p_org uuid,
  p_inward_id uuid,
  p_date date
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inward public.dc_documents;
  v_fy text;
  v_serial text;
  v_prefix text;
  v_segment text;
  v_padding integer;
  v_number text;
  v_try integer := 1;
begin
  select * into v_inward
  from public.dc_documents d
  where d.organization_id = p_org
    and d.id = p_inward_id
    and d.dc_type = 'inward'
    and d.deleted_at is null;

  if not found then
    perform app_private.raise_validation(
      'reference_inward_dc_id',
      'is not an inward challan in this workspace'
    );
    return null;
  end if;

  -- The part after the last slash: 0005 out of KI/IN/2026-27/0005.
  v_serial := regexp_replace(v_inward.dc_number, '^.*/', '');

  if v_serial !~ '^[0-9]+$' then
    return app_private.dc_reserve_number(p_org, 'outward_customer', p_date);
  end if;

  v_fy := app_private.dc_financial_year(p_date);

  perform pg_advisory_xact_lock(
    hashtextextended(p_org::text || ':dcnum:outward_customer:' || v_fy, 0)
  );

  insert into public.dc_settings (organization_id, dc_type, prefix, segment_code, padding)
  values (p_org, 'outward_customer', 'KI', 'OUT-C', 4)
  on conflict (organization_id, dc_type) do nothing;

  select prefix, segment_code, padding into v_prefix, v_segment, v_padding
  from public.dc_settings
  where organization_id = p_org and dc_type = 'outward_customer';

  loop
    v_number := format(
      '%s/%s/%s/%s',
      v_prefix, v_segment, v_fy,
      v_serial || case when v_try = 1 then '' else '-' || v_try::text end
    );

    exit when not exists (
      select 1
      from public.dc_documents d
      where d.organization_id = p_org
        and d.dc_type = 'outward_customer'
        and d.dc_number_normalized = lower(btrim(v_number))
    );

    v_try := v_try + 1;
  end loop;

  return v_number;
end;
$$;

revoke all on function app_private.dc_reserve_outward_number(uuid, uuid, date) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The save path, taught about the reference
-- ---------------------------------------------------------------------------
--
-- The body below is the function from 0026, unchanged except in four places,
-- each marked. Everything else - the receipt lifecycle, the party snapshot,
-- the audit row, the line validation - is carried over exactly.
--
--   a. the reference is read once, into a variable, and kept when an update
--      does not mention it (an update that silently dropped it would break the
--      link between the two documents on the next edit);
--   b. the reference is checked: it must be an inward challan of the same
--      customer in this workspace;
--   c. a new outward challan that names an inward one takes the mirrored
--      number;
--   d. every linked line must come from the inward challan that was named,
--      because the number says the whole outward challan answers that one.

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
  -- (a) the inward challan this document answers, when it answers one.
  v_reference_inward uuid;
  v_reference_party uuid;
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
  end if;

  -- (a) The reference. A create takes it from the payload; an update takes it
  -- from the payload when it is mentioned and otherwise keeps what is stored,
  -- so editing an outward challan cannot quietly detach it from the inward one
  -- it answers.
  if v_is_create or p_payload ? 'reference_inward_dc_id' then
    v_reference_inward := app_private.parse_uuid(
      p_payload -> 'reference_inward_dc_id', 'reference_inward_dc_id', false
    );
  else
    v_reference_inward := v_existing.reference_inward_dc_id;
  end if;

  -- (b) The reference has to name an inward challan of the same customer.
  if v_reference_inward is not null then
    select d.party_id into v_reference_party
    from public.dc_documents d
    where d.organization_id = p_org
      and d.id = v_reference_inward
      and d.dc_type = 'inward'
      and d.deleted_at is null;

    if v_reference_party is null then
      perform app_private.raise_validation(
        'reference_inward_dc_id',
        'is not an inward challan in this workspace'
      );
    end if;

    if v_reference_party <> v_party_id then
      perform app_private.raise_validation(
        'reference_inward_dc_id',
        'belongs to a different customer'
      );
    end if;
  end if;

  -- (c) The number. Only on create: a number, once issued, is never changed.
  if v_is_create then
    if p_dc_type = 'outward_customer' and v_reference_inward is not null then
      v_number := app_private.dc_reserve_outward_number(p_org, v_reference_inward, v_date);
    else
      v_number := app_private.dc_reserve_number(p_org, p_dc_type, v_date);
    end if;
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
    v_reference_inward,
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

    -- (d) A challan that names the inward it answers may only draw from that
    -- inward. The number says the whole challan answers one inward challan, so
    -- a line drawn from somewhere else would make the number a lie.
    if v_reference_inward is not null and v_source_item is not null then
      if not exists (
        select 1
        from public.dc_items si
        where si.organization_id = p_org
          and si.id = v_source_item
          and si.dc_id = v_reference_inward
      ) then
        perform app_private.raise_validation(
          'source_inward_item_id',
          'must belong to the inward challan named as the reference'
        );
      end if;
    end if;

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
-- 4. The job on an inward challan, in the words the shop floor uses
-- ---------------------------------------------------------------------------
--
-- The receipt status on an inward challan means the material reached our gate.
-- It keeps that meaning. The job's progress is derived from the outward
-- challans drawn from this one, and the four states are:
--
--   Job not started  - nothing has been raised against this inward challan.
--   Work in process - an outward challan exists for it. The work has begun;
--                      it may not have left the gate yet.
--   Partly delivered- the customer has acknowledged some of it.
--   Delivered       - every linked line has been acknowledged in full.
--
-- "Pending" and "Dispatched" are gone: both described the same moment from
-- two directions, and neither said whether the work was happening. Nothing is
-- stored, so the badge cannot drift away from the quantities underneath it.

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
    where d.organization_id = p_org
      and d.id = p_dc_id
      and d.deleted_at is null
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
      greatest(p.accepted_qty - p.machining_rejection_qty - p.dispatched_qty, 0) as outstanding_qty
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
