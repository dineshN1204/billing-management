alter table public.bills
  add column financial_year text generated always as (
    case
      when extract(month from bill_date) >= 4
        then extract(year from bill_date)::integer::text || '-' || lpad(((extract(year from bill_date)::integer + 1) % 100)::text, 2, '0')
      else (extract(year from bill_date)::integer - 1)::text || '-' || lpad((extract(year from bill_date)::integer % 100)::text, 2, '0')
    end
  ) stored,
  add column payment_date date,
  add column payment_method text,
  add column cess_amount numeric(14, 2) not null default 0;

alter table public.bill_items
  add column cess_rate numeric(7, 2) not null default 0,
  add column cess_amount numeric(14, 2) not null default 0;

alter table public.bills
  drop constraint bills_amounts_check,
  drop constraint bills_totals_consistent_check,
  add constraint bills_amounts_check check (
    subtotal >= 0 and discount_total >= 0 and taxable_amount >= 0 and cgst_amount >= 0
    and sgst_amount >= 0 and igst_amount >= 0 and tax_total >= 0 and cess_amount >= 0 and grand_total >= 0
  ),
  add constraint bills_totals_consistent_check check (
    taxable_amount = subtotal - discount_total
    and tax_total = cgst_amount + sgst_amount + igst_amount
    and grand_total = taxable_amount + tax_total + cess_amount
  ),
  add constraint bills_payment_method_check check (
    payment_method is null or payment_method in ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other')
  ),
  add constraint bills_payment_date_check check (
    payment_date is null or (payment_date >= bill_date and payment_date <= date '2100-12-31')
  ),
  add constraint bills_payment_unpaid_check check (
    payment_status <> 'unpaid' or (payment_date is null and payment_method is null)
  );

alter table public.bill_items
  drop constraint bill_items_amounts_check,
  drop constraint bill_items_total_check,
  add constraint bill_items_amounts_check check (
    line_subtotal >= 0 and taxable_amount >= 0 and cgst_amount >= 0 and sgst_amount >= 0
    and igst_amount >= 0 and tax_amount >= 0 and cess_amount >= 0 and line_total >= 0
  ),
  add constraint bill_items_total_check check (line_total = taxable_amount + tax_amount + cess_amount),
  add constraint bill_items_cess_rate_check check (cess_rate >= 0 and cess_rate <= 1000),
  add constraint bill_items_cess_consistent_check check (
    cess_rate = 0 or cess_amount = round(taxable_amount * cess_rate / 100, 2)
  );

create index bills_org_financial_year_idx on public.bills (organization_id, financial_year, bill_date desc) where deleted_at is null;
create index bills_org_payment_date_idx on public.bills (organization_id, payment_date) where deleted_at is null and payment_date is not null;
