-- 0033 - the customer material ledger, rebuilt.
--
-- What was wrong
-- ==============
--
-- customer_material_ledger was written in 0017 and never revised. Six later
-- migrations changed the rules it reads from and left it behind, so it had come
-- to disagree with the rest of the module in six separate ways. Every one of
-- these was reproduced against live data before this migration was written.
--
-- 1. Finished stock went negative.
--    The machining CTE matched `material_owner_id = p_customer_id` strictly.
--    The machining panel sent a NULL owner, so accepted output read as zero while
--    dispatch still counted, and 0 + 0 - 50 = -50. Reproduced three times:
--    TYFGUHI-9652 (-50), DRTRCFG-54151 (-10), FCUKJ-8456 (-20).
--    0027 already established the correct rule for dc_available_balance
--    (`material_owner_id = party OR (material_owner_id is null AND party_id = party)`)
--    and this function never picked it up.
--
-- 2. Customer material never fell.
--    The balance was `accepted - issued + returned`, where issued and returned
--    both came from `dc_type = 'outward_self'`. Migration 0024 deleted that
--    document type, so both terms became permanently zero and the pool read as
--    "everything this customer ever sent us", never reduced by a dispatch.
--    That is KNOWN_ISSUES 21, fixed in the dispatch guard by 0027 and never
--    fixed in the report.
--
-- 3. Four columns could never hold a value.
--    issued_for_processing, returned_from_processing, still_at_vendor and
--    accepted_return all read outward_self, so they were 0 forever once 0024
--    landed. 0025 had already deleted the equivalent dashboard fields for exactly
--    this reason; the ledger was missed. They are removed here rather than left
--    as four columns that can only ever print 0.
--
-- 4. Parts appeared that had never been inwarded.
--    The part list took `select distinct part_number, unit` over every document
--    of the customer with no dc_type filter, so a material_return or an
--    outward_self document injected a part. Every customer showed rows such as
--    HG-5562 and DFHRF-424 with a zero in all sixteen columns. Two problems in
--    one: noise, and a part that appeared twice under two different units if the
--    units ever disagreed.
--
-- 5. The date filter was half applied.
--    `inward` filtered on dc_date and `machining` on operation_date, but
--    outward_customer, outward_self and orders carried no date predicate at all.
--    A filtered month therefore computed *March receipts minus all-time
--    dispatches*, with no opening balance carried in. This is the largest
--    arithmetic error in the function and the reason a period view could never
--    be right.
--
-- 6. There was no membership guard.
--    The function is SECURITY DEFINER, which bypasses the RLS policies in 0015,
--    and it never called app_private.is_org_member. Every sibling that reports on
--    material - dc_dashboard_summary (0025), dc_inward_lines (0027),
--    dc_job_progress (0028) - does call it. Any authenticated user could pass any
--    p_org and p_customer_id and read another workspace's material ledger.
--
-- What this migration changes
-- ==========================
--
-- The function is dropped and recreated rather than replaced, because CREATE OR
-- REPLACE cannot change a RETURNS TABLE (the precedent is 0032).
--
--   - Two pools, drained only by what actually left them:
--       raw      = accepted material - machining input consumed - dispatched unmachined
--       finished = machining output + accepted finished - dispatched machined
--     A dispatch out of one pool can no longer reduce the other, which is what
--     produced the negative balances. "Machined" means the outward line is
--     declared finished_stock, or a machining result is credited to this
--     customer for this part - never the line's supply_source alone. A line
--     drawing on customer material that was then machined ships FINISHED
--     pieces; charging that to the raw pool would say 90 raw were consumed by
--     machining and 85 raw shipped, and leave the 85 finished pieces that
--     actually went out still showing as stock.
--   - Machining attribution takes the 0027 rule, so a result with a NULL owner
--     and a party is credited to that party.
--   - Issued / returned / at-vendor / accepted-return are gone. See point 3.
--   - The part list comes from inward and outward_customer only, with one
--     deterministic unit per part, and a part with no quantity anywhere is not
--     reported at all. See point 4.
--   - Every movement column is date filtered. Balances are LIFETIME and carry no
--     date predicate, because a period balance with no opening figure is not a
--     balance. The screen says so when a range is set.
--   - A balance is never negative. Where a pool was over-drained - material that
--     left with no machining result or no receipt behind it - the shortfall is
--     returned as unaccounted_dispatch instead of being printed as a stock level.
--   - dc_pending_at_vendors is dropped. It filters on outward_self, nothing in the
--     application calls it, and 0025 removed its dashboard counterpart for the
--     same reason.
--
-- Not changed here
-- ================
--
-- app_private.dc_inward_line_available (0026) computes a dispatch cap as
-- `accepted - machining rejection - dispatched`. This migration uses machining
-- *input consumed* instead of machining rejection, because a rejection is already
-- inside the input that was consumed and counting it twice understates the raw
-- pool. The two therefore disagree, and the ledger is the stricter of the two:
-- it reports less raw material than the guard would allow to be dispatched. That
-- is the safe direction for a stock report, and aligning the guard is a separate
-- decision about the dispatch cap rather than about this screen. It is recorded
-- in KNOWN_ISSUES.
--
-- The other 0017 report functions - dc_register, dc_acceptance_rate,
-- dc_rejection_trend, dc_movement_history - share the missing membership guard
-- described in point 6. They are left alone here; the scope agreed for this
-- change was the ledger, and widening it changes access to five more screens.
--
-- Forward-only: one function dropped and recreated, one dropped unused. No table
-- is touched and no row is read or written by this migration.

begin;

-- ---------------------------------------------------------------------------
-- The part list
--
-- Inward and outward only. material_return documents record material going back
-- to the customer and never introduce a part that was not inwarded or dispatched,
-- so counting them is what produced rows of pure zeros.
--
-- min(i.unit) rather than distinct part_number, unit: one row per part, and a
-- part whose unit was typed differently on two challans resolves to one of them
-- instead of appearing twice.
-- ---------------------------------------------------------------------------

create or replace function public._dc_ledger_parts(p_org uuid, p_customer uuid, p_part text)
returns table (part_number text, unit text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select i.part_number, min(i.unit)
  from public.dc_items i
  join public.dc_documents d
    on d.organization_id = i.organization_id and d.id = i.dc_id
  where i.organization_id = p_org
    and d.party_id = p_customer
    and d.dc_type in ('inward', 'outward_customer')
    and d.status not in ('draft', 'cancelled')
    and d.deleted_at is null
    and (p_part is null or i.part_number = p_part)
  group by i.part_number;
$$;

revoke all on function public._dc_ledger_parts(uuid, uuid, text) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- The ledger
--
-- plpgsql rather than sql purely so the membership guard can be written the same
-- way it is in dc_dashboard_summary, dc_inward_lines and dc_job_progress: an
-- absent token is PT401 UNAUTHENTICATED, a real token from the wrong workspace is
-- PT403 FORBIDDEN. 0021 exists precisely because conflating those two produces a
-- message the browser cannot recognise and a tab that never recovers.
--
-- The `_all` columns are the same sums with the date predicate removed. They are
-- carried through the one scan rather than by repeating the join, and they feed
-- the balances and nothing else.
-- ---------------------------------------------------------------------------

drop function if exists public.customer_material_ledger(uuid, uuid, text, date, date);

create function public.customer_material_ledger(
  p_org uuid,
  p_customer_id uuid,
  p_part text default null,
  p_from date default null,
  p_to date default null
)
returns table (
  part_number text,
  unit text,
  declared_total numeric,
  received_total numeric,
  shortage_total numeric,
  excess_total numeric,
  damaged_total numeric,
  accepted_material numeric,
  accepted_finished_inward numeric,
  rejected_material numeric,
  pending_inspection numeric,
  machining_input numeric,
  accepted_output numeric,
  machining_rejection numeric,
  rework_total numeric,
  scrap_total numeric,
  process_loss_total numeric,
  output_unit text,
  unit_conversion boolean,
  dispatched_customer_material numeric,
  dispatched_finished_stock numeric,
  dispatched_total numeric,
  available_customer_material numeric,
  available_finished_stock numeric,
  unaccounted_dispatch numeric,
  ordered_quantity numeric,
  remaining_to_order numeric
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  if not app_private.is_org_member(p_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'you are not a member of this workspace');
  end if;

  if p_customer_id is null then
    perform app_private.raise_validation('customer_id', 'is required');
  end if;

  return query
  with
  inward as (
    select
      i.part_number,
      sum(i.declared_qty) filter (where _dc_in_range(d.dc_date, p_from, p_to)) as declared,
      sum(i.received_qty) filter (where _dc_in_range(d.dc_date, p_from, p_to)) as received,
      sum(i.shortage_qty) filter (where _dc_in_range(d.dc_date, p_from, p_to)) as shortage,
      sum(i.excess_qty) filter (where _dc_in_range(d.dc_date, p_from, p_to)) as excess,
      sum(i.damaged_qty) filter (where _dc_in_range(d.dc_date, p_from, p_to)) as damaged,
      sum(i.accepted_qty) filter (
        where _dc_in_range(d.dc_date, p_from, p_to) and i.supply_source = 'customer_material') as accepted_material,
      sum(i.accepted_qty) filter (
        where _dc_in_range(d.dc_date, p_from, p_to) and i.supply_source = 'finished_stock') as accepted_finished,
      sum(i.rejected_qty) filter (where _dc_in_range(d.dc_date, p_from, p_to)) as rejected,
      sum(i.pending_inspection_qty) filter (where _dc_in_range(d.dc_date, p_from, p_to)) as pending,
      -- Lifetime, no date predicate. These two feed the balances only.
      sum(i.accepted_qty) filter (where i.supply_source = 'customer_material') as accepted_material_all,
      sum(i.accepted_qty) filter (where i.supply_source = 'finished_stock') as accepted_finished_all
    from public.dc_items i
    join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
    where i.organization_id = p_org
      and d.party_id = p_customer_id
      and d.dc_type = 'inward'
      and d.status not in ('draft', 'cancelled')
      and d.deleted_at is null
      and (p_part is null or i.part_number = p_part)
    group by i.part_number
  ),
  machining as (
    select
      r.part_number,
      sum(r.input_quantity) filter (where _dc_in_range(r.operation_date, p_from, p_to)) as input,
      sum(r.accepted_output_quantity) filter (where _dc_in_range(r.operation_date, p_from, p_to)) as accepted_output,
      sum(r.machining_rejection_quantity) filter (where _dc_in_range(r.operation_date, p_from, p_to)) as rejection,
      sum(r.rework_quantity) filter (where _dc_in_range(r.operation_date, p_from, p_to)) as rework,
      sum(r.scrap_quantity) filter (where _dc_in_range(r.operation_date, p_from, p_to)) as scrap,
      sum(r.process_loss_quantity) filter (where _dc_in_range(r.operation_date, p_from, p_to)) as loss,
      max(r.output_unit) as output_unit,
      bool_or(r.unit_conversion) as unit_conversion,
      -- Lifetime. input_all is what actually left the raw pool; output_all is
      -- what arrived in the finished pool.
      sum(r.input_quantity) as input_all,
      sum(r.accepted_output_quantity) as accepted_output_all
    from public.dc_machining_results r
    where r.organization_id = p_org
      -- The 0027 rule. A machining result that names a party but no owner is
      -- credited to that party, which is what a record made on an outward challan
      -- to a customer means.
      and (r.material_owner_id = p_customer_id
           or (r.material_owner_id is null and r.party_id = p_customer_id))
      and (p_part is null or r.part_number = p_part)
    group by r.part_number
  ),
  outward_lines as (
    select
      i.part_number,
      i.qty_dispatched,
      d.dc_date,
      -- Was what went out on this line finished?
      --
      -- Two signals, either of which is enough:
      --
      --   1. The line is declared finished_stock. That is the operator saying
      --      so, in the column they type it into.
      --   2. A machining result is credited to this customer for this part, so
      --      the part has output and the material that went out is that output.
      --      The credit uses the same attribution as the machining CTE below:
      --      an explicit owner, or a party with no owner.
      --
      -- dc_machining_results.source_dc_item_id would make this exact per line,
      -- and is used where it is needed - 0026, 0028 - but it cannot be relied on
      -- here: a machining result filed without naming an outward line carries a
      -- null source_dc_item_id, and relying on it classified 400 genuinely
      -- finished pieces as unprocessed raw. Attribution therefore falls back to
      -- the part.
      --
      -- Limitation, stated rather than hidden: where the same part has both
      -- machined dispatches and unprocessed returns, the split is made at part
      -- level and the raw/finished attribution is approximate. Nothing else in
      -- the schema distinguishes them.
      (i.supply_source = 'finished_stock' or exists (
        select 1
        from public.dc_machining_results r
        where r.organization_id = i.organization_id
          and r.part_number = i.part_number
          and (r.material_owner_id = p_customer_id
               or (r.material_owner_id is null and r.party_id = p_customer_id))
      )) as machined
    from public.dc_items i
    join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
    where i.organization_id = p_org
      and d.party_id = p_customer_id
      and d.dc_type = 'outward_customer'
      and d.status not in ('draft', 'cancelled')
      and d.deleted_at is null
      and (p_part is null or i.part_number = p_part)
  ),
  outward as (
    -- Every column is qualified with `ol`. A `returns table` declaration turns
    -- part_number into a plpgsql variable, and an unqualified reference here
    -- would silently bind to that variable rather than the column, which is how
    -- this function first failed with "column reference part_number is ambiguous".
    select
      ol.part_number,
      sum(ol.qty_dispatched) filter (where _dc_in_range(ol.dc_date, p_from, p_to) and not ol.machined) as dispatched_material,
      sum(ol.qty_dispatched) filter (where _dc_in_range(ol.dc_date, p_from, p_to) and ol.machined) as dispatched_finished,
      sum(ol.qty_dispatched) filter (where _dc_in_range(ol.dc_date, p_from, p_to)) as dispatched_total,
      sum(ol.qty_dispatched) filter (where not ol.machined) as dispatched_material_all,
      sum(ol.qty_dispatched) filter (where ol.machined) as dispatched_finished_all,
      sum(ol.qty_dispatched) as dispatched_all
    from outward_lines ol
    group by ol.part_number
  ),
  orders as (
    select poi.part_number, sum(poi.ordered_quantity) as ordered
    from public.production_order_items poi
    join public.production_orders po
      on po.organization_id = poi.organization_id and po.id = poi.production_order_id
    where poi.organization_id = p_org
      and po.customer_id = p_customer_id
      and po.deleted_at is null
      and (p_part is null or poi.part_number = p_part)
    group by poi.part_number
  ),
  computed as (
    select
      p.part_number,
      p.unit,
      coalesce(nw.declared, 0) as declared_total,
      coalesce(nw.received, 0) as received_total,
      coalesce(nw.shortage, 0) as shortage_total,
      coalesce(nw.excess, 0) as excess_total,
      coalesce(nw.damaged, 0) as damaged_total,
      coalesce(nw.accepted_material, 0) as accepted_material,
      coalesce(nw.accepted_finished, 0) as accepted_finished_inward,
      coalesce(nw.rejected, 0) as rejected_material,
      coalesce(nw.pending, 0) as pending_inspection,
      coalesce(m.input, 0) as machining_input,
      coalesce(m.accepted_output, 0) as accepted_output,
      coalesce(m.rejection, 0) as machining_rejection,
      coalesce(m.rework, 0) as rework_total,
      coalesce(m.scrap, 0) as scrap_total,
      coalesce(m.loss, 0) as process_loss_total,
      m.output_unit as output_unit,
      coalesce(m.unit_conversion, false) as unit_conversion,
      coalesce(oc.dispatched_material, 0) as dispatched_customer_material,
      coalesce(oc.dispatched_finished, 0) as dispatched_finished_stock,
      coalesce(oc.dispatched_total, 0) as dispatched_total,
      -- Two pools, each drained only by what actually left it. Flooring at zero
      -- is deliberate: the shortfall below is the reportable part of the
      -- difference, and a balance is not something that can be negative.
      greatest(
        coalesce(nw.accepted_material_all, 0)
          - coalesce(m.input_all, 0)
          - coalesce(oc.dispatched_material_all, 0),
        0) as available_customer_material,
      greatest(
        coalesce(m.accepted_output_all, 0)
          + coalesce(nw.accepted_finished_all, 0)
          - coalesce(oc.dispatched_finished_all, 0),
        0) as available_finished_stock,
      -- What left the plant with no receipt and no machining result behind it.
      greatest(
        coalesce(m.input_all, 0)
          + coalesce(oc.dispatched_material_all, 0)
          - coalesce(nw.accepted_material_all, 0),
        0)
      + greatest(
        coalesce(oc.dispatched_finished_all, 0)
          - coalesce(m.accepted_output_all, 0)
          - coalesce(nw.accepted_finished_all, 0),
        0) as unaccounted_dispatch,
      coalesce(o.ordered, 0) as ordered_quantity,
      greatest(coalesce(o.ordered, 0) - coalesce(oc.dispatched_all, 0), 0) as remaining_to_order
    from public._dc_ledger_parts(p_org, p_customer_id, p_part) p
    left join inward nw on nw.part_number = p.part_number
    left join machining m on m.part_number = p.part_number
    left join outward oc on oc.part_number = p.part_number
    left join orders o on o.part_number = p.part_number
  )
  select
    c.part_number,
    c.unit,
    c.declared_total,
    c.received_total,
    c.shortage_total,
    c.excess_total,
    c.damaged_total,
    c.accepted_material,
    c.accepted_finished_inward,
    c.rejected_material,
    c.pending_inspection,
    c.machining_input,
    c.accepted_output,
    c.machining_rejection,
    c.rework_total,
    c.scrap_total,
    c.process_loss_total,
    c.output_unit,
    c.unit_conversion,
    c.dispatched_customer_material,
    c.dispatched_finished_stock,
    c.dispatched_total,
    c.available_customer_material,
    c.available_finished_stock,
    c.unaccounted_dispatch,
    c.ordered_quantity,
    c.remaining_to_order
  from computed c
  -- A part with nothing in any bucket is not reported. Before this, a
  -- material_return document alone was enough to put a row of sixteen zeros on
  -- the screen for a part that had never been inwarded.
  where c.declared_total <> 0
     or c.received_total <> 0
     or c.accepted_material <> 0
     or c.accepted_finished_inward <> 0
     or c.rejected_material <> 0
     or c.pending_inspection <> 0
     or c.machining_input <> 0
     or c.accepted_output <> 0
     or c.machining_rejection <> 0
     or c.rework_total <> 0
     or c.scrap_total <> 0
     or c.process_loss_total <> 0
     or c.dispatched_total <> 0
     or c.available_customer_material <> 0
     or c.available_finished_stock <> 0
     or c.unaccounted_dispatch <> 0
     or c.ordered_quantity <> 0
  order by c.part_number;
end;
$$;

revoke all on function public.customer_material_ledger(uuid, uuid, text, date, date) from public, anonymous;
grant execute on function public.customer_material_ledger(uuid, uuid, text, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Dead report
--
-- dc_pending_at_vendors filters on dc_type = 'outward_self', which 0024 removed
-- from the documents table. No function in the application calls it; it is
-- referenced nowhere in src/. 0025 removed the matching dashboard summary fields
-- for the same reason. Dropping a report function cannot lose anything - it holds
-- no rows and no state.
-- ---------------------------------------------------------------------------

drop function if exists public.dc_pending_at_vendors(uuid);

commit;