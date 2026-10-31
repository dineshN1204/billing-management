create schema if not exists app_private;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  gstin text,
  state_code text,
  address text,
  phone text,
  email text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint organizations_name_check check (char_length(btrim(name)) between 2 and 120),
  constraint organizations_gstin_check check (gstin is null or gstin ~ '^[0-9A-Z]{15}$'),
  constraint organizations_state_code_check check (state_code is null or state_code ~ '^[0-9]{2}$'),
  constraint organizations_address_check check (address is null or char_length(address) <= 500),
  constraint organizations_phone_check check (phone is null or char_length(phone) <= 32),
  constraint organizations_email_check check (email is null or char_length(email) <= 254)
);

create table if not exists public.profiles (
  id uuid primary key,
  full_name text,
  default_organization_id uuid references public.organizations (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_full_name_check check (full_name is null or char_length(full_name) <= 120)
);

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null,
  role text not null default 'viewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memberships_role_check check (role in ('admin', 'staff', 'viewer')),
  constraint memberships_org_user_key unique (organization_id, user_id)
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  gstin text,
  phone text,
  email text,
  address text,
  state_code text,
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint customers_org_id_key unique (organization_id, id),
  constraint customers_name_check check (char_length(btrim(name)) between 1 and 200),
  constraint customers_gstin_check check (gstin is null or gstin ~ '^[0-9A-Z]{15}$'),
  constraint customers_state_code_check check (state_code is null or state_code ~ '^[0-9]{2}$'),
  constraint customers_phone_check check (phone is null or char_length(phone) <= 32),
  constraint customers_email_check check (email is null or char_length(email) <= 254),
  constraint customers_address_check check (address is null or char_length(address) <= 500),
  constraint customers_notes_check check (notes is null or char_length(notes) <= 2000)
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  product_code text,
  hsn_code text,
  unit text not null default 'NOS',
  default_rate numeric(14, 4) not null default 0,
  gst_rate numeric(5, 2) not null default 0,
  description text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint products_org_id_key unique (organization_id, id),
  constraint products_name_check check (char_length(btrim(name)) between 1 and 200),
  constraint products_code_check check (product_code is null or char_length(product_code) between 1 and 64),
  constraint products_hsn_check check (hsn_code is null or hsn_code ~ '^[0-9]{2,8}$'),
  constraint products_unit_check check (char_length(btrim(unit)) between 1 and 32),
  constraint products_rate_check check (default_rate >= 0 and default_rate <= 999999999.9999),
  constraint products_gst_rate_check check (gst_rate >= 0 and gst_rate <= 100),
  constraint products_description_check check (description is null or char_length(description) <= 500)
);

create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  file_name text,
  status text not null default 'pending',
  total_rows integer not null default 0,
  success_rows integer not null default 0,
  failed_rows integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  deleted_at timestamptz,
  constraint import_batches_org_id_key unique (organization_id, id),
  constraint import_batches_status_check check (status in ('pending', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
  constraint import_batches_rows_check check (total_rows >= 0 and success_rows >= 0 and failed_rows >= 0),
  constraint import_batches_errors_check check (jsonb_typeof(errors) = 'array'),
  constraint import_batches_metadata_check check (jsonb_typeof(metadata) = 'object'),
  constraint import_batches_file_name_check check (file_name is null or char_length(file_name) <= 255)
);

create table if not exists public.bills (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  customer_id uuid not null,
  customer_name text not null,
  customer_gstin text,
  bill_number text not null,
  bill_number_normalized text generated always as (lower(btrim(bill_number))) stored,
  bill_date date not null,
  place_of_supply text,
  tax_mode text not null default 'intra',
  payment_status text not null default 'unpaid',
  notes text,
  source_type text not null default 'manual',
  verification_status text not null default 'unverified',
  verified_by uuid,
  verified_at timestamptz,
  import_batch_id uuid,
  subtotal numeric(14, 2) not null default 0,
  discount_total numeric(14, 2) not null default 0,
  taxable_amount numeric(14, 2) not null default 0,
  cgst_amount numeric(14, 2) not null default 0,
  sgst_amount numeric(14, 2) not null default 0,
  igst_amount numeric(14, 2) not null default 0,
  tax_total numeric(14, 2) not null default 0,
  grand_total numeric(14, 2) not null default 0,
  version integer not null default 1,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  constraint bills_org_id_key unique (organization_id, id),
  constraint bills_customer_fk foreign key (organization_id, customer_id) references public.customers (organization_id, id),
  constraint bills_import_batch_fk foreign key (organization_id, import_batch_id) references public.import_batches (organization_id, id),
  constraint bills_bill_number_check check (char_length(btrim(bill_number)) between 1 and 64),
  constraint bills_customer_name_check check (char_length(btrim(customer_name)) between 1 and 200),
  constraint bills_bill_date_check check (bill_date between date '2000-01-01' and date '2100-12-31'),
  constraint bills_place_of_supply_check check (place_of_supply is null or char_length(place_of_supply) <= 100),
  constraint bills_tax_mode_check check (tax_mode in ('intra', 'inter')),
  constraint bills_payment_status_check check (payment_status in ('unpaid', 'partial', 'paid')),
  constraint bills_notes_check check (notes is null or char_length(notes) <= 5000),
  constraint bills_source_type_check check (source_type in ('manual', 'ocr', 'import')),
  constraint bills_verification_status_check check (verification_status in ('unverified', 'needs_review', 'verified', 'rejected')),
  constraint bills_verified_check check (verification_status <> 'verified' or verified_at is not null),
  constraint bills_amounts_check check (
    subtotal >= 0 and discount_total >= 0 and taxable_amount >= 0 and cgst_amount >= 0
    and sgst_amount >= 0 and igst_amount >= 0 and tax_total >= 0 and grand_total >= 0
  ),
  constraint bills_totals_consistent_check check (
    taxable_amount = subtotal - discount_total
    and tax_total = cgst_amount + sgst_amount + igst_amount
    and grand_total = taxable_amount + tax_total
  ),
  constraint bills_tax_mode_amounts_check check (
    (tax_mode = 'intra' and igst_amount = 0) or (tax_mode = 'inter' and cgst_amount = 0 and sgst_amount = 0)
  ),
  constraint bills_version_check check (version >= 1),
  constraint bills_deleted_check check (deleted_by is null or deleted_at is not null)
);

create table if not exists public.bill_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  bill_id uuid not null,
  line_no integer not null,
  product_id uuid,
  product_name text not null,
  product_code text,
  hsn_code text,
  description text,
  unit text not null default 'NOS',
  quantity numeric(14, 3) not null,
  rate numeric(14, 4) not null,
  discount numeric(14, 2) not null default 0,
  gst_rate numeric(5, 2) not null default 0,
  line_subtotal numeric(14, 2) not null,
  taxable_amount numeric(14, 2) not null,
  cgst_amount numeric(14, 2) not null default 0,
  sgst_amount numeric(14, 2) not null default 0,
  igst_amount numeric(14, 2) not null default 0,
  tax_amount numeric(14, 2) not null default 0,
  line_total numeric(14, 2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bill_items_bill_fk foreign key (organization_id, bill_id) references public.bills (organization_id, id) on delete cascade,
  constraint bill_items_product_fk foreign key (organization_id, product_id) references public.products (organization_id, id),
  constraint bill_items_bill_line_key unique (bill_id, line_no),
  constraint bill_items_line_no_check check (line_no >= 1),
  constraint bill_items_product_name_check check (char_length(btrim(product_name)) between 1 and 200),
  constraint bill_items_product_code_check check (product_code is null or char_length(product_code) <= 64),
  constraint bill_items_hsn_check check (hsn_code is null or hsn_code ~ '^[0-9]{2,8}$'),
  constraint bill_items_description_check check (description is null or char_length(description) <= 500),
  constraint bill_items_unit_check check (char_length(btrim(unit)) between 1 and 32),
  constraint bill_items_quantity_check check (quantity > 0 and quantity <= 99999999),
  constraint bill_items_rate_check check (rate >= 0 and rate <= 999999999.9999),
  constraint bill_items_discount_check check (discount >= 0 and discount <= line_subtotal),
  constraint bill_items_gst_rate_check check (gst_rate >= 0 and gst_rate <= 100),
  constraint bill_items_amounts_check check (
    line_subtotal >= 0 and taxable_amount >= 0 and cgst_amount >= 0 and sgst_amount >= 0
    and igst_amount >= 0 and tax_amount >= 0 and line_total >= 0
  ),
  constraint bill_items_taxable_check check (taxable_amount = line_subtotal - discount),
  constraint bill_items_tax_check check (tax_amount = cgst_amount + sgst_amount + igst_amount),
  constraint bill_items_total_check check (line_total = taxable_amount + tax_amount),
  constraint bill_items_tax_split_check check (igst_amount = 0 or (cgst_amount = 0 and sgst_amount = 0))
);

create table if not exists public.bill_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  bill_id uuid not null,
  file_path text not null,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint bill_attachments_org_id_key unique (organization_id, id),
  constraint bill_attachments_bill_fk foreign key (organization_id, bill_id) references public.bills (organization_id, id) on delete cascade,
  constraint bill_attachments_path_prefix_check check (starts_with(file_path, organization_id::text || '/')),
  constraint bill_attachments_path_safe_check check (file_path !~ '(^|/)\.\.(/|$)' and char_length(file_path) <= 512),
  constraint bill_attachments_file_name_check check (char_length(btrim(file_name)) between 1 and 255),
  constraint bill_attachments_mime_check check (mime_type is null or char_length(mime_type) <= 127),
  constraint bill_attachments_size_check check (size_bytes is null or size_bytes >= 0)
);

create table if not exists public.ocr_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  bill_id uuid,
  file_path text not null,
  status text not null default 'queued',
  staging jsonb not null default '{}'::jsonb,
  engine text,
  confidence numeric(5, 2),
  attempts integer not null default 0,
  error_message text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  deleted_at timestamptz,
  constraint ocr_jobs_org_id_key unique (organization_id, id),
  constraint ocr_jobs_bill_fk foreign key (organization_id, bill_id) references public.bills (organization_id, id),
  constraint ocr_jobs_status_check check (status in ('queued', 'processing', 'succeeded', 'failed', 'imported', 'discarded')),
  constraint ocr_jobs_staging_check check (jsonb_typeof(staging) = 'object'),
  constraint ocr_jobs_path_prefix_check check (starts_with(file_path, organization_id::text || '/')),
  constraint ocr_jobs_path_safe_check check (file_path !~ '(^|/)\.\.(/|$)' and char_length(file_path) <= 512),
  constraint ocr_jobs_confidence_check check (confidence is null or (confidence >= 0 and confidence <= 100)),
  constraint ocr_jobs_attempts_check check (attempts >= 0),
  constraint ocr_jobs_engine_check check (engine is null or char_length(engine) <= 64),
  constraint ocr_jobs_error_check check (error_message is null or char_length(error_message) <= 2000)
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid,
  actor_id uuid,
  action text not null,
  table_name text not null,
  record_id uuid,
  old_data jsonb,
  new_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.storage_objects (
  organization_id uuid not null,
  object_path text not null,
  content_type text,
  size_bytes bigint,
  created_at timestamptz not null default now(),
  primary key (organization_id, object_path)
);

create index if not exists memberships_user_id_idx on public.memberships (user_id);
create index if not exists profiles_default_organization_id_idx on public.profiles (default_organization_id) where default_organization_id is not null;
create index if not exists organizations_created_by_idx on public.organizations (created_by) where created_by is not null;

create index if not exists customers_org_name_idx on public.customers (organization_id, lower(name) text_pattern_ops) where deleted_at is null;
create unique index if not exists customers_org_gstin_key on public.customers (organization_id, gstin) where gstin is not null and deleted_at is null;
create index if not exists customers_org_created_idx on public.customers (organization_id, created_at desc) where deleted_at is null;

create index if not exists products_org_name_idx on public.products (organization_id, lower(name) text_pattern_ops) where deleted_at is null;
create unique index if not exists products_org_code_key on public.products (organization_id, lower(product_code)) where product_code is not null and deleted_at is null;

create index if not exists import_batches_org_created_idx on public.import_batches (organization_id, created_at desc) where deleted_at is null;

create index if not exists bills_org_date_idx on public.bills (organization_id, bill_date desc, created_at desc) where deleted_at is null;
create index if not exists bills_org_customer_date_idx on public.bills (organization_id, customer_id, bill_date desc) where deleted_at is null;
create index if not exists bills_org_number_idx on public.bills (organization_id, bill_number_normalized) where deleted_at is null;
create index if not exists bills_org_dup_idx on public.bills (organization_id, customer_id, bill_date, grand_total) where deleted_at is null;
create index if not exists bills_org_verification_idx on public.bills (organization_id, verification_status) where deleted_at is null;
create index if not exists bills_org_payment_idx on public.bills (organization_id, payment_status) where deleted_at is null;
create index if not exists bills_org_deleted_idx on public.bills (organization_id, deleted_at) where deleted_at is not null;
create index if not exists bills_import_batch_idx on public.bills (organization_id, import_batch_id) where import_batch_id is not null;

create index if not exists bill_items_bill_idx on public.bill_items (organization_id, bill_id);
create index if not exists bill_items_product_idx on public.bill_items (organization_id, product_id) where product_id is not null;

create index if not exists bill_attachments_bill_idx on public.bill_attachments (organization_id, bill_id);
create unique index if not exists bill_attachments_org_path_key on public.bill_attachments (organization_id, file_path) where deleted_at is null;

create index if not exists ocr_jobs_org_status_idx on public.ocr_jobs (organization_id, status, created_at desc) where deleted_at is null;
create index if not exists ocr_jobs_bill_idx on public.ocr_jobs (organization_id, bill_id) where bill_id is not null;
create index if not exists ocr_jobs_staging_gin_idx on public.ocr_jobs using gin (staging jsonb_path_ops);

create index if not exists audit_logs_org_created_idx on public.audit_logs (organization_id, created_at desc);
create index if not exists audit_logs_record_idx on public.audit_logs (organization_id, table_name, record_id, created_at desc);
create index if not exists audit_logs_actor_idx on public.audit_logs (actor_id, created_at desc) where actor_id is not null;

-- Foreign keys to the Neon Auth user table (replaces auth.users).
-- Idempotent: safe to re-run this block after Neon Auth has been enabled.
do $$
declare
  v_specs text[] := array[
    'organizations|created_by|organizations_created_by_fkey|set null',
    'profiles|id|profiles_id_fkey|cascade',
    'memberships|user_id|memberships_user_id_fkey|cascade',
    'customers|created_by|customers_created_by_fkey|set null',
    'customers|verified_by|customers_verified_by_fkey|set null',
    'products|created_by|products_created_by_fkey|set null',
    'import_batches|created_by|import_batches_created_by_fkey|set null',
    'bills|created_by|bills_created_by_fkey|set null',
    'bills|updated_by|bills_updated_by_fkey|set null',
    'bills|deleted_by|bills_deleted_by_fkey|set null',
    'bills|verified_by|bills_verified_by_fkey|set null',
    'bill_attachments|created_by|bill_attachments_created_by_fkey|set null',
    'ocr_jobs|created_by|ocr_jobs_created_by_fkey|set null'
  ];
  v_spec text;
  v_part text[];
begin
  if to_regclass('neon_auth.user') is null then
    raise notice 'neon_auth.user does not exist yet: foreign keys to the Neon Auth user table were SKIPPED. Enable Neon Auth on this branch, then re-run db/migrations/0001_core_schema.sql to create them.';
    return;
  end if;

  foreach v_spec in array v_specs loop
    v_part := string_to_array(v_spec, '|');
    if not exists (
      select 1
      from pg_catalog.pg_attribute a
      where a.attrelid = format('public.%I', v_part[1])::regclass
        and a.attname = v_part[2]
        and not a.attisdropped
    ) then
      raise notice 'public.%.% does not exist yet: % skipped', v_part[1], v_part[2], v_part[3];
    elsif not exists (
      select 1
      from pg_catalog.pg_constraint c
      where c.conrelid = format('public.%I', v_part[1])::regclass
        and c.conname = v_part[3]
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (%I) references neon_auth.user (id) on delete %s',
        v_part[1], v_part[3], v_part[2], v_part[4]
      );
    end if;
  end loop;
end
$$;