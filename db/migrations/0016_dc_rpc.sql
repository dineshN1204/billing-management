-- 0016: Delivery Challan write path.
--
-- Every quantity that moves material is written by a function in this file.
-- The browser has no write privilege on any dc_* table (see 0015), so these
-- functions are not a convenience layer â€” they are the only way material can
-- move.
--
-- The three ideas this file exists to enforce:
--
--   1. Receiving is not accepting. declared_qty / received_qty / accepted_qty
--      are separate columns and are validated separately.
--   2. Two pools, never netted. Customer-owned raw stock and finished
--      components are different things. A balance is computed for exactly one
--      pool, selected by supply_source, and a dispatch draws from the pool it
--      declares. 600 pieces issued and 570 accepted back is 600 at the vendor
--      and 570 finished â€” not "360 remaining".
--   3. Concurrency is a database problem. Material issue and dispatch take a
--      row lock on the document and a transaction-scoped advisory lock on
--      (organization, party, part) before re-reading the balance, so two users
--      pressing "dispatch" at the same moment cannot both succeed.

-- Timestamps arrive from the browser as ISO 8601 strings ("2026-10-12T14:30").
-- Parsing them in one place keeps every write path honest about the column type.
create or replace function app_private.parse_timestamp(p_value jsonb, p_field text, p_required boolean default false)
returns timestamptz
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  v_text text;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    v_text := null;
  elsif jsonb_typeof(p_value) = 'string' then
    v_text := nullif(btrim(p_value #>> '{}'), '');
  else
    perform app_private.raise_validation(p_field, 'must be an ISO 8601 timestamp string');
  end if;
  if v_text is null then
    if p_required then
      perform app_private.raise_validation(p_field, 'is required');
    end if;
    return null;
  end if;
  if v_text !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$' then
    perform app_private.raise_validation(p_field, 'must be a YYYY-MM-DDTHH:MM timestamp');
  end if;
  return v_text::timestamptz;
end;
$$;

revoke all on function app_private.parse_timestamp(jsonb, text, boolean) from public, anonymous;
grant execute on function app_private.parse_timestamp(jsonb, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Financial year, numbering
-- ---------------------------------------------------------------------------

create or replace function app_private.dc_financial_year(p_date date)
returns text
language sql
immutable
as $$
  select
    extract(year from p_date - (case when extract(month from p_date) < 4 then interval '1 year' else interval '0' end))::int::text
    || '-' ||
    lpad((((extract(year from p_date - (case when extract(month from p_date) < 4 then interval '1 year' else interval '0' end))::int + 1) % 100))::int::text, 2, '0');
$$;

revoke all on function app_private.dc_financial_year(date) from public, anonymous, authenticated;

create or replace function app_private.dc_default_segment(p_dc_type text)
returns text
language sql
immutable
as $$
  select case p_dc_type
    when 'inward' then 'IN'
    when 'outward_self' then 'OUT-S'
    when 'outward_customer' then 'OUT-C'
    when 'material_return' then 'RET'
  end;
$$;

revoke all on function app_private.dc_default_segment(text) from public, anonymous, authenticated;

-- Allocates the next number for a document type. The upsert on the sequence row
-- is the concurrency control: the returned value is the post-increment count
-- for this transaction only, and the row stays locked until the transaction
-- ends, so two concurrent calls get different numbers.
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
begin
  v_fy := app_private.dc_financial_year(p_date);

  insert into public.dc_settings (organization_id, dc_type, prefix, segment_code, padding)
  values (p_org, p_dc_type, 'KI', app_private.dc_default_segment(p_dc_type), 4)
  on conflict (organization_id, dc_type) do nothing;

  select prefix, segment_code, padding into v_prefix, v_segment, v_padding
  from public.dc_settings
  where organization_id = p_org and dc_type = p_dc_type;

  insert into public.dc_number_sequences (organization_id, dc_type, financial_year, next_value)
  values (p_org, p_dc_type, v_fy, 2)
  on conflict (organization_id, dc_type, financial_year)
    do update set next_value = public.dc_number_sequences.next_value + 1, updated_at = now()
  returning next_value - 1 into v_value;

  return format('%s/%s/%s/%s', v_prefix, v_segment, v_fy, lpad(v_value::text, v_padding, '0'));
end;
$$;

revoke all on function app_private.dc_reserve_number(uuid, text, date) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- Seeded, workspace-configurable option lists
-- ---------------------------------------------------------------------------

create or replace function app_private.dc_seed_options(p_org uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.dc_settings (organization_id, dc_type, prefix, segment_code, padding)
  values
    (p_org, 'inward', 'KI', 'IN', 4),
    (p_org, 'outward_self', 'KI', 'OUT-S', 4),
    (p_org, 'outward_customer', 'KI', 'OUT-C', 4),
    (p_org, 'material_return', 'KI', 'RET', 4)
  on conflict (organization_id, dc_type) do nothing;

  insert into public.dc_options (organization_id, option_group, option_value, sort_order)
  select p_org, seed.group_name, seed.value, seed.position
  from (values
    ('mot', 'Customer Vehicle', 1), ('mot', 'Company Vehicle', 2),
    ('mot', 'Third-Party Transport', 3), ('mot', 'Courier', 4),
    ('mot', 'Parcel Service', 5), ('mot', 'Other', 6),
    ('destination_type', 'Subcontractor', 1), ('destination_type', 'Supplier', 2),
    ('destination_type', 'Testing Laboratory', 3), ('destination_type', 'Heat Treatment Vendor', 4),
    ('destination_type', 'Plating Vendor', 5), ('destination_type', 'Grinding Vendor', 6),
    ('destination_type', 'Other Processing Vendor', 7), ('destination_type', 'Company Location', 8),
    ('destination_type', 'Other Authorized Destination', 9),
    ('processing_operation', 'CNC Turning', 1), ('processing_operation', 'VMC Machining', 2),
    ('processing_operation', 'Grinding', 3), ('processing_operation', 'Drilling', 4),
    ('processing_operation', 'Threading', 5), ('processing_operation', 'Heat Treatment', 6),
    ('processing_operation', 'Surface Treatment', 7), ('processing_operation', 'Plating', 8),
    ('processing_operation', 'Inspection', 9), ('processing_operation', 'Other', 10),
    ('rejection_reason', 'Dimensional Out of Tolerance', 1),
    ('rejection_reason', 'Surface Finish Failure', 2),
    ('rejection_reason', 'Thread Defect', 3),
    ('rejection_reason', 'Wrong Dimension', 4),
    ('rejection_reason', 'Tool Damage', 5),
    ('rejection_reason', 'Material Defect Discovered During Machining', 6),
    ('rejection_reason', 'Handling Damage', 7),
    ('rejection_reason', 'Shortage', 8), ('rejection_reason', 'Other', 9),
    ('disposition', 'Return to Customer', 1), ('disposition', 'Return to Supplier', 2),
    ('disposition', 'Rework', 3), ('disposition', 'Hold for Customer Decision', 4),
    ('disposition', 'Scrap', 5), ('disposition', 'Other Approved Disposition', 6),
    ('unit', 'NOS', 1), ('unit', 'Kg', 2), ('unit', 'Meter', 3), ('unit', 'Gram', 4),
    ('unit', 'Liter', 5), ('unit', 'Set', 6), ('unit', 'Pair', 7), ('unit', 'Litre', 8),
    ('receipt_type', 'Raw Material', 1), ('receipt_type', 'Customer Owned Component', 2),
    ('receipt_type', 'Semi-Finished Component', 3), ('receipt_type', 'Return from Processing', 4),
    ('receipt_type', 'For Inspection', 5), ('receipt_type', 'For Rework', 6),
    ('movement_type', 'Subcontracting', 1), ('movement_type', 'Inter-Company Transfer', 2),
    ('movement_type', 'Return to Supplier', 3), ('movement_type', 'Testing', 4),
    ('movement_type', 'Inspection', 5), ('movement_type', 'Other', 6),
    ('delivery_purpose', 'Finished Goods', 1), ('delivery_purpose', 'Partially Processed', 2),
    ('delivery_purpose', 'Approved Sample', 3), ('delivery_purpose', 'Customer Inspection', 4),
    ('delivery_purpose', 'Replacement', 5), ('delivery_purpose', 'Rework', 6),
    ('delivery_purpose', 'Other', 7)
  ) as seed(group_name, value, position)
  on conflict (organization_id, option_group, lower(option_value)) do nothing;
end;
$$;

revoke all on function app_private.dc_seed_options(uuid) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- Party snapshot
-- ---------------------------------------------------------------------------

create or replace function app_private.dc_party_snapshot(p_org uuid, p_party_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_party jsonb;
begin
  select to_jsonb(c) - 'created_at' - 'updated_at' - 'deleted_at' into v_party
  from public.customers c
  where c.organization_id = p_org and c.id = p_party_id and c.deleted_at is null;

  if v_party is null then
    perform app_private.raise_error(
      'PT404', 'NOT_FOUND', 'party not found',
      jsonb_build_object('party_id', p_party_id)
    );
  end if;

  return v_party || jsonb_build_object(
    'party_address', nullif(btrim(concat_ws(', ',
      nullif(btrim(v_party ->> 'address_line_1'), ''),
      nullif(btrim(v_party ->> 'address_line_2'), ''),
      nullif(btrim(v_party ->> 'city'), ''),
      nullif(btrim(concat_ws(' ', nullif(btrim(v_party ->> 'state'), ''), nullif(btrim(v_party ->> 'pincode'), ''))), ''),
      nullif(btrim(v_party ->> 'country'), '')
    )), '')
  );
end;
$$;

revoke all on function app_private.dc_party_snapshot(uuid, uuid) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- Material locks and balances
-- ---------------------------------------------------------------------------

-- Two different pools. They are never subtracted from one another, because
-- "600 pieces issued to a vendor, 570 accepted back" means 600 at the vendor and
-- 570 finished - not 360 of "remaining material".
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
                  and m.material_owner_id = p_party
                  and m.part_number = p_part), 0)
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
    select
      coalesce((select sum(i.accepted_qty)
                from public.dc_items i
                join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
                where i.organization_id = p_org
                  and d.party_id = p_party
                  and d.dc_type = 'inward'
                  and i.supply_source = 'customer_material'
                  and d.status not in ('draft', 'cancelled')
                  and d.deleted_at is null), 0)
      - coalesce((select sum(i.qty_sent - i.returned_qty)
                  from public.dc_items i
                  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
                  where i.organization_id = p_org
                    and d.party_id = p_party
                    and d.dc_type = 'outward_self'
                    and i.supply_source = 'customer_material'
                    and d.status not in ('draft', 'cancelled')
                    and d.deleted_at is null), 0)
      + coalesce((select sum(i.accepted_return_qty)
                  from public.dc_items i
                  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
                  where i.organization_id = p_org
                    and d.party_id = p_party
                    and d.dc_type = 'outward_self'
                    and i.supply_source = 'customer_material'
                    and d.status not in ('draft', 'cancelled')
                    and d.deleted_at is null), 0)
    into v_balance;
  end if;

  return coalesce(v_balance, 0);
end;
$$;

revoke all on function app_private.dc_available_balance(uuid, uuid, text, text)
  from public, anonymous, authenticated;

-- Serializes every movement of one (organization, party, part, pool).
create or replace function app_private.dc_lock_material(
  p_org uuid,
  p_party uuid,
  p_part text,
  p_supply_source text
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended(p_org::text || ':' || p_party::text || ':' || p_part || ':' || p_supply_source, 0)
  );
end;
$$;

revoke all on function app_private.dc_lock_material(uuid, uuid, text, text)
  from public, anonymous, authenticated;

create or replace function app_private.dc_require_movement_write(p_org uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if not app_private.can_write(p_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'your role cannot record material movements');
  end if;
end;
$$;

revoke all on function app_private.dc_require_movement_write(uuid) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- Document read model
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
    'items', coalesce((
      select jsonb_agg(to_jsonb(i) - 'created_at' - 'updated_at' order by i.line_no)
      from public.dc_items i
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
-- Document creation / update (shared by all three types)
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
    organization_id, dc_type, dc_number, dc_date, financial_year, status,
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
    p_org, p_dc_type, v_number, v_date, app_private.dc_financial_year(v_date), v_status,
    (p_payload ->> 'party_id')::uuid,
    coalesce(app_private.parse_enum(v_party -> 'party_type', 'party_type',
      array['customer', 'supplier', 'vendor', 'other'], null), 'customer'),
    coalesce(app_private.parse_text(v_party -> 'name', 'party_name', true, 200), 'â€”'),
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

-- ---------------------------------------------------------------------------
-- Public entry points: save a challan
-- ---------------------------------------------------------------------------

create or replace function public.save_inward_dc(payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;
  if payload is null or not (payload ? 'organization_id') then
    perform app_private.raise_validation('organization_id', 'is required');
  end if;
  return app_private.dc_save_document(
    (payload ->> 'organization_id')::uuid, v_uid,
    payload - 'organization_id', 'inward'
  );
end;
$$;

revoke all on function public.save_inward_dc(jsonb) from public, anonymous;
grant execute on function public.save_inward_dc(jsonb) to authenticated;

create or replace function public.save_outward_self_dc(payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;
  if payload is null or not (payload ? 'organization_id') then
    perform app_private.raise_validation('organization_id', 'is required');
  end if;
  return app_private.dc_save_document(
    (payload ->> 'organization_id')::uuid, v_uid,
    payload - 'organization_id', 'outward_self'
  );
end;
$$;

revoke all on function public.save_outward_self_dc(jsonb) from public, anonymous;
grant execute on function public.save_outward_self_dc(jsonb) to authenticated;

create or replace function public.save_outward_customer_dc(payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;
  if payload is null or not (payload ? 'organization_id') then
    perform app_private.raise_validation('organization_id', 'is required');
  end if;
  return app_private.dc_save_document(
    (payload ->> 'organization_id')::uuid, v_uid,
    payload - 'organization_id', 'outward_customer'
  );
end;
$$;

revoke all on function public.save_outward_customer_dc(jsonb) from public, anonymous;
grant execute on function public.save_outward_customer_dc(jsonb) to authenticated;

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
  v_received numeric;
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
    v_received := coalesce(app_private.parse_numeric(v_elem -> 'received_qty', 'received_qty', true, 3, 0, 99999999), 0);
    v_inspection_required := coalesce(
      (v_elem ->> 'inspection_required')::boolean, v_item.inspection_required
    );

    update public.dc_items i
    set received_qty = v_received,
        shortage_qty = greatest(v_declared - v_received, 0),
        excess_qty = greatest(v_received - v_declared, 0),
        damaged_qty = coalesce(app_private.parse_numeric(v_elem -> 'damaged_qty', 'damaged_qty', false, 3, 0, 99999999), 0),
        inspection_required = v_inspection_required,
        pending_inspection_qty = case when v_inspection_required then v_received else 0 end,
        inspection_status = case
          when not v_inspection_required then 'not_required'
          when v_received = 0 then 'pending'
          else 'pending'
        end,
        storage_location = coalesce(app_private.parse_text(v_elem -> 'storage_location', 'storage_location', false, 120), i.storage_location)
    where i.id = v_item.id;

    insert into public.dc_movements (organization_id, dc_id, dc_item_id, movement_type, quantity, unit, supply_source, moved_at, reference, remarks)
    values (
      v_org, v_dc.id, v_item.id, 'receipt', v_received, v_item.unit, v_item.supply_source,
      coalesce(app_private.parse_timestamp(payload -> 'received_at', 'received_at'), now()),
      app_private.parse_text(payload -> 'lr_number', 'lr_number', false, 64),
      app_private.parse_text(v_elem -> 'receipt_remarks', 'receipt_remarks', false, 500)
    );
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
    -- Cumulative, not incremental: a second inspection must be measured against
    -- what has already been accepted, or 960 accepted plus another 500 would
    -- pass while exceeding the 990 physically received.
    if v_item.accepted_qty + v_item.rejected_qty + v_item.rework_qty + v_accepted + v_rejected + v_rework > v_item.received_qty then
      perform app_private.raise_error(
        'PT409', 'INSPECTION_EXCEEDS_RECEIPT',
        format('inspected outcomes (%s) exceed the quantity physically received (%s) for line %s',
          v_item.accepted_qty + v_item.rejected_qty + v_item.rework_qty + v_accepted + v_rejected + v_rework,
          v_item.received_qty, v_item.part_number),
        jsonb_build_object('dc_item_id', v_item.id, 'received_qty', v_item.received_qty)
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
    set inspected_qty = i.inspected_qty + v_inspected,
        accepted_qty = i.accepted_qty + v_accepted,
        rejected_qty = i.rejected_qty + v_rejected,
        rework_qty = i.rework_qty + v_rework,
        pending_inspection_qty = i.pending_inspection_qty - (v_accepted + v_rejected + v_rework),
        inspection_status = case
          when i.accepted_qty + v_accepted > 0 and i.rejected_qty + v_rejected > 0 then 'partially_accepted'
          when i.rejected_qty + v_rejected > 0 and i.accepted_qty + v_accepted = 0 then 'rejected'
          when v_rework > 0 and v_rejected = 0 then 'rework_required'
          when i.pending_inspection_qty - (v_accepted + v_rejected + v_rework) > 0 then 'partially_inspected'
          else 'accepted'
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
-- Material return (rejected material physically going back)
-- ---------------------------------------------------------------------------

create or replace function public.record_material_return(payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_rejection public.dc_rejections;
  v_return_dc_id uuid;
  v_qty numeric;
  v_number text;
  v_date date;
  v_party public.customers;
  v_item public.dc_items;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  v_org := app_private.parse_uuid(payload -> 'organization_id', 'organization_id', true);
  perform app_private.dc_require_movement_write(v_org);

  select * into v_rejection
  from public.dc_rejections r
  where r.organization_id = v_org
    and r.id = app_private.parse_uuid(payload -> 'rejection_id', 'rejection_id', true)
  for update;

  if not found then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'material rejection not found');
  end if;

  v_qty := coalesce(app_private.parse_numeric(payload -> 'returned_qty', 'returned_qty', true, 3, 0.001, 99999999), 0);

  if v_rejection.quantity_returned + v_qty > v_rejection.quantity_rejected then
    perform app_private.raise_error(
      'PT409', 'RETURN_EXCEEDS_REJECTION',
      format('cannot return %s: only %s of %s rejected pieces are still outstanding',
        v_qty, v_rejection.quantity_rejected - v_rejection.quantity_returned, v_rejection.quantity_rejected),
      jsonb_build_object('outstanding', v_rejection.quantity_rejected - v_rejection.quantity_returned)
    );
  end if;

  v_date := coalesce(app_private.parse_date(payload -> 'return_date', 'return_date', false), current_date);
  v_number := app_private.dc_reserve_number(v_org, 'material_return', v_date);

  select * into v_party from public.customers c where c.organization_id = v_org and c.id = v_rejection.party_id;
  select * into v_item from public.dc_items i where i.organization_id = v_org and i.id = v_rejection.dc_item_id;

  insert into public.dc_documents (
    organization_id, dc_type, dc_number, dc_date, financial_year, status,
    party_id, party_type, party_name, party_gstin, party_phone, party_email,
    party_address, party_state_code, party_pincode,
    movement_type, purpose, mode_of_transport, transporter_name, vehicle_number,
    dispatch_at, expected_return_at, remarks, prepared_by, authorized_by,
    finalized_at, finalized_by, created_by, updated_by
  ) values (
    v_org, 'material_return', v_number, v_date, app_private.dc_financial_year(v_date), 'issued',
    v_rejection.party_id, coalesce(v_party.party_type, 'customer'),
    v_party.name, nullif(upper(coalesce(v_party.gstin, '')), ''), v_party.phone, v_party.email,
    nullif(btrim(concat_ws(', ', v_party.address_line_1, v_party.address_line_2, v_party.city,
      nullif(btrim(concat_ws(' ', v_party.state, v_party.pincode)), ''), v_party.country)), ''),
    v_party.state_code, v_party.pincode,
    'return_to_supplier',
    coalesce(app_private.parse_text(payload -> 'purpose', 'purpose', false, 500), 'Return of rejected material'),
    app_private.parse_text(payload -> 'mode_of_transport', 'mode_of_transport', false, 64),
    app_private.parse_text(payload -> 'transporter_name', 'transporter_name', false, 120),
    app_private.parse_text(payload -> 'vehicle_number', 'vehicle_number', false, 32),
    now(), v_date,
    app_private.parse_text(payload -> 'remarks', 'remarks', false, 5000),
    app_private.parse_text(payload -> 'prepared_by', 'prepared_by', false, 120),
    app_private.parse_text(payload -> 'authorized_by', 'authorized_by', false, 120),
    now(), v_uid, v_uid, v_uid
  ) returning id into v_return_dc_id;

  insert into public.dc_items (
    organization_id, dc_id, line_no, part_number, description, batch_lot_no, unit,
    supply_source, declared_qty
  ) values (
    v_org, v_return_dc_id, 1, v_rejection.part_number,
    coalesce(v_item.description, 'Rejected material returned'), v_rejection.batch_lot_no,
    coalesce(v_item.unit, 'NOS'), 'customer_material', v_qty
  );

  insert into public.dc_movements (
    organization_id, dc_id, dc_item_id, movement_type, quantity, unit, supply_source, moved_at, remarks
  )
  select v_org, v_return_dc_id, i.id, 'material_return', v_qty, i.unit, i.supply_source,
    coalesce(app_private.parse_timestamp(payload -> 'returned_at', 'returned_at'), now()),
    app_private.parse_text(payload -> 'remarks', 'remarks', false, 1000)
  from public.dc_items i where i.organization_id = v_org and i.dc_id = v_return_dc_id;

  update public.dc_rejections r
  set quantity_returned = r.quantity_returned + v_qty,
      return_dc_id = coalesce(r.return_dc_id, v_return_dc_id),
      status = case
        when r.quantity_returned + v_qty >= r.quantity_rejected then 'returned'
        else 'partially_returned'
      end,
      disposition = 'return_to_customer',
      remarks = coalesce(r.remarks || E'\n', '') ||
        format('Returned %s on %s (%s)', v_qty, v_number, v_date)
  where r.id = v_rejection.id;

  insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, new_data, metadata)
  values (v_org, v_uid, 'MATERIAL_RETURN', 'dc_rejections', v_rejection.id,
    jsonb_build_object('returned_qty', v_qty, 'return_dc_id', v_return_dc_id),
    jsonb_build_object('return_dc_number', v_number));

  return jsonb_build_object(
    'rejection', (select to_jsonb(x) - 'created_at' - 'updated_at' from public.dc_rejections x where x.id = v_rejection.id),
    'return_dc', app_private.dc_document_json(v_return_dc_id)
  );
end;
$$;

revoke all on function public.record_material_return(jsonb) from public, anonymous;
grant execute on function public.record_material_return(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Vendor return (partial return from a subcontractor)
-- ---------------------------------------------------------------------------

create or replace function public.record_vendor_return(payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_elem jsonb;
  v_item public.dc_items;
  v_dc public.dc_documents;
  v_returned numeric;
  v_accepted numeric;
  v_rejected numeric;
  v_outstanding numeric;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  v_org := app_private.parse_uuid(payload -> 'organization_id', 'organization_id', true);
  perform app_private.dc_require_movement_write(v_org);

  if payload -> 'lines' is null or jsonb_typeof(payload -> 'lines') <> 'array' then
    perform app_private.raise_validation('lines', 'must be an array of returned quantities');
  end if;

  for v_elem in select value from jsonb_array_elements(payload -> 'lines') loop
    select * into v_item
    from public.dc_items i
    where i.organization_id = v_org
      and i.id = app_private.parse_uuid(v_elem -> 'dc_item_id', 'dc_item_id', true)
    for update;

    if not found then
      perform app_private.raise_error('PT404', 'NOT_FOUND', 'outward line item not found');
    end if;

    select * into v_dc from public.dc_documents d where d.organization_id = v_org and d.id = v_item.dc_id;
    if v_dc.dc_type <> 'outward_self' then
      perform app_private.raise_validation('dc_item_id', 'vendor returns apply to outward self challans only');
    end if;
    if v_dc.status = 'cancelled' then
      perform app_private.raise_error('PT409', 'DOCUMENT_CANCELLED', 'a cancelled challan cannot receive a vendor return');
    end if;

    v_returned := coalesce(app_private.parse_numeric(v_elem -> 'returned_qty', 'returned_qty', true, 3, 0.001, 99999999), 0);
    v_accepted := coalesce(app_private.parse_numeric(v_elem -> 'accepted_qty', 'accepted_qty', false, 3, 0, 99999999), 0);
    v_rejected := coalesce(app_private.parse_numeric(v_elem -> 'rejected_qty', 'rejected_qty', false, 3, 0, 99999999), 0);

    if v_accepted + v_rejected > v_returned then
      perform app_private.raise_validation('accepted_qty', 'plus rejected_qty cannot exceed returned_qty');
    end if;

    v_outstanding := v_item.qty_sent - v_item.returned_qty;
    if v_returned > v_outstanding then
      perform app_private.raise_error(
        'PT409', 'RETURN_EXCEEDS_SENT',
        format('cannot return %s: only %s of %s pieces are still at the vendor',
          v_returned, v_outstanding, v_item.qty_sent),
        jsonb_build_object('outstanding', v_outstanding)
      );
    end if;

    perform app_private.dc_lock_material(v_org, v_dc.party_id, v_item.part_number, v_item.supply_source);

    update public.dc_items i
    set returned_qty = i.returned_qty + v_returned,
        accepted_return_qty = i.accepted_return_qty + v_accepted,
        rejected_return_qty = i.rejected_return_qty + v_rejected,
        still_at_vendor_qty = i.qty_sent - (i.returned_qty + v_returned)
    where i.id = v_item.id;

    insert into public.dc_movements (
      organization_id, dc_id, dc_item_id, movement_type, quantity, unit, supply_source, moved_at, remarks
    ) values (
      v_org, v_dc.id, v_item.id, 'vendor_return', v_returned, v_item.unit, v_item.supply_source,
      coalesce(app_private.parse_timestamp(payload -> 'returned_at', 'returned_at'), now()),
      app_private.parse_text(payload -> 'remarks', 'remarks', false, 1000)
    );
  end loop;

  insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, metadata)
  values (v_org, v_uid, 'VENDOR_RETURN', 'dc_documents',
    app_private.parse_uuid(payload -> 'dc_id', 'dc_id', false),
    jsonb_build_object('source', 'record_vendor_return'));

  return app_private.dc_document_json(app_private.parse_uuid(payload -> 'dc_id', 'dc_id', true));
end;
$$;

revoke all on function public.record_vendor_return(jsonb) from public, anonymous;
grant execute on function public.record_vendor_return(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Dispatch and delivery (Rule 6: never exceed the eligible balance)
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
      app_private.parse_text(payload -> 'proof_of_delivery_ref', 'proof_of_delivery_ref', false, 120),
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

-- Confirm actual delivery. Dispatching is not delivering.
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
  v_delivered boolean;
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
    and d.deleted_at is null
  for update;

  if not found then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'delivery challan not found');
  end if;
  if v_dc.status = 'cancelled' then
    perform app_private.raise_error('PT409', 'DOCUMENT_CANCELLED', 'a cancelled challan cannot be delivered');
  end if;

  v_delivered := coalesce((payload ->> 'delivered')::boolean, true);
  v_pod := app_private.parse_text(payload -> 'proof_of_delivery_ref', 'proof_of_delivery_ref', false, 120);

  if v_delivered and v_pod is null then
    perform app_private.raise_validation('proof_of_delivery_ref', 'is required to mark a delivery as delivered');
  end if;

  update public.dc_documents d
  set status = case when v_delivered then 'delivered' else 'dispatched' end,
      actual_delivery_at = case
        when v_delivered then coalesce(app_private.parse_timestamp(payload -> 'delivered_at', 'delivered_at'), now())
        else null
      end,
      proof_of_delivery_ref = coalesce(v_pod, d.proof_of_delivery_ref),
      receiver_name = coalesce(app_private.parse_text(payload -> 'receiver_name', 'receiver_name', false, 120), d.receiver_name),
      updated_by = v_uid
  where d.id = v_dc.id;

  insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, new_data, metadata)
  values (v_org, v_uid, case when v_delivered then 'DELIVERED' else 'DELIVERY_PENDING' end,
    'dc_documents', v_dc.id,
    jsonb_build_object('status', case when v_delivered then 'delivered' else 'dispatched' end, 'pod', v_pod), '{}'::jsonb);

  return app_private.dc_document_json(v_dc.id);
end;
$$;

revoke all on function public.confirm_delivery(jsonb) from public, anonymous;
grant execute on function public.confirm_delivery(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Issue material for processing (Rule 3 and Rule 4)
-- ---------------------------------------------------------------------------

create or replace function public.issue_material(payload jsonb)
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
  v_source_inward uuid;
  v_source_status text;
  v_owner uuid;
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
    and d.dc_type = 'outward_self'
    and d.deleted_at is null
  for update;

  if not found then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'outward self challan not found');
  end if;
  if v_dc.status = 'cancelled' then
    perform app_private.raise_error('PT409', 'DOCUMENT_CANCELLED', 'a cancelled challan cannot issue material');
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

    v_qty := coalesce(app_private.parse_numeric(v_elem -> 'qty_sent', 'qty_sent', true, 3, 0.001, 99999999), 0);
    v_source_inward := app_private.parse_uuid(v_elem -> 'source_inward_item_id', 'source_inward_item_id', false);

    -- The destination party is the vendor, but the balance belongs to whoever
    -- owns the material. Without this the check would look up the vendor's own
    -- stock and find none, which is not a safety failure but is wrong.
    v_owner := app_private.parse_uuid(v_elem -> 'material_owner_id', 'material_owner_id', false);
    if v_owner is null then
      v_owner := v_item.material_owner_id;
    end if;

    if v_source_inward is not null then
      select i.accepted_qty, i.inspection_status
        into v_balance, v_source_status
      from public.dc_items i
      where i.organization_id = v_org and i.id = v_source_inward;

      if not found then
        perform app_private.raise_error('PT404', 'NOT_FOUND', 'source inward line item not found');
      end if;

      if v_owner is null then
        select d.party_id into v_owner
        from public.dc_items i
        join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
        where i.organization_id = v_org and i.id = v_source_inward;
      end if;

      -- Rule 3: rejected or quarantined material is not available.
      if v_source_status not in ('accepted', 'partially_accepted') then
        perform app_private.raise_error(
          'PT409', 'MATERIAL_NOT_ELIGIBLE',
          'this inward line is not accepted material; only accepted stock can be issued for processing'
        );
      end if;

      if v_qty > v_balance then
        perform app_private.raise_error(
          'PT409', 'QUANTITY_EXCEEDED',
          format('cannot issue %s: the referenced inward line has only %s accepted', v_qty, v_balance),
          jsonb_build_object('dc_item_id', v_source_inward, 'requested', v_qty, 'accepted', v_balance)
        );
      end if;
    else
      if v_owner is null then
        perform app_private.raise_validation('material_owner_id',
          'is required: state whose material is being sent to the vendor');
      end if;
      perform app_private.dc_lock_material(v_org, v_owner, v_item.part_number, v_item.supply_source);
      v_balance := app_private.dc_available_balance(v_org, v_owner, v_item.part_number, v_item.supply_source);
      if v_qty > v_balance then
        perform app_private.raise_error(
          'PT409', 'QUANTITY_EXCEEDED',
          format('cannot issue %s of %s: only %s is eligible', v_qty, v_item.part_number, v_balance),
          jsonb_build_object('part_number', v_item.part_number, 'requested', v_qty, 'available', v_balance)
        );
      end if;
    end if;

    update public.dc_items i
    set qty_sent = i.qty_sent + v_qty,
        still_at_vendor_qty = i.qty_sent + v_qty - i.returned_qty,
        source_inward_item_id = coalesce(v_source_inward, i.source_inward_item_id),
        material_owner_id = coalesce(v_owner, i.material_owner_id),
        expected_return_qty = coalesce(
          app_private.parse_numeric(v_elem -> 'expected_return_qty', 'expected_return_qty', false, 3, 0, 99999999), i.expected_return_qty)
    where i.id = v_item.id;

    insert into public.dc_movements (
      organization_id, dc_id, dc_item_id, movement_type, quantity, unit, supply_source, moved_at, remarks
    ) values (
      v_org, v_dc.id, v_item.id, 'dispatch', v_qty, v_item.unit, v_item.supply_source,
      coalesce(app_private.parse_timestamp(payload -> 'dispatched_at', 'dispatched_at'), now()),
      app_private.parse_text(v_elem -> 'remarks', 'remarks', false, 500)
    );
  end loop;

  update public.dc_documents d
  set status = 'dispatched',
      dispatch_at = coalesce(app_private.parse_timestamp(payload -> 'dispatched_at', 'dispatched_at'), d.dispatch_at),
      prepared_by = coalesce(app_private.parse_text(payload -> 'prepared_by', 'prepared_by', false, 120), d.prepared_by),
      authorized_by = coalesce(app_private.parse_text(payload -> 'authorized_by', 'authorized_by', false, 120), d.authorized_by),
      updated_by = v_uid
  where d.id = v_dc.id;

  insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, metadata)
  values (v_org, v_uid, 'ISSUE', 'dc_documents', v_dc.id, jsonb_build_object('source', 'issue_material'));

  return app_private.dc_document_json(v_dc.id);
end;
$$;

revoke all on function public.issue_material(jsonb) from public, anonymous;
grant execute on function public.issue_material(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Machining / processing reconciliation (Rule 5)
-- ---------------------------------------------------------------------------

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
  v_input_unit text;
  v_output_unit text;
  v_conversion boolean;
  v_loss_reason text;
  v_total numeric;
  v_diff numeric;
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
    v_total := v_accepted + v_rejection + v_rework + v_scrap + v_loss;
    v_diff := v_input - v_total;
    if v_diff <> 0 then
      perform app_private.raise_error(
        'PT409', 'MACHINING_NOT_RECONCILED',
        format(
          'input %s does not reconcile: accepted %s + machining rejection %s + rework %s + scrap %s + process loss %s = %s (difference %s)',
          v_input, v_accepted, v_rejection, v_rework, v_scrap, v_loss, v_total, v_diff),
        jsonb_build_object('input', v_input, 'accounted', v_total, 'difference', v_diff)
      );
    end if;
  end if;

  insert into public.dc_machining_results (
    organization_id, source_dc_id, source_dc_item_id, party_id, material_owner_id,
    part_number, production_order_id, job_work_order_id,
    operation, operation_date, input_quantity, input_unit,
    accepted_output_quantity, output_unit, machining_rejection_quantity,
    rework_quantity, scrap_quantity, process_loss_quantity, unit_conversion,
    loss_reason, loss_approved_by, loss_approved_at, rejection_reason, inspection_report,
    operator_name, inspector_name, corrective_action, remarks
  ) values (
    v_org,
    app_private.parse_uuid(payload -> 'source_dc_id', 'source_dc_id', false),
    app_private.parse_uuid(payload -> 'source_dc_item_id', 'source_dc_item_id', false),
    app_private.parse_uuid(payload -> 'party_id', 'party_id', true),
    app_private.parse_uuid(payload -> 'material_owner_id', 'material_owner_id', false),
    app_private.parse_text(payload -> 'part_number', 'part_number', true, 64),
    app_private.parse_uuid(payload -> 'production_order_id', 'production_order_id', false),
    app_private.parse_uuid(payload -> 'job_work_order_id', 'job_work_order_id', false),
    app_private.parse_text(payload -> 'operation', 'operation', true, 120),
    coalesce(app_private.parse_date(payload -> 'operation_date', 'operation_date', false), current_date),
    v_input, v_input_unit, v_accepted, v_output_unit, v_rejection,
    v_rework, v_scrap, v_loss, v_conversion,
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
  values (v_org, v_uid, 'MACHINING', 'dc_machining_results',
    (select id from public.dc_machining_results r where r.organization_id = v_org order by r.created_at desc limit 1),
    jsonb_build_object('input', v_input, 'accepted_output', v_accepted, 'rejection', v_rejection, 'loss', v_loss),
    jsonb_build_object('source', 'record_machining_result'));

  return jsonb_build_object(
    'input_quantity', v_input,
    'accepted_output_quantity', v_accepted,
    'machining_rejection_quantity', v_rejection,
    'rework_quantity', v_rework,
    'scrap_quantity', v_scrap,
    'process_loss_quantity', v_loss
  );
end;
$$;

revoke all on function public.record_machining_result(jsonb) from public, anonymous;
grant execute on function public.record_machining_result(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Cancellation (Rule 8): record the reversal, never delete
-- ---------------------------------------------------------------------------

create or replace function public.cancel_dc(payload jsonb)
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
  v_reason text;
  v_restored numeric;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  v_org := app_private.parse_uuid(payload -> 'organization_id', 'organization_id', true);
  v_reason := app_private.parse_text(payload -> 'reason', 'reason', true, 500);

  select * into v_dc
  from public.dc_documents d
  where d.organization_id = v_org
    and d.id = app_private.parse_uuid(payload -> 'dc_id', 'dc_id', true)
    and d.deleted_at is null
  for update;

  if not found then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'delivery challan not found');
  end if;
  if v_dc.status = 'cancelled' then
    perform app_private.raise_error('PT409', 'ALREADY_CANCELLED', 'this challan is already cancelled');
  end if;

  -- Cancelling a challan that already moved material needs an administrator:
  -- the reversal has to be reconciled against physical stock.
  if v_dc.status in ('dispatched', 'partially_delivered', 'delivered')
     and not app_private.is_org_admin(v_org) then
    perform app_private.raise_error(
      'PT403', 'FORBIDDEN',
      'cancelling a challan that has already moved material requires an administrator'
    );
  end if;

  update public.dc_documents d
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = v_uid,
      cancel_reason = v_reason,
      updated_by = v_uid
  where d.id = v_dc.id;

  select coalesce(sum(i.qty_dispatched), 0) into v_restored
  from public.dc_items i where i.organization_id = v_org and i.dc_id = v_dc.id;

  insert into public.dc_movements (
    organization_id, dc_id, movement_type, quantity, unit, moved_at, is_reversal, remarks
  ) values (
    v_org, v_dc.id, 'customer_delivery',
    greatest(v_restored, 0.001), 'NOS', now(), true,
    'Reversal recorded on cancellation: ' || v_reason
  );

  insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, old_data, new_data, metadata)
  values (v_org, v_uid, 'CANCEL', 'dc_documents', v_dc.id,
    jsonb_build_object('status', v_dc.status, 'restored_quantity', v_restored),
    jsonb_build_object('status', 'cancelled', 'reason', v_reason),
    jsonb_build_object('source', 'cancel_dc'));

  return app_private.dc_document_json(v_dc.id);
end;
$$;

revoke all on function public.cancel_dc(jsonb) from public, anonymous;
grant execute on function public.cancel_dc(jsonb) to authenticated;

-- Read-only wrapper so the browser can show an eligible balance before the user
-- types a quantity. It only ever returns a number; it cannot move material.
create or replace function public.dc_available_balance(
  p_org uuid,
  p_customer_id uuid,
  p_part text,
  p_supply_source text
)
returns numeric
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not app_private.is_org_member(p_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'you are not a member of this workspace');
  end if;
  return app_private.dc_available_balance(
    p_org, p_customer_id, coalesce(nullif(btrim(p_part), ''), ''), coalesce(p_supply_source, 'customer_material')
  );
end;
$$;

revoke all on function public.dc_available_balance(uuid, uuid, text, text) from public, anonymous;
grant execute on function public.dc_available_balance(uuid, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Settings and options
-- ---------------------------------------------------------------------------

create or replace function public.dc_update_settings(payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;
  v_org := app_private.parse_uuid(payload -> 'organization_id', 'organization_id', true);
  if not app_private.is_org_admin(v_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'only administrators can change document numbering');
  end if;

  perform app_private.dc_seed_options(v_org);

  update public.dc_settings s
  set prefix = app_private.parse_text(payload -> 'prefix', 'prefix', true, 16),
      segment_code = upper(coalesce(app_private.parse_text(payload -> 'segment_code', 'segment_code', true, 16), s.segment_code)),
      padding = coalesce(app_private.parse_numeric(payload -> 'padding', 'padding', false, 0, 1, 10), s.padding)::integer,
      updated_by = v_uid,
      updated_at = now()
  where s.organization_id = v_org
    and s.dc_type = app_private.parse_enum(payload -> 'dc_type', 'dc_type',
      array['inward', 'outward_self', 'outward_customer', 'material_return'], null);

  return (select to_jsonb(x) - 'updated_at' from public.dc_settings x
          where x.organization_id = v_org
          order by x.dc_type);
end;
$$;

revoke all on function public.dc_update_settings(jsonb) from public, anonymous;
grant execute on function public.dc_update_settings(jsonb) to authenticated;

create or replace function public.dc_save_option(payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_group text;
  v_value text;
  v_is_active boolean;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;
  v_org := app_private.parse_uuid(payload -> 'organization_id', 'organization_id', true);
  if not app_private.is_org_admin(v_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'only administrators can change option lists');
  end if;

  v_group := app_private.parse_enum(payload -> 'option_group', 'option_group',
    array['mot', 'destination_type', 'processing_operation', 'rejection_reason',
      'disposition', 'unit', 'receipt_type', 'movement_type', 'delivery_purpose'], null);
  v_value := app_private.parse_text(payload -> 'option_value', 'option_value', true, 120);
  v_is_active := coalesce((payload ->> 'is_active')::boolean, true);

  insert into public.dc_options (organization_id, option_group, option_value, is_active, sort_order, created_by)
  values (v_org, v_group, v_value, v_is_active,
    coalesce(app_private.parse_numeric(payload -> 'sort_order', 'sort_order', false, 0, 0, 9999), 100)::integer, v_uid)
  on conflict (organization_id, option_group, lower(option_value)) do update
    set is_active = excluded.is_active, updated_at = now();

  return (select to_jsonb(x) - 'created_at' - 'updated_at' from public.dc_options x
          where x.organization_id = v_org and x.option_group = v_group
            and lower(x.option_value) = lower(v_value));
end;
$$;

revoke all on function public.dc_save_option(jsonb) from public, anonymous;
grant execute on function public.dc_save_option(jsonb) to authenticated;

-- Seed the workspace lists the first time the DC module is opened.
create or replace function public.dc_bootstrap_options()
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;
  select m.organization_id into v_org
  from public.memberships m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = v_uid and o.deleted_at is null
  order by m.created_at
  limit 1;

  if v_org is null then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'no workspace found');
  end if;

  perform app_private.dc_seed_options(v_org);
  return jsonb_build_object('organization_id', v_org, 'seeded', true);
end;
$$;

revoke all on function public.dc_bootstrap_options() from public, anonymous;
grant execute on function public.dc_bootstrap_options() to authenticated;