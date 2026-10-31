-- ---------------------------------------------------------------------------
-- 0024 - remove the outward self delivery challan
--
-- The outward self challan (material dispatched to a processing vendor, or
-- between our own locations) is no longer part of how this business records
-- movement, and the records were asked to go with the feature. This migration
-- removes the type end to end:
--
--   1. Every outward self document and everything hanging from it. Line items,
--      movements, inspections and rejections cascade from dc_documents;
--      machining results reference the document without a cascade, so they are
--      deleted first.
--   2. The numbering and configuration rows for the OUT-S series.
--   3. The three RPCs that could only ever act on an outward self challan:
--      save_outward_self_dc, record_vendor_return and issue_material.
--   4. The check constraints on documents, number sequences and settings, so
--      the type can never be written again.
--
-- The data deletion is irreversible by design. audit_logs entries naming the
-- deleted records are deliberately kept: audit history stays complete even
-- when the record it describes is gone.
--
-- Reporting functions defined in 0017 that filtered on dc_type = 'outward_self'
-- are corrected by 0033, which rewrites customer_material_ledger and drops
-- dc_pending_at_vendors. Nothing else in the reporting set reads that type.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The settings seeder
--
-- app_private.dc_seed_options (0016) inserts one dc_settings row per document
-- type, and app_private.dc_save_document calls it on every save. It still listed
-- outward_self, so the insert violated the dc_settings_type_check constraint
-- this migration tightens, and **every document save failed**:
--
--     new row for relation "dc_settings" violates check constraint
--     "dc_settings_type_check"
--
-- This went unnoticed for as long as it did because this migration had never
-- been applied anywhere - it could not get past the append-only triggers, so the
-- constraint it adds had never actually rejected anything.
-- ---------------------------------------------------------------------------

create or replace function app_private.dc_seed_options(p_org uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.dc_settings (organization_id, dc_type, prefix, segment_code, padding)
  values
    (p_org, 'inward', 'KI', 'IN', 4),
    (p_org, 'outward_customer', 'KI', 'OUT-C', 4),
    (p_org, 'material_return', 'KI', 'RET', 4)
  on conflict (organization_id, dc_type) do nothing;

  insert into public.dc_options (organization_id, option_group, option_value, sort_order)
  select p_org, seed.group_name, seed.value, seed.position
  from (values
    ('mot', 'Customer Vehicle', 1), ('mot', 'Company Vehicle', 2),
    ('mot', 'Third-Party Transport', 3), ('mot', 'Courier', 4),
    ('mot', 'Parcel Service', 5), ('mot', 'Other', 6),
    ('destination_type', 'Subcontractor', 1), ('destination_type', 'Supplier', 2),
    ('destination_type', 'Testing Laboratory', 3), ('destination_type', 'Heat Treatment Vendor', 4),
    ('destination_type', 'Plating Vendor', 5), ('destination_type', 'Grinding Vendor', 6),
    ('destination_type', 'Other Processing Vendor', 7), ('destination_type', 'Company Location', 8),
    ('destination_type', 'Other Authorized Destination', 9),
    ('processing_operation', 'CNC Turning', 1), ('processing_operation', 'VMC Machining', 2),
    ('processing_operation', 'Grinding', 3), ('processing_operation', 'Drilling', 4),
    ('processing_operation', 'Threading', 5), ('processing_operation', 'Heat Treatment', 6),
    ('processing_operation', 'Surface Treatment', 7), ('processing_operation', 'Plating', 8),
    ('processing_operation', 'Inspection', 9), ('processing_operation', 'Other', 10),
    ('rejection_reason', 'Dimensional Out of Tolerance', 1),
    ('rejection_reason', 'Surface Finish Failure', 2),
    ('rejection_reason', 'Thread Defect', 3),
    ('rejection_reason', 'Wrong Dimension', 4),
    ('rejection_reason', 'Tool Damage', 5),
    ('rejection_reason', 'Material Defect Discovered During Machining', 6),
    ('rejection_reason', 'Handling Damage', 7),
    ('rejection_reason', 'Shortage', 8), ('rejection_reason', 'Other', 9),
    ('disposition', 'Return to Customer', 1), ('disposition', 'Return to Supplier', 2),
    ('disposition', 'Rework', 3), ('disposition', 'Hold for Customer Decision', 4),
    ('disposition', 'Scrap', 5), ('disposition', 'Other Approved Disposition', 6),
    ('unit', 'NOS', 1), ('unit', 'Kg', 2), ('unit', 'Meter', 3), ('unit', 'Gram', 4),
    ('unit', 'Liter', 5), ('unit', 'Set', 6), ('unit', 'Pair', 7), ('unit', 'Litre', 8),
    ('receipt_type', 'Raw Material', 1), ('receipt_type', 'Customer Owned Component', 2),
    ('receipt_type', 'Semi-Finished Component', 3), ('receipt_type', 'Return from Processing', 4),
    ('receipt_type', 'For Inspection', 5), ('receipt_type', 'For Rework', 6),
    ('movement_type', 'Subcontracting', 1), ('movement_type', 'Inter-Company Transfer', 2),
    ('movement_type', 'Return to Supplier', 3), ('movement_type', 'Testing', 4),
    ('movement_type', 'Inspection', 5), ('movement_type', 'Other', 6),
    ('delivery_purpose', 'Finished Goods', 1), ('delivery_purpose', 'Partially Processed', 2),
    ('delivery_purpose', 'Approved Sample', 3), ('delivery_purpose', 'Customer Inspection', 4),
    ('delivery_purpose', 'Replacement', 5), ('delivery_purpose', 'Rework', 6),
    ('delivery_purpose', 'Other', 7)
  ) as seed(group_name, value, position)
  on conflict (organization_id, option_group, lower(option_value)) do nothing;
end;
$$;

revoke all on function app_private.dc_seed_options(uuid) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- The append-only guards
--
-- 0014 puts an append-only trigger on three tables this migration deletes from:
--
--   dc_machining_results   deleted explicitly below
--   dc_inspections         reached through ON DELETE CASCADE
--   dc_movements           reached through ON DELETE CASCADE
--
-- PostgreSQL fires row triggers for a cascaded delete, so all three refuse the
-- statement. A migration running as the table owner has already defeated the
-- guard - it is there to stop casual deletion through the Data API, not a
-- superuser migration - and re-enabling inside the same transaction restores it
-- for every other session. It was never re-enabled before, because the statement
-- aborted the migration on its first error.
-- ---------------------------------------------------------------------------

alter table public.dc_machining_results disable trigger dc_machining_results_append_only;
alter table public.dc_inspections       disable trigger dc_inspections_append_only;
alter table public.dc_movements          disable trigger dc_movements_append_only;

-- Machining results hold a plain reference to the document and its items, with
-- no cascade, so they have to go before the documents they point at.
delete from public.dc_machining_results m
using public.dc_documents d
where m.organization_id = d.organization_id
  and d.dc_type = 'outward_self'
  and (
    m.source_dc_id = d.id
    or m.source_dc_item_id in (
      select i.id from public.dc_items i
      where i.organization_id = d.organization_id and i.dc_id = d.id
    )
  );

-- The documents themselves. dc_items, dc_movements, dc_inspections and
-- dc_rejections all carry 'on delete cascade' from dc_documents, so this one
-- statement removes the whole challan.
delete from public.dc_documents d
where d.dc_type = 'outward_self';

alter table public.dc_movements          enable trigger dc_movements_append_only;
alter table public.dc_inspections       enable trigger dc_inspections_append_only;
alter table public.dc_machining_results enable trigger dc_machining_results_append_only;

-- The number series and the workspace configuration for it.
delete from public.dc_number_sequences where dc_type = 'outward_self';
delete from public.dc_settings where dc_type = 'outward_self';

-- Entry points that could create or move outward self material.
drop function if exists public.save_outward_self_dc(jsonb);
drop function if exists public.record_vendor_return(jsonb);
drop function if exists public.issue_material(jsonb);

-- Constraints: the type is gone from the documents, the series and the settings.
alter table public.dc_documents
  drop constraint if exists dc_documents_type_check;
alter table public.dc_documents
  add constraint dc_documents_type_check
  check (dc_type in ('inward', 'outward_customer', 'material_return'));

alter table public.dc_number_sequences
  drop constraint if exists dc_number_sequences_type_check;
alter table public.dc_number_sequences
  add constraint dc_number_sequences_type_check
  check (dc_type in ('inward', 'outward_customer', 'material_return'));

alter table public.dc_settings
  drop constraint if exists dc_settings_type_check;
alter table public.dc_settings
  add constraint dc_settings_type_check
  check (dc_type in ('inward', 'outward_customer', 'material_return'));

-- The default numbering segment no longer knows the OUT-S series.
create or replace function app_private.dc_default_segment(p_dc_type text)
returns text
language sql
immutable
as $$
  select case p_dc_type
    when 'inward' then 'IN'
    when 'outward_customer' then 'OUT-C'
    when 'material_return' then 'RET'
  end;
$$;

revoke all on function app_private.dc_default_segment(text) from public, anonymous, authenticated;

-- The settings RPC no longer accepts the removed type either.
create or replace function public.dc_update_settings(payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;
  v_org := app_private.parse_uuid(payload -> 'organization_id', 'organization_id', true);
  if not app_private.is_org_admin(v_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'only administrators can change document numbering');
  end if;

  perform app_private.dc_seed_options(v_org);

  update public.dc_settings s
  set prefix = app_private.parse_text(payload -> 'prefix', 'prefix', true, 16),
      segment_code = upper(coalesce(app_private.parse_text(payload -> 'segment_code', 'segment_code', true, 16), s.segment_code)),
      padding = coalesce(app_private.parse_numeric(payload -> 'padding', 'padding', false, 0, 1, 10), s.padding)::integer,
      updated_by = v_uid,
      updated_at = now()
  where s.organization_id = v_org
    and s.dc_type = app_private.parse_enum(payload -> 'dc_type', 'dc_type',
      array['inward', 'outward_customer', 'material_return'], null);

  return (select to_jsonb(x) - 'updated_at' from public.dc_settings x
          where x.organization_id = v_org
          order by x.dc_type);
end;
$$;

revoke all on function public.dc_update_settings(jsonb) from public, anonymous;
grant execute on function public.dc_update_settings(jsonb) to authenticated;