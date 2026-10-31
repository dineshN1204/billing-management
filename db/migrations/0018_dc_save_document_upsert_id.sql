-- Editing a challan, or finalizing a saved draft, failed with
--   23505 duplicate key value violates unique constraint
--   "dc_documents_org_type_number_key"
--
-- dc_save_document upserts with `on conflict (organization_id, id) do update`,
-- but its insert listed no `id` column. Every call therefore supplied a fresh
-- gen_random_uuid() and could never match the conflict target, so the upsert
-- branch was unreachable. The insert instead collided with the unique index on
-- (organization_id, dc_type, dc_number_normalized), which is the only constraint
-- the proposed row actually violated.
--
-- That made "Save draft" followed by "Finalize" impossible for every document
-- type, and re-saving an existing draft or challan likewise. It was hidden until
-- the client's call shape was corrected: until then PostgREST answered
-- PGRST202 before this function was ever reached.

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
begin
  perform app_private.dc_require_movement_write(p_org);

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    perform app_private.raise_validation('payload', 'must be a JSON object');
  end if;

  v_date := app_private.parse_date(p_payload -> 'dc_date', 'dc_date', true);
  v_expected_version := app_private.parse_numeric(p_payload -> 'expected_version', 'expected_version', false, 0, 1, 2147483647)::integer;
  v_party := app_private.dc_party_snapshot(
    p_org,
    app_private.parse_uuid(p_payload -> 'party_id', 'party_id', true)
  );

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
    (p_payload ->> 'party_id')::uuid,
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

    insert into public.dc_items (
      organization_id, dc_id, line_no, product_id, part_number, customer_part_number,
      description, drawing_number, drawing_revision, batch_lot_no, heat_no, material_grade,
      unit, supply_source, declared_qty, processing_operation, ordered_qty,
      source_inward_item_id, material_owner_id, production_order_id, storage_location, item_remarks
    ) values (
      p_org, v_dc_id, v_ord,
      app_private.parse_uuid(v_elem -> 'product_id', 'product_id', false),
      v_part,
      app_private.parse_text(v_elem -> 'customer_part_number', 'customer_part_number', false, 64),
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
      app_private.parse_uuid(v_elem -> 'source_inward_item_id', 'source_inward_item_id', false),
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