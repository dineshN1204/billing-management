do $seed$
declare
  v_org uuid;
  v_user uuid;
  v_org_setting text := nullif(current_setting('app.seed_organization_id', true), '');
  v_email_setting text := nullif(current_setting('app.seed_user_email', true), '');
  v_org_state text;
  v_customer_ids uuid[];
  v_customer_states text[];
  v_product_ids uuid[];
  v_product_names text[];
  v_product_rates numeric[];
  v_batch_id uuid;
  v_items jsonb;
  v_payload jsonb;
  v_cust_idx integer;
  v_prod_idx integer;
  v_qty numeric;
  v_rate numeric;
  v_discount numeric;
  v_gst numeric;
  v_bill_no integer;
  v_item_no integer;
  v_bill_count integer := 0;
  v_item_count integer := 0;
begin
  if v_org_setting is not null then
    select m.organization_id, m.user_id into v_org, v_user
    from public.memberships m
    join public.organizations o on o.id = m.organization_id and o.deleted_at is null
    where m.organization_id = v_org_setting::uuid
      and m.role in ('admin', 'staff')
    order by (m.role = 'admin') desc, m.created_at
    limit 1;
  elsif v_email_setting is not null then
    select m.organization_id, m.user_id into v_org, v_user
    from neon_auth.user u
    join public.memberships m on m.user_id = u.id and m.role in ('admin', 'staff')
    join public.organizations o on o.id = m.organization_id and o.deleted_at is null
    left join public.profiles p on p.id = u.id
    where lower(u.email) = lower(v_email_setting)
    order by (m.organization_id = p.default_organization_id) desc, (m.role = 'admin') desc, m.created_at
    limit 1;
  elsif auth.uid() is not null then
    select m.organization_id, m.user_id into v_org, v_user
    from public.memberships m
    join public.organizations o on o.id = m.organization_id and o.deleted_at is null
    left join public.profiles p on p.id = m.user_id
    where m.user_id = auth.uid()
      and m.role in ('admin', 'staff')
    order by (m.organization_id = p.default_organization_id) desc, (m.role = 'admin') desc, m.created_at
    limit 1;
  end if;

  if v_org is null then
    raise notice 'seed skipped: no target organization with an admin/staff member (set app.seed_user_email or app.seed_organization_id)';
    return;
  end if;

  if exists (select 1 from public.bills b where b.organization_id = v_org and b.bill_number like 'SEED-%') then
    raise notice 'seed skipped: organization % is already seeded', v_org;
    return;
  end if;

  perform set_config('request.jwt.claim.sub', v_user::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);

  select o.state_code into v_org_state from public.organizations o where o.id = v_org;
  v_org_state := coalesce(v_org_state, '27');

  with src (ord, name, state_code, city) as (
    values
      (1, 'Sunrise Test Traders', '27', 'Pune'),
      (2, 'Blue Lotus Demo Stores', '27', 'Mumbai'),
      (3, 'Greenfield Sample Agencies', '29', 'Bengaluru'),
      (4, 'Maple Example Hardware', '27', 'Nashik'),
      (5, 'Orchid Fake Pharma', '24', 'Ahmedabad'),
      (6, 'Riverbend Mock Electricals', '27', 'Nagpur'),
      (7, 'Summit Placeholder Foods', '07', 'New Delhi'),
      (8, 'Coral Demo Textiles', '33', 'Chennai'),
      (9, 'Pioneer Sample Stationers', '27', 'Thane'),
      (10, 'Lakeside Test Furnishings', '29', 'Mysuru'),
      (11, 'Harbor Example Logistics', '27', 'Aurangabad'),
      (12, 'Crescent Mock Appliances', '24', 'Surat')
  ),
  ins as (
    insert into public.customers (organization_id, name, gstin, phone, email, address, state_code, notes, created_by)
    select
      v_org,
      s.name,
      s.state_code || 'FAKEC' || lpad(s.ord::text, 4, '0') || 'A1Z0',
      '99999' || lpad(s.ord::text, 5, '0'),
      'accounts' || s.ord || '@example.com',
      s.ord || ' Sample Road, ' || s.city,
      s.state_code,
      'Seed data',
      v_user
    from src s
    returning id, state_code, name
  )
  select array_agg(i.id order by i.name), array_agg(i.state_code order by i.name)
  into v_customer_ids, v_customer_states
  from ins i;

  with src (ord, name, code, hsn, unit, rate, gst, descr) as (
    values
      (1, 'Copper Wire 1.5mm', 'SEED-P001', '8544', 'MTR', 42.50, 18, 'Demo item'),
      (2, 'LED Bulb 9W', 'SEED-P002', '8539', 'NOS', 85.00, 12, 'Demo item'),
      (3, 'Notebook A4 200pg', 'SEED-P003', '4820', 'NOS', 60.00, 12, 'Demo item'),
      (4, 'Steel Bolt M8', 'SEED-P004', '7318', 'KGS', 120.00, 18, 'Demo item'),
      (5, 'Cotton Fabric Roll', 'SEED-P005', '5208', 'MTR', 210.00, 5, 'Demo item'),
      (6, 'Basmati Rice 25kg', 'SEED-P006', '1006', 'BAG', 1450.00, 5, 'Demo item'),
      (7, 'Paracetamol Strip', 'SEED-P007', '3004', 'STR', 18.00, 12, 'Demo item'),
      (8, 'Desk Lamp', 'SEED-P008', '9405', 'NOS', 799.00, 18, 'Demo item'),
      (9, 'PVC Pipe 1in', 'SEED-P009', '3917', 'MTR', 65.00, 18, 'Demo item'),
      (10, 'Packing Tape', 'SEED-P010', '3919', 'NOS', 35.00, 18, 'Demo item'),
      (11, 'Mixer Grinder', 'SEED-P011', '8509', 'NOS', 2899.00, 18, 'Demo item'),
      (12, 'Consulting Hour', 'SEED-P012', '9983', 'HRS', 1500.00, 18, 'Demo service')
  ),
  ins as (
    insert into public.products (organization_id, name, product_code, hsn_code, unit, default_rate, gst_rate, description, created_by)
    select v_org, s.name, s.code, s.hsn, s.unit, s.rate, s.gst, s.descr, v_user
    from src s
    returning id, name, default_rate, product_code
  )
  select array_agg(i.id order by i.product_code), array_agg(i.name order by i.product_code), array_agg(i.default_rate order by i.product_code)
  into v_product_ids, v_product_names, v_product_rates
  from ins i;

  insert into public.import_batches (organization_id, file_name, status, total_rows, success_rows, failed_rows, errors, metadata, created_by, completed_at)
  values (v_org, 'seed-import.csv', 'completed', 5, 5, 0, '[]'::jsonb, jsonb_build_object('seed', true), v_user, now())
  returning id into v_batch_id;

  for v_bill_no in 1..30 loop
    v_cust_idx := ((v_bill_no - 1) % array_length(v_customer_ids, 1)) + 1;
    v_items := '[]'::jsonb;
    for v_item_no in 1..(1 + (v_bill_no % 3)) loop
      v_prod_idx := ((v_bill_no * 3 + v_item_no * 5) % array_length(v_product_ids, 1)) + 1;
      v_qty := ((v_bill_no + v_item_no) % 9) + 1;
      v_rate := v_product_rates[v_prod_idx];
      v_discount := case when (v_bill_no + v_item_no) % 4 = 0 then round(v_qty * v_rate * 0.05, 2) else 0 end;
      v_gst := case (v_bill_no + v_item_no) % 4 when 0 then 5 when 1 then 12 else 18 end;
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'product_id', v_product_ids[v_prod_idx],
        'product_name', v_product_names[v_prod_idx],
        'quantity', v_qty,
        'rate', v_rate,
        'discount', v_discount,
        'gst_rate', v_gst
      ));
      v_item_count := v_item_count + 1;
    end loop;

    v_payload := jsonb_build_object(
      'bill_number', 'SEED-' || lpad(v_bill_no::text, 4, '0'),
       'bill_date', to_char(current_date - (v_bill_no * 35), 'YYYY-MM-DD'),
      'customer_id', v_customer_ids[v_cust_idx],
      'place_of_supply', v_customer_states[v_cust_idx],
      'tax_mode', case when v_customer_states[v_cust_idx] = v_org_state then 'intra' else 'inter' end,
      'payment_status', (array['paid', 'unpaid', 'partial'])[(v_bill_no % 3) + 1],
      'notes', 'Seed bill ' || v_bill_no,
      'source_type', case when v_bill_no <= 5 then 'import' when v_bill_no % 4 = 0 then 'ocr' else 'manual' end,
      'verification_status', (array['verified', 'needs_review', 'unverified', 'verified', 'rejected'])[(v_bill_no % 5) + 1],
      'items', v_items
    );
    if v_bill_no <= 5 then
      v_payload := v_payload || jsonb_build_object('import_batch_id', v_batch_id);
    end if;

    perform public.save_bill(v_payload, false);
    v_bill_count := v_bill_count + 1;
  end loop;

  raise notice 'seeded organization %: 12 customers, 12 products, % bills, % items', v_org, v_bill_count, v_item_count;
end
$seed$;
