-- ---------------------------------------------------------------------------
-- 0057 - customer profile: what has been received and what is still owed
--
-- What this changes
-- -----------------
-- The customer profile page shows how much a customer has bought (total
-- purchase), how much GST is on those bills, and the average bill. It does not
-- say how much has been paid or how much is still owed, so the summary cannot
-- drive payment follow-up without opening every bill.
--
-- This adds two figures to `customer_summary`, both read from the same columns
-- the reports already trust:
--
--   total_paid   the sum of `bills.paid_amount`   - what has been received
--   pending_amount  the sum of `bills.remaining_amount` - what is still owed
--
-- `remaining_amount` is a generated column (grand_total - paid_amount), so the
-- profile, the outstanding report and the dashboard all read the same number
-- and cannot disagree about it. The two new figures are consistent by
-- construction: pending = total purchase - total paid.
--
-- The function keeps its existing auth and membership guard and returns the
-- same keys as before, so existing callers are unaffected.
-- ---------------------------------------------------------------------------

begin;

create or replace function public.customer_summary(target_customer_id uuid)
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
    'total_paid', coalesce(sum(b.paid_amount), 0),
    'pending_amount', coalesce(sum(b.remaining_amount), 0),
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

revoke all on function public.customer_summary(uuid) from public, anonymous;
grant execute on function public.customer_summary(uuid) to authenticated;

commit;
