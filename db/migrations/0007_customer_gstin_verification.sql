alter table public.customers
  add column address_line_1 text,
  add column address_line_2 text,
  add column city text,
  add column state text,
  add column pincode text,
  add column country text,
  add column verification_status text not null default 'unverified',
  add column verified_by uuid,
  add column verified_at timestamptz,
  add column customer_name text generated always as (name) stored;

do $$
begin
  if to_regclass('neon_auth.user') is null then
    raise notice 'neon_auth.user does not exist yet: customers_verified_by_fkey was SKIPPED. Enable Neon Auth on this branch, then re-run db/migrations/0001_core_schema.sql to create it.';
    return;
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.customers'::regclass
      and c.conname = 'customers_verified_by_fkey'
  ) then
    alter table public.customers
      add constraint customers_verified_by_fkey
      foreign key (verified_by) references neon_auth.user (id) on delete set null;
  end if;
end
$$;

alter table public.customers
  add constraint customers_address_line_1_check check (address_line_1 is null or char_length(address_line_1) <= 200),
  add constraint customers_address_line_2_check check (address_line_2 is null or char_length(address_line_2) <= 200),
  add constraint customers_city_check check (city is null or char_length(city) <= 100),
  add constraint customers_state_check check (state is null or char_length(state) <= 100),
  add constraint customers_country_check check (country is null or char_length(country) between 2 and 100),
  add constraint customers_pincode_check check (
    pincode is null
    or case
      when country is null or lower(country) in ('india', 'in') then pincode ~ '^[1-9][0-9]{5}$'
      else pincode ~ '^[A-Za-z0-9][A-Za-z0-9 -]{1,10}[A-Za-z0-9]$'
    end
  ),
  add constraint customers_verification_status_check check (verification_status in ('unverified', 'needs_review', 'verified', 'rejected')),
  add constraint customers_verified_check check (verification_status <> 'verified' or verified_at is not null);

create index customers_org_verification_idx on public.customers (organization_id, verification_status) where deleted_at is null;

create function app_private.normalize_gstin_column()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.gstin := nullif(upper(regexp_replace(coalesce(new.gstin, ''), '\s+', '', 'g')), '');
  return new;
end;
$$;

create function app_private.normalize_bill_gstin()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.customer_gstin := nullif(upper(regexp_replace(coalesce(new.customer_gstin, ''), '\s+', '', 'g')), '');
  return new;
end;
$$;

create function app_private.normalize_customer_fields()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.gstin := nullif(upper(regexp_replace(coalesce(new.gstin, ''), '\s+', '', 'g')), '');
  new.address_line_1 := nullif(btrim(new.address_line_1), '');
  new.address_line_2 := nullif(btrim(new.address_line_2), '');
  new.city := nullif(btrim(new.city), '');
  new.state := nullif(btrim(new.state), '');
  new.country := nullif(btrim(new.country), '');
  new.pincode := nullif(regexp_replace(coalesce(new.pincode, ''), '\s+', '', 'g'), '');
  if new.verification_status = 'verified' then
    if tg_op = 'INSERT' or old.verification_status is distinct from 'verified' then
      new.verified_at := coalesce(new.verified_at, now());
      new.verified_by := coalesce(new.verified_by, auth.uid());
    end if;
  else
    new.verified_at := null;
    new.verified_by := null;
  end if;
  return new;
end;
$$;

create trigger a_normalize_fields before insert or update on public.customers
  for each row execute function app_private.normalize_customer_fields();
create trigger a_normalize_gstin before insert or update of gstin on public.organizations
  for each row execute function app_private.normalize_gstin_column();
create trigger a_normalize_gstin before insert or update of customer_gstin on public.bills
  for each row execute function app_private.normalize_bill_gstin();

alter table public.customers
  add constraint customers_gstin_format_check check (
    gstin is null or gstin ~ '^(0[1-9]|[12][0-9]|3[0-8]|97|99)[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
  ) not valid;

alter table public.organizations
  add constraint organizations_gstin_format_check check (
    gstin is null or gstin ~ '^(0[1-9]|[12][0-9]|3[0-8]|97|99)[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
  ) not valid;

alter table public.bills
  add constraint bills_customer_gstin_format_check check (
    customer_gstin is null or customer_gstin ~ '^(0[1-9]|[12][0-9]|3[0-8]|97|99)[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
  ) not valid;

do $$
begin
  begin
    alter table public.customers validate constraint customers_gstin_format_check;
  exception when check_violation then
    raise warning 'customers_gstin_format_check left NOT VALID: legacy rows with malformed GSTIN exist';
  end;
  begin
    alter table public.organizations validate constraint organizations_gstin_format_check;
  exception when check_violation then
    raise warning 'organizations_gstin_format_check left NOT VALID: legacy rows with malformed GSTIN exist';
  end;
  begin
    alter table public.bills validate constraint bills_customer_gstin_format_check;
  exception when check_violation then
    raise warning 'bills_customer_gstin_format_check left NOT VALID: legacy rows with malformed GSTIN exist';
  end;
end;
$$;

grant insert (address_line_1, address_line_2, city, state, pincode, country) on public.customers to authenticated;
grant update (address_line_1, address_line_2, city, state, pincode, country) on public.customers to authenticated;

create function public.set_customer_verification(target_customer_id uuid, new_status text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_status text;
  v_customer public.customers;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;
  select c.organization_id into v_org
  from public.customers c
  where c.id = target_customer_id and c.deleted_at is null;
  if v_org is null or not app_private.is_org_member(v_org) then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'customer not found', jsonb_build_object('customer_id', target_customer_id));
  end if;
  if not app_private.can_write(v_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'your role cannot modify customers');
  end if;
  v_status := app_private.parse_enum(
    to_jsonb(new_status), 'new_status', array['unverified', 'needs_review', 'verified', 'rejected'], null
  );
  if v_status is null then
    perform app_private.raise_validation('new_status', 'is required');
  end if;
  update public.customers c
  set verification_status = v_status
  where c.id = target_customer_id
  returning * into v_customer;
  return to_jsonb(v_customer);
end;
$$;

revoke all on function app_private.normalize_gstin_column() from public, anonymous, authenticated;
revoke all on function app_private.normalize_bill_gstin() from public, anonymous, authenticated;
revoke all on function app_private.normalize_customer_fields() from public, anonymous, authenticated;
revoke all on function public.set_customer_verification(uuid, text) from public, anonymous;
grant execute on function public.set_customer_verification(uuid, text) to authenticated;
