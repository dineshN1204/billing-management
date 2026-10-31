-- ---------------------------------------------------------------------------
-- 0029 - link a bill to the challans it bills for
--
-- The gap
-- -------
-- Searching the DC register by bill number was asked for and could not be
-- answered: `bills` (0001_core_schema.sql) has no column pointing at a
-- challan and nothing points back at it. There is no relationship in the
-- database between an invoice and the deliveries it bills for, so a bill
-- number could only ever return a bill.
--
-- This is a junction rather than a column on either table because both
-- directions occur:
--
--   - one bill can cover several outward challans, when a customer is invoiced
--     for a month's deliveries together;
--   - one challan can be billed across several bills, when payment is part
--     settled or the invoice is raised in instalments.
--
-- A single dc_id column on bills could express only the first.
--
-- Access
-- ------
-- No grants, exactly like every dc_* table: the browser cannot read or write
-- this table, and everything goes through the RPCs in this migration and 0030.
-- That is deliberate - a bill number and a challan number are both commercially
-- sensitive, and the read path is a security-definer function that checks
-- workspace membership first.
-- ---------------------------------------------------------------------------

begin;

create table if not exists public.bill_dc_links (
  organization_id uuid not null,
  bill_id uuid not null,
  dc_id uuid not null,
  linked_by uuid default auth.uid(),
  linked_at timestamptz not null default now(),

  constraint bill_dc_links_pk primary key (organization_id, bill_id, dc_id),
  constraint bill_dc_links_bill_fk
    foreign key (organization_id, bill_id) references public.bills (organization_id, id) on delete cascade,
  constraint bill_dc_links_dc_fk
    foreign key (organization_id, dc_id) references public.dc_documents (organization_id, id) on delete cascade
);

-- The reverse direction: "which bills cover this challan?" reads this table the
-- other way round.
create index if not exists bill_dc_links_dc_idx
  on public.bill_dc_links (organization_id, dc_id);

-- Reads only rows of the workspace the caller belongs to, so the table is safe
-- even though it carries no direct grant.
alter table public.bill_dc_links enable row level security;

create policy bill_dc_links_member_read on public.bill_dc_links
  for select to authenticated
  using (app_private.is_org_member(organization_id));

create policy bill_dc_links_writer on public.bill_dc_links
  for all to authenticated
  using (app_private.can_write(organization_id))
  with check (app_private.can_write(organization_id));

-- ---------------------------------------------------------------------------
-- Attach and detach, both audited
--
-- Set rather than toggle: the caller sends the bills that should be attached,
-- and anything not in the list is detached. Retrying the same request is then
-- harmless, which a toggle would not be.
-- ---------------------------------------------------------------------------

create or replace function public.dc_link_bills(payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_bill uuid;
  v_dc uuid;
  v_elem jsonb;
  v_prev jsonb;
  v_now jsonb;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  v_org := app_private.parse_uuid(payload -> 'organization_id', 'organization_id', true);
  perform app_private.dc_require_movement_write(v_org);

  v_dc := app_private.parse_uuid(payload -> 'dc_id', 'dc_id', true);

  if not exists (
    select 1 from public.dc_documents d
    where d.organization_id = v_org and d.id = v_dc and d.deleted_at is null
  ) then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'delivery challan not found');
  end if;

  select coalesce(jsonb_agg(to_jsonb(l) order by l.bill_id), '[]'::jsonb)
  into v_prev
  from public.bill_dc_links l
  where l.organization_id = v_org and l.dc_id = v_dc;

  for v_elem in select value from jsonb_array_elements(coalesce(payload -> 'bills', '[]'::jsonb)) loop
    v_bill := app_private.parse_uuid(v_elem -> 'bill_id', 'bill_id', true);

    if not exists (
      select 1 from public.bills b
      where b.organization_id = v_org and b.id = v_bill and b.deleted_at is null
    ) then
      perform app_private.raise_error('PT404', 'NOT_FOUND', 'bill not found in this workspace');
    end if;

    insert into public.bill_dc_links (organization_id, bill_id, dc_id, linked_by)
    values (v_org, v_bill, v_dc, v_uid)
    on conflict (organization_id, bill_id, dc_id) do nothing;
  end loop;

  delete from public.bill_dc_links l
  where l.organization_id = v_org
    and l.dc_id = v_dc
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(payload -> 'bills', '[]'::jsonb)) e
      where app_private.parse_uuid(e -> 'bill_id', 'bill_id', false) = l.bill_id
    );

  select coalesce(jsonb_agg(jsonb_build_object('bill_id', l.bill_id) order by l.bill_id), '[]'::jsonb)
  into v_now
  from public.bill_dc_links l
  where l.organization_id = v_org and l.dc_id = v_dc;

  insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, old_data, new_data, metadata)
  values (v_org, v_uid, 'LINK_BILLS', 'dc_documents', v_dc, v_prev, v_now,
    jsonb_build_object('source', 'dc_link_bills'));

  return jsonb_build_object('dc_id', v_dc, 'bills', v_now);
end;
$$;

revoke all on function public.dc_link_bills(jsonb) from public, anonymous;
grant execute on function public.dc_link_bills(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- The bills attached to one challan
-- ---------------------------------------------------------------------------

create or replace function public.dc_linked_bills(p_org uuid, p_dc_id uuid)
returns table (
  bill_id uuid,
  bill_number text,
  bill_date date,
  customer_id uuid,
  customer_name text,
  grand_total numeric,
  payment_status text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select b.id, b.bill_number, b.bill_date, b.customer_id, b.customer_name, b.grand_total, b.payment_status
  from public.bill_dc_links l
  join public.bills b
    on b.organization_id = l.organization_id and b.id = l.bill_id
  where l.organization_id = p_org
    and l.dc_id = p_dc_id
    and b.deleted_at is null
  order by b.bill_date desc, b.bill_number desc;
$$;

revoke all on function public.dc_linked_bills(uuid, uuid) from public, anonymous;
grant execute on function public.dc_linked_bills(uuid, uuid) to authenticated;

commit;
