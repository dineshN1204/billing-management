-- 0015: Delivery Challan security — grants, RLS policies and write restrictions.
--
-- The rule that shapes this file: **clients read, the database writes.**
--
-- Every quantity that moves material is changed by a SECURITY DEFINER RPC in
-- 0016. So the dc_* tables grant SELECT only — there is no INSERT, UPDATE or
-- DELETE privilege for the authenticated role on any of them, and therefore no
-- path by which a crafted request can set accepted_qty or qty_dispatched to an
-- arbitrary value. Form validation in the browser is a convenience; this is the
-- control.

revoke all on public.dc_number_sequences from public, anonymous, authenticated;
revoke all on public.dc_documents from public, anonymous, authenticated;
revoke all on public.dc_items from public, anonymous, authenticated;
revoke all on public.dc_inspections from public, anonymous, authenticated;
revoke all on public.dc_rejections from public, anonymous, authenticated;
revoke all on public.dc_machining_results from public, anonymous, authenticated;
revoke all on public.dc_movements from public, anonymous, authenticated;
revoke all on public.dc_settings from public, anonymous, authenticated;
revoke all on public.dc_options from public, anonymous, authenticated;
revoke all on public.production_orders from public, anonymous, authenticated;
revoke all on public.production_order_items from public, anonymous, authenticated;
revoke all on public.job_work_orders from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- Read access
-- ---------------------------------------------------------------------------

grant select on public.dc_documents to authenticated;
grant select on public.dc_items to authenticated;
grant select on public.dc_inspections to authenticated;
grant select on public.dc_rejections to authenticated;
grant select on public.dc_machining_results to authenticated;
grant select on public.dc_movements to authenticated;
grant select on public.dc_settings to authenticated;
grant select on public.dc_options to authenticated;

grant select on public.production_orders to authenticated;
grant select on public.production_order_items to authenticated;
grant select on public.job_work_orders to authenticated;

-- Orders are ordinary master data maintained from the screen, like customers.
grant insert (organization_id, order_number, customer_id, order_date, required_date, status, remarks)
  on public.production_orders to authenticated;
grant update (order_number, customer_id, order_date, required_date, status, remarks, deleted_at, deleted_by)
  on public.production_orders to authenticated;
grant delete on public.production_orders to authenticated;

grant insert (organization_id, production_order_id, line_no, product_id, part_number, description, unit, ordered_quantity, remarks)
  on public.production_order_items to authenticated;
grant update (line_no, product_id, part_number, description, unit, ordered_quantity, remarks)
  on public.production_order_items to authenticated;
grant delete on public.production_order_items to authenticated;

grant insert (organization_id, job_number, party_id, production_order_id, operation, quantity_issued, unit, issued_date, expected_return_date, status, remarks)
  on public.job_work_orders to authenticated;
grant update (job_number, party_id, production_order_id, operation, quantity_issued, unit, issued_date, expected_return_date, status, remarks, deleted_at, deleted_by)
  on public.job_work_orders to authenticated;
grant delete on public.job_work_orders to authenticated;

-- ---------------------------------------------------------------------------
-- RLS policies
--
-- Same shape as 0002: members read their own organization, writers need
-- can_write, deletion needs admin. dc_documents and below have SELECT only, so
-- only the read policies exist for them.
-- ---------------------------------------------------------------------------

drop policy if exists dc_documents_select on public.dc_documents;
create policy dc_documents_select on public.dc_documents
  for select to authenticated
  using (app_private.is_org_member(organization_id));

drop policy if exists dc_items_select on public.dc_items;
create policy dc_items_select on public.dc_items
  for select to authenticated
  using (app_private.is_org_member(organization_id));

drop policy if exists dc_inspections_select on public.dc_inspections;
create policy dc_inspections_select on public.dc_inspections
  for select to authenticated
  using (app_private.is_org_member(organization_id));

drop policy if exists dc_rejections_select on public.dc_rejections;
create policy dc_rejections_select on public.dc_rejections
  for select to authenticated
  using (app_private.is_org_member(organization_id));

drop policy if exists dc_machining_results_select on public.dc_machining_results;
create policy dc_machining_results_select on public.dc_machining_results
  for select to authenticated
  using (app_private.is_org_member(organization_id));

drop policy if exists dc_movements_select on public.dc_movements;
create policy dc_movements_select on public.dc_movements
  for select to authenticated
  using (app_private.is_org_member(organization_id));

drop policy if exists dc_settings_select on public.dc_settings;
create policy dc_settings_select on public.dc_settings
  for select to authenticated
  using (app_private.is_org_member(organization_id));

drop policy if exists dc_options_select on public.dc_options;
create policy dc_options_select on public.dc_options
  for select to authenticated
  using (app_private.is_org_member(organization_id));

drop policy if exists production_orders_select on public.production_orders;
create policy production_orders_select on public.production_orders
  for select to authenticated
  using (
    app_private.is_org_member(organization_id)
    and (deleted_at is null or app_private.is_org_admin(organization_id))
  );

drop policy if exists production_orders_insert on public.production_orders;
create policy production_orders_insert on public.production_orders
  for insert to authenticated
  with check (app_private.can_write(organization_id) and deleted_at is null);

drop policy if exists production_orders_update on public.production_orders;
create policy production_orders_update on public.production_orders
  for update to authenticated
  using (
    app_private.can_write(organization_id)
    and (deleted_at is null or app_private.is_org_admin(organization_id))
  )
  with check (app_private.can_write(organization_id));

drop policy if exists production_order_items_select on public.production_order_items;
create policy production_order_items_select on public.production_order_items
  for select to authenticated
  using (app_private.is_org_member(organization_id));

drop policy if exists production_order_items_insert on public.production_order_items;
create policy production_order_items_insert on public.production_order_items
  for insert to authenticated
  with check (app_private.can_write(organization_id));

drop policy if exists production_order_items_update on public.production_order_items;
create policy production_order_items_update on public.production_order_items
  for update to authenticated
  using (app_private.can_write(organization_id))
  with check (app_private.can_write(organization_id));

drop policy if exists production_order_items_delete on public.production_order_items;
create policy production_order_items_delete on public.production_order_items
  for delete to authenticated
  using (app_private.can_write(organization_id));

drop policy if exists job_work_orders_select on public.job_work_orders;
create policy job_work_orders_select on public.job_work_orders
  for select to authenticated
  using (
    app_private.is_org_member(organization_id)
    and (deleted_at is null or app_private.is_org_admin(organization_id))
  );

drop policy if exists job_work_orders_insert on public.job_work_orders;
create policy job_work_orders_insert on public.job_work_orders
  for insert to authenticated
  with check (app_private.can_write(organization_id) and deleted_at is null);

drop policy if exists job_work_orders_update on public.job_work_orders;
create policy job_work_orders_update on public.job_work_orders
  for update to authenticated
  using (
    app_private.can_write(organization_id)
    and (deleted_at is null or app_private.is_org_admin(organization_id))
  )
  with check (app_private.can_write(organization_id));