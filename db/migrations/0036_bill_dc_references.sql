-- ---------------------------------------------------------------------------
-- 0036 - the challans a bill refers to, on the bill itself
--
-- What this changes
-- -----------------
-- 1. A bill can carry the customer's own DC number as a typed reference
--    (bills.customer_dc_reference). Most bills never need it: when a bill is
--    raised from an outward challan, the customer DC numbers come from that
--    challan and the link between the two is already recorded in
--    bill_dc_links. A bill raised by hand - an old invoice typed in from a
--    stack of paper, a bill imported from a spreadsheet, a bill for work that
--    was never on a challan - still needs to say which of the customer's
--    documents it pays for, and there was nowhere to write that down.
--
-- 2. The new bill screen can offer the outward challans that are actually
--    billable for the chosen customer (public.dc_billable_documents), so a
--    bill can be raised against several outward challans without the operator
--    having to remember their numbers.
--
-- 3. Searching for a customer DC number also finds the bills that carry it as
--    a typed reference, not only the bills linked to a challan that carries it.
--
-- Why the typed reference is a column and not a note
-- -------------------------------------------------
-- A bill's `notes` field is free text that the customer can see on the
-- invoice. A reference number buried in it cannot be searched, cannot be
-- checked, and disappears into a sentence the moment somebody edits the note.
--
-- Why this is a separate RPC rather than part of save_bill
-- ---------------------------------------------------------
-- app_private.upsert_bill is a long function that computes every amount on
-- the bill. Changing its signature to carry a field that is not an amount
-- would mean rewriting it, and a rewrite of a function that computes money is
-- exactly the wrong risk to take for a reference number. This is the same
-- shape as the bill-to-challan link, which is also attached after the bill
-- itself is saved.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------

alter table public.bills add column if not exists customer_dc_reference text;

alter table public.bills drop constraint if exists bills_customer_dc_reference_check;
alter table public.bills add constraint bills_customer_dc_reference_check
  check (customer_dc_reference is null or char_length(btrim(customer_dc_reference)) between 1 and 64);

comment on column public.bills.customer_dc_reference is
  'The customer''s own delivery challan number, typed by hand. Bills raised from one of our outward challans take it from that challan instead.';

-- ---------------------------------------------------------------------------
-- 2. Writing the reference
-- ---------------------------------------------------------------------------

create or replace function public.set_bill_dc_references(payload jsonb)
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
  v_reference text;
  v_prev jsonb;
  v_next jsonb;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  v_org := app_private.parse_uuid(payload -> 'organization_id', 'organization_id', true);
  if not app_private.is_org_member(v_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'you are not a member of this workspace');
  end if;
  if not app_private.can_write(v_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'your role cannot modify bills');
  end if;

  v_bill := app_private.parse_uuid(payload -> 'bill_id', 'bill_id', true);

  -- The previous state of the bill, read as json. `to_jsonb(b)` rather than
  -- `select * into v_prev`: the row is a composite, and handing a composite to
  -- a jsonb variable casts it through its text form, which is not JSON and is
  -- refused with "invalid input syntax for type json".
  select to_jsonb(b) - 'created_at' - 'updated_at' into v_prev
  from public.bills b
  where b.organization_id = v_org and b.id = v_bill and b.deleted_at is null;

  if not found then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'bill not found');
  end if;

  -- An empty string means "no reference", not "a reference of no length". The
  -- column's own check constraint refuses an empty string, so it has to be
  -- turned into null here rather than handed to the database to refuse.
  v_reference := nullif(btrim(coalesce(payload ->> 'customer_dc_reference', '')), '');

  update public.bills b
  set customer_dc_reference = v_reference,
      updated_at = now()
  where b.organization_id = v_org and b.id = v_bill;

  select to_jsonb(b) - 'created_at' - 'updated_at' into v_next
  from public.bills b
  where b.organization_id = v_org and b.id = v_bill;

  insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, old_data, new_data, metadata)
  values (
    v_org, v_uid, 'UPDATE', 'bills', v_bill,
    v_prev - 'created_at' - 'updated_at', v_next,
    jsonb_build_object('source', 'set_bill_dc_references')
  );

  return jsonb_build_object('bill_id', v_bill, 'customer_dc_reference', v_reference);
end;
$$;

revoke all on function public.set_bill_dc_references(jsonb) from public, anonymous;
grant execute on function public.set_bill_dc_references(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The outward challans a customer can be invoiced for
-- ---------------------------------------------------------------------------
--
-- Only challans that are finalized, not cancelled, and have something on them
-- to invoice. The customer DC numbers are read from the inward lines the
-- material was drawn from, because that is where the customer's own number
-- lives (0026): an outward challan made from our inward challan 500 carries
-- 500 on the inward line, not on its own.

create or replace function public.dc_billable_documents(
  p_org uuid,
  p_party_id uuid default null
)
returns table (
  dc_id uuid,
  dc_number text,
  dc_date date,
  dc_status text,
  reference_inward_number text,
  customer_dc_numbers jsonb,
  line_count bigint,
  total_dispatched numeric
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  if not app_private.is_org_member(p_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'you are not a member of this workspace');
  end if;

  return query
  with docs as (
    select
      d.id,
      d.dc_number,
      d.dc_date,
      d.status,
      d.reference_inward_dc_id,
      ref.dc_number as reference_inward_number
    from public.dc_documents d
    left join public.dc_documents ref
      on ref.organization_id = d.organization_id and ref.id = d.reference_inward_dc_id
    where d.organization_id = p_org
      and d.dc_type = 'outward_customer'
      and d.status not in ('draft', 'cancelled')
      and d.deleted_at is null
      and (p_party_id is null or d.party_id = p_party_id)
  ),
  lines as (
    select
      oi.dc_id,
      count(*) filter (where oi.qty_dispatched > 0) as line_count,
      coalesce(sum(oi.qty_dispatched), 0) as total_dispatched
    from public.dc_items oi
    where oi.organization_id = p_org
      and oi.dc_id in (select d.id from docs d)
    group by oi.dc_id
  ),
  own_numbers as (
    select oi.dc_id, oi.customer_dc_number
    from public.dc_items oi
    where oi.organization_id = p_org
      and oi.dc_id in (select id from docs)
      and oi.customer_dc_number is not null
    group by oi.dc_id, oi.customer_dc_number
  ),
  source_numbers as (
    select oi.dc_id, si.customer_dc_number
    from public.dc_items oi
    join public.dc_items si
      on si.organization_id = oi.organization_id and si.id = oi.source_inward_item_id
    where oi.organization_id = p_org
      and oi.dc_id in (select id from docs)
      and si.customer_dc_number is not null
    group by oi.dc_id, si.customer_dc_number
  )
  select
    d.id,
    d.dc_number,
    d.dc_date,
    d.status,
    d.reference_inward_number,
    coalesce((
      select jsonb_agg(x.dc order by x.dc)
      from (
        select customer_dc_number as dc from own_numbers where own_numbers.dc_id = d.id
        union
        select customer_dc_number as dc from source_numbers where source_numbers.dc_id = d.id
      ) x
    ), '[]'::jsonb),
    coalesce(l.line_count, 0),
    coalesce(l.total_dispatched, 0)
  from docs d
  left join lines l on l.dc_id = d.id
  where coalesce(l.total_dispatched, 0) > 0
  order by d.dc_date desc, d.dc_number desc;
end;
$$;

revoke all on function public.dc_billable_documents(uuid, uuid) from public, anonymous;
grant execute on function public.dc_billable_documents(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Searching for a customer DC number finds the typed references too
-- ---------------------------------------------------------------------------
--
-- The same shape as the function in 0032, with one more place to look. The
-- join to bill_dc_links is kept, because most bills are still found through
-- the challans they pay for.

create or replace function public.bill_ids_for_customer_dc(p_org uuid, p_query text)
returns table (
  bill_id uuid,
  bill_number text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_term text;
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  if not app_private.is_org_member(p_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'you are not a member of this workspace');
  end if;

  v_term := btrim(coalesce(p_query, ''));
  if v_term = '' then
    return;
  end if;

  return query
  with by_link as (
    select distinct b.id as bill_id, b.bill_number as bill_number
    from public.bills b
    join public.bill_dc_links l
      on l.organization_id = b.organization_id and l.bill_id = b.id
    join public.dc_documents d
      on d.organization_id = l.organization_id and d.id = l.dc_id
    where b.organization_id = p_org
      and b.deleted_at is null
      -- Two places the customer's number can sit, and on an OUTWARD challan it is
      -- always the second: the challan is linked to the bill, and its own lines
      -- carry no customer number at all - the number is on the inward line the
      -- material was drawn from (0026). Checking only d's own items would find
      -- nothing for exactly the challans a job-work bill is raised against.
      and (
        exists (
          select 1 from public.dc_items i
          where i.organization_id = b.organization_id and i.dc_id = d.id
            and coalesce(i.customer_dc_number, '') ilike '%' || v_term || '%'
        )
        or exists (
          select 1
          from public.dc_items oi
          join public.dc_items si
            on si.organization_id = oi.organization_id and si.id = oi.source_inward_item_id
          where oi.organization_id = b.organization_id and oi.dc_id = d.id
            and coalesce(si.customer_dc_number, '') ilike '%' || v_term || '%'
        )
      )
  ),
  by_reference as (
    select b.id as bill_id, b.bill_number as bill_number
    from public.bills b
    where b.organization_id = p_org
      and b.deleted_at is null
      and coalesce(b.customer_dc_reference, '') ilike '%' || v_term || '%'
  )
  -- Every column is named with an alias. A function whose return type is
  -- `table (bill_id uuid, bill_number text)` has OUT parameters called
  -- bill_id and bill_number, and PL/pgSQL substitutes an unqualified name that
  -- matches one of them - so an unqualified `bill_number` here would mean both
  -- the column and the parameter, and the query would be refused as ambiguous.
  select u.bill_id, u.bill_number
  from (
    select bl.bill_id as bill_id, bl.bill_number as bill_number from by_link bl
    union
    select br.bill_id as bill_id, br.bill_number as bill_number from by_reference br
  ) u
  order by u.bill_number;
end;
$$;

revoke all on function public.bill_ids_for_customer_dc(uuid, text) from public, anonymous;
grant execute on function public.bill_ids_for_customer_dc(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The outward challans that answer one inward challan
-- ---------------------------------------------------------------------------
--
-- The other direction of the link. The inward challan's page shows which of
-- our outward challans were made from it, so the pair can be read from either
-- side without opening the other document.

create or replace function public.dc_outward_challans_for_inward(p_org uuid, p_inward_id uuid)
returns table (
  dc_id uuid,
  dc_number text,
  dc_date date,
  dc_status text,
  line_count bigint,
  total_dispatched numeric,
  total_delivered numeric
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  if not app_private.is_org_member(p_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'you are not a member of this workspace');
  end if;

  return query
  select
    d.id,
    d.dc_number,
    d.dc_date,
    d.status,
    count(i.id),
    coalesce(sum(i.qty_dispatched), 0),
    coalesce(sum(i.qty_delivered), 0)
  from public.dc_items i
  join public.dc_documents d
    on d.organization_id = i.organization_id and d.id = i.dc_id
  where i.organization_id = p_org
    and i.source_inward_item_id in (
      select si.id
      from public.dc_items si
      where si.organization_id = p_org and si.dc_id = p_inward_id
    )
    and d.deleted_at is null
    and d.status <> 'cancelled'
  group by d.id, d.dc_number, d.dc_date, d.status
  order by d.dc_date desc, d.dc_number desc;
end;
$$;

revoke all on function public.dc_outward_challans_for_inward(uuid, uuid) from public, anonymous;
grant execute on function public.dc_outward_challans_for_inward(uuid, uuid) to authenticated;

commit;
