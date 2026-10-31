create function public.dashboard_summary(org_id uuid)
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
    'pending_amount', coalesce(sum(b.grand_total) filter (where b.payment_status in ('unpaid', 'partial')), 0),
    'bills_this_month', count(*) filter (
      where b.bill_date >= v_month_start and b.bill_date < (v_month_start + interval '1 month')::date
    )
  ) into v_result
  from public.bills b
  where b.organization_id = org_id and b.deleted_at is null;

  return v_result;
end;
$$;

create function public.customer_summary(target_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_org uuid;
  v_result jsonb;
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;
  select c.organization_id into v_org
  from public.customers c
  join public.organizations o on o.id = c.organization_id
  join public.memberships m on m.organization_id = c.organization_id
  where c.id = target_customer_id
    and c.deleted_at is null
    and o.deleted_at is null
    and m.user_id = auth.uid()
    and m.role in ('admin', 'staff', 'viewer');
  if v_org is null then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'customer not found');
  end if;

  select jsonb_build_object(
    'bill_count', count(*),
    'total_purchase', coalesce(sum(b.grand_total), 0),
    'total_gst', coalesce(sum(b.tax_total), 0),
    'average_bill', coalesce(round(avg(b.grand_total), 2), 0),
    'last_bill', max(b.bill_date)
  ) into v_result
  from public.bills b
  where b.organization_id = v_org
    and b.customer_id = target_customer_id
    and b.deleted_at is null;

  return v_result;
end;
$$;

create function public.customer_products(target_customer_id uuid)
returns table (product_name text, quantity numeric, total_amount numeric, last_purchased date)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;
  select c.organization_id into v_org
  from public.customers c
  join public.organizations o on o.id = c.organization_id
  join public.memberships m on m.organization_id = c.organization_id
  where c.id = target_customer_id
    and c.deleted_at is null
    and o.deleted_at is null
    and m.user_id = auth.uid()
    and m.role in ('admin', 'staff', 'viewer');
  if v_org is null then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'customer not found');
  end if;

  return query
  select i.product_name, sum(i.quantity), sum(i.line_total), max(b.bill_date)
  from public.bills b
  join public.bill_items i on i.organization_id = b.organization_id and i.bill_id = b.id
  where b.organization_id = v_org
    and b.customer_id = target_customer_id
    and b.deleted_at is null
  group by i.product_name
  order by sum(i.line_total) desc, i.product_name
  limit 100;
end;
$$;

create function public.report_summary(org_id uuid, start_date date, end_date date)
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
    'sales', coalesce(sum(b.grand_total), 0),
    'bills', count(*),
    'pending', coalesce(sum(b.grand_total) filter (where b.payment_status in ('unpaid', 'partial')), 0)
  ) into v_result
  from public.bills b
  where b.organization_id = org_id
    and b.bill_date >= start_date
    and b.bill_date <= end_date
    and b.deleted_at is null;

  return v_result;
end;
$$;

revoke all on function public.dashboard_summary(uuid) from public, anonymous;
revoke all on function public.customer_summary(uuid) from public, anonymous;
revoke all on function public.customer_products(uuid) from public, anonymous;
revoke all on function public.report_summary(uuid, date, date) from public, anonymous;

grant execute on function public.dashboard_summary(uuid) to authenticated;
grant execute on function public.customer_summary(uuid) to authenticated;
grant execute on function public.customer_products(uuid) to authenticated;
grant execute on function public.report_summary(uuid, date, date) to authenticated;

create schema if not exists extensions;

create extension if not exists pg_trgm with schema extensions;

do $$
declare
  v_opclass text;
begin
  select format('%I.gin_trgm_ops', n.nspname) into v_opclass
  from pg_catalog.pg_extension e
  join pg_catalog.pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pg_trgm';

  execute format('create index organizations_name_trgm_idx on public.organizations using gin (name %s) where deleted_at is null', v_opclass);
  execute format('create index customers_org_name_trgm_idx on public.customers using gin (name %s) where deleted_at is null', v_opclass);
  execute format('create index customers_org_phone_trgm_idx on public.customers using gin (phone %s) where deleted_at is null and phone is not null', v_opclass);
  execute format('create index products_org_name_trgm_idx on public.products using gin (name %s) where deleted_at is null', v_opclass);
  execute format('create index bills_org_number_trgm_idx on public.bills using gin (bill_number %s) where deleted_at is null', v_opclass);
end;
$$;
