-- ---------------------------------------------------------------------------
-- 0038 - what has been received against a bill
--
-- What this changes
-- -----------------
-- 1. A bill carries the amount that has been received against it. Until now a
--    bill could say it was "partially paid" but not say how much had been
--    paid, so every figure that depended on the balance - the outstanding
--    report, the dashboard's pending amount - counted the whole bill as if
--    nothing had been received.
--
-- 2. Setting the payment status to "partially paid" asks for the amount. The
--    operator types what the customer has paid, and the bill then says what is
--    still owed.
--
-- 3. The remaining is the database's own figure. `bills.remaining_amount` is a
--    generated column - the total less the received - so the bills list, the
--    outstanding report, the dashboard and the invoice all read the same
--    number and cannot disagree about it.
--
-- The rule the status and the amount follow
-- ------------------------------------------
--   unpaid    nothing has been received          remaining = the whole total
--   partial   the amount the operator typed     remaining = total - received
--   paid      the whole total has been received remaining = 0
--
-- The amount is derived from the status, not trusted from the caller: a
-- partly paid bill is refused without an amount, and refused again if the
-- amount is the whole bill (that is a paid bill, and the status should say so).
--
-- Existing bills
-- --------------
-- A bill already marked paid has, by definition, received its whole total, so
-- the backfill gives it that amount and its remaining becomes zero. A bill
-- marked unpaid receives nothing. A bill marked partly paid keeps its status -
-- it is a fact somebody recorded - and starts with nothing received, because
-- nobody ever wrote down the amount; the form asks for it the next time the
-- bill is opened.
--
-- A bill with no total cannot be partly paid, so it becomes unpaid.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. The amount received
-- ---------------------------------------------------------------------------

alter table public.bills add column if not exists paid_amount numeric(14, 2) not null default 0;

comment on column public.bills.paid_amount is
  'What has been received against this bill so far. Zero on an unpaid bill.';

-- A bill with nothing on it cannot be partly paid.
update public.bills set payment_status = 'unpaid' where payment_status = 'partial' and grand_total <= 0;

-- A bill marked paid has received its whole total.
update public.bills set paid_amount = grand_total where payment_status = 'paid';

alter table public.bills drop constraint if exists bills_paid_amount_check;
alter table public.bills add constraint bills_paid_amount_check
  check (paid_amount >= 0);

-- The status and the amount have to agree. A paid bill has received its whole
-- total; an unpaid bill has received nothing; a partly paid bill has received
-- some of it and not all of it.
--
-- The partly paid case allows zero, because a bill that was marked partly paid
-- before this migration carries no amount at all. The function that writes
-- bills refuses a new partly paid bill without an amount; this constraint only
-- has to hold the line for the rows that already exist.
alter table public.bills drop constraint if exists bills_payment_amount_check;
alter table public.bills add constraint bills_payment_amount_check
  check (
    (payment_status = 'unpaid' and paid_amount = 0)
    or (payment_status = 'paid' and paid_amount = grand_total)
    or (payment_status = 'partial' and paid_amount >= 0 and paid_amount < grand_total)
  );

-- ---------------------------------------------------------------------------
-- 2. What is still owed
-- ---------------------------------------------------------------------------
--
-- A generated column, so it cannot be written and cannot drift: it is the
-- total less the received, every time it is read.

alter table public.bills add column if not exists remaining_amount numeric(14, 2)
  generated always as (grand_total - paid_amount) stored;

comment on column public.bills.remaining_amount is
  'What is still owed on this bill: the total less what has been received.';

create or replace function app_private.upsert_bill(
  p_bill_id uuid,
  p_payload jsonb,
  p_allow_duplicate boolean,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_is_create boolean := (p_bill_id is null);
  v_existing public.bills;
  v_customer public.customers;
  v_product public.products;
  v_org uuid;
  v_bill_id uuid;
  v_customer_id uuid;
  v_customer_name text;
  v_customer_gstin text;
  v_bill_number text;
  v_norm text;
  v_bill_date date;
  v_place text;
  v_tax_mode text;
  v_payment_status text;
  v_payment_date date;
  v_payment_method text;
  v_amount_received numeric;
  v_paid_amount numeric := 0;
  v_notes text;
  v_source_type text;
  v_verification text;
  v_verified_by uuid;
  v_verified_at timestamptz;
  v_import_batch_id uuid;
  v_ocr_job_id uuid;
  v_payload_org uuid;
  v_rewrite boolean;
  v_items_in jsonb;
  v_items_from_existing boolean := false;
  v_elem jsonb;
  v_ord integer;
  v_prefix text;
  v_lines jsonb := '[]'::jsonb;
  v_product_id uuid;
  v_product_name text;
  v_product_code text;
  v_hsn text;
  v_desc text;
  v_unit text;
  v_qty numeric;
  v_rate numeric;
  v_discount numeric;
  v_gst numeric;
  v_cess_rate_in numeric;
  v_cess_amount_in numeric;
  v_cess_rate numeric;
  v_cess numeric;
  v_gross numeric;
  v_taxable numeric;
  v_cgst numeric;
  v_sgst numeric;
  v_igst numeric;
  v_tax numeric;
  v_subtotal numeric := 0;
  v_discount_total numeric := 0;
  v_taxable_total numeric := 0;
  v_cgst_total numeric := 0;
  v_sgst_total numeric := 0;
  v_igst_total numeric := 0;
  v_tax_total numeric := 0;
  v_cess_total numeric := 0;
  v_grand_total numeric := 0;
  v_check_dups boolean;
  v_dups jsonb := '[]'::jsonb;
  v_attach jsonb := '[]'::jsonb;
  v_att jsonb;
  v_att_path text;
  v_att_name text;
  v_att_mime text;
  v_att_size numeric;
  v_has_obj boolean;
  v_obj_content_type text;
  v_obj_size_bytes bigint;
  v_result jsonb;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    perform app_private.raise_validation('payload', 'must be a JSON object');
  end if;
  p_allow_duplicate := coalesce(p_allow_duplicate, false);

  if p_payload ? 'cess_amount' or p_payload ? 'cess_rate' then
    perform app_private.raise_validation(
      case when p_payload ? 'cess_amount' then 'cess_amount' else 'cess_rate' end,
      'is not accepted at bill level; send cess_rate or cess_amount on each item'
    );
  end if;

  v_payload_org := app_private.parse_uuid(p_payload -> 'organization_id', 'organization_id', false);

  if not v_is_create then
    select b.organization_id into v_org from public.bills b where b.id = p_bill_id;
    if v_org is null or not app_private.is_org_member(v_org) then
      perform app_private.raise_error('PT404', 'NOT_FOUND', 'bill not found', jsonb_build_object('bill_id', p_bill_id));
    end if;
    if not app_private.can_write(v_org) then
      perform app_private.raise_error('PT403', 'FORBIDDEN', 'your role cannot modify bills');
    end if;
    select * into v_existing from public.bills b where b.id = p_bill_id for update;
    if v_existing.deleted_at is not null then
      perform app_private.raise_error('PT404', 'NOT_FOUND', 'bill not found', jsonb_build_object('bill_id', p_bill_id));
    end if;
    if p_expected_version is not null and v_existing.version <> p_expected_version then
      perform app_private.raise_error(
        'PT409', 'VERSION_CONFLICT', 'bill was modified by someone else',
        jsonb_build_object('bill_id', p_bill_id, 'expected_version', p_expected_version, 'current_version', v_existing.version),
        'Reload the bill and retry'
      );
    end if;
    if v_payload_org is not null and v_payload_org <> v_org then
      perform app_private.raise_validation('organization_id', 'does not match the bill organization');
    end if;
  end if;

  if v_is_create or p_payload ? 'customer_id' then
    v_customer_id := app_private.parse_uuid(p_payload -> 'customer_id', 'customer_id', true);
  else
    v_customer_id := v_existing.customer_id;
  end if;

  select * into v_customer from public.customers c where c.id = v_customer_id;
  if v_customer.id is null
    or not app_private.is_org_member(v_customer.organization_id)
    or (not v_is_create and v_customer.organization_id <> v_org)
    or (v_payload_org is not null and v_customer.organization_id <> v_payload_org)
  then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'customer not found', jsonb_build_object('customer_id', v_customer_id));
  end if;
  if v_is_create then
    v_org := v_customer.organization_id;
    if not app_private.can_write(v_org) then
      perform app_private.raise_error('PT403', 'FORBIDDEN', 'your role cannot create bills');
    end if;
  end if;
  if v_is_create or v_customer_id is distinct from v_existing.customer_id then
    if v_customer.deleted_at is not null then
      perform app_private.raise_validation('customer_id', 'refers to a deleted customer');
    end if;
    v_customer_name := v_customer.name;
    v_customer_gstin := v_customer.gstin;
  else
    v_customer_name := v_existing.customer_name;
    v_customer_gstin := v_existing.customer_gstin;
  end if;

  if v_is_create or p_payload ? 'bill_number' then
    v_bill_number := app_private.parse_text(p_payload -> 'bill_number', 'bill_number', true, 64);
  else
    v_bill_number := v_existing.bill_number;
  end if;
  v_norm := lower(btrim(v_bill_number));

  if v_is_create or p_payload ? 'bill_date' then
    v_bill_date := app_private.parse_date(p_payload -> 'bill_date', 'bill_date', true);
  else
    v_bill_date := v_existing.bill_date;
  end if;

  if v_is_create or p_payload ? 'place_of_supply' then
    v_place := app_private.parse_text(p_payload -> 'place_of_supply', 'place_of_supply', false, 100);
  else
    v_place := v_existing.place_of_supply;
  end if;

  if v_is_create or p_payload ? 'tax_mode' then
    v_tax_mode := app_private.parse_enum(p_payload -> 'tax_mode', 'tax_mode', array['intra', 'inter'],
      case when v_is_create then 'intra' else v_existing.tax_mode end);
  else
    v_tax_mode := v_existing.tax_mode;
  end if;

  if v_is_create or p_payload ? 'payment_status' then
    v_payment_status := app_private.parse_enum(p_payload -> 'payment_status', 'payment_status', array['unpaid', 'partial', 'paid'],
      case when v_is_create then 'unpaid' else v_existing.payment_status end);
  else
    v_payment_status := v_existing.payment_status;
  end if;

  if p_payload ? 'payment_date' then
    v_payment_date := app_private.parse_date(p_payload -> 'payment_date', 'payment_date', false);
  elsif not v_is_create then
    v_payment_date := v_existing.payment_date;
  end if;

  if p_payload ? 'payment_method' then
    v_payment_method := app_private.parse_enum(p_payload -> 'payment_method', 'payment_method',
      array['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other'], null);
  elsif not v_is_create then
    v_payment_method := v_existing.payment_method;
  end if;

  -- What the operator says has been received against this bill.
  --
  -- It is checked against the total once the money is worked out, because a
  -- partly paid bill is about the whole bill and not about one line of it.
  if p_payload ? 'amount_received' and jsonb_typeof(p_payload -> 'amount_received') <> 'null' then
    v_amount_received := app_private.parse_numeric(p_payload -> 'amount_received', 'amount_received', true, 2, 0, 999999999.99);
  end if;

  if v_payment_status = 'unpaid' then
    if v_payment_date is not null and p_payload ? 'payment_date' then
      perform app_private.raise_validation('payment_date', 'must be empty when payment_status is unpaid');
    end if;
    if v_payment_method is not null and p_payload ? 'payment_method' then
      perform app_private.raise_validation('payment_method', 'must be empty when payment_status is unpaid');
    end if;
    if v_amount_received is not null then
      perform app_private.raise_validation('amount_received', 'must be empty when payment_status is unpaid');
    end if;
    v_payment_date := null;
    v_payment_method := null;
  end if;
  if v_payment_date is not null and v_payment_date < v_bill_date then
    perform app_private.raise_validation('payment_date', 'cannot be before bill_date');
  end if;

  if v_is_create or p_payload ? 'notes' then
    v_notes := app_private.parse_text(p_payload -> 'notes', 'notes', false, 5000);
  else
    v_notes := v_existing.notes;
  end if;

  if v_is_create or p_payload ? 'source_type' then
    v_source_type := app_private.parse_enum(p_payload -> 'source_type', 'source_type', array['manual', 'ocr', 'import'],
      case when v_is_create then 'manual' else v_existing.source_type end);
  else
    v_source_type := v_existing.source_type;
  end if;

  if p_payload ? 'verification_status' and jsonb_typeof(p_payload -> 'verification_status') <> 'null' then
    v_verification := app_private.parse_enum(p_payload -> 'verification_status', 'verification_status',
      array['unverified', 'needs_review', 'verified', 'rejected'], null);
  elsif v_is_create then
    v_verification := case when v_source_type = 'manual' then 'verified' else 'needs_review' end;
  else
    v_verification := v_existing.verification_status;
  end if;
  if v_verification = 'verified' then
    if v_is_create or v_existing.verification_status <> 'verified' then
      v_verified_by := v_uid;
      v_verified_at := now();
    else
      v_verified_by := v_existing.verified_by;
      v_verified_at := v_existing.verified_at;
    end if;
  end if;

  if p_payload ? 'import_batch_id' then
    v_import_batch_id := app_private.parse_uuid(p_payload -> 'import_batch_id', 'import_batch_id', false);
    if v_import_batch_id is not null and not exists (
      select 1 from public.import_batches ib
      where ib.id = v_import_batch_id and ib.organization_id = v_org and ib.deleted_at is null
    ) then
      perform app_private.raise_validation('import_batch_id', 'does not exist in this organization');
    end if;
  elsif not v_is_create then
    v_import_batch_id := v_existing.import_batch_id;
  end if;

  v_ocr_job_id := app_private.parse_uuid(p_payload -> 'ocr_job_id', 'ocr_job_id', false);
  if v_ocr_job_id is not null and not exists (
    select 1 from public.ocr_jobs oj
    where oj.id = v_ocr_job_id and oj.organization_id = v_org and oj.deleted_at is null
  ) then
    perform app_private.raise_validation('ocr_job_id', 'does not exist in this organization');
  end if;

  v_rewrite := v_is_create or p_payload ? 'items' or v_tax_mode is distinct from v_existing.tax_mode;

  if v_rewrite then
    if p_payload ? 'items' then
      v_items_in := p_payload -> 'items';
    elsif v_is_create then
      v_items_in := null;
    else
      v_items_from_existing := true;
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'product_id', i.product_id,
          'product_name', i.product_name,
          'product_code', i.product_code,
          'hsn_code', i.hsn_code,
          'description', i.description,
          'unit', i.unit,
          'quantity', i.quantity,
          'rate', i.rate,
          'discount', i.discount,
          'gst_rate', i.gst_rate
        ) || case
          when i.cess_rate > 0 then jsonb_build_object('cess_rate', i.cess_rate)
          else jsonb_build_object('cess_amount', i.cess_amount)
        end
        order by i.line_no
      ), '[]'::jsonb)
      into v_items_in
      from public.bill_items i
      where i.bill_id = p_bill_id;
    end if;

    if v_items_in is null or jsonb_typeof(v_items_in) <> 'array' then
      perform app_private.raise_validation('items', 'must be an array');
    end if;
    if jsonb_array_length(v_items_in) < 1 then
      perform app_private.raise_validation('items', 'must contain at least one item');
    end if;
    if jsonb_array_length(v_items_in) > 200 then
      perform app_private.raise_validation('items', 'must contain at most 200 items');
    end if;

    for v_elem, v_ord in
      select e.value, e.ordinality::integer from jsonb_array_elements(v_items_in) with ordinality as e(value, ordinality)
    loop
      v_prefix := format('items[%s].', v_ord - 1);
      if jsonb_typeof(v_elem) <> 'object' then
        perform app_private.raise_validation(trim(trailing '.' from v_prefix), 'must be an object');
      end if;

      v_product := null;
      v_product_id := app_private.parse_uuid(v_elem -> 'product_id', v_prefix || 'product_id', false);
      if v_product_id is not null then
        select * into v_product from public.products p
        where p.id = v_product_id and p.organization_id = v_org;
        if v_product.id is null or (v_product.deleted_at is not null and not v_items_from_existing) then
          perform app_private.raise_validation(v_prefix || 'product_id', 'does not exist in this organization');
        end if;
      end if;

      v_product_name := coalesce(
        app_private.parse_text(v_elem -> 'product_name', v_prefix || 'product_name', false, 200),
        v_product.name
      );
      if v_product_name is null then
        perform app_private.raise_validation(v_prefix || 'product_name', 'is required when product_id is not given');
      end if;

      v_product_code := coalesce(
        app_private.parse_text(v_elem -> 'product_code', v_prefix || 'product_code', false, 64),
        v_product.product_code
      );
      v_hsn := coalesce(
        app_private.parse_text(v_elem -> 'hsn_code', v_prefix || 'hsn_code', false, 8),
        v_product.hsn_code
      );
      if v_hsn is not null and v_hsn !~ '^[0-9]{2,8}$' then
        perform app_private.raise_validation(v_prefix || 'hsn_code', 'must be 2 to 8 digits');
      end if;
      v_desc := coalesce(
        app_private.parse_text(v_elem -> 'description', v_prefix || 'description', false, 500),
        v_product.description
      );
      v_unit := coalesce(
        app_private.parse_text(v_elem -> 'unit', v_prefix || 'unit', false, 32),
        v_product.unit,
        'NOS'
      );

      v_qty := app_private.parse_numeric(v_elem -> 'quantity', v_prefix || 'quantity', true, 3, 0.001, 99999999);
      v_rate := coalesce(
        app_private.parse_numeric(v_elem -> 'rate', v_prefix || 'rate', false, 4, 0, 999999999.9999),
        v_product.default_rate
      );
      if v_rate is null then
        perform app_private.raise_validation(v_prefix || 'rate', 'is required when product_id is not given');
      end if;
      v_discount := coalesce(
        app_private.parse_numeric(v_elem -> 'discount', v_prefix || 'discount', false, 2, 0, 999999999.99),
        0
      );
      v_gst := coalesce(
        app_private.parse_numeric(v_elem -> 'gst_rate', v_prefix || 'gst_rate', false, 2, 0, 100),
        v_product.gst_rate,
        0
      );
      v_cess_rate_in := app_private.parse_numeric(v_elem -> 'cess_rate', v_prefix || 'cess_rate', false, 2, 0, 1000);
      v_cess_amount_in := app_private.parse_numeric(v_elem -> 'cess_amount', v_prefix || 'cess_amount', false, 2, 0, 999999999.99);
      if coalesce(v_cess_rate_in, 0) > 0 and coalesce(v_cess_amount_in, 0) > 0 then
        perform app_private.raise_validation(v_prefix || 'cess_amount', 'cannot be combined with cess_rate; send only one');
      end if;

      v_gross := round(v_qty * v_rate, 2);
      if v_gross > 999999999.99 then
        perform app_private.raise_validation(v_prefix || 'quantity', 'quantity times rate exceeds the maximum line amount');
      end if;
      if v_discount > v_gross then
        perform app_private.raise_validation(v_prefix || 'discount', 'cannot exceed quantity times rate');
      end if;
      v_taxable := v_gross - v_discount;
      if v_tax_mode = 'intra' then
        v_cgst := round(v_taxable * v_gst / 200, 2);
        v_sgst := v_cgst;
        v_igst := 0;
      else
        v_cgst := 0;
        v_sgst := 0;
        v_igst := round(v_taxable * v_gst / 100, 2);
      end if;
      v_tax := v_cgst + v_sgst + v_igst;

      if coalesce(v_cess_amount_in, 0) > 0 then
        v_cess_rate := 0;
        v_cess := v_cess_amount_in;
      else
        v_cess_rate := coalesce(v_cess_rate_in, 0);
        v_cess := round(v_taxable * v_cess_rate / 100, 2);
      end if;

      v_subtotal := v_subtotal + v_gross;
      v_discount_total := v_discount_total + v_discount;
      v_taxable_total := v_taxable_total + v_taxable;
      v_cgst_total := v_cgst_total + v_cgst;
      v_sgst_total := v_sgst_total + v_sgst;
      v_igst_total := v_igst_total + v_igst;
      v_cess_total := v_cess_total + v_cess;

      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'line_no', v_ord,
        'product_id', v_product_id,
        'product_name', v_product_name,
        'product_code', v_product_code,
        'hsn_code', v_hsn,
        'description', v_desc,
        'unit', v_unit,
        'quantity', v_qty,
        'rate', v_rate,
        'discount', v_discount,
        'gst_rate', v_gst,
        'cess_rate', v_cess_rate,
        'line_subtotal', v_gross,
        'taxable_amount', v_taxable,
        'cgst_amount', v_cgst,
        'sgst_amount', v_sgst,
        'igst_amount', v_igst,
        'tax_amount', v_tax,
        'cess_amount', v_cess,
        'line_total', v_taxable + v_tax + v_cess
      ));
    end loop;

    v_tax_total := v_cgst_total + v_sgst_total + v_igst_total;
    v_grand_total := v_taxable_total + v_tax_total + v_cess_total;
  else
    v_subtotal := v_existing.subtotal;
    v_discount_total := v_existing.discount_total;
    v_taxable_total := v_existing.taxable_amount;
    v_cgst_total := v_existing.cgst_amount;
    v_sgst_total := v_existing.sgst_amount;
    v_igst_total := v_existing.igst_amount;
    v_tax_total := v_existing.tax_total;
    v_cess_total := v_existing.cess_amount;
    v_grand_total := v_existing.grand_total;
  end if;

  -- What has been received against the bill.
  --
  -- The amount is derived from the payment status rather than taken on trust:
  -- an unpaid bill has received nothing, a paid bill has received everything,
  -- and a partly paid bill has received what the operator typed. The figure
  -- left over is the database's own (bills.remaining_amount), so the list, the
  -- reports and the invoice all read the same number.
  if v_payment_status = 'unpaid' then
    v_paid_amount := 0;
  elsif v_payment_status = 'paid' then
    v_paid_amount := v_grand_total;
  else
    if v_amount_received is null then
      if not v_is_create and v_existing.payment_status = 'partial' and v_existing.paid_amount > 0 then
        -- An edit that does not touch the money keeps the amount that was
        -- already recorded against the bill. A bill that was marked partly
        -- paid before this migration carries no amount at all, and asking for
        -- it is the whole point of the field.
        v_paid_amount := v_existing.paid_amount;
      else
        perform app_private.raise_validation(
          'amount_received',
          'is required when the payment status is partial: type how much has been received'
        );
      end if;
    else
      v_paid_amount := v_amount_received;
    end if;
    if v_paid_amount <= 0 then
      perform app_private.raise_validation(
        'amount_received',
        'must be more than zero when the payment status is partial'
      );
    end if;
    if v_paid_amount >= v_grand_total then
      perform app_private.raise_validation(
        'amount_received',
        format(
          'is %s, which is not less than the bill (%s). Set the payment status to paid instead',
          v_paid_amount, v_grand_total
        )
      );
    end if;
  end if;

  v_check_dups := v_is_create
    or v_norm is distinct from v_existing.bill_number_normalized
    or v_customer_id is distinct from v_existing.customer_id
    or v_bill_date is distinct from v_existing.bill_date
    or v_grand_total is distinct from v_existing.grand_total;

  if v_check_dups then
    perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || v_norm, 0));
    select coalesce(jsonb_agg(d.row_json order by d.created_at desc), '[]'::jsonb)
    into v_dups
    from (
      select
        b.created_at,
        jsonb_build_object(
          'bill_id', b.id,
          'bill_number', b.bill_number,
          'bill_date', b.bill_date,
          'customer_id', b.customer_id,
          'grand_total', b.grand_total,
          'reason', case when b.bill_number_normalized = v_norm then 'same_bill_number' else 'same_customer_date_total' end
        ) as row_json
      from public.bills b
      where b.organization_id = v_org
        and b.deleted_at is null
        and (v_is_create or b.id <> p_bill_id)
        and (
          b.bill_number_normalized = v_norm
          or (b.customer_id = v_customer_id and b.bill_date = v_bill_date and b.grand_total = v_grand_total)
        )
      order by b.created_at desc
      limit 5
    ) d;
    if jsonb_array_length(v_dups) > 0 and not p_allow_duplicate then
      perform app_private.raise_error(
        'PT409', 'DUPLICATE_BILL', 'a likely duplicate of this bill already exists',
        jsonb_build_object('duplicates', v_dups),
        'Retry with allow_duplicate = true to save anyway'
      );
    end if;
  end if;

  if p_payload ? 'attachments' and jsonb_typeof(p_payload -> 'attachments') not in ('array', 'null') then
    perform app_private.raise_validation('attachments', 'must be an array');
  end if;
  if p_payload ? 'attachments' and jsonb_typeof(p_payload -> 'attachments') = 'array' then
    v_attach := p_payload -> 'attachments';
  end if;
  if p_payload ? 'attachment_path' and jsonb_typeof(p_payload -> 'attachment_path') <> 'null' then
    v_attach := v_attach || jsonb_build_array(jsonb_build_object('file_path', p_payload -> 'attachment_path'));
  end if;
  if jsonb_array_length(v_attach) > 10 then
    perform app_private.raise_validation('attachments', 'must contain at most 10 entries');
  end if;

  if v_is_create then
    insert into public.bills (
      organization_id, customer_id, customer_name, customer_gstin, bill_number, bill_date, place_of_supply,
      tax_mode, payment_status, payment_date, payment_method, notes, source_type, verification_status,
      verified_by, verified_at, import_batch_id, subtotal, discount_total, taxable_amount, cgst_amount,
      sgst_amount, igst_amount, tax_total, cess_amount, grand_total, paid_amount, created_by, updated_by
    )
    values (
      v_org, v_customer_id, v_customer_name, v_customer_gstin, v_bill_number, v_bill_date, v_place,
      v_tax_mode, v_payment_status, v_payment_date, v_payment_method, v_notes, v_source_type, v_verification,
      v_verified_by, v_verified_at, v_import_batch_id, v_subtotal, v_discount_total, v_taxable_total, v_cgst_total,
      v_sgst_total, v_igst_total, v_tax_total, v_cess_total, v_grand_total, v_paid_amount, v_uid, v_uid
    )
    returning id into v_bill_id;
  else
    v_bill_id := p_bill_id;
    update public.bills b
    set customer_id = v_customer_id,
        customer_name = v_customer_name,
        customer_gstin = v_customer_gstin,
        bill_number = v_bill_number,
        bill_date = v_bill_date,
        place_of_supply = v_place,
        tax_mode = v_tax_mode,
        payment_status = v_payment_status,
        payment_date = v_payment_date,
        payment_method = v_payment_method,
        notes = v_notes,
        source_type = v_source_type,
        verification_status = v_verification,
        verified_by = v_verified_by,
        verified_at = v_verified_at,
        import_batch_id = v_import_batch_id,
        subtotal = v_subtotal,
        discount_total = v_discount_total,
        taxable_amount = v_taxable_total,
        cgst_amount = v_cgst_total,
        sgst_amount = v_sgst_total,
        igst_amount = v_igst_total,
        tax_total = v_tax_total,
        cess_amount = v_cess_total,
        grand_total = v_grand_total,
        paid_amount = v_paid_amount,
        version = b.version + 1,
        updated_by = v_uid
    where b.id = p_bill_id;
    if v_rewrite then
      delete from public.bill_items i where i.bill_id = p_bill_id;
    end if;
  end if;

  if v_rewrite then
    insert into public.bill_items (
      organization_id, bill_id, line_no, product_id, product_name, product_code, hsn_code, description, unit,
      quantity, rate, discount, gst_rate, cess_rate, line_subtotal, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, cess_amount, line_total
    )
    select
      v_org, v_bill_id, x.line_no, x.product_id, x.product_name, x.product_code, x.hsn_code, x.description, x.unit,
      x.quantity, x.rate, x.discount, x.gst_rate, x.cess_rate, x.line_subtotal, x.taxable_amount, x.cgst_amount, x.sgst_amount,
      x.igst_amount, x.tax_amount, x.cess_amount, x.line_total
    from jsonb_to_recordset(v_lines) as x(
      line_no integer, product_id uuid, product_name text, product_code text, hsn_code text, description text,
      unit text, quantity numeric, rate numeric, discount numeric, gst_rate numeric, cess_rate numeric,
      line_subtotal numeric, taxable_amount numeric, cgst_amount numeric, sgst_amount numeric, igst_amount numeric,
      tax_amount numeric, cess_amount numeric, line_total numeric
    )
    order by x.line_no;
  end if;

  for v_att, v_ord in
    select e.value, e.ordinality::integer from jsonb_array_elements(v_attach) with ordinality as e(value, ordinality)
  loop
    v_prefix := format('attachments[%s].', v_ord - 1);
    if jsonb_typeof(v_att) <> 'object' then
      perform app_private.raise_validation(trim(trailing '.' from v_prefix), 'must be an object');
    end if;
    v_att_path := app_private.parse_text(v_att -> 'file_path', v_prefix || 'file_path', true, 512);
    if not starts_with(v_att_path, v_org::text || '/') or v_att_path ~ '(^|/)\.\.(/|$)' then
      perform app_private.raise_validation(v_prefix || 'file_path', 'must start with the organization id folder');
    end if;

    select true, so.content_type, so.size_bytes
    into v_has_obj, v_obj_content_type, v_obj_size_bytes
    from public.storage_objects so
    where so.organization_id = v_org and so.object_path = v_att_path;
    if v_has_obj is not true then
      perform app_private.raise_validation(v_prefix || 'file_path', 'was not found in the bill-attachments bucket');
    end if;

    v_att_name := coalesce(
      app_private.parse_text(v_att -> 'file_name', v_prefix || 'file_name', false, 255),
      nullif(regexp_replace(v_att_path, '^.*/', ''), '')
    );
    v_att_mime := coalesce(
      app_private.parse_text(v_att -> 'mime_type', v_prefix || 'mime_type', false, 127),
      v_obj_content_type
    );
    v_att_size := coalesce(
      app_private.parse_numeric(v_att -> 'size_bytes', v_prefix || 'size_bytes', false, 0, 0, 9007199254740991),
      v_obj_size_bytes::numeric
    );

    if exists (
      select 1 from public.bill_attachments a
      where a.organization_id = v_org and a.file_path = v_att_path and a.deleted_at is null and a.bill_id <> v_bill_id
    ) then
      perform app_private.raise_validation(v_prefix || 'file_path', 'is already attached to another bill');
    end if;

    insert into public.bill_attachments (organization_id, bill_id, file_path, file_name, mime_type, size_bytes, created_by)
    values (v_org, v_bill_id, v_att_path, v_att_name, v_att_mime, v_att_size::bigint, v_uid)
    on conflict (organization_id, file_path) where deleted_at is null do nothing;
  end loop;

  if v_ocr_job_id is not null then
    update public.ocr_jobs oj
    set bill_id = v_bill_id,
        status = 'imported',
        completed_at = coalesce(oj.completed_at, now())
    where oj.id = v_ocr_job_id and oj.organization_id = v_org;
  end if;

  insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, metadata)
  values (
    v_org,
    v_uid,
    case when v_is_create then 'RPC_SAVE_BILL' else 'RPC_UPDATE_BILL' end,
    'bills',
    v_bill_id,
    jsonb_build_object(
      'allow_duplicate', p_allow_duplicate,
      'duplicates_overridden', v_dups,
      'item_count', case when v_rewrite then jsonb_array_length(v_lines) else null end,
      'items_rewritten', v_rewrite,
      'grand_total', v_grand_total,
      'paid_amount', v_paid_amount,
      'remaining_amount', v_grand_total - v_paid_amount,
      'cess_amount', v_cess_total,
      'ocr_job_id', v_ocr_job_id
    )
  );

  v_result := app_private.bill_json(v_bill_id);
  return v_result || jsonb_build_object('duplicate_warnings', v_dups);
end;
$$;


-- ---------------------------------------------------------------------------
-- 3. The reports read what is owed, not the whole bill
-- ---------------------------------------------------------------------------
--
-- The outstanding figures counted the whole of every bill that was not paid, so
-- a bill with most of it received was counted as though nothing had been
-- received. The remaining is the figure they were after.

create or replace function public.report_summary(org_id uuid, start_date date, end_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;
  if not exists (
    select 1
    from public.memberships m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.role in ('admin', 'staff', 'viewer')
      and o.deleted_at is null
  ) then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'organization not found');
  end if;
  if start_date is null or end_date is null or start_date > end_date then
    perform app_private.raise_validation('date_range', 'requires a start_date on or before end_date');
  end if;

  select jsonb_build_object(
    'taxable', coalesce(sum(b.taxable_amount), 0),
    'cgst', coalesce(sum(b.cgst_amount), 0),
    'sgst', coalesce(sum(b.sgst_amount), 0),
    'igst', coalesce(sum(b.igst_amount), 0),
    'total_gst', coalesce(sum(b.tax_total), 0),
    'cess', coalesce(sum(b.cess_amount), 0),
    'sales', coalesce(sum(b.grand_total), 0),
    'bills', count(*),
    'pending', coalesce(sum(b.remaining_amount), 0)
  ) into v_result
  from public.bills b
  where b.organization_id = org_id
    and b.bill_date >= start_date
    and b.bill_date <= end_date
    and b.deleted_at is null;

  return v_result;
end;
$$;

create or replace function public.dashboard_summary(org_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_fy_start date := make_date(
    extract(year from current_date)::integer - case when extract(month from current_date) < 4 then 1 else 0 end,
    4,
    1
  );
  v_month_start date := date_trunc('month', current_date)::date;
  v_result jsonb;
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;
  if not exists (
    select 1
    from public.memberships m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.role in ('admin', 'staff', 'viewer')
      and o.deleted_at is null
  ) then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'organization not found');
  end if;

  select jsonb_build_object(
    'total_customers', (
      select count(*)
      from public.customers c
      where c.organization_id = org_id and c.deleted_at is null
    ),
    'total_bills', count(*),
    'total_sales', coalesce(sum(b.grand_total), 0),
    'current_fy_sales', coalesce(sum(b.grand_total) filter (
      where b.bill_date >= v_fy_start and b.bill_date < (v_fy_start + interval '1 year')::date
    ), 0),
    'pending_amount', coalesce(sum(b.remaining_amount), 0),
    'bills_this_month', count(*) filter (
      where b.bill_date >= v_month_start and b.bill_date < (v_month_start + interval '1 month')::date
    )
  ) into v_result
  from public.bills b
  where b.organization_id = org_id and b.deleted_at is null;

  return v_result;
end;
$$;

commit;
