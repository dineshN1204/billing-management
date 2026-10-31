-- 0012: Store the customer's contact details on the bill so the invoice shows
-- the customer's company name, GSTIN, phone, email and address at a glance —
-- and keeps showing them forever, even if the customer is later edited or
-- deleted.
--
-- The bills table already froze customer_name and customer_gstin. This adds
-- customer_phone, customer_email and customer_address with the same
-- "frozen at bill creation, refreshed when the customer changes" behaviour,
-- applied by a BEFORE trigger so it happens for every write path
-- (save_bill / update_bill RPCs, direct inserts, imports).

-- 1. Columns (nullable: older bills have no data until backfilled below).
alter table public.bills
  add column if not exists customer_phone text,
  add column if not exists customer_email text,
  add column if not exists customer_address text;

-- 2. Backfill existing bills from their current customer.
update public.bills b
set
  customer_phone = c.phone,
  customer_email = c.email,
  customer_address = coalesce(
    nullif(btrim(concat_ws(', ',
      nullif(btrim(c.address_line_1), ''),
      nullif(btrim(c.address_line_2), ''),
      nullif(btrim(c.city), ''),
      nullif(btrim(concat_ws(' ', nullif(btrim(c.state), ''), nullif(btrim(c.pincode), ''))), ''),
      nullif(btrim(c.country), '')
    )), ''),
    nullif(btrim(c.address), '')
  )
from public.customers c
where c.id = b.customer_id;

-- 3. Trigger function that snapshots the customer's contact details.
create or replace function app_private.fill_bill_customer_snapshot()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_struct text;
  v_phone text;
  v_email text;
  v_legacy text;
begin
  -- Only (re)build the snapshot on insert, or when the bill's customer changes,
  -- so an invoice keeps its original details after later edits.
  if tg_op = 'INSERT' or new.customer_id is distinct from old.customer_id then
    select
      nullif(btrim(concat_ws(', ',
        nullif(btrim(c.address_line_1), ''),
        nullif(btrim(c.address_line_2), ''),
        nullif(btrim(c.city), ''),
        nullif(btrim(concat_ws(' ', nullif(btrim(c.state), ''), nullif(btrim(c.pincode), ''))), ''),
        nullif(btrim(c.country), '')
      )), ''),
      c.phone,
      c.email,
      c.address
    into v_struct, v_phone, v_email, v_legacy
    from public.customers c
    where c.id = new.customer_id;

    if found then
      new.customer_phone := v_phone;
      new.customer_email := v_email;
      new.customer_address := coalesce(v_struct, nullif(btrim(v_legacy), ''));
    end if;
  end if;
  return new;
end;
$$;

revoke all on function app_private.fill_bill_customer_snapshot() from public;

drop trigger if exists b_fill_customer_snapshot on public.bills;
create trigger b_fill_customer_snapshot
  before insert or update of customer_id on public.bills
  for each row execute function app_private.fill_bill_customer_snapshot();
