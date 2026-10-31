-- 0010_bill_customer_contact_snapshot.sql
--
-- The invoice view ("BILLED TO") must carry the customer's contact details the same
-- way it already carries `customer_name` and `customer_gstin`: as a snapshot taken
-- from the customer record when the bill is saved. Without these columns a bill can
-- only ever show a name and a GSTIN, so an old bill silently loses the phone, email
-- and address the customer had at the time it was raised.
--
-- Applied on top of 0009. Idempotent: safe to re-run.
--
-- History: this file originally also re-declared app_private.upsert_bill in order to
-- populate the three new columns. That re-declaration was removed because it shipped
-- with a body that stopped after resolving the customer and returned no value, which
-- made every save_bill / update_bill call fail with
-- "control reached end of function without RETURN". 0012 already delivers the same
-- behaviour through a BEFORE INSERT OR UPDATE trigger, which is strictly better
-- because it covers direct inserts and imports too, not just the RPC path. See
-- docs/PROJECT_AUDIT.md (finding DB-01).
--
-- This file therefore owns only the column definitions. Do not re-introduce a
-- copy of app_private.upsert_bill here: 0009 owns that function.

begin;

-- 1. Snapshot columns on public.bills -----------------------------------------
-- Same shape as the other denormalised customer_* columns: nullable, no default,
-- written by app_private.upsert_bill only. A bill raised before this migration keeps
-- NULLs, and the invoice simply omits those lines rather than inventing values.
alter table public.bills
  add column if not exists customer_phone text,
  add column if not exists customer_email text,
  add column if not exists customer_address text;

comment on column public.bills.customer_phone is
  'Denormalised snapshot of the customer phone at save time; null for bills raised before 0010.';
comment on column public.bills.customer_email is
  'Denormalised snapshot of the customer email at save time; null for bills raised before 0010.';
comment on column public.bills.customer_address is
  'Denormalised snapshot of the customer mailing address at save time; null for bills raised before 0010.';

-- The audit trigger compares row images, so these columns are covered automatically.

-- 2. Populating the columns ------------------------------------------------
-- No statement is needed here. The snapshot is maintained by the trigger
-- app_private.fill_bill_customer_snapshot() installed in 0012, which re-reads the
-- customer on INSERT and whenever a bill is re-pointed at a different customer.
-- 0012 also backfills bills that predate these columns.
--
-- What must NOT happen: re-declaring app_private.upsert_bill here to do the work in
-- PL/pgSQL. That function is owned by 0009, and a partial copy of it replaces a
-- working one with a broken one.

commit;
