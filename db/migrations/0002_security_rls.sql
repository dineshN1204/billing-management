do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anonymous') then
    create role anonymous nologin;
  end if;
end
$$;

revoke all on schema app_private from public, anonymous;
grant usage on schema app_private to authenticated;
grant usage on schema public to authenticated;
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema app_private to service_role';
  end if;
end
$$;

create function app_private.is_org_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.memberships m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = p_org
      and m.user_id = auth.uid()
      and o.deleted_at is null
  );
$$;

create function app_private.has_org_role(p_org uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.memberships m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = p_org
      and m.user_id = auth.uid()
      and m.role = any (p_roles)
      and o.deleted_at is null
  );
$$;

create function app_private.can_write(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select app_private.has_org_role(p_org, array['admin', 'staff']);
$$;

create function app_private.is_org_admin(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select app_private.has_org_role(p_org, array['admin']);
$$;

create function app_private.shares_org_with(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.memberships mine
    join public.memberships theirs on theirs.organization_id = mine.organization_id
    join public.organizations o on o.id = mine.organization_id
    where mine.user_id = auth.uid()
      and theirs.user_id = p_user
      and o.deleted_at is null
  );
$$;

create function app_private.storage_path_org(p_name text)
returns uuid
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when p_name is not null
      and position('/' in p_name) > 1
      and p_name !~ '(^|/)\.\.(/|$)'
      and split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(p_name, '/', 1)::uuid
  end;
$$;

create function app_private.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create function app_private.enforce_immutable_columns()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.id is distinct from old.id
    or new.created_at is distinct from old.created_at
    or (to_jsonb(new) ->> 'organization_id') is distinct from (to_jsonb(old) ->> 'organization_id')
  then
    raise exception using
      errcode = '42501',
      message = 'IMMUTABLE_COLUMN: id, organization_id and created_at cannot be changed';
  end if;
  return new;
end;
$$;

create function app_private.guard_soft_delete()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.deleted_at is distinct from old.deleted_at
    and auth.uid() is not null
    and not app_private.is_org_admin(old.organization_id)
  then
    raise exception using
      errcode = '42501',
      message = 'FORBIDDEN: only organization admins can delete or restore records';
  end if;
  return new;
end;
$$;

create function app_private.guard_last_admin()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if old.role = 'admin'
    and (tg_op = 'DELETE' or new.role <> 'admin')
    and not exists (
      select 1
      from public.memberships m
      where m.organization_id = old.organization_id
        and m.role = 'admin'
        and m.id <> old.id
    )
  then
    raise exception using
      errcode = 'PT409',
      message = 'LAST_ADMIN: an organization must keep at least one admin',
      detail = jsonb_build_object('code', 'LAST_ADMIN', 'organization_id', old.organization_id)::text;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create function app_private.write_audit_row()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    v_row := v_new;
    v_action := 'INSERT';
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    if v_old = v_new then
      return null;
    end if;
    v_row := v_new;
    v_action := 'UPDATE';
    if (v_old ->> 'deleted_at') is null and (v_new ->> 'deleted_at') is not null then
      v_action := 'SOFT_DELETE';
    elsif (v_old ->> 'deleted_at') is not null and (v_new ->> 'deleted_at') is null then
      v_action := 'RESTORE';
    end if;
  else
    v_old := to_jsonb(old);
    v_row := v_old;
    v_action := 'DELETE';
  end if;

  insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, old_data, new_data)
  values (
    case when tg_table_name = 'organizations' then (v_row ->> 'id')::uuid else (v_row ->> 'organization_id')::uuid end,
    auth.uid(),
    v_action,
    tg_table_name,
    (v_row ->> 'id')::uuid,
    v_old,
    v_new
  );
  return null;
end;
$$;

create function app_private.block_audit_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using
    errcode = '42501',
    message = 'IMMUTABLE_TABLE: audit_logs is append-only';
end;
$$;

create trigger a_set_updated_at before update on public.organizations for each row execute function app_private.set_updated_at();
create trigger a_set_updated_at before update on public.profiles for each row execute function app_private.set_updated_at();
create trigger a_set_updated_at before update on public.memberships for each row execute function app_private.set_updated_at();
create trigger a_set_updated_at before update on public.customers for each row execute function app_private.set_updated_at();
create trigger a_set_updated_at before update on public.products for each row execute function app_private.set_updated_at();
create trigger a_set_updated_at before update on public.import_batches for each row execute function app_private.set_updated_at();
create trigger a_set_updated_at before update on public.bills for each row execute function app_private.set_updated_at();
create trigger a_set_updated_at before update on public.bill_items for each row execute function app_private.set_updated_at();
create trigger a_set_updated_at before update on public.bill_attachments for each row execute function app_private.set_updated_at();
create trigger a_set_updated_at before update on public.ocr_jobs for each row execute function app_private.set_updated_at();

create trigger b_immutable_columns before update on public.organizations for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.profiles for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.memberships for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.customers for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.products for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.import_batches for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.bills for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.bill_items for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.bill_attachments for each row execute function app_private.enforce_immutable_columns();
create trigger b_immutable_columns before update on public.ocr_jobs for each row execute function app_private.enforce_immutable_columns();

create trigger c_guard_soft_delete before update on public.customers for each row execute function app_private.guard_soft_delete();
create trigger c_guard_soft_delete before update on public.products for each row execute function app_private.guard_soft_delete();
create trigger c_guard_soft_delete before update on public.import_batches for each row execute function app_private.guard_soft_delete();
create trigger c_guard_soft_delete before update on public.bill_attachments for each row execute function app_private.guard_soft_delete();
create trigger c_guard_soft_delete before update on public.ocr_jobs for each row execute function app_private.guard_soft_delete();

create trigger c_guard_last_admin before update or delete on public.memberships for each row execute function app_private.guard_last_admin();

create trigger z_audit after insert or update or delete on public.organizations for each row execute function app_private.write_audit_row();
create trigger z_audit after insert or update or delete on public.memberships for each row execute function app_private.write_audit_row();
create trigger z_audit after insert or update or delete on public.customers for each row execute function app_private.write_audit_row();
create trigger z_audit after insert or update or delete on public.products for each row execute function app_private.write_audit_row();
create trigger z_audit after insert or update or delete on public.import_batches for each row execute function app_private.write_audit_row();
create trigger z_audit after insert or update or delete on public.bills for each row execute function app_private.write_audit_row();
create trigger z_audit after insert or update or delete on public.bill_items for each row execute function app_private.write_audit_row();
create trigger z_audit after insert or update or delete on public.bill_attachments for each row execute function app_private.write_audit_row();
create trigger z_audit after insert or update or delete on public.ocr_jobs for each row execute function app_private.write_audit_row();

create trigger block_audit_update before update or delete on public.audit_logs for each row execute function app_private.block_audit_mutation();
create trigger block_audit_truncate before truncate on public.audit_logs for each statement execute function app_private.block_audit_mutation();

revoke all on function app_private.is_org_member(uuid) from public, anonymous;
revoke all on function app_private.has_org_role(uuid, text[]) from public, anonymous;
revoke all on function app_private.can_write(uuid) from public, anonymous;
revoke all on function app_private.is_org_admin(uuid) from public, anonymous;
revoke all on function app_private.shares_org_with(uuid) from public, anonymous;
revoke all on function app_private.storage_path_org(text) from public, anonymous;
revoke all on function app_private.set_updated_at() from public, anonymous, authenticated;
revoke all on function app_private.enforce_immutable_columns() from public, anonymous, authenticated;
revoke all on function app_private.guard_soft_delete() from public, anonymous, authenticated;
revoke all on function app_private.guard_last_admin() from public, anonymous, authenticated;
revoke all on function app_private.write_audit_row() from public, anonymous, authenticated;
revoke all on function app_private.block_audit_mutation() from public, anonymous, authenticated;

grant execute on function app_private.is_org_member(uuid) to authenticated;
grant execute on function app_private.has_org_role(uuid, text[]) to authenticated;
grant execute on function app_private.can_write(uuid) to authenticated;
grant execute on function app_private.is_org_admin(uuid) to authenticated;
grant execute on function app_private.shares_org_with(uuid) to authenticated;
grant execute on function app_private.storage_path_org(text) to authenticated;

revoke all on all tables in schema public from public, anonymous, authenticated;
revoke all on all sequences in schema public from public, anonymous, authenticated;

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.memberships enable row level security;
alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.import_batches enable row level security;
alter table public.bills enable row level security;
alter table public.bill_items enable row level security;
alter table public.bill_attachments enable row level security;
alter table public.ocr_jobs enable row level security;
alter table public.audit_logs enable row level security;
alter table public.storage_objects enable row level security;

grant select on public.organizations to authenticated;
grant update (name, gstin, state_code, address, phone, email) on public.organizations to authenticated;

grant select on public.profiles to authenticated;
grant insert (id, full_name, default_organization_id) on public.profiles to authenticated;
grant update (full_name, default_organization_id) on public.profiles to authenticated;

grant select on public.memberships to authenticated;
grant update (role) on public.memberships to authenticated;
grant delete on public.memberships to authenticated;

grant select on public.customers to authenticated;
grant insert (organization_id, name, gstin, phone, email, address, state_code, notes) on public.customers to authenticated;
grant update (name, gstin, phone, email, address, state_code, notes, deleted_at) on public.customers to authenticated;

grant select on public.products to authenticated;
grant insert (organization_id, name, product_code, hsn_code, unit, default_rate, gst_rate, description) on public.products to authenticated;
grant update (name, product_code, hsn_code, unit, default_rate, gst_rate, description, deleted_at) on public.products to authenticated;

grant select on public.import_batches to authenticated;
grant insert (organization_id, file_name, status, total_rows, success_rows, failed_rows, errors, metadata) on public.import_batches to authenticated;
grant update (file_name, status, total_rows, success_rows, failed_rows, errors, metadata, completed_at, deleted_at) on public.import_batches to authenticated;

grant select on public.bills to authenticated;
grant select on public.bill_items to authenticated;

grant select on public.bill_attachments to authenticated;
grant insert (organization_id, bill_id, file_path, file_name, mime_type, size_bytes) on public.bill_attachments to authenticated;
grant update (deleted_at) on public.bill_attachments to authenticated;

grant select on public.ocr_jobs to authenticated;
grant insert (organization_id, file_path, status, staging, engine, confidence) on public.ocr_jobs to authenticated;
grant update (status, staging, engine, confidence, error_message, completed_at, deleted_at) on public.ocr_jobs to authenticated;

grant select on public.audit_logs to authenticated;

grant select on public.storage_objects to authenticated;
grant insert (organization_id, object_path, content_type, size_bytes) on public.storage_objects to authenticated;
grant update (content_type, size_bytes) on public.storage_objects to authenticated;

create policy organizations_select on public.organizations
  for select to authenticated
  using (app_private.is_org_member(id));

create policy organizations_update on public.organizations
  for update to authenticated
  using (app_private.is_org_admin(id))
  with check (app_private.is_org_admin(id));

create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or app_private.shares_org_with(id));

create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (
    id = (select auth.uid())
    and (default_organization_id is null or app_private.is_org_member(default_organization_id))
  );

create policy profiles_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (
    id = (select auth.uid())
    and (default_organization_id is null or app_private.is_org_member(default_organization_id))
  );

create policy memberships_select on public.memberships
  for select to authenticated
  using (app_private.is_org_member(organization_id));

create policy memberships_update on public.memberships
  for update to authenticated
  using (app_private.is_org_admin(organization_id))
  with check (app_private.is_org_admin(organization_id));

create policy memberships_delete on public.memberships
  for delete to authenticated
  using (app_private.is_org_admin(organization_id));

create policy customers_select on public.customers
  for select to authenticated
  using (
    app_private.is_org_member(organization_id)
    and (deleted_at is null or app_private.is_org_admin(organization_id))
  );

create policy customers_insert on public.customers
  for insert to authenticated
  with check (app_private.can_write(organization_id) and deleted_at is null);

create policy customers_update on public.customers
  for update to authenticated
  using (
    app_private.can_write(organization_id)
    and (deleted_at is null or app_private.is_org_admin(organization_id))
  )
  with check (app_private.can_write(organization_id));

create policy products_select on public.products
  for select to authenticated
  using (
    app_private.is_org_member(organization_id)
    and (deleted_at is null or app_private.is_org_admin(organization_id))
  );

create policy products_insert on public.products
  for insert to authenticated
  with check (app_private.can_write(organization_id) and deleted_at is null);

create policy products_update on public.products
  for update to authenticated
  using (
    app_private.can_write(organization_id)
    and (deleted_at is null or app_private.is_org_admin(organization_id))
  )
  with check (app_private.can_write(organization_id));

create policy import_batches_select on public.import_batches
  for select to authenticated
  using (
    app_private.is_org_member(organization_id)
    and (deleted_at is null or app_private.is_org_admin(organization_id))
  );

create policy import_batches_insert on public.import_batches
  for insert to authenticated
  with check (app_private.can_write(organization_id));

create policy import_batches_update on public.import_batches
  for update to authenticated
  using (
    app_private.can_write(organization_id)
    and (deleted_at is null or app_private.is_org_admin(organization_id))
  )
  with check (app_private.can_write(organization_id));

create policy bills_select on public.bills
  for select to authenticated
  using (
    app_private.is_org_member(organization_id)
    and (deleted_at is null or app_private.is_org_admin(organization_id))
  );

create policy bill_items_select on public.bill_items
  for select to authenticated
  using (
    app_private.is_org_member(organization_id)
    and exists (
      select 1
      from public.bills b
      where b.id = bill_items.bill_id
        and b.organization_id = bill_items.organization_id
    )
  );

create policy bill_attachments_select on public.bill_attachments
  for select to authenticated
  using (
    app_private.is_org_member(organization_id)
    and (deleted_at is null or app_private.is_org_admin(organization_id))
    and exists (
      select 1
      from public.bills b
      where b.id = bill_attachments.bill_id
        and b.organization_id = bill_attachments.organization_id
    )
  );

create policy bill_attachments_insert on public.bill_attachments
  for insert to authenticated
  with check (
    app_private.can_write(organization_id)
    and exists (
      select 1
      from public.bills b
      where b.id = bill_attachments.bill_id
        and b.organization_id = bill_attachments.organization_id
        and b.deleted_at is null
    )
  );

create policy bill_attachments_update on public.bill_attachments
  for update to authenticated
  using (
    app_private.can_write(organization_id)
    and (deleted_at is null or app_private.is_org_admin(organization_id))
  )
  with check (app_private.can_write(organization_id));

create policy ocr_jobs_select on public.ocr_jobs
  for select to authenticated
  using (
    app_private.is_org_member(organization_id)
    and (deleted_at is null or app_private.is_org_admin(organization_id))
  );

create policy ocr_jobs_insert on public.ocr_jobs
  for insert to authenticated
  with check (app_private.can_write(organization_id));

create policy ocr_jobs_update on public.ocr_jobs
  for update to authenticated
  using (
    app_private.can_write(organization_id)
    and (deleted_at is null or app_private.is_org_admin(organization_id))
  )
  with check (app_private.can_write(organization_id));

create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (organization_id is not null and app_private.is_org_admin(organization_id));

create policy storage_objects_select on public.storage_objects
  for select to authenticated
  using (app_private.is_org_member(organization_id));

create policy storage_objects_insert on public.storage_objects
  for insert to authenticated
  with check (app_private.can_write(organization_id));

create policy storage_objects_update on public.storage_objects
  for update to authenticated
  using (app_private.can_write(organization_id))
  with check (app_private.can_write(organization_id));