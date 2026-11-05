-- ---------------------------------------------------------------------------
-- 0053: restore the intended dc_available_balance body
--
-- The test branch executes the pre-0027 body of app_private.dc_available_balance:
-- the customer_material pool deducts outward_self terms (a document type that
-- 0024 deleted, so they are permanently zero) and has no part-number filter. The
-- pool therefore never moves when customer material is dispatched, and summing
-- across parts over-states it. Migration 0027 carries the correct body, but a
-- recorded migration never re-runs, so the stale body persists on branches that
-- compiled an earlier revision of 0027.
--
-- This migration re-issues the 0027 body as a forward-only replacement. It
-- changes no data and nothing else; it only restores the intended function.
--
-- The customer_material pool is
--
--     sum(inward accepted_qty) - sum(outward_customer qty_dispatched)
--
-- filtered by party, part and supply_source, excluding draft/cancelled docs.
-- Machining rejection is deliberately NOT subtracted here: it is subtracted
-- once per inward line by app_private.dc_inward_line_available (0026), and a
-- line that has a source is guarded by that per-line figure.
-- ---------------------------------------------------------------------------
begin;

create or replace function app_private.dc_available_balance(
  p_org uuid,
  p_party uuid,
  p_part text,
  p_supply_source text
)
returns numeric
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_balance numeric := 0;
begin
  if p_supply_source = 'finished_stock' then
    select
      coalesce((select sum(m.accepted_output_quantity)
                from public.dc_machining_results m
                where m.organization_id = p_org
                  and m.part_number = p_part
                  and (m.material_owner_id = p_party
                       or (m.material_owner_id is null and m.party_id = p_party))), 0)
      + coalesce((select sum(i.accepted_qty)
                  from public.dc_items i
                  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
                  where i.organization_id = p_org
                    and d.party_id = p_party
                    and d.dc_type = 'inward'
                    and i.supply_source = 'finished_stock'
                    and d.status not in ('draft', 'cancelled')
                    and d.deleted_at is null), 0)
      - coalesce((select sum(i.qty_dispatched)
                  from public.dc_items i
                  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
                  where i.organization_id = p_org
                    and d.party_id = p_party
                    and d.dc_type = 'outward_customer'
                    and i.supply_source = 'finished_stock'
                    and d.status not in ('draft', 'cancelled')
                    and d.deleted_at is null), 0)
    into v_balance;

  elsif p_supply_source = 'customer_material' then
    select
      coalesce((select sum(i.accepted_qty)
                from public.dc_items i
                join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
                where i.organization_id = p_org
                  and d.party_id = p_party
                  and d.dc_type = 'inward'
                  and i.supply_source = 'customer_material'
                  and i.part_number = p_part
                  and d.status not in ('draft', 'cancelled')
                  and d.deleted_at is null), 0)
      - coalesce((select sum(i.qty_dispatched)
                  from public.dc_items i
                  join public.dc_documents d on d.organization_id = i.organization_id and d.id = i.dc_id
                  where i.organization_id = p_org
                    and d.party_id = p_party
                    and d.dc_type = 'outward_customer'
                    and i.supply_source = 'customer_material'
                    and i.part_number = p_part
                    and d.status not in ('draft', 'cancelled')
                    and d.deleted_at is null), 0)
    into v_balance;
  end if;

  return coalesce(v_balance, 0);
end;
$$;

revoke all on function app_private.dc_available_balance(uuid, uuid, text, text)
  from public, anonymous, authenticated;

commit;
