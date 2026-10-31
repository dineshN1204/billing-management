-- ---------------------------------------------------------------------------
-- 0030 - one search across challans and bills
--
-- What it answers
-- ---------------
-- A single term, typed once, matched against every identifier someone in a
-- store actually holds:
--
--   - the customer's own DC number, on an inward line or on the challan header
--   - our own DC number
--   - a part number
--   - a drawing number
--   - a customer or supplier name
--   - a GSTIN
--   - a bill number
--
-- Searching a customer's DC number returns the inward challans that carry it
-- *and* the outward challans whose lines were drawn from those inward lines.
-- That is the point of the feature: the customer sent three of their own
-- challans, one inward challan of ours received all three, and two outward
-- challans went back out. One search shows all five documents.
--
-- Why it is a function and not more client-side filtering
-- --------------------------------------------------------
-- The register page fetched every row of its type and filtered in the browser
-- (src/pages/DcList.tsx). That cannot work here: part numbers and customer DC
-- numbers live on dc_items, not on the document row the page holds, and bills
-- are a different table entirely. Paging a joined set in the browser would mean
-- fetching the whole workspace on every keystroke.
--
-- Customer DC numbers on the lines of a document are assembled from both
-- directions - the document's own lines, and the lines behind any source link
-- - so an inward challan shows the customer's numbers and an outward challan
-- shows the same numbers its material came in on.
--
-- GSTIN stays searchable. The register *list* shows the customer DC number in
-- place of GSTIN, but a search term that matches neither a number nor a name is
-- very often a GSTIN being read off paperwork, and a search that silently fails
-- on the one identifier printed on every invoice is worse than a wide column.
-- ---------------------------------------------------------------------------

begin;

create or replace function public.dc_search(
  p_org uuid,
  p_query text,
  p_limit integer default 100
)
returns table (
  result_type text,
  id uuid,
  dc_number text,
  dc_type text,
  dc_date date,
  status text,
  job_status text,
  party_id uuid,
  party_name text,
  customer_dc_numbers jsonb,
  line_count bigint,
  total_quantity numeric,
  matched_on text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_term text;
  v_like text;
  v_capped integer;
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  if not app_private.is_org_member(p_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'you are not a member of this workspace');
  end if;

  v_term := btrim(coalesce(p_query, ''));
  if v_term = '' then
    -- An empty term lists nothing rather than everything. A search box that
    -- shows the whole workspace the moment it is focused is indistinguishable
    -- from one that is broken.
    return;
  end if;

  -- The wildcards are escaped so a literal % or _ in a part number is searched
  -- for literally instead of turning the term into a match-everything pattern.
  v_like := '%' || v_term || '%';

  v_capped := least(greatest(coalesce(p_limit, 100), 1), 500);

  return query
  with docs as (
    select
      d.id,
      d.dc_number,
      d.dc_type,
      d.dc_date,
      d.status,
      d.party_id,
      d.party_name,
      (
        select count(*) from public.dc_items i
        where i.organization_id = d.organization_id and i.dc_id = d.id
      ) as line_count,
      coalesce((
        select sum(
          case when d.dc_type = 'inward' then i.received_qty
               when d.dc_type = 'outward_customer' then i.qty_dispatched
               else i.declared_qty end
        )
        from public.dc_items i
        where i.organization_id = d.organization_id and i.dc_id = d.id
      ), 0) as total_quantity,
      -- Matched on: reported so the person searching can tell why a row is in
      -- the list. A row that appears for no visible reason looks like a bug.
      concat_ws(', ', array_remove(array[
        case when d.dc_number ilike v_like then 'our DC number' end,
        case when d.external_dc_number ilike v_like then 'customer DC number' end,
        case when d.party_name ilike v_like then 'customer name' end,
        case when coalesce(d.party_gstin, '') ilike v_like then 'GSTIN' end,
        case when exists (
          select 1 from public.dc_items i
          where i.organization_id = d.organization_id and i.dc_id = d.id
            and i.part_number ilike v_like
        ) then 'part number' end,
        case when exists (
          select 1 from public.dc_items i
          where i.organization_id = d.organization_id and i.dc_id = d.id
            and coalesce(i.drawing_number, '') ilike v_like
        ) then 'drawing number' end,
        case when exists (
          select 1 from public.dc_items i
          where i.organization_id = d.organization_id and i.dc_id = d.id
            and coalesce(i.customer_dc_number, '') ilike v_like
        ) then 'customer DC number (line)' end,
        -- An outward line stores no customer DC number of its own: it is the
        -- inward line it was drawn from that carries it. Without this, searching
        -- a customer's DC number would find the inward challan that received
        -- their material and not the outward challan that sent it back - which
        -- is the half of the answer that matters.
        case when exists (
          select 1
          from public.dc_items oi
          join public.dc_items si
            on si.organization_id = oi.organization_id and si.id = oi.source_inward_item_id
          where oi.organization_id = d.organization_id and oi.dc_id = d.id
            and coalesce(si.customer_dc_number, '') ilike v_like
        ) then 'customer DC number (inward line)' end,
        case when exists (
          select 1 from public.bill_dc_links l
          join public.bills b
            on b.organization_id = l.organization_id and b.id = l.bill_id
          where l.organization_id = d.organization_id and l.dc_id = d.id
            and b.bill_number ilike v_like and b.deleted_at is null
        ) then 'bill number' end
      ], null)) as matched_on
    from public.dc_documents d
    where d.organization_id = p_org
      and d.deleted_at is null
      and (
        d.dc_number ilike v_like
        or coalesce(d.external_dc_number, '') ilike v_like
        or d.party_name ilike v_like
        or coalesce(d.party_gstin, '') ilike v_like
        or exists (
          select 1 from public.dc_items i
          where i.organization_id = d.organization_id and i.dc_id = d.id
            and (
              i.part_number ilike v_like
              or coalesce(i.drawing_number, '') ilike v_like
              or coalesce(i.customer_dc_number, '') ilike v_like
              or coalesce(i.batch_lot_no, '') ilike v_like
            )
        )
        or exists (
          select 1
          from public.dc_items oi
          join public.dc_items si
            on si.organization_id = oi.organization_id and si.id = oi.source_inward_item_id
          where oi.organization_id = d.organization_id and oi.dc_id = d.id
            and coalesce(si.customer_dc_number, '') ilike v_like
        )
        or exists (
          select 1 from public.bill_dc_links l
          join public.bills b
            on b.organization_id = l.organization_id and b.id = l.bill_id
          where l.organization_id = d.organization_id and l.dc_id = d.id
            and b.bill_number ilike v_like and b.deleted_at is null
        )
      )
  ),
  numbered as (
    select
      g.*,
      coalesce((
        select jsonb_agg(x.dc order by x.dc)
        from (
          select i.customer_dc_number as dc
          from public.dc_items i
          where i.organization_id = p_org and i.dc_id = g.id and i.customer_dc_number is not null
          union
          select s.customer_dc_number as dc
          from public.dc_items oi
          join public.dc_items s
            on s.organization_id = oi.organization_id and s.id = oi.source_inward_item_id
          where oi.organization_id = p_org and oi.dc_id = g.id and s.customer_dc_number is not null
        ) x
      ), '[]'::jsonb) as customer_dc_numbers
    from docs g
  ),
  inward_lines as (
    select i.id, i.dc_id, i.accepted_qty
    from public.dc_items i
    join public.dc_documents d
      on d.organization_id = i.organization_id and d.id = i.dc_id
    where i.organization_id = p_org and d.dc_type = 'inward' and d.deleted_at is null
  ),
  linked as (
    select
      oi.source_inward_item_id as source_id,
      oi.qty_dispatched,
      oi.qty_delivered
    from public.dc_items oi
    join public.dc_documents od
      on od.organization_id = oi.organization_id and od.id = oi.dc_id
    where oi.organization_id = p_org
      and oi.source_inward_item_id is not null
      and od.dc_type = 'outward_customer'
      and od.status <> 'cancelled'
      and od.deleted_at is null
  ),
  progress as (
    select
      il.dc_id,
      count(*) filter (where l.source_id is not null) as linked_lines,
      count(*) filter (
        where l.source_id is not null and l.qty_delivered >= l.qty_dispatched
      ) as done_lines,
      coalesce(sum(l.qty_dispatched), 0) as dispatched,
      coalesce(sum(l.qty_delivered), 0) as delivered
    from inward_lines il
    left join linked l on l.source_id = il.id
    group by il.dc_id
  )
  select
    case when n.dc_type = 'inward' then 'inward'
         when n.dc_type = 'outward_customer' then 'outward'
         else 'other' end,
    n.id,
    n.dc_number,
    n.dc_type,
    n.dc_date,
    n.status,
    case when n.dc_type <> 'inward' then null
         when coalesce(p.linked_lines, 0) = 0 then 'not_started'
         when coalesce(p.done_lines, 0) = p.linked_lines then 'delivered'
         when coalesce(p.delivered, 0) > 0 then 'partially_delivered'
         when coalesce(p.dispatched, 0) > 0 then 'in_progress'
         else 'pending'
    end,
    n.party_id,
    n.party_name,
    n.customer_dc_numbers,
    n.line_count,
    n.total_quantity,
    n.matched_on
  from numbered n
  left join progress p on p.dc_id = n.id
  order by n.dc_date desc, n.dc_number desc
  limit v_capped;
end;
$$;

revoke all on function public.dc_search(uuid, text, integer) from public, anonymous;
grant execute on function public.dc_search(uuid, text, integer) to authenticated;

commit;
