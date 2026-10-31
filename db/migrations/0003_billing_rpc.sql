create function app_private.raise_error(
  p_sqlstate text,
  p_code text,
  p_message text,
  p_detail jsonb default '{}'::jsonb,
  p_hint text default null
)
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using
    errcode = p_sqlstate,
    message = p_code || ': ' || p_message,
    detail = (jsonb_build_object('code', p_code) || coalesce(p_detail, '{}'::jsonb))::text,
    hint = coalesce(p_hint, 'See DETAIL for the machine-readable error');
end;
$$;

create function app_private.raise_validation(p_field text, p_reason text)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  perform app_private.raise_error(
    '22023',
    'VALIDATION_ERROR',
    p_field || ' ' || p_reason,
    jsonb_build_object('field', p_field, 'reason', p_reason)
  );
end;
$$;

create function app_private.parse_text(p_value jsonb, p_field text, p_required boolean, p_max_len integer)
returns text
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_text text;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    v_text := null;
  elsif jsonb_typeof(p_value) in ('string', 'number') then
    v_text := nullif(btrim(p_value #>> '{}'), '');
  else
    perform app_private.raise_validation(p_field, 'must be a string');
  end if;
  if v_text is null then
    if p_required then
      perform app_private.raise_validation(p_field, 'is required');
    end if;
    return null;
  end if;
  if char_length(v_text) > p_max_len then
    perform app_private.raise_validation(p_field, format('must be at most %s characters', p_max_len));
  end if;
  return v_text;
end;
$$;

create function app_private.parse_numeric(
  p_value jsonb,
  p_field text,
  p_required boolean,
  p_scale integer,
  p_min numeric,
  p_max numeric
)
returns numeric
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_num numeric;
  v_text text;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    v_num := null;
  elsif jsonb_typeof(p_value) = 'number' then
    v_num := (p_value #>> '{}')::numeric;
  elsif jsonb_typeof(p_value) = 'string' then
    v_text := btrim(p_value #>> '{}');
    if v_text !~ '^-?[0-9]{1,15}(\.[0-9]{1,6})?$' then
      perform app_private.raise_validation(p_field, 'must be a plain decimal number');
    end if;
    v_num := v_text::numeric;
  else
    perform app_private.raise_validation(p_field, 'must be a number');
  end if;
  if v_num is null then
    if p_required then
      perform app_private.raise_validation(p_field, 'is required');
    end if;
    return null;
  end if;
  if v_num <> round(v_num, p_scale) then
    perform app_private.raise_validation(p_field, format('must have at most %s decimal places', p_scale));
  end if;
  if p_min is not null and v_num < p_min then
    perform app_private.raise_validation(p_field, format('must be at least %s', p_min));
  end if;
  if p_max is not null and v_num > p_max then
    perform app_private.raise_validation(p_field, format('must be at most %s', p_max));
  end if;
  return v_num;
end;
$$;

create function app_private.parse_uuid(p_value jsonb, p_field text, p_required boolean)
returns uuid
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_text text;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    v_text := null;
  elsif jsonb_typeof(p_value) = 'string' then
    v_text := lower(btrim(p_value #>> '{}'));
  else
    perform app_private.raise_validation(p_field, 'must be a uuid string');
  end if;
  if v_text is null or v_text = '' then
    if p_required then
      perform app_private.raise_validation(p_field, 'is required');
    end if;
    return null;
  end if;
  if v_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform app_private.raise_validation(p_field, 'must be a valid uuid');
  end if;
  return v_text::uuid;
end;
$$;

create function app_private.parse_date(p_value jsonb, p_field text, p_required boolean)
returns date
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_text text;
  v_date date;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    v_text := null;
  elsif jsonb_typeof(p_value) = 'string' then
    v_text := btrim(p_value #>> '{}');
  else
    perform app_private.raise_validation(p_field, 'must be a YYYY-MM-DD string');
  end if;
  if v_text is null or v_text = '' then
    if p_required then
      perform app_private.raise_validation(p_field, 'is required');
    end if;
    return null;
  end if;
  if v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    perform app_private.raise_validation(p_field, 'must be a YYYY-MM-DD string');
  end if;
  begin
    v_date := v_text::date;
  exception when others then
    perform app_private.raise_validation(p_field, 'is not a valid calendar date');
  end;
  if v_date < date '2000-01-01' or v_date > date '2100-12-31' then
    perform app_private.raise_validation(p_field, 'must be between 2000-01-01 and 2100-12-31');
  end if;
  return v_date;
end;
$$;

create function app_private.parse_enum(
  p_value jsonb,
  p_field text,
  p_allowed text[],
  p_default text
)
returns text
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_text text;
begin
  v_text := lower(app_private.parse_text(p_value, p_field, false, 64));
  if v_text is null then
    return p_default;
  end if;
  if not (v_text = any (p_allowed)) then
    perform app_private.raise_validation(p_field, 'must be one of: ' || array_to_string(p_allowed, ', '));
  end if;
  return v_text;
end;
$$;

create function app_private.bill_json(p_bill_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'bill', to_jsonb(b) - 'bill_number_normalized',
    'items', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.line_no)
      from public.bill_items i
      where i.bill_id = b.id
    ), '[]'::jsonb),
    'attachments', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.created_at, a.id)
      from public.bill_attachments a
      where a.bill_id = b.id and a.deleted_at is null
    ), '[]'::jsonb)
  )
  from public.bills b
  where b.id = p_bill_id;
$$;

create function app_private.upsert_bill(
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
      select coalesce(jsonb_agg(jsonb_build_object(
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
      ) order by i.line_no), '[]'::jsonb)
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

      v_subtotal := v_subtotal + v_gross;
      v_discount_total := v_discount_total + v_discount;
      v_taxable_total := v_taxable_total + v_taxable;
      v_cgst_total := v_cgst_total + v_cgst;
      v_sgst_total := v_sgst_total + v_sgst;
      v_igst_total := v_igst_total + v_igst;

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
        'line_subtotal', v_gross,
        'taxable_amount', v_taxable,
        'cgst_amount', v_cgst,
        'sgst_amount', v_sgst,
        'igst_amount', v_igst,
        'tax_amount', v_tax,
        'line_total', v_taxable + v_tax
      ));
    end loop;

    v_tax_total := v_cgst_total + v_sgst_total + v_igst_total;
    v_grand_total := v_taxable_total + v_tax_total;
  else
    v_subtotal := v_existing.subtotal;
    v_discount_total := v_existing.discount_total;
    v_taxable_total := v_existing.taxable_amount;
    v_cgst_total := v_existing.cgst_amount;
    v_sgst_total := v_existing.sgst_amount;
    v_igst_total := v_existing.igst_amount;
    v_tax_total := v_existing.tax_total;
    v_grand_total := v_existing.grand_total;
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
      tax_mode, payment_status, notes, source_type, verification_status, verified_by, verified_at,
      import_batch_id, subtotal, discount_total, taxable_amount, cgst_amount, sgst_amount, igst_amount,
      tax_total, grand_total, created_by, updated_by
    )
    values (
      v_org, v_customer_id, v_customer_name, v_customer_gstin, v_bill_number, v_bill_date, v_place,
      v_tax_mode, v_payment_status, v_notes, v_source_type, v_verification, v_verified_by, v_verified_at,
      v_import_batch_id, v_subtotal, v_discount_total, v_taxable_total, v_cgst_total, v_sgst_total, v_igst_total,
      v_tax_total, v_grand_total, v_uid, v_uid
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
        grand_total = v_grand_total,
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
      quantity, rate, discount, gst_rate, line_subtotal, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total
    )
    select
      v_org, v_bill_id, x.line_no, x.product_id, x.product_name, x.product_code, x.hsn_code, x.description, x.unit,
      x.quantity, x.rate, x.discount, x.gst_rate, x.line_subtotal, x.taxable_amount, x.cgst_amount, x.sgst_amount,
      x.igst_amount, x.tax_amount, x.line_total
    from jsonb_to_recordset(v_lines) as x(
      line_no integer, product_id uuid, product_name text, product_code text, hsn_code text, description text,
      unit text, quantity numeric, rate numeric, discount numeric, gst_rate numeric, line_subtotal numeric,
      taxable_amount numeric, cgst_amount numeric, sgst_amount numeric, igst_amount numeric,
      tax_amount numeric, line_total numeric
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
      'ocr_job_id', v_ocr_job_id
    )
  );

  v_result := app_private.bill_json(v_bill_id);
  return v_result || jsonb_build_object('duplicate_warnings', v_dups);
end;
$$;

create function app_private.soft_delete_state(p_bill_id uuid, p_delete boolean)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_bill public.bills;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;
  select b.organization_id into v_org from public.bills b where b.id = p_bill_id;
  if v_org is null or not app_private.is_org_member(v_org) then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'bill not found', jsonb_build_object('bill_id', p_bill_id));
  end if;
  if not app_private.is_org_admin(v_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'only organization admins can delete or restore bills');
  end if;
  select * into v_bill from public.bills b where b.id = p_bill_id for update;
  if p_delete then
    if v_bill.deleted_at is null then
      update public.bills b
      set deleted_at = now(), deleted_by = v_uid, updated_by = v_uid, version = b.version + 1
      where b.id = p_bill_id;
    end if;
  else
    if v_bill.deleted_at is not null then
      update public.bills b
      set deleted_at = null, deleted_by = null, updated_by = v_uid, version = b.version + 1
      where b.id = p_bill_id;
    end if;
  end if;
  return app_private.bill_json(p_bill_id);
end;
$$;

create function public.save_bill(payload jsonb, allow_duplicate boolean default false)
returns jsonb
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select app_private.upsert_bill(null, payload, coalesce(allow_duplicate, false), null);
$$;

create function public.update_bill(
  target_bill_id uuid,
  payload jsonb,
  allow_duplicate boolean default false,
  expected_version integer default null
)
returns jsonb
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select app_private.upsert_bill(target_bill_id, payload, coalesce(allow_duplicate, false), expected_version);
$$;

create function public.soft_delete_bill(target_bill_id uuid)
returns jsonb
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select app_private.soft_delete_state(target_bill_id, true);
$$;

create function public.restore_bill(target_bill_id uuid)
returns jsonb
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select app_private.soft_delete_state(target_bill_id, false);
$$;

create function public.bootstrap_organization(
  org_name text,
  org_gstin text default null,
  org_state_code text default null,
  user_full_name text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_gstin text;
  v_state text;
  v_full_name text;
  v_existing uuid[];
  v_org public.organizations;
  v_membership public.memberships;
  v_profile public.profiles;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;
  if not exists (select 1 from neon_auth.user u where u.id = v_uid) then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'user does not exist');
  end if;

  v_name := app_private.parse_text(to_jsonb(org_name), 'org_name', true, 120);
  if char_length(v_name) < 2 then
    perform app_private.raise_validation('org_name', 'must be at least 2 characters');
  end if;
  v_gstin := upper(app_private.parse_text(to_jsonb(org_gstin), 'org_gstin', false, 15));
  if v_gstin is not null and v_gstin !~ '^[0-9A-Z]{15}$' then
    perform app_private.raise_validation('org_gstin', 'must be 15 alphanumeric characters');
  end if;
  v_state := app_private.parse_text(to_jsonb(org_state_code), 'org_state_code', false, 2);
  if v_state is not null and v_state !~ '^[0-9]{2}$' then
    perform app_private.raise_validation('org_state_code', 'must be a 2 digit state code');
  end if;
  v_full_name := app_private.parse_text(to_jsonb(user_full_name), 'user_full_name', false, 120);

  perform pg_advisory_xact_lock(hashtextextended('bootstrap:' || v_uid::text, 0));

  select array_agg(m.organization_id order by m.created_at) into v_existing
  from public.memberships m
  where m.user_id = v_uid;
  if v_existing is not null then
    perform app_private.raise_error(
      'PT409', 'ALREADY_BOOTSTRAPPED', 'user already belongs to an organization',
      jsonb_build_object('organization_ids', to_jsonb(v_existing))
    );
  end if;

  insert into public.organizations (name, gstin, state_code, created_by)
  values (v_name, v_gstin, v_state, v_uid)
  returning * into v_org;

  insert into public.memberships (organization_id, user_id, role)
  values (v_org.id, v_uid, 'admin')
  returning * into v_membership;

  insert into public.profiles (id, full_name, default_organization_id)
  values (v_uid, v_full_name, v_org.id)
  on conflict (id) do update
  set default_organization_id = excluded.default_organization_id,
      full_name = coalesce(excluded.full_name, public.profiles.full_name)
  returning * into v_profile;

  return jsonb_build_object(
    'organization', to_jsonb(v_org),
    'membership', to_jsonb(v_membership),
    'profile', to_jsonb(v_profile)
  );
end;
$$;

revoke all on function app_private.raise_error(text, text, text, jsonb, text) from public, anonymous, authenticated;
revoke all on function app_private.raise_validation(text, text) from public, anonymous, authenticated;
revoke all on function app_private.parse_text(jsonb, text, boolean, integer) from public, anonymous, authenticated;
revoke all on function app_private.parse_numeric(jsonb, text, boolean, integer, numeric, numeric) from public, anonymous, authenticated;
revoke all on function app_private.parse_uuid(jsonb, text, boolean) from public, anonymous, authenticated;
revoke all on function app_private.parse_date(jsonb, text, boolean) from public, anonymous, authenticated;
revoke all on function app_private.parse_enum(jsonb, text, text[], text) from public, anonymous, authenticated;
revoke all on function app_private.bill_json(uuid) from public, anonymous, authenticated;
revoke all on function app_private.upsert_bill(uuid, jsonb, boolean, integer) from public, anonymous, authenticated;
revoke all on function app_private.soft_delete_state(uuid, boolean) from public, anonymous, authenticated;

revoke all on function public.save_bill(jsonb, boolean) from public, anonymous;
revoke all on function public.update_bill(uuid, jsonb, boolean, integer) from public, anonymous;
revoke all on function public.soft_delete_bill(uuid) from public, anonymous;
revoke all on function public.restore_bill(uuid) from public, anonymous;
revoke all on function public.bootstrap_organization(text, text, text, text) from public, anonymous;

grant execute on function public.save_bill(jsonb, boolean) to authenticated;
grant execute on function public.update_bill(uuid, jsonb, boolean, integer) to authenticated;
grant execute on function public.soft_delete_bill(uuid) to authenticated;
grant execute on function public.restore_bill(uuid) to authenticated;
grant execute on function public.bootstrap_organization(text, text, text, text) to authenticated;
