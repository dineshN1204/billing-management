-- 0014: Delivery Challan core schema.
--
-- Design notes that matter more than the column list:
--
-- * DECLARED vs RECEIVED. dc_items.declared_qty is what the external challan
--   says; dc_items.received_qty is what physically arrived. They are different
--   columns because receiving is not accepting, and a short receipt is data, not
--   an error.
--
-- * ACCEPTED vs REJECTED vs PENDING. Inspection writes accepted_qty,
--   rejected_qty, rework_qty and pending_inspection_qty as separate columns.
--   Only accepted_qty is eligible stock. Nothing may be inferred from the sum.
--
-- * SNAPSHOTS. dc_documents freezes party_name / party_gstin / party_phone /
--   party_email / party_address / party_state_code / party_pincode when the
--   document is finalized, so a PDF printed in 2027 still shows the address the
--   party had in 2026 even after the customer record is edited or soft-deleted.
--
-- * SUPPLY SOURCE. A job-work plant holds two different pools of material:
--   customer-owned raw stock, and finished components. They are never netted
--   against each other. dc_items.supply_source says which pool a movement draws
--   from, and every balance check is done against that pool only.
--
-- * APPEND-ONLY EVENT LOGS. dc_inspections, dc_movements and dc_machining_results
--   are event streams. Corrections are new rows that reverse an old one; they do
--   not overwrite it.

-- ---------------------------------------------------------------------------
-- Document numbering
-- ---------------------------------------------------------------------------

create table if not exists public.dc_number_sequences (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  dc_type text not null,
  financial_year text not null,
  next_value bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (organization_id, dc_type, financial_year),
  constraint dc_number_sequences_type_check
    check (dc_type in ('inward', 'outward_self', 'outward_customer', 'material_return')),
  constraint dc_number_sequences_next_check check (next_value >= 1)
);

-- ---------------------------------------------------------------------------
-- Document header
-- ---------------------------------------------------------------------------

create table if not exists public.dc_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  dc_type text not null,
  dc_number text not null,
  dc_number_normalized text generated always as (lower(btrim(dc_number))) stored,
  dc_date date not null default current_date,
  financial_year text not null,
  status text not null default 'draft',

  -- Party (customer, supplier, subcontractor or company location)
  party_id uuid not null,
  party_type text not null default 'customer',
  party_name text not null,
  party_gstin text,
  party_phone text,
  party_email text,
  party_address text,
  party_state_code text,
  party_pincode text,
  party_contact_person text,
  party_ship_to text,

  -- Purpose and references
  receipt_type text,
  movement_type text,
  delivery_purpose text,
  purpose text,
  external_dc_number text,
  external_dc_date date,
  external_notes text,
  purchase_order_no text,
  job_work_order_id uuid,
  production_order_id uuid,
  reference_inward_dc_id uuid,
  customer_order_reference text,
  delivery_schedule_reference text,

  -- Mode of transport
  mode_of_transport text,
  transporter_name text,
  transporter_gstin text,
  vehicle_number text,
  driver_name text,
  driver_contact text,
  lr_number text,
  docket_number text,
  eway_bill_number text,
  package_count numeric(14, 3),
  package_type text,
  gross_weight numeric(14, 3),
  net_weight numeric(14, 3),

  -- Dates and times
  dispatch_at timestamptz,
  expected_arrival_at timestamptz,
  actual_arrival_at timestamptz,
  expected_return_at timestamptz,
  actual_delivery_at timestamptz,
  receipt_date date,
  receipt_time time,

  -- People and acknowledgement
  received_by text,
  prepared_by text,
  authorized_by text,
  receiver_name text,
  proof_of_delivery_ref text,
  unloading_remarks text,
  dispatch_remarks text,

  remarks text,
  internal_remarks text,

  version integer not null default 1,
  finalized_at timestamptz,
  finalized_by uuid,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text,
  created_by uuid default auth.uid(),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,

  constraint dc_documents_org_id_key unique (organization_id, id),
  constraint dc_documents_party_fk
    foreign key (organization_id, party_id) references public.customers (organization_id, id),
  constraint dc_documents_job_work_order_fk
    foreign key (organization_id, job_work_order_id) references public.job_work_orders (organization_id, id),
  constraint dc_documents_production_order_fk
    foreign key (organization_id, production_order_id) references public.production_orders (organization_id, id),
  constraint dc_documents_reference_inward_fk
    foreign key (organization_id, reference_inward_dc_id) references public.dc_documents (organization_id, id),
  constraint dc_documents_type_check
    check (dc_type in ('inward', 'outward_self', 'outward_customer', 'material_return')),
  constraint dc_documents_status_check
    check (status in ('draft', 'issued', 'dispatched', 'partially_delivered', 'delivered', 'cancelled')),
  constraint dc_documents_number_check
    check (char_length(btrim(dc_number)) between 1 and 64),
  constraint dc_documents_date_check
    check (dc_date between date '2000-01-01' and date '2100-12-31'),
  constraint dc_documents_party_name_check
    check (char_length(btrim(party_name)) between 1 and 200),
  constraint dc_documents_party_gstin_check
    check (party_gstin is null or party_gstin ~ '^[0-9A-Z]{15}$'),
  constraint dc_documents_party_type_check
    check (party_type in ('customer', 'supplier', 'vendor', 'other')),
  constraint dc_documents_receipt_type_check
    check (receipt_type is null or receipt_type in
      ('raw_material', 'customer_owned', 'semi_finished', 'inspection_rework', 'return_from_processing', 'other')),
  constraint dc_documents_movement_type_check
    check (movement_type is null or movement_type in
      ('subcontracting', 'inter_company', 'return_to_supplier', 'testing', 'inspection', 'other')),
  constraint dc_documents_delivery_purpose_check
    check (delivery_purpose is null or delivery_purpose in
      ('finished_goods', 'partially_processed', 'sample', 'customer_inspection', 'replacement', 'rework', 'other')),
  constraint dc_documents_transporter_gstin_check
    check (transporter_gstin is null or transporter_gstin ~ '^[0-9A-Z]{15}$'),
  constraint dc_documents_packages_check
    check (package_count is null or package_count >= 0),
  constraint dc_documents_weights_check
    check ((gross_weight is null or gross_weight >= 0) and (net_weight is null or net_weight >= 0)),
  constraint dc_documents_version_check check (version >= 1),
  constraint dc_documents_remarks_check check (
    (remarks is null or char_length(remarks) <= 5000)
    and (internal_remarks is null or char_length(internal_remarks) <= 5000)
  ),
  constraint dc_documents_cancel_check
    check ((cancelled_at is null) = (cancel_reason is null)),
  constraint dc_documents_finalized_check
    check (finalized_at is null or finalized_by is not null),
  constraint dc_documents_deleted_check
    check (deleted_by is null or deleted_at is not null)
);

-- A finalized document number is never reused, cancelled or not.
create unique index if not exists dc_documents_org_type_number_key
  on public.dc_documents (organization_id, dc_type, dc_number_normalized)
  where deleted_at is null;
create index if not exists dc_documents_org_date_idx
  on public.dc_documents (organization_id, dc_type, dc_date desc, created_at desc)
  where deleted_at is null;
create index if not exists dc_documents_org_party_idx
  on public.dc_documents (organization_id, party_id, dc_date desc)
  where deleted_at is null;
create index if not exists dc_documents_org_status_idx
  on public.dc_documents (organization_id, status)
  where deleted_at is null;
create index if not exists dc_documents_reference_inward_idx
  on public.dc_documents (organization_id, reference_inward_dc_id)
  where reference_inward_dc_id is not null;

-- ---------------------------------------------------------------------------
-- Line items
-- ---------------------------------------------------------------------------

create table if not exists public.dc_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  dc_id uuid not null,
  line_no integer not null,

  product_id uuid,
  part_number text not null,
  customer_part_number text,
  description text,
  drawing_number text,
  drawing_revision text,
  batch_lot_no text,
  heat_no text,
  material_grade text,

  unit text not null default 'NOS',
  supply_source text not null default 'customer_material',

  -- Declared vs physically received
  declared_qty numeric(14, 3) not null default 0,
  received_qty numeric(14, 3) not null default 0,
  shortage_qty numeric(14, 3) not null default 0,
  excess_qty numeric(14, 3) not null default 0,
  damaged_qty numeric(14, 3) not null default 0,

  -- Inspection
  inspection_required boolean not null default true,
  inspected_qty numeric(14, 3) not null default 0,
  accepted_qty numeric(14, 3) not null default 0,
  rejected_qty numeric(14, 3) not null default 0,
  rework_qty numeric(14, 3) not null default 0,
  pending_inspection_qty numeric(14, 3) not null default 0,
  inspection_status text not null default 'pending',
  inspection_date date,
  inspected_by uuid,
  rejection_reason text,
  inspection_report_no text,
  inspection_remarks text,

  -- Processing / vendor round trip
  processing_operation text,
  qty_sent numeric(14, 3) not null default 0,
  expected_return_qty numeric(14, 3),
  returned_qty numeric(14, 3) not null default 0,
  accepted_return_qty numeric(14, 3) not null default 0,
  rejected_return_qty numeric(14, 3) not null default 0,
  scrap_qty numeric(14, 3) not null default 0,
  still_at_vendor_qty numeric(14, 3),

  -- Customer delivery
  ordered_qty numeric(14, 3),
  previously_dispatched_qty numeric(14, 3) not null default 0,
  qty_dispatched numeric(14, 3) not null default 0,

  source_inward_item_id uuid,
  production_order_id uuid,
  storage_location text,
  item_remarks text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint dc_items_org_id_key unique (organization_id, id),
  constraint dc_items_dc_fk
    foreign key (organization_id, dc_id) references public.dc_documents (organization_id, id) on delete cascade,
  constraint dc_items_product_fk
    foreign key (organization_id, product_id) references public.products (organization_id, id),
  constraint dc_items_production_order_fk
    foreign key (organization_id, production_order_id) references public.production_orders (organization_id, id),
  constraint dc_items_source_inward_fk
    foreign key (organization_id, source_inward_item_id) references public.dc_items (organization_id, id),
  constraint dc_items_line_key unique (dc_id, line_no),
  constraint dc_items_line_no_check check (line_no >= 1),
  constraint dc_items_part_check check (char_length(btrim(part_number)) between 1 and 64),
  constraint dc_items_unit_check check (char_length(btrim(unit)) between 1 and 32),
  constraint dc_items_supply_source_check
    check (supply_source in ('customer_material', 'finished_stock', 'other')),
  constraint dc_items_declared_check check (declared_qty >= 0 and declared_qty <= 99999999),
  constraint dc_items_received_check check (received_qty >= 0 and received_qty <= 99999999),
  constraint dc_items_variance_check
    check (shortage_qty >= 0 and excess_qty >= 0 and damaged_qty >= 0),
  constraint dc_items_inspection_quantities_check
    check (inspected_qty >= 0 and accepted_qty >= 0 and rejected_qty >= 0
      and rework_qty >= 0 and pending_inspection_qty >= 0),
  constraint dc_items_inspection_status_check
    check (inspection_status in (
      'not_required', 'pending', 'partially_inspected', 'accepted',
      'partially_accepted', 'rejected', 'rework_required'
    )),
  -- The inspection outcome can never account for more than what arrived.
  constraint dc_items_inspection_within_receipt_check
    check (accepted_qty + rejected_qty + rework_qty <= received_qty),
  -- Material awaiting inspection is never accepted stock.
  constraint dc_items_pending_not_accepted_check
    check (pending_inspection_qty <= received_qty),
  constraint dc_items_processing_quantities_check
    check (qty_sent >= 0 and returned_qty >= 0 and accepted_return_qty >= 0
      and rejected_return_qty >= 0 and scrap_qty >= 0),
  constraint dc_items_return_within_sent_check
    check (returned_qty <= qty_sent),
  constraint dc_items_accepted_return_check
    check (accepted_return_qty + rejected_return_qty + scrap_qty <= returned_qty),
  constraint dc_items_dispatch_quantities_check
    check (qty_dispatched >= 0 and previously_dispatched_qty >= 0)
);

create index if not exists dc_items_dc_idx on public.dc_items (organization_id, dc_id, line_no);
create index if not exists dc_items_part_idx on public.dc_items (organization_id, part_number);
create index if not exists dc_items_inspection_idx
  on public.dc_items (organization_id, inspection_status)
  where inspection_required;

-- ---------------------------------------------------------------------------
-- Material owner
--
-- Added after the CREATE TABLE on purpose. `create table if not exists` is a
-- no-op on a database that already has the table, so a column added to the
-- definition would simply never appear on an existing installation. Splitting
-- it out is what makes this migration safe to re-run.
--
-- Whose material a line refers to. On an outward self challan the header party
-- is the destination vendor, which says nothing about ownership: sending 600
-- pieces of Customer A's stock to a machine shop does not tell you that the
-- balance belongs to Customer A. Without this column no balance can be
-- computed at all.
-- ---------------------------------------------------------------------------

alter table public.dc_items add column if not exists material_owner_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint where conname = 'dc_items_material_owner_fk'
  ) then
    alter table public.dc_items
      add constraint dc_items_material_owner_fk
      foreign key (organization_id, material_owner_id) references public.customers (organization_id, id);
  end if;
end
$$;

create index if not exists dc_items_owner_idx
  on public.dc_items (organization_id, material_owner_id, part_number)
  where material_owner_id is not null;

-- ---------------------------------------------------------------------------
-- Inspection events (append only; a correction is a reversing row)
-- ---------------------------------------------------------------------------

create table if not exists public.dc_inspections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  dc_id uuid not null,
  dc_item_id uuid not null,
  inspected_at timestamptz not null default now(),
  inspected_by uuid,
  inspected_quantity numeric(14, 3) not null default 0,
  accepted_quantity numeric(14, 3) not null default 0,
  rejected_quantity numeric(14, 3) not null default 0,
  rework_quantity numeric(14, 3) not null default 0,
  pending_quantity numeric(14, 3) not null default 0,
  rejection_reason text,
  disposition text,
  inspection_report_no text,
  remarks text,
  is_reversal boolean not null default false,
  reverses_inspection_id uuid,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint dc_inspections_org_id_key unique (organization_id, id),
  constraint dc_inspections_dc_fk
    foreign key (organization_id, dc_id) references public.dc_documents (organization_id, id) on delete cascade,
  constraint dc_inspections_item_fk
    foreign key (organization_id, dc_item_id) references public.dc_items (organization_id, id) on delete cascade,
  constraint dc_inspections_reverses_fk
    foreign key (organization_id, reverses_inspection_id) references public.dc_inspections (organization_id, id),
  constraint dc_inspections_quantities_check
    check (inspected_quantity >= 0 and accepted_quantity >= 0 and rejected_quantity >= 0
      and rework_quantity >= 0 and pending_quantity >= 0),
  constraint dc_inspections_balance_check
    check (accepted_quantity + rejected_quantity + rework_quantity + pending_quantity = inspected_quantity),
  constraint dc_inspections_disposition_check
    check (disposition is null or disposition in
      ('return_to_customer', 'return_to_supplier', 'rework', 'hold_for_decision', 'scrap', 'other')),
  constraint dc_inspections_reversal_check
    check (is_reversal or reverses_inspection_id is null)
);

create index if not exists dc_inspections_item_idx
  on public.dc_inspections (organization_id, dc_item_id, inspected_at desc);

-- ---------------------------------------------------------------------------
-- Material rejections
-- ---------------------------------------------------------------------------

create table if not exists public.dc_rejections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  dc_id uuid not null,
  dc_item_id uuid not null,
  party_id uuid not null,
  part_number text not null,
  batch_lot_no text,

  quantity_received numeric(14, 3) not null default 0,
  quantity_inspected numeric(14, 3) not null default 0,
  quantity_accepted numeric(14, 3) not null default 0,
  quantity_rejected numeric(14, 3) not null default 0,
  quantity_returned numeric(14, 3) not null default 0,
  quantity_scrapped numeric(14, 3) not null default 0,

  rejection_date date not null default current_date,
  rejection_reason text,
  inspection_report_no text,
  disposition text not null default 'hold_for_decision',
  responsible_person text,
  scrap_approved_by uuid,
  scrap_approved_at timestamptz,
  return_dc_id uuid,
  status text not null default 'open',
  remarks text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint dc_rejections_org_id_key unique (organization_id, id),
  constraint dc_rejections_dc_fk
    foreign key (organization_id, dc_id) references public.dc_documents (organization_id, id) on delete cascade,
  constraint dc_rejections_item_fk
    foreign key (organization_id, dc_item_id) references public.dc_items (organization_id, id) on delete cascade,
  constraint dc_rejections_party_fk
    foreign key (organization_id, party_id) references public.customers (organization_id, id),
  constraint dc_rejections_return_dc_fk
    foreign key (organization_id, return_dc_id) references public.dc_documents (organization_id, id),
  constraint dc_rejections_quantities_check
    check (quantity_received >= 0 and quantity_inspected >= 0 and quantity_accepted >= 0
      and quantity_rejected >= 0 and quantity_returned >= 0 and quantity_scrapped >= 0),
  constraint dc_rejections_inspection_check
    check (quantity_accepted + quantity_rejected <= quantity_inspected),
  -- Partial return is the normal case, so only the sum is bounded.
  constraint dc_rejections_settled_check
    check (quantity_returned + quantity_scrapped <= quantity_rejected),
  constraint dc_rejections_disposition_check
    check (disposition in ('return_to_customer', 'return_to_supplier', 'rework', 'hold_for_decision', 'scrap', 'other')),
  constraint dc_rejections_status_check
    check (status in ('open', 'partially_returned', 'returned', 'scrapped', 'closed')),
  constraint dc_rejections_scrap_approval_check
    check (disposition <> 'scrap' or scrap_approved_by is not null)
);

create index if not exists dc_rejections_party_idx
  on public.dc_rejections (organization_id, party_id, rejection_date desc);
create index if not exists dc_rejections_status_idx
  on public.dc_rejections (organization_id, status);

-- ---------------------------------------------------------------------------
-- Machining / processing results (append only)
-- ---------------------------------------------------------------------------

create table if not exists public.dc_machining_results (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  source_dc_id uuid,
  source_dc_item_id uuid,
  party_id uuid not null,
  material_owner_id uuid,
  part_number text not null,
  production_order_id uuid,
  job_work_order_id uuid,

  operation text not null,
  operation_date date not null default current_date,

  input_quantity numeric(14, 3) not null,
  input_unit text not null default 'NOS',
  accepted_output_quantity numeric(14, 3) not null default 0,
  output_unit text not null default 'NOS',

  machining_rejection_quantity numeric(14, 3) not null default 0,
  rework_quantity numeric(14, 3) not null default 0,
  scrap_quantity numeric(14, 3) not null default 0,
  process_loss_quantity numeric(14, 3) not null default 0,
  unit_conversion boolean not null default false,
  loss_reason text,
  loss_approved_by uuid,
  loss_approved_at timestamptz,

  rejection_reason text,
  inspection_report text,
  operator_name text,
  inspector_name text,
  corrective_action text,
  remarks text,

  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),

  constraint dc_machining_results_org_id_key unique (organization_id, id),
  constraint dc_machining_results_source_dc_fk
    foreign key (organization_id, source_dc_id) references public.dc_documents (organization_id, id),
  constraint dc_machining_results_source_item_fk
    foreign key (organization_id, source_dc_item_id) references public.dc_items (organization_id, id),
  constraint dc_machining_results_party_fk
    foreign key (organization_id, party_id) references public.customers (organization_id, id),
  constraint dc_machining_results_owner_fk
    foreign key (organization_id, material_owner_id) references public.customers (organization_id, id),
  constraint dc_machining_results_production_order_fk
    foreign key (organization_id, production_order_id) references public.production_orders (organization_id, id),
  constraint dc_machining_results_job_work_order_fk
    foreign key (organization_id, job_work_order_id) references public.job_work_orders (organization_id, id),
  constraint dc_machining_results_operation_check
    check (char_length(btrim(operation)) between 1 and 120),
  constraint dc_machining_results_input_check check (input_quantity > 0 and input_quantity <= 99999999),
  constraint dc_machining_results_units_check
    check (char_length(btrim(input_unit)) between 1 and 32 and char_length(btrim(output_unit)) between 1 and 32),
  constraint dc_machining_results_quantities_check
    check (accepted_output_quantity >= 0 and machining_rejection_quantity >= 0
      and rework_quantity >= 0 and scrap_quantity >= 0 and process_loss_quantity >= 0),
  -- Universal reconciliation applies only when the units are compatible.
  constraint dc_machining_results_balance_check
    check (
      unit_conversion
      or input_unit <> output_unit
      or input_quantity =
         accepted_output_quantity + machining_rejection_quantity
         + rework_quantity + scrap_quantity + process_loss_quantity
    ),
  -- An allowed process loss is never silent.
  constraint dc_machining_results_loss_check
    check (
      process_loss_quantity = 0
      or (loss_reason is not null and loss_approved_by is not null)
    ),
  constraint dc_machining_results_approval_check
    check ((loss_approved_at is null) = (loss_approved_by is null))
);

create index if not exists dc_machining_results_owner_idx
  on public.dc_machining_results (organization_id, material_owner_id, part_number, operation_date desc);
create index if not exists dc_machining_results_source_idx
  on public.dc_machining_results (organization_id, source_dc_item_id);

-- ---------------------------------------------------------------------------
-- Movement events (dispatch / receipt / vendor return / customer delivery)
-- ---------------------------------------------------------------------------

create table if not exists public.dc_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  dc_id uuid not null,
  dc_item_id uuid,
  movement_type text not null,
  quantity numeric(14, 3) not null,
  unit text not null default 'NOS',
  supply_source text not null default 'customer_material',
  moved_at timestamptz not null default now(),
  reference text,
  remarks text,
  reverses_movement_id uuid,
  is_reversal boolean not null default false,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),

  constraint dc_movements_org_id_key unique (organization_id, id),
  constraint dc_movements_dc_fk
    foreign key (organization_id, dc_id) references public.dc_documents (organization_id, id) on delete cascade,
  constraint dc_movements_item_fk
    foreign key (organization_id, dc_item_id) references public.dc_items (organization_id, id),
  constraint dc_movements_type_check
    check (movement_type in ('dispatch', 'receipt', 'vendor_return', 'material_return', 'customer_delivery')),
  constraint dc_movements_supply_source_check
    check (supply_source in ('customer_material', 'finished_stock', 'other')),
  constraint dc_movements_quantity_check check (quantity > 0 and quantity <= 99999999),
  constraint dc_movements_unit_check check (char_length(btrim(unit)) between 1 and 32)
);

create index if not exists dc_movements_dc_idx on public.dc_movements (organization_id, dc_id, moved_at desc);
create index if not exists dc_movements_item_idx on public.dc_movements (organization_id, dc_item_id);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

drop trigger if exists dc_documents_set_updated_at on public.dc_documents;
create trigger dc_documents_set_updated_at
  before update on public.dc_documents
  for each row execute function app_private.set_updated_at();
drop trigger if exists dc_documents_immutable on public.dc_documents;
create trigger dc_documents_immutable
  before update on public.dc_documents
  for each row execute function app_private.enforce_immutable_columns();
drop trigger if exists dc_documents_soft_delete on public.dc_documents;
create trigger dc_documents_soft_delete
  before update on public.dc_documents
  for each row execute function app_private.guard_soft_delete();
drop trigger if exists dc_documents_audit on public.dc_documents;
create trigger dc_documents_audit
  after insert or update or delete on public.dc_documents
  for each row execute function app_private.write_audit_row();

drop trigger if exists dc_items_set_updated_at on public.dc_items;
create trigger dc_items_set_updated_at
  before update on public.dc_items
  for each row execute function app_private.set_updated_at();
drop trigger if exists dc_items_immutable on public.dc_items;
create trigger dc_items_immutable
  before update on public.dc_items
  for each row execute function app_private.enforce_immutable_columns();
drop trigger if exists dc_items_audit on public.dc_items;
create trigger dc_items_audit
  after insert or update or delete on public.dc_items
  for each row execute function app_private.write_audit_row();

drop trigger if exists dc_rejections_set_updated_at on public.dc_rejections;
create trigger dc_rejections_set_updated_at
  before update on public.dc_rejections
  for each row execute function app_private.set_updated_at();
drop trigger if exists dc_rejections_immutable on public.dc_rejections;
create trigger dc_rejections_immutable
  before update on public.dc_rejections
  for each row execute function app_private.enforce_immutable_columns();
drop trigger if exists dc_rejections_audit on public.dc_rejections;
create trigger dc_rejections_audit
  after insert or update or delete on public.dc_rejections
  for each row execute function app_private.write_audit_row();

drop trigger if exists dc_movements_audit on public.dc_movements;
create trigger dc_movements_audit
  after insert or delete on public.dc_movements
  for each row execute function app_private.write_audit_row();

drop trigger if exists dc_inspections_audit on public.dc_inspections;
create trigger dc_inspections_audit
  after insert on public.dc_inspections
  for each row execute function app_private.write_audit_row();

drop trigger if exists dc_machining_results_audit on public.dc_machining_results;
create trigger dc_machining_results_audit
  after insert on public.dc_machining_results
  for each row execute function app_private.write_audit_row();

-- Append-only event tables must not be silently edited or deleted.
create or replace function app_private.guard_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception using
    errcode = '42501',
    message = 'APPEND_ONLY: ' || tg_table_name || ' records cannot be modified or deleted; record a reversing entry instead';
end;
$$;

revoke all on function app_private.guard_append_only() from public, anonymous, authenticated;

drop trigger if exists dc_inspections_append_only on public.dc_inspections;
create trigger dc_inspections_append_only
  before update or delete on public.dc_inspections
  for each row execute function app_private.guard_append_only();

drop trigger if exists dc_movements_append_only on public.dc_movements;
create trigger dc_movements_append_only
  before update or delete on public.dc_movements
  for each row execute function app_private.guard_append_only();

drop trigger if exists dc_machining_results_append_only on public.dc_machining_results;
create trigger dc_machining_results_append_only
  before update or delete on public.dc_machining_results
  for each row execute function app_private.guard_append_only();