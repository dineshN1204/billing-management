-- ---------------------------------------------------------------------------
-- 0051: immutable-column guards for DC tables
--
-- The core billing tables (0002) guard id, organization_id and created_at from
-- being changed on UPDATE via the b_immutable_columns trigger. The DC schema
-- (0013/0014) was added without those triggers, so the 10 tables below — all of
-- which carry id, organization_id and created_at — were updatable in those
-- columns. This adds the same guard, so the DC data enjoys the same
-- immutability guarantee as the core data.
--
-- No new columns, no RLS change; purely a BEFORE UPDATE integrity trigger.
-- ---------------------------------------------------------------------------
begin;

create trigger b_immutable_columns before update on public.dc_documents for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.dc_inspections for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.dc_items for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.dc_machining_results for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.dc_movements for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.dc_options for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.dc_rejections for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.job_work_orders for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.production_order_items for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.production_orders for each row execute function app_private.enforce_immutable_columns();

commit;
