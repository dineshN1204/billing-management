-- 0013: Delivery Challan foundations.
--
-- Additive only. Nothing existing is rewritten, dropped or re-typed.
--
-- 1. customers.party_type — the DC module needs suppliers, subcontractors and
--    vendors, and the brief is explicit that a second party master must not be
--    created. One party table, one GSTIN uniqueness rule, one set of RLS
--    policies, one search path.
-- 2. production_orders / job_work_orders — these did not exist anywhere in the
--    project. They are created EMPTY. No production history is invented and no
--    link to bills is asserted: an order is only what a user records today.
-- 3. dc_settings — per-workspace document numbering configuration.
-- 4. dc_options — configurable business lists (transport modes, processing
--    operations, rejection reasons, dispositions, units). Seeded with the
--    defaults suggested in the brief, overridable per workspace.

-- ---------------------------------------------------------------------------
-- 1. Party type
-- ---------------------------------------------------------------------------

alter table public.customers add column if not exists party_type text not null default 'customer';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint where conname = 'customers_party_type_check'
  ) then
    alter table public.customers
      add constraint customers_party_type_check
      check (party_type in ('customer', 'supplier', 'vendor', 'other'));
  end if;
end
$$;

create index if not exists customers_org_party_type_idx
  on public.customers (organization_id, party_type)
  where deleted_at is null;

-- 0002_security_rls.sql grants INSERT/UPDATE on customers by explicit column
-- list. A new column that is not re-granted is "permission denied for column"
-- on every direct client write, so both grants are extended here.
grant insert (organization_id, name, gstin, phone, email, address, state_code, notes, party_type)
  on public.customers to authenticated;
grant update (name, gstin, phone, email, address, state_code, notes, party_type, deleted_at)
  on public.customers to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Production and job-work orders
-- ---------------------------------------------------------------------------

create table if not exists public.production_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  order_number text not null,
  customer_id uuid not null,
  order_date date not null default current_date,
  required_date date,
  status text not null default 'open',
  remarks text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  constraint production_orders_org_id_key unique (organization_id, id),
  constraint production_orders_customer_fk
    foreign key (organization_id, customer_id) references public.customers (organization_id, id),
  constraint production_orders_number_check
    check (char_length(btrim(order_number)) between 1 and 64),
  constraint production_orders_date_check
    check (order_date between date '2000-01-01' and date '2100-12-31'),
  constraint production_orders_required_check
    check (required_date is null or required_date >= order_date),
  constraint production_orders_status_check
    check (status in ('open', 'in_progress', 'partially_dispatched', 'completed', 'cancelled')),
  constraint production_orders_remarks_check
    check (remarks is null or char_length(remarks) <= 5000),
  constraint production_orders_deleted_check
    check (deleted_by is null or deleted_at is not null)
);

create table if not exists public.production_order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  production_order_id uuid not null,
  line_no integer not null,
  product_id uuid,
  part_number text not null,
  description text,
  unit text not null default 'NOS',
  ordered_quantity numeric(14, 3) not null default 0,
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint production_order_items_org_id_key unique (organization_id, id),
  constraint production_order_items_order_fk
    foreign key (organization_id, production_order_id)
    references public.production_orders (organization_id, id) on delete cascade,
  constraint production_order_items_product_fk
    foreign key (organization_id, product_id) references public.products (organization_id, id),
  constraint production_order_items_line_key unique (production_order_id, line_no),
  constraint production_order_items_line_no_check check (line_no >= 1),
  constraint production_order_items_part_check check (char_length(btrim(part_number)) between 1 and 64),
  constraint production_order_items_description_check
    check (description is null or char_length(description) <= 500),
  constraint production_order_items_unit_check check (char_length(btrim(unit)) between 1 and 32),
  constraint production_order_items_quantity_check
    check (ordered_quantity >= 0 and ordered_quantity <= 99999999)
);

create table if not exists public.job_work_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  job_number text not null,
  party_id uuid not null,
  production_order_id uuid,
  operation text not null,
  quantity_issued numeric(14, 3) not null default 0,
  unit text not null default 'NOS',
  issued_date date not null default current_date,
  expected_return_date date,
  status text not null default 'open',
  remarks text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  constraint job_work_orders_org_id_key unique (organization_id, id),
  constraint job_work_orders_party_fk
    foreign key (organization_id, party_id) references public.customers (organization_id, id),
  constraint job_work_orders_production_order_fk
    foreign key (organization_id, production_order_id) references public.production_orders (organization_id, id),
  constraint job_work_orders_number_check
    check (char_length(btrim(job_number)) between 1 and 64),
  constraint job_work_orders_operation_check
    check (char_length(btrim(operation)) between 1 and 120),
  constraint job_work_orders_quantity_check
    check (quantity_issued >= 0 and quantity_issued <= 99999999),
  constraint job_work_orders_unit_check check (char_length(btrim(unit)) between 1 and 32),
  constraint job_work_orders_dates_check check (
    issued_date between date '2000-01-01' and date '2100-12-31'
    and (expected_return_date is null or expected_return_date >= issued_date)
  ),
  constraint job_work_orders_status_check
    check (status in ('open', 'in_progress', 'partially_returned', 'returned', 'cancelled')),
  constraint job_work_orders_remarks_check
    check (remarks is null or char_length(remarks) <= 5000),
  constraint job_work_orders_deleted_check
    check (deleted_by is null or deleted_at is not null)
);

create unique index if not exists production_orders_org_number_key
  on public.production_orders (organization_id, lower(order_number))
  where deleted_at is null;
create index if not exists production_orders_org_customer_idx
  on public.production_orders (organization_id, customer_id, order_date desc)
  where deleted_at is null;
create index if not exists production_order_items_order_idx
  on public.production_order_items (organization_id, production_order_id, line_no);
create unique index if not exists job_work_orders_org_number_key
  on public.job_work_orders (organization_id, lower(job_number))
  where deleted_at is null;
create index if not exists job_work_orders_org_party_idx
  on public.job_work_orders (organization_id, party_id, issued_date desc)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 3. DC settings — one row per workspace and document type
-- ---------------------------------------------------------------------------

create table if not exists public.dc_settings (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  dc_type text not null,
  prefix text not null default 'KI',
  segment_code text not null,
  padding integer not null default 4,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (organization_id, dc_type),
  constraint dc_settings_type_check
    check (dc_type in ('inward', 'outward_self', 'outward_customer', 'material_return')),
  constraint dc_settings_prefix_check
    check (char_length(btrim(prefix)) between 1 and 16),
  constraint dc_settings_segment_check
    check (char_length(btrim(segment_code)) between 1 and 16 and segment_code = upper(btrim(segment_code))),
  constraint dc_settings_padding_check check (padding between 1 and 10)
);

-- ---------------------------------------------------------------------------
-- 4. DC options — configurable business lists
-- ---------------------------------------------------------------------------

create table if not exists public.dc_options (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  option_group text not null,
  option_value text not null,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dc_options_org_id_key unique (organization_id, id),
  constraint dc_options_group_check
    check (option_group in (
      'mot', 'destination_type', 'processing_operation', 'rejection_reason',
      'disposition', 'unit', 'receipt_type', 'movement_type', 'delivery_purpose'
    )),
  constraint dc_options_value_check check (char_length(btrim(option_value)) between 1 and 120),
  constraint dc_options_sort_check check (sort_order >= 0)
);

create index if not exists dc_options_org_group_idx
  on public.dc_options (organization_id, option_group, sort_order)
  where is_active;

-- Case-insensitive uniqueness needs an index over the expression, not a
-- constraint: Postgres only accepts plain columns in a UNIQUE constraint.
create unique index if not exists dc_options_value_key
  on public.dc_options (organization_id, option_group, lower(option_value));

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

drop trigger if exists production_orders_set_updated_at on public.production_orders;
create trigger production_orders_set_updated_at
  before update on public.production_orders
  for each row execute function app_private.set_updated_at();
drop trigger if exists production_orders_immutable on public.production_orders;
create trigger production_orders_immutable
  before update on public.production_orders
  for each row execute function app_private.enforce_immutable_columns();
drop trigger if exists production_orders_soft_delete on public.production_orders;
create trigger production_orders_soft_delete
  before update on public.production_orders
  for each row execute function app_private.guard_soft_delete();
drop trigger if exists production_orders_audit on public.production_orders;
create trigger production_orders_audit
  after insert or update or delete on public.production_orders
  for each row execute function app_private.write_audit_row();

drop trigger if exists production_order_items_set_updated_at on public.production_order_items;
create trigger production_order_items_set_updated_at
  before update on public.production_order_items
  for each row execute function app_private.set_updated_at();
drop trigger if exists production_order_items_immutable on public.production_order_items;
create trigger production_order_items_immutable
  before update on public.production_order_items
  for each row execute function app_private.enforce_immutable_columns();
drop trigger if exists production_order_items_audit on public.production_order_items;
create trigger production_order_items_audit
  after insert or update or delete on public.production_order_items
  for each row execute function app_private.write_audit_row();

drop trigger if exists job_work_orders_set_updated_at on public.job_work_orders;
create trigger job_work_orders_set_updated_at
  before update on public.job_work_orders
  for each row execute function app_private.set_updated_at();
drop trigger if exists job_work_orders_immutable on public.job_work_orders;
create trigger job_work_orders_immutable
  before update on public.job_work_orders
  for each row execute function app_private.enforce_immutable_columns();
drop trigger if exists job_work_orders_soft_delete on public.job_work_orders;
create trigger job_work_orders_soft_delete
  before update on public.job_work_orders
  for each row execute function app_private.guard_soft_delete();
drop trigger if exists job_work_orders_audit on public.job_work_orders;
create trigger job_work_orders_audit
  after insert or update or delete on public.job_work_orders
  for each row execute function app_private.write_audit_row();

drop trigger if exists dc_options_set_updated_at on public.dc_options;
create trigger dc_options_set_updated_at
  before update on public.dc_options
  for each row execute function app_private.set_updated_at();
drop trigger if exists dc_options_immutable on public.dc_options;
create trigger dc_options_immutable
  before update on public.dc_options
  for each row execute function app_private.enforce_immutable_columns();
drop trigger if exists dc_options_audit on public.dc_options;
create trigger dc_options_audit
  after insert or update or delete on public.dc_options
  for each row execute function app_private.write_audit_row();

drop trigger if exists dc_settings_immutable on public.dc_settings;
create trigger dc_settings_immutable
  before update on public.dc_settings
  for each row execute function app_private.enforce_immutable_columns();
drop trigger if exists dc_settings_audit on public.dc_settings;
create trigger dc_settings_audit
  after insert or update or delete on public.dc_settings
  for each row execute function app_private.write_audit_row();