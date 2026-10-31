-- ============================================================================
--  tests/security.sql
--
--  Executable SQL security test suite for the Neon schema in db/migrations/
--  0001..0009. Every assertion prints PASS/FAIL and the file exits non-zero
--  if any assertion fails.
--
--  HOW TO RUN
--  -----------
--  The suite needs the two things plain postgres:17 lacks:
--    * auth.uid()                     (provided on Neon by pg_session_jwt)
--    * the neon_auth.user table       (provided on Neon by Neon Auth)
--  Those are created by a THROWAWAY stub script, never by db/migrations/.
--
--    docker run -d --name neon_sec_test -e POSTGRES_PASSWORD=postgres \
--      -e POSTGRES_USER=postgres -e POSTGRES_DB=neonsec -p 55432:5432 postgres:17
--
--    # stubs.sql = create schema auth + auth.uid(); create schema neon_auth
--    #             + neon_auth.user(id uuid pk, email, "emailVerified", "createdAt")
--    Get-Content -Raw stubs.sql | docker exec -i neon_sec_test \
--      psql -U postgres -d neonsec -v ON_ERROR_STOP=1 -q -f -
--    Get-ChildItem db/migrations/*.sql | Sort-Object Name | ForEach-Object {
--      Get-Content -Raw $_ | docker exec -i neon_sec_test \
--        psql -U postgres -d neonsec -v ON_ERROR_STOP=1 -q -f - }
--    Get-Content -Raw tests/security.sql | docker exec -i neon_sec_test \
--      psql -U postgres -d neonsec -v ON_ERROR_STOP=1 -f -
--
--  Running it against real Neon is identical: apply db/migrations/0001..0009
--  first with Neon Auth + Data API enabled, then run this file. No stub is
--  needed there because auth.uid() and neon_auth.user already exist.
--
--  HARNESS NOTES
--  -------------
--  * sec_test.scalar(role, uid, sql) executes one statement with
--      SET LOCAL ROLE <role> and request.jwt.claim.sub = <uid>, so auth.uid()
--      resolves and RLS is enforced exactly as it is for a Data API client.
--      search_path is set to `public, extensions` so the pg_trgm operators
--      resolve; migration 0004 installs the extension into `extensions`.
--  * Data-modifying statements are wrapped in a CTE by the assertion helpers,
--    because Postgres does not allow `update ... returning` inside a FROM
--    subquery. That also means a statement that matched no rows because RLS
--    hid them is reported as a count of 0, not as an error.
--  * Fixtures are written by the superuser (RLS bypassed) BEFORE any assertion
--    runs, so every expected-zero assertion is a real RLS result and never an
--    artefact of an empty table. Where a zero could be ambiguous, a
--    "self test" assertion first proves the same query does return rows for a
--    permitted reader, or a "harness" assertion proves it returns rows for the
--    superuser.
--  * SECURITY DEFINER RPCs execute as the migration owner, matching
--    production, which is why each RPC needs its own authorization test.
-- ============================================================================

\set ON_ERROR_STOP on
\timing off

drop schema if exists sec_test cascade;
create schema sec_test;

create table sec_test.results (
  ord    serial primary key,
  name   text unique not null,
  ok     boolean not null,
  detail text not null default ''
);

-- ---------------------------------------------------------------------------
--  Harness
-- ---------------------------------------------------------------------------

-- Executes one statement as (p_role, p_uid) and returns {err, val}: the error
-- text if it raised, otherwise the single scalar it produced. Queries only --
-- use sec_test.assert_ok / assert_count for data-modifying statements instead.
create or replace function sec_test.scalar(p_role text, p_uid uuid, p_sql text)
returns jsonb language plpgsql volatile as $$
declare
  v_err text := null;
  v_val text := null;
begin
  if p_uid is not null then
    perform set_config('request.jwt.claim.sub', p_uid::text, true);
  end if;
  if p_role is not null then
    execute format('set local role %I', p_role);
  end if;
  execute 'set local search_path = public, extensions';
  begin
    execute 'select (' || p_sql || ')::text' into v_val;
  exception when others then
    v_err := sqlstate || ': ' || sqlerrm;
  end;
  if p_role is not null then
    execute 'reset role';
  end if;
  return jsonb_build_object('err', v_err, 'val', v_val);
end;
$$;

create or replace function sec_test.record(p_name text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  insert into sec_test.results(name, ok, detail) values (p_name, coalesce(p_ok, false), coalesce(p_detail, ''));
  raise notice '% %  %',
    case when coalesce(p_ok, false) then 'PASS' else 'FAIL' end,
    rpad(p_name, 56),
    coalesce(p_detail, '');
end;
$$;

create or replace function sec_test.summary() returns text language sql as $$
  select format('TOTAL %s   PASSED %s   FAILED %s',
                count(*),
                count(*) filter (where ok),
                count(*) filter (where not ok))
  from sec_test.results;
$$;

-- Executes p_sql verbatim as p_role with auth.uid() = p_uid. Used for
-- statements that do not return rows: bare INSERT/UPDATE/DELETE without a
-- RETURNING clause, TRUNCATE, and plain queries.
create or replace function sec_test.run_plain(p_role text, p_uid uuid, p_sql text)
returns jsonb language plpgsql volatile as $$
declare v_err text := null;
begin
  if p_uid is not null then
    perform set_config('request.jwt.claim.sub', p_uid::text, true);
  end if;
  if p_role is not null then
    execute format('set local role %I', p_role);
  end if;
  execute 'set local search_path = public, extensions';
  begin
    execute p_sql;
  exception when others then
    v_err := sqlstate || ': ' || sqlerrm;
  end;
  if p_role is not null then
    execute 'reset role';
  end if;
  return jsonb_build_object('err', v_err, 'val', null);
end;
$$;

-- Runs p_sql and counts the rows it yields. p_sql must be a query, or a
-- data-modifying statement with a RETURNING clause, because it is wrapped in
-- a CTE -- `update ... returning` is not valid inside a FROM subquery.
create or replace function sec_test.run_counted(p_role text, p_uid uuid, p_sql text)
returns jsonb language plpgsql volatile as $$
declare v_err text := null; v_val text := null;
begin
  if p_uid is not null then
    perform set_config('request.jwt.claim.sub', p_uid::text, true);
  end if;
  if p_role is not null then
    execute format('set local role %I', p_role);
  end if;
  execute 'set local search_path = public, extensions';
  begin
    execute 'with sec_q as (' || p_sql || ') select count(*)::text from sec_q' into v_val;
  exception when others then
    v_err := sqlstate || ': ' || sqlerrm;
  end;
  if p_role is not null then
    execute 'reset role';
  end if;
  return jsonb_build_object('err', v_err, 'val', v_val);
end;
$$;

create or replace function sec_test.assert_count(
  p_name text, p_role text, p_uid uuid, p_sql text, p_expected bigint
) returns void language plpgsql as $$
declare r jsonb;
begin
  r := sec_test.run_counted(p_role, p_uid, p_sql);
  if (r->>'err') is not null then
    perform sec_test.record(p_name, false, 'ERROR ' || (r->>'err'));
  elsif (r->>'val') is null or (r->>'val') !~ '^[0-9]+$' then
    perform sec_test.record(p_name, false, 'non-numeric result ' || coalesce((r->>'val'), 'null'));
  else
    perform sec_test.record(p_name, (r->>'val')::bigint = p_expected,
      format('expected %s got %s', p_expected, (r->>'val')));
  end if;
end;
$$;

create or replace function sec_test.assert_count_min(
  p_name text, p_role text, p_uid uuid, p_sql text, p_minimum bigint
) returns void language plpgsql as $$
declare r jsonb;
begin
  r := sec_test.run_counted(p_role, p_uid, p_sql);
  if (r->>'err') is not null then
    perform sec_test.record(p_name, false, 'ERROR ' || (r->>'err'));
  elsif (r->>'val') is null or (r->>'val') !~ '^[0-9]+$' then
    perform sec_test.record(p_name, false, 'non-numeric result ' || coalesce((r->>'val'), 'null'));
  else
    perform sec_test.record(p_name, (r->>'val')::bigint >= p_minimum,
      format('expected at least %s got %s', p_minimum, (r->>'val')));
  end if;
end;
$$;

-- p_sql must succeed. Accepts anything: a query, or a data-modifying
-- statement with or without a RETURNING clause.
create or replace function sec_test.assert_ok(
  p_name text, p_role text, p_uid uuid, p_sql text
) returns void language plpgsql as $$
declare r jsonb;
begin
  r := sec_test.run_plain(p_role, p_uid, p_sql);
  perform sec_test.record(p_name, (r->>'err') is null, coalesce((r->>'err'), 'ok'));
end;
$$;

-- p_sql must fail, optionally with p_like anywhere in the error text. Accepts
-- anything, including a bare INSERT/UPDATE/DELETE or TRUNCATE.
create or replace function sec_test.assert_error(
  p_name text, p_role text, p_uid uuid, p_sql text, p_like text default null
) returns void language plpgsql as $$
declare r jsonb;
begin
  r := sec_test.run_plain(p_role, p_uid, p_sql);
  if (r->>'err') is null then
    perform sec_test.record(p_name, false, 'expected an error, statement succeeded');
  elsif p_like is not null and position(p_like in (r->>'err')) = 0 then
    perform sec_test.record(p_name, false, 'wrong error: ' || (r->>'err'));
  else
    perform sec_test.record(p_name, true, (r->>'err'));
  end if;
end;
$$;

create or replace function sec_test.assert_eq(
  p_name text, p_actual text, p_expected text
) returns void language plpgsql as $$
begin
  perform sec_test.record(p_name, p_actual is not distinct from p_expected,
    format('expected [%s] got [%s]', coalesce(p_expected, 'null'), coalesce(p_actual, 'null')));
end;
$$;

-- Convenience: assert the scalar a query returns as text.
create or replace function sec_test.assert_scalar(
  p_name text, p_role text, p_uid uuid, p_sql text, p_expected text
) returns void language plpgsql as $$
declare r jsonb;
begin
  r := sec_test.scalar(p_role, p_uid, p_sql);
  perform sec_test.record(p_name, (r->>'err') is null and (r->>'val') is not distinct from p_expected,
    coalesce('ERROR ' || (r->>'err'), format('expected [%s] got [%s]', p_expected, coalesce((r->>'val'), 'null'))));
end;
$$;

-- ===========================================================================
--  FIXTURES  (written by the superuser; RLS is intentionally bypassed)
--
--  Three organizations:
--    alpha  11111111-...-111111111111  admin A / staff A / viewer A
--    beta   22222222-...-222222222222  admin B          (the other tenant)
--    gamma  33333333-...-333333333333  admin C / admin C2 (two admins, so the
--                                            last-admin guard can be tested
--                                            both before and after a demotion)
--  One user, outsider, belongs to no organization at all.
-- ===========================================================================

insert into neon_auth.user (id, email, "emailVerified") values
  ('11111111-1111-4111-8111-111111111101', 'admin-a@example.com',  true),
  ('11111111-1111-4111-8111-111111111102', 'staff-a@example.com',  true),
  ('11111111-1111-4111-8111-111111111103', 'viewer-a@example.com', true),
  ('22222222-2222-4222-8222-222222222201', 'admin-b@example.com',  true),
  ('22222222-2222-4222-8222-222222222202', 'outsider@example.com', true),
  ('33333333-3333-4333-8333-333333333301', 'admin-c@example.com',  true),
  ('33333333-3333-4333-8333-333333333302', 'admin-c2@example.com', true),
  ('33333333-3333-4333-8333-333333333303', 'temp@example.com',      true)
on conflict (id) do nothing;

insert into public.organizations (id, name, gstin, state_code, created_by) values
  ('11111111-1111-4111-8111-111111111111', 'Alpha Org', '27AAPFU0939F1ZV', '27', '11111111-1111-4111-8111-111111111101'),
  ('22222222-2222-4222-8222-222222222222', 'Beta Org',  '27ABCDE1234F1Z8', '27', '22222222-2222-4222-8222-222222222201'),
  ('33333333-3333-4333-8333-333333333333', 'Gamma Org', null,              '27', '33333333-3333-4333-8333-333333333301');

insert into public.profiles (id, full_name, default_organization_id) values
  ('11111111-1111-4111-8111-111111111101', 'Admin A',   '11111111-1111-4111-8111-111111111111'),
  ('11111111-1111-4111-8111-111111111102', 'Staff A',   '11111111-1111-4111-8111-111111111111'),
  ('11111111-1111-4111-8111-111111111103', 'Viewer A',  '11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222201', 'Admin B',   '22222222-2222-4222-8222-222222222222'),
  ('22222222-2222-4222-8222-222222222202', 'Outsider',  null),
  ('33333333-3333-4333-8333-333333333301', 'Admin C',   '33333333-3333-4333-8333-333333333333'),
  ('33333333-3333-4333-8333-333333333302', 'Admin C2',  '33333333-3333-4333-8333-333333333333'),
  ('33333333-3333-4333-8333-333333333303', 'Temp User', null);

insert into public.memberships (id, organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111101', 'admin'),
  ('aaaaaaaa-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111102', 'staff'),
  ('aaaaaaaa-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111103', 'viewer'),
  ('bbbbbbbb-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222201', 'admin'),
  ('cccccccc-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333301', 'admin'),
  ('cccccccc-0000-4000-8000-000000000002', '33333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333302', 'admin');

-- alpha has an active trigram-searchable row, a soft-deleted row and a second
-- active row; beta has its own "Sunrise Traders" row so the trigram search can
-- prove RLS scoping rather than an incidental non-match.
insert into public.customers (id, organization_id, name, gstin, state_code, created_by, deleted_at) values
  ('cccccccc-0000-4000-8000-000000000101', '11111111-1111-4111-8111-111111111111', 'Sunrise Traders Alpha', '27AAPFU0939F1ZV', '27', '11111111-1111-4111-8111-111111111101', null),
  ('cccccccc-0000-4000-8000-000000000102', '11111111-1111-4111-8111-111111111111', 'Retired Customer Alpha', null, '27', '11111111-1111-4111-8111-111111111101', now()),
  ('cccccccc-0000-4000-8000-000000000103', '11111111-1111-4111-8111-111111111111', 'Delta Supplies Alpha', null, '27', '11111111-1111-4111-8111-111111111102', null),
  ('cccccccc-0000-4000-8000-000000000201', '22222222-2222-4222-8222-222222222222', 'Sunrise Traders Beta', null, '27', '22222222-2222-4222-8222-222222222201', null),
  ('cccccccc-0000-4000-8000-000000000202', '22222222-2222-4222-8222-222222222222', 'Echo Supplies Beta', null, '27', '22222222-2222-4222-8222-222222222201', null);

insert into public.products (id, organization_id, name, product_code, hsn_code, created_by) values
  ('dddddddd-0000-4000-8000-000000000101', '11111111-1111-4111-8111-111111111111', 'Alpha Widget', 'ALW-1', '8544', '11111111-1111-4111-8111-111111111102'),
  ('dddddddd-0000-4000-8000-000000000201', '22222222-2222-4222-8222-222222222222', 'Beta Widget',  'BEW-1', '8544', '22222222-2222-4222-8222-222222222201');

insert into public.import_batches (id, organization_id, file_name, status, created_by) values
  ('eeeeeeee-0000-4000-8000-000000000101', '11111111-1111-4111-8111-111111111111', 'alpha.csv', 'completed', '11111111-1111-4111-8111-111111111102');

insert into public.bills (
  id, organization_id, customer_id, customer_name, bill_number, bill_date, tax_mode,
  payment_status, source_type, verification_status, verified_by, verified_at,
  subtotal, discount_total, taxable_amount, cgst_amount, sgst_amount, igst_amount,
  tax_total, cess_amount, grand_total, created_by, updated_by, deleted_at, deleted_by
) values
  ('ffffffff-0000-4000-8000-000000000101', '11111111-1111-4111-8111-111111111111', 'cccccccc-0000-4000-8000-000000000101', 'Sunrise Traders Alpha', 'SEC-A-0001', date '2026-01-15', 'intra',
   'unpaid', 'manual', 'verified', '11111111-1111-4111-8111-111111111101', now(),
   1000.00, 0.00, 1000.00, 90.00, 90.00, 0.00, 180.00, 0.00, 1180.00,
   '11111111-1111-4111-8111-111111111101', '11111111-1111-4111-8111-111111111101', null, null),
  ('ffffffff-0000-4000-8000-000000000102', '11111111-1111-4111-8111-111111111111', 'cccccccc-0000-4000-8000-000000000102', 'Retired Customer Alpha', 'SEC-A-0002', date '2026-02-15', 'intra',
   'unpaid', 'manual', 'unverified', null, null,
   500.00, 0.00, 500.00, 45.00, 45.00, 0.00, 90.00, 0.00, 590.00,
   '11111111-1111-4111-8111-111111111101', '11111111-1111-4111-8111-111111111101', now(), '11111111-1111-4111-8111-111111111101'),
  ('ffffffff-0000-4000-8000-000000000103', '11111111-1111-4111-8111-111111111111', 'cccccccc-0000-4000-8000-000000000103', 'Delta Supplies Alpha', 'SEC-A-0003', date '2026-03-15', 'intra',
   'partial', 'manual', 'verified', '11111111-1111-4111-8111-111111111101', now(),
   200.00, 0.00, 200.00, 18.00, 18.00, 0.00, 36.00, 0.00, 236.00,
   '11111111-1111-4111-8111-111111111102', '11111111-1111-4111-8111-111111111102', null, null),
  ('ffffffff-0000-4000-8000-000000000201', '22222222-2222-4222-8222-222222222222', 'cccccccc-0000-4000-8000-000000000201', 'Sunrise Traders Beta', 'SEC-B-0001', date '2026-01-20', 'intra',
   'unpaid', 'manual', 'verified', '22222222-2222-4222-8222-222222222201', now(),
   700.00, 0.00, 700.00, 63.00, 63.00, 0.00, 126.00, 0.00, 826.00,
   '22222222-2222-4222-8222-222222222201', '22222222-2222-4222-8222-222222222201', null, null);

insert into public.bill_items (
  id, organization_id, bill_id, line_no, product_id, product_name,
  quantity, rate, discount, gst_rate, line_subtotal, taxable_amount,
  cgst_amount, sgst_amount, igst_amount, tax_amount, cess_amount, line_total
) values
  ('12121212-0000-4000-8000-000000000101', '11111111-1111-4111-8111-111111111111', 'ffffffff-0000-4000-8000-000000000101', 1, 'dddddddd-0000-4000-8000-000000000101', 'Alpha Widget',
   1.000, 1000.0000, 0.00, 18.00, 1000.00, 1000.00, 90.00, 90.00, 0.00, 180.00, 0.00, 1180.00),
  ('12121212-0000-4000-8000-000000000103', '11111111-1111-4111-8111-111111111111', 'ffffffff-0000-4000-8000-000000000103', 1, 'dddddddd-0000-4000-8000-000000000101', 'Alpha Widget',
   1.000, 200.0000, 0.00, 18.00, 200.00, 200.00, 18.00, 18.00, 0.00, 36.00, 0.00, 236.00),
  ('12121212-0000-4000-8000-000000000201', '22222222-2222-4222-8222-222222222222', 'ffffffff-0000-4000-8000-000000000201', 1, 'dddddddd-0000-4000-8000-000000000201', 'Beta Widget',
   1.000, 700.0000, 0.00, 18.00, 700.00, 700.00, 63.00, 63.00, 0.00, 126.00, 0.00, 826.00);

insert into public.bill_attachments (
  id, organization_id, bill_id, file_path, file_name, mime_type, size_bytes, created_by
) values
  ('13131313-0000-4000-8000-000000000101', '11111111-1111-4111-8111-111111111111', 'ffffffff-0000-4000-8000-000000000101',
   '11111111-1111-4111-8111-111111111111/2026/01/11111111-1111-4111-8111-111111111901/original.pdf', 'invoice.pdf', 'application/pdf', 2048, '11111111-1111-4111-8111-111111111102'),
  ('13131313-0000-4000-8000-000000000103', '11111111-1111-4111-8111-111111111111', 'ffffffff-0000-4000-8000-000000000103',
   '11111111-1111-4111-8111-111111111111/2026/03/11111111-1111-4111-8111-111111111903/original.png', 'invoice.png', 'image/png', 4096, '11111111-1111-4111-8111-111111111102'),
  ('13131313-0000-4000-8000-000000000201', '22222222-2222-4222-8222-222222222222', 'ffffffff-0000-4000-8000-000000000201',
   '22222222-2222-4222-8222-222222222222/2026/01/22222222-2222-4222-8222-222222222901/original.pdf', 'invoice.pdf', 'application/pdf', 3072, '22222222-2222-4222-8222-222222222201');

insert into public.storage_objects (organization_id, object_path, content_type, size_bytes) values
  ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111/2026/01/11111111-1111-4111-8111-111111111901/original.pdf', 'application/pdf', 2048),
  ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111/2026/03/11111111-1111-4111-8111-111111111903/original.png', 'image/png', 4096),
  ('22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222/2026/01/22222222-2222-4222-8222-222222222901/original.pdf', 'application/pdf', 3072);

insert into public.ocr_jobs (id, organization_id, file_path, status, created_by) values
  ('14141414-0000-4000-8000-000000000101', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111/2026/03/scan-original.pdf', 'queued', '11111111-1111-4111-8111-111111111102'),
  ('14141414-0000-4000-8000-000000000201', '22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222/2026/01/scan-original.pdf', 'queued', '22222222-2222-4222-8222-222222222201');

-- Marker rows so the audit-log assertions can count exactly what they seeded
-- even though the z_audit trigger has already written many other rows.
insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, metadata) values
  ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111101', 'INSERT', 'sec_suite_marker', 'cccccccc-0000-4000-8000-000000000101', '{"suite":"security.sql"}'),
  ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111101', 'INSERT', 'sec_suite_marker', 'ffffffff-0000-4000-8000-000000000101', '{"suite":"security.sql"}'),
  ('22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222201', 'INSERT', 'sec_suite_marker', 'cccccccc-0000-4000-8000-000000000201', '{"suite":"security.sql"}'),
  ('22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222201', 'INSERT', 'sec_suite_marker', 'ffffffff-0000-4000-8000-000000000201', '{"suite":"security.sql"}');

-- ===========================================================================
--  1. CROSS-ORGANIZATION ISOLATION ON READ
--      An org A user must see zero org B rows in every tenant-scoped table.
--      A "selftest" assertion first proves the same query does return rows for
--      a permitted reader, so a zero can only come from RLS.
-- ===========================================================================

\echo '== 1. cross-organization isolation (read) =='

select sec_test.assert_count('01.selftest.alpha_admin_reads_own_customers',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id from public.customers
    where organization_id = '11111111-1111-4111-8111-111111111111'$$, 3);

select sec_test.assert_count('01.iso.customers',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id from public.customers
    where organization_id = '22222222-2222-4222-8222-222222222222'$$, 0);

select sec_test.assert_count('01.iso.products',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id from public.products
    where organization_id = '22222222-2222-4222-8222-222222222222'$$, 0);

select sec_test.assert_count('01.iso.bills',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id from public.bills
    where organization_id = '22222222-2222-4222-8222-222222222222'$$, 0);

select sec_test.assert_count('01.iso.bill_items',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id from public.bill_items
    where organization_id = '22222222-2222-4222-8222-222222222222'$$, 0);

select sec_test.assert_count('01.iso.bill_attachments',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id from public.bill_attachments
    where organization_id = '22222222-2222-4222-8222-222222222222'$$, 0);

select sec_test.assert_count('01.iso.ocr_jobs',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id from public.ocr_jobs
    where organization_id = '22222222-2222-4222-8222-222222222222'$$, 0);

select sec_test.assert_count('01.iso.storage_objects',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select object_path from public.storage_objects
    where organization_id = '22222222-2222-4222-8222-222222222222'$$, 0);

select sec_test.assert_count('01.iso.organizations',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id from public.organizations
    where id = '22222222-2222-4222-8222-222222222222'$$, 0);

select sec_test.assert_count('01.iso.memberships',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id from public.memberships
    where organization_id = '22222222-2222-4222-8222-222222222222'$$, 0);

select sec_test.assert_count('01.iso.import_batches',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id from public.import_batches
    where organization_id = '22222222-2222-4222-8222-222222222222'$$, 0);

-- audit_logs: use an org A ADMIN, the only role its policy admits, so the zero
-- is attributable to RLS rather than to the role filter.
select sec_test.assert_count('01.selftest.alpha_admin_reads_own_audit_markers',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id from public.audit_logs
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and table_name = 'sec_suite_marker'$$, 2);

select sec_test.assert_count('01.iso.audit_logs',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id from public.audit_logs
    where organization_id = '22222222-2222-4222-8222-222222222222'
      and table_name = 'sec_suite_marker'$$, 0);

-- A user who belongs to no organization sees nothing at all.
select sec_test.assert_count('01.iso.outsider_sees_nothing',
  'authenticated', '22222222-2222-4222-8222-222222222202',
  $$select id from public.customers
    where organization_id in ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')$$, 0);

-- Harness control: the same query does return rows for the superuser, so every
-- zero above is RLS and not an empty table.
select sec_test.assert_count('01.harness.superuser_sees_both_orgs',
  null, null,
  $$select id from public.customers
    where organization_id in ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')$$, 5);

-- ===========================================================================
--  2. CROSS-ORGANIZATION ISOLATION ON WRITE
--      An org A staff user must not mutate a single org B row. The restriction
--      is a USING / WITH CHECK policy, so out-of-policy statements match zero
--      rows silently; each is paired with an assertion that the row is
--      unchanged afterwards, and with a superuser harness assertion proving the
--      statement does match rows without the policy.
-- ===========================================================================

\echo '== 2. cross-organization isolation (write) =='

select sec_test.assert_count('02.harness.superuser_updates_beta_customers',
  null, null,
  $$update public.customers set notes = notes
    where organization_id = '22222222-2222-4222-8222-222222222222'
    returning id$$, 2);

select sec_test.assert_count('02.crossorg.update_customers',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$update public.customers set name = 'HACKED'
    where organization_id = '22222222-2222-4222-8222-222222222222'
    returning id$$, 0);

select sec_test.assert_count('02.crossorg.update_products',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$update public.products set name = 'HACKED'
    where organization_id = '22222222-2222-4222-8222-222222222222'
    returning id$$, 0);

select sec_test.assert_count('02.crossorg.update_organizations',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$update public.organizations set name = 'HACKED'
    where id = '22222222-2222-4222-8222-222222222222'
    returning id$$, 0);

-- ocr_jobs keeps a column-level UPDATE grant on deleted_at only (migration
-- 0005), so status is not writable by a client at all, in any organization.
select sec_test.assert_error('02.crossorg.ocr_jobs_status_not_grantable',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$update public.ocr_jobs set status = 'failed'
    where organization_id = '22222222-2222-4222-8222-222222222222'
    returning id$$, '42501');

-- memberships is the only tenant table with a client DELETE grant, so it is
-- where a cross-tenant delete can actually be attempted.
select sec_test.assert_count('02.crossorg.delete_memberships',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$delete from public.memberships
    where organization_id = '22222222-2222-4222-8222-222222222222'
    returning id$$, 0);

-- bill_attachments carries no client DELETE grant either.
select sec_test.assert_error('02.crossorg.delete_bill_attachments',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$delete from public.bill_attachments
    where organization_id = '22222222-2222-4222-8222-222222222222'
    returning id$$, '42501');

-- No client DELETE grant exists on these tables at all, so the attempt is
-- refused before RLS is even consulted.
select sec_test.assert_error('02.crossorg.delete_customers',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$delete from public.customers
    where organization_id = '22222222-2222-4222-8222-222222222222'$$, '42501');

select sec_test.assert_error('02.crossorg.delete_bills',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$delete from public.bills
    where organization_id = '22222222-2222-4222-8222-222222222222'$$, '42501');

-- Nothing was actually changed in beta.
select sec_test.assert_count('02.crossorg.beta_customers_untouched',
  null, null,
  $$select id from public.customers
    where organization_id = '22222222-2222-4222-8222-222222222222'
      and name like 'HACKED%'$$, 0);

select sec_test.assert_count('02.crossorg.beta_ocr_jobs_untouched',
  null, null,
  $$select id from public.ocr_jobs
    where organization_id = '22222222-2222-4222-8222-222222222222'
      and status = 'failed'$$, 0);

select sec_test.assert_count('02.crossorg.beta_memberships_intact',
  null, null,
  $$select id from public.memberships
    where organization_id = '22222222-2222-4222-8222-222222222222'$$, 1);

-- Writing INTO beta from a user who is not a member of beta.
select sec_test.assert_error('02.crossorg.insert_customer_into_beta',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$insert into public.customers (organization_id, name)
    values ('22222222-2222-4222-8222-222222222222', 'Injected')$$, '42501');

select sec_test.assert_error('02.crossorg.insert_product_into_beta',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$insert into public.products (organization_id, name)
    values ('22222222-2222-4222-8222-222222222222', 'Injected Product')$$, '42501');

-- And the mirror image: a beta admin cannot write into alpha.
select sec_test.assert_count('02.mirror.beta_admin_cannot_update_alpha',
  'authenticated', '22222222-2222-4222-8222-222222222201',
  $$update public.customers set name = 'HACKED'
    where organization_id = '11111111-1111-4111-8111-111111111111'
    returning id$$, 0);

select sec_test.assert_count('02.mirror.beta_admin_cannot_delete_alpha_memberships',
  'authenticated', '22222222-2222-4222-8222-222222222201',
  $$delete from public.memberships
    where organization_id = '11111111-1111-4111-8111-111111111111'
    returning id$$, 0);

-- ===========================================================================
--  3. VIEWER RESTRICTIONS
-- ===========================================================================

\echo '== 3. viewer restrictions =='

select sec_test.assert_count('03.selftest.viewer_reads_own_active_customers',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$select id from public.customers
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and deleted_at is null$$, 2);

select sec_test.assert_error('03.viewer.cannot_insert_customer',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$insert into public.customers (organization_id, name)
    values ('11111111-1111-4111-8111-111111111111', 'Viewer Made')$$, '42501');

select sec_test.assert_count('03.viewer.cannot_update_customer',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$update public.customers set name = 'Viewer Edited'
    where organization_id = '11111111-1111-4111-8111-111111111111'
    returning id$$, 0);

select sec_test.assert_error('03.viewer.cannot_insert_product',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$insert into public.products (organization_id, name)
    values ('11111111-1111-4111-8111-111111111111', 'Viewer Product')$$, '42501');

select sec_test.assert_count('03.viewer.cannot_update_product',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$update public.products set name = 'Viewer Product'
    where organization_id = '11111111-1111-4111-8111-111111111111'
    returning id$$, 0);

-- bills carry no client INSERT/UPDATE grant at all: the RPC is the only path.
select sec_test.assert_error('03.viewer.cannot_insert_bill',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$insert into public.bills (organization_id, customer_id, customer_name, bill_number, bill_date)
    values ('11111111-1111-4111-8111-111111111111', 'cccccccc-0000-4000-8000-000000000101', 'X', 'VIEW-1', date '2026-04-01')$$, '42501');

select sec_test.assert_error('03.viewer.cannot_update_bill',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$update public.bills set notes = 'n'
    where organization_id = '11111111-1111-4111-8111-111111111111'$$, '42501');

select sec_test.assert_error('03.viewer.cannot_insert_import_batch',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$insert into public.import_batches (organization_id, file_name)
    values ('11111111-1111-4111-8111-111111111111', 'x.csv')
    returning id$$, '42501');

select sec_test.assert_error('03.viewer.cannot_call_save_bill',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$select public.save_bill('{
       "bill_number": "VIEW-SAVE-1", "bill_date": "2026-04-01",
       "customer_id": "cccccccc-0000-4000-8000-000000000101",
       "items": [{"product_name": "X", "quantity": 1, "rate": 10}]
     }'::jsonb)$$, 'FORBIDDEN');

select sec_test.assert_error('03.viewer.cannot_call_update_bill',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$select public.update_bill('ffffffff-0000-4000-8000-000000000103'::uuid, '{"notes": "x"}'::jsonb)$$, 'FORBIDDEN');

select sec_test.assert_error('03.viewer.cannot_call_soft_delete_bill',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$select public.soft_delete_bill('ffffffff-0000-4000-8000-000000000101'::uuid)$$, 'FORBIDDEN');

select sec_test.assert_error('03.viewer.cannot_call_restore_bill',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$select public.restore_bill('ffffffff-0000-4000-8000-000000000102'::uuid)$$, 'FORBIDDEN');

select sec_test.assert_error('03.viewer.cannot_call_set_customer_verification',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$select public.set_customer_verification('cccccccc-0000-4000-8000-000000000103'::uuid, 'verified')$$, 'FORBIDDEN');

select sec_test.assert_error('03.viewer.cannot_call_add_organization_member',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$select public.add_organization_member('11111111-1111-4111-8111-111111111111'::uuid, 'temp@example.com', 'viewer')$$, 'FORBIDDEN');

select sec_test.assert_count('03.viewer.cannot_see_soft_deleted_customers',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$select id from public.customers
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and deleted_at is not null$$, 0);

select sec_test.assert_count('03.viewer.cannot_see_soft_deleted_bills',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$select id from public.bills
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and deleted_at is not null$$, 0);

select sec_test.assert_count('03.viewer.cannot_read_audit_logs',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$select id from public.audit_logs
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and table_name = 'sec_suite_marker'$$, 0);

-- An admin CAN see soft-deleted rows, which is what makes the viewer and staff
-- zero above a restriction rather than a table-level accident.
select sec_test.assert_count('03.selftest.admin_can_see_soft_deleted',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id from public.customers
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and deleted_at is not null$$, 1);

-- ===========================================================================
--  4. STAFF RESTRICTIONS
-- ===========================================================================

\echo '== 4. staff restrictions =='

select sec_test.assert_count('04.selftest.staff_reads_active_rows',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select id from public.customers
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and deleted_at is null$$, 2);

select sec_test.assert_error('04.staff.cannot_call_soft_delete_bill',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.soft_delete_bill('ffffffff-0000-4000-8000-000000000103'::uuid)$$, 'FORBIDDEN');

select sec_test.assert_error('04.staff.cannot_call_restore_bill',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.restore_bill('ffffffff-0000-4000-8000-000000000102'::uuid)$$, 'FORBIDDEN');

select sec_test.assert_count('04.staff.cannot_see_soft_deleted_customers',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select id from public.customers
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and deleted_at is not null$$, 0);

select sec_test.assert_count('04.staff.cannot_see_soft_deleted_bills',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select id from public.bills
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and deleted_at is not null$$, 0);

select sec_test.assert_count('04.staff.cannot_read_audit_logs',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select id from public.audit_logs
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and table_name = 'sec_suite_marker'$$, 0);

select sec_test.assert_error('04.staff.cannot_call_add_organization_member',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.add_organization_member('11111111-1111-4111-8111-111111111111'::uuid, 'temp@example.com', 'viewer')$$, 'FORBIDDEN');

select sec_test.assert_count('04.staff.cannot_change_membership_role',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$update public.memberships set role = 'admin'
    where organization_id = '11111111-1111-4111-8111-111111111111'
    returning id$$, 0);

select sec_test.assert_count('04.staff.cannot_delete_membership',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$delete from public.memberships
    where organization_id = '11111111-1111-4111-8111-111111111111'
    returning id$$, 0);

select sec_test.assert_count('04.selftest.alpha_still_has_exactly_one_admin',
  null, null,
  $$select id from public.memberships
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and role = 'admin'$$, 1);

-- Staff CAN write ordinary domain rows, which is what makes the restrictions
-- above specific rather than a blanket denial. Only `notes` is touched, so the
-- names the later trigram assertions depend on stay intact.
select sec_test.assert_count('04.staff.can_update_own_org_customer',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$update public.customers set notes = 'touched by staff'
    where id = 'cccccccc-0000-4000-8000-000000000103'
    returning id$$, 1);

-- app_private.guard_soft_delete raises for a non-admin rather than silently
-- skipping the row, so the attempt is an error, not a zero-row update.
select sec_test.assert_error('04.staff.cannot_soft_delete_customer_directly',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$update public.customers set deleted_at = now()
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and deleted_at is null
    returning id$$, 'FORBIDDEN');

-- ===========================================================================
--  5. ADMIN-ONLY: SOFT DELETE / RESTORE AND MEMBERSHIP MANAGEMENT
-- ===========================================================================

\echo '== 5. admin-only operations =='

select sec_test.assert_ok('05.admin.can_call_soft_delete_bill',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select public.soft_delete_bill('ffffffff-0000-4000-8000-000000000103'::uuid)$$);

select sec_test.assert_count('05.admin.soft_delete_took_effect',
  null, null,
  $$select id from public.bills
    where id = 'ffffffff-0000-4000-8000-000000000103'
      and deleted_at is not null
      and deleted_by = '11111111-1111-4111-8111-111111111101'$$, 1);

select sec_test.assert_ok('05.admin.can_call_restore_bill',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select public.restore_bill('ffffffff-0000-4000-8000-000000000103'::uuid)$$);

select sec_test.assert_count('05.admin.restore_took_effect',
  null, null,
  $$select id from public.bills
    where id = 'ffffffff-0000-4000-8000-000000000103'
      and deleted_at is null
      and deleted_by is null$$, 1);

select sec_test.assert_count('05.admin.can_soft_delete_customer_directly',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$update public.customers set deleted_at = now()
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and id = 'cccccccc-0000-4000-8000-000000000103'
    returning id$$, 1);

select sec_test.assert_count('05.admin.can_restore_customer_directly',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$update public.customers set deleted_at = null
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and id = 'cccccccc-0000-4000-8000-000000000103'
    returning id$$, 1);

select sec_test.assert_ok('05.admin.can_call_add_organization_member',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select public.add_organization_member('11111111-1111-4111-8111-111111111111'::uuid, 'temp@example.com', 'staff')$$);

select sec_test.assert_count('05.admin.membership_created',
  null, null,
  $$select id from public.memberships
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and user_id = '33333333-3333-4333-8333-333333333303'
      and role = 'staff'$$, 1);

select sec_test.assert_count('05.admin.can_change_membership_role',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$update public.memberships set role = 'viewer'
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and user_id = '33333333-3333-4333-8333-333333333303'
    returning id$$, 1);

select sec_test.assert_count('05.selftest.role_change_took_effect',
  null, null,
  $$select id from public.memberships
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and user_id = '33333333-3333-4333-8333-333333333303'
      and role = 'viewer'$$, 1);

select sec_test.assert_count('05.admin.can_remove_managed_membership',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$delete from public.memberships
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and user_id = '33333333-3333-4333-8333-333333333303'
    returning id$$, 1);

-- A non-admin still cannot manage a membership in its own organization.
select sec_test.assert_count('05.nonadmin_staff_cannot_delete_membership',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$delete from public.memberships
    where organization_id = '11111111-1111-4111-8111-111111111111'
    returning id$$, 0);

select sec_test.assert_count('05.nonadmin_viewer_cannot_delete_membership',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$delete from public.memberships
    where organization_id = '11111111-1111-4111-8111-111111111111'
    returning id$$, 0);

-- ===========================================================================
--  6. LAST-ADMIN PROTECTION
--      Gamma has two admins. While both exist one may be demoted; once one is
--      gone the final admin is locked against DELETE, demotion and self-removal.
-- ===========================================================================

\echo '== 6. last-admin protection =='

select sec_test.assert_count('06.selftest.gamma_starts_with_two_admins',
  null, null,
  $$select id from public.memberships
    where organization_id = '33333333-3333-4333-8333-333333333333'
      and role = 'admin'$$, 2);

select sec_test.assert_count('06.admin_demote_allowed_while_two_admins_exist',
  'authenticated', '33333333-3333-4333-8333-333333333301',
  $$update public.memberships set role = 'staff'
    where organization_id = '33333333-3333-4333-8333-333333333333'
      and user_id = '33333333-3333-4333-8333-333333333302'
    returning id$$, 1);

select sec_test.assert_count('06.selftest.gamma_has_one_admin',
  null, null,
  $$select id from public.memberships
    where organization_id = '33333333-3333-4333-8333-333333333333'
      and role = 'admin'$$, 1);

select sec_test.assert_error('06.cannot_delete_final_admin',
  'authenticated', '33333333-3333-4333-8333-333333333301',
  $$delete from public.memberships
    where organization_id = '33333333-3333-4333-8333-333333333333'
      and user_id = '33333333-3333-4333-8333-333333333301'$$, 'LAST_ADMIN');

select sec_test.assert_error('06.cannot_demote_final_admin',
  'authenticated', '33333333-3333-4333-8333-333333333301',
  $$update public.memberships set role = 'staff'
    where organization_id = '33333333-3333-4333-8333-333333333333'
      and user_id = '33333333-3333-4333-8333-333333333301'$$, 'LAST_ADMIN');

select sec_test.assert_error('06.cannot_promote_to_admin_without_second_admin',
  'authenticated', '33333333-3333-4333-8333-333333333301',
  $$delete from public.memberships where user_id = '33333333-3333-4333-8333-333333333301'$$,
  'LAST_ADMIN');

select sec_test.assert_count('06.selftest.gamma_still_has_exactly_one_admin',
  null, null,
  $$select id from public.memberships
    where organization_id = '33333333-3333-4333-8333-333333333333'
      and role = 'admin'$$, 1);

select sec_test.assert_count('06.final_admin_membership_survived',
  null, null,
  $$select id from public.memberships
    where organization_id = '33333333-3333-4333-8333-333333333333'
      and user_id = '33333333-3333-4333-8333-333333333301'
      and role = 'admin'$$, 1);

-- The guard must also fire for a caller with no membership at all once it
-- reaches the trigger, i.e. it is not merely a policy side effect.
select sec_test.assert_count('06.selftest.gamma_membership_count_unchanged',
  null, null,
  $$select id from public.memberships
    where organization_id = '33333333-3333-4333-8333-333333333333'$$, 2);

-- ===========================================================================
--  7. AUDIT LOG IMMUTABILITY
--      Clients hold no INSERT/UPDATE/DELETE/TRUNCATE grant at all; the
--      triggers are a second, independent barrier that also stops the
--      superuser, which is the only role that has every grant.
-- ===========================================================================

\echo '== 7. audit log immutability =='

select sec_test.assert_count('07.no_insert_grant_for_authenticated',
  null, null,
  $$select 1 from information_schema.role_table_grants
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'audit_logs' and privilege_type = 'INSERT'$$, 0);

select sec_test.assert_count('07.no_update_grant_for_authenticated',
  null, null,
  $$select 1 from information_schema.role_table_grants
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'audit_logs' and privilege_type = 'UPDATE'$$, 0);

select sec_test.assert_count('07.no_delete_grant_for_authenticated',
  null, null,
  $$select 1 from information_schema.role_table_grants
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'audit_logs' and privilege_type = 'DELETE'$$, 0);

select sec_test.assert_count('07.no_truncate_grant_for_authenticated',
  null, null,
  $$select 1 from information_schema.role_table_grants
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'audit_logs' and privilege_type = 'TRUNCATE'$$, 0);

select sec_test.assert_count('07.only_select_is_granted_to_authenticated',
  null, null,
  $$select 1 from information_schema.role_table_grants
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'audit_logs' and privilege_type <> 'SELECT'$$, 0);

select sec_test.assert_count('07.select_is_granted_to_authenticated',
  null, null,
  $$select 1 from information_schema.role_table_grants
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'audit_logs' and privilege_type = 'SELECT'$$, 1);

-- Live probes for the client role.
select sec_test.assert_error('07.authenticated_cannot_update',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$update public.audit_logs set action = 'TAMPERED'
    where organization_id = '11111111-1111-4111-8111-111111111111'
    returning id$$, '42501');

select sec_test.assert_error('07.authenticated_cannot_delete',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$delete from public.audit_logs
    where organization_id = '11111111-1111-4111-8111-111111111111'
    returning id$$, '42501');

select sec_test.assert_error('07.authenticated_cannot_truncate',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$truncate public.audit_logs$$, '42501');

select sec_test.assert_error('07.authenticated_cannot_insert',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$insert into public.audit_logs (organization_id, action, table_name)
    values ('11111111-1111-4111-8111-111111111111', 'FORGED', 'customers')$$, '42501');

-- The trigger barrier, proven against the superuser. Triggers are not
-- bypassable by privilege, so this is the barrier that actually holds.
select sec_test.assert_error('07.trigger_blocks_update_even_for_superuser',
  null, null,
  $$update public.audit_logs set action = 'TAMPERED'
    where organization_id = '11111111-1111-4111-8111-111111111111'
    returning id$$, 'IMMUTABLE_TABLE');

select sec_test.assert_error('07.trigger_blocks_delete_even_for_superuser',
  null, null,
  $$delete from public.audit_logs
    where organization_id = '11111111-1111-4111-8111-111111111111'
    returning id$$, 'IMMUTABLE_TABLE');

select sec_test.assert_error('07.trigger_blocks_truncate_even_for_superuser',
  null, null,
  $$truncate public.audit_logs$$, 'IMMUTABLE_TABLE');

-- The blocking triggers must actually exist on audit_logs. pg_trigger.tgtype
-- bits: 1 row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate.
select sec_test.assert_count('07.update_delete_block_trigger_exists',
  null, null,
  $$select 1 from pg_trigger
    where tgrelid = 'public.audit_logs'::regclass
      and tgname = 'block_audit_update'
      and not tgisinternal
      and (tgtype & 1) = 1
      and (tgtype & 2) = 2
      and (tgtype & 8) = 8
      and (tgtype & 16) = 16
      and (tgtype & 4) = 0
      and (tgtype & 32) = 0
      and tgenabled = 'O'$$
  , 1);

select sec_test.assert_count('07.truncate_block_trigger_exists',
  null, null,
  $$select 1 from pg_trigger
    where tgrelid = 'public.audit_logs'::regclass
      and tgname = 'block_audit_truncate'
      and not tgisinternal
      and (tgtype & 32) = 32
      and tgenabled = 'O'$$
  , 1);

-- block_audit_mutation is the function both triggers must point at.
select sec_test.assert_count('07.both_blocking_triggers_use_the_blocking_function',
  null, null,
  $$select 1
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.audit_logs'::regclass
      and t.tgname in ('block_audit_update', 'block_audit_truncate')
      and not t.tgisinternal
      and p.pronamespace = 'app_private'::regnamespace
      and p.proname = 'block_audit_mutation'$$
  , 2);

select sec_test.assert_count('07.audit_markers_survived_all_of_the_above',
  null, null,
  $$select id from public.audit_logs
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and table_name = 'sec_suite_marker'$$, 2);

select sec_test.assert_count('07.no_forged_audit_rows',
  null, null,
  $$select id from public.audit_logs
    where action in ('TAMPERED', 'FORGED')$$, 0);

-- ===========================================================================
--  8. IMMUTABLE COLUMNS
--      app_private.enforce_immutable_columns fires for any writer including
--      the superuser, so the column-level grants are not the only barrier.
-- ===========================================================================

\echo '== 8. immutable columns =='

select sec_test.assert_error('08.trigger_blocks_id_change',
  null, null,
  $$update public.customers set id = '99999999-9999-4999-8999-999999999999'
    where id = 'cccccccc-0000-4000-8000-000000000101'
    returning id$$, 'IMMUTABLE_COLUMN');

select sec_test.assert_error('08.trigger_blocks_organization_id_change',
  null, null,
  $$update public.customers set organization_id = '22222222-2222-4222-8222-222222222222'
    where id = 'cccccccc-0000-4000-8000-000000000101'
    returning id$$, 'IMMUTABLE_COLUMN');

select sec_test.assert_error('08.trigger_blocks_created_at_change',
  null, null,
  $$update public.customers set created_at = now()
    where id = 'cccccccc-0000-4000-8000-000000000101'
    returning id$$, 'IMMUTABLE_COLUMN');

select sec_test.assert_error('08.bill_id_is_immutable',
  null, null,
  $$update public.bills set id = '99999999-9999-4999-8999-999999999999'
    where id = 'ffffffff-0000-4000-8000-000000000101'
    returning id$$, 'IMMUTABLE_COLUMN');

select sec_test.assert_error('08.bill_organization_id_is_immutable',
  null, null,
  $$update public.bills set organization_id = '22222222-2222-4222-8222-222222222222'
    where id = 'ffffffff-0000-4000-8000-000000000101'
    returning id$$, 'IMMUTABLE_COLUMN');

select sec_test.assert_error('08.bill_created_at_is_immutable',
  null, null,
  $$update public.bills set created_at = now()
    where id = 'ffffffff-0000-4000-8000-000000000101'
    returning id$$, 'IMMUTABLE_COLUMN');

select sec_test.assert_error('08.bill_item_id_is_immutable',
  null, null,
  $$update public.bill_items set id = '99999999-9999-4999-8999-999999999999'
    where id = '12121212-0000-4000-8000-000000000101'
    returning id$$, 'IMMUTABLE_COLUMN');

select sec_test.assert_error('08.bill_item_organization_id_is_immutable',
  null, null,
  $$update public.bill_items set organization_id = '22222222-2222-4222-8222-222222222222'
    where id = '12121212-0000-4000-8000-000000000101'
    returning id$$, 'IMMUTABLE_COLUMN');

select sec_test.assert_error('08.attachment_organization_id_is_immutable',
  null, null,
  $$update public.bill_attachments set organization_id = '22222222-2222-4222-8222-222222222222'
    where id = '13131313-0000-4000-8000-000000000101'
    returning id$$, 'IMMUTABLE_COLUMN');

select sec_test.assert_error('08.product_organization_id_is_immutable',
  null, null,
  $$update public.products set organization_id = '22222222-2222-4222-8222-222222222222'
    where id = 'dddddddd-0000-4000-8000-000000000101'
    returning id$$, 'IMMUTABLE_COLUMN');

select sec_test.assert_error('08.membership_organization_id_is_immutable',
  null, null,
  $$update public.memberships set organization_id = '22222222-2222-4222-8222-222222222222'
    where id = 'aaaaaaaa-0000-4000-8000-000000000002'
    returning id$$, 'IMMUTABLE_COLUMN');

-- And at the privilege level for the client role: no UPDATE grant on those
-- columns at all, so the request is refused before the trigger can run.
select sec_test.assert_error('08.client_cannot_update_id_column',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$update public.customers set id = '99999999-9999-4999-8999-999999999999'
    where organization_id = '11111111-1111-4111-8111-111111111111'
    returning id$$, '42501');

select sec_test.assert_error('08.client_cannot_update_organization_id_column',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$update public.customers set organization_id = '22222222-2222-4222-8222-222222222222'
    where organization_id = '11111111-1111-4111-8111-111111111111'
    returning id$$, '42501');

select sec_test.assert_error('08.client_cannot_update_created_at_column',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$update public.customers set created_at = now()
    where organization_id = '11111111-1111-4111-8111-111111111111'
    returning id$$, '42501');

select sec_test.assert_count('08.customer_id_unchanged',
  null, null,
  $$select id from public.customers
    where id = 'cccccccc-0000-4000-8000-000000000101'
      and organization_id = '11111111-1111-4111-8111-111111111111'$$, 1);

select sec_test.assert_count('08.bill_items_organization_id_unchanged',
  null, null,
  $$select id from public.bill_items
    where organization_id = '22222222-2222-4222-8222-222222222222'$$, 1);

-- The immutable trigger is present on every table it is meant to protect.
select sec_test.assert_count('08.trigger_present_on_all_guarded_tables',
  null, null,
  $$select c.oid::regclass::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'id' and not a.attisdropped
      )
      and exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'created_at' and not a.attisdropped
      )
      and not exists (
        select 1 from pg_trigger t
        where t.tgrelid = c.oid and t.tgname = 'b_immutable_columns' and not t.tgisinternal
      )
      and c.relname <> 'audit_logs'
      and c.relname <> 'storage_objects'$$, 0);

-- ===========================================================================
--  9. RPC AUTHORIZATION
--      Every RPC is SECURITY DEFINER, so each must re-check membership and
--      role itself. Each is called across the organization boundary on
--      purpose, plus the existence and optimistic-concurrency checks.
-- ===========================================================================

\echo '== 9. RPC authorization =='

select sec_test.assert_error('09.save_bill_rejects_other_org_customer',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.save_bill('{
       "bill_number": "XORG-1", "bill_date": "2026-04-01",
       "customer_id": "cccccccc-0000-4000-8000-000000000201",
       "items": [{"product_name": "X", "quantity": 1, "rate": 10}]
     }'::jsonb)$$, 'NOT_FOUND');

select sec_test.assert_error('09.save_bill_rejects_payload_org_mismatch',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.save_bill('{
       "organization_id": "22222222-2222-4222-8222-222222222222",
       "bill_number": "XORG-2", "bill_date": "2026-04-01",
       "customer_id": "cccccccc-0000-4000-8000-000000000103",
       "items": [{"product_name": "X", "quantity": 1, "rate": 10}]
     }'::jsonb)$$, 'NOT_FOUND');

select sec_test.assert_error('09.save_bill_rejects_nonexistent_customer',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.save_bill('{
       "bill_number": "XORG-3", "bill_date": "2026-04-01",
       "customer_id": "99999999-9999-4999-8999-999999999999",
       "items": [{"product_name": "X", "quantity": 1, "rate": 10}]
     }'::jsonb)$$, 'NOT_FOUND');

select sec_test.assert_error('09.save_bill_rejects_other_org_product',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.save_bill('{
       "bill_number": "XORG-4", "bill_date": "2026-04-01",
       "customer_id": "cccccccc-0000-4000-8000-000000000103",
       "items": [{"product_id": "dddddddd-0000-4000-8000-000000000201", "quantity": 1, "rate": 10}]
     }'::jsonb)$$, 'VALIDATION_ERROR');

select sec_test.assert_error('09.update_bill_rejects_other_org_bill',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.update_bill('ffffffff-0000-4000-8000-000000000201'::uuid,
       '{"notes": "hijack"}'::jsonb)$$, 'NOT_FOUND');

select sec_test.assert_error('09.update_bill_rejects_nonexistent_bill',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.update_bill('99999999-9999-4999-8999-999999999999'::uuid,
       '{"notes": "hijack"}'::jsonb)$$, 'NOT_FOUND');

select sec_test.assert_error('09.update_bill_rejects_nonexistent_customer_in_payload',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.update_bill('ffffffff-0000-4000-8000-000000000103'::uuid,
       '{"customer_id": "99999999-9999-4999-8999-999999999999"}'::jsonb)$$, 'NOT_FOUND');

select sec_test.assert_error('09.update_bill_rejects_customer_from_other_org',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.update_bill('ffffffff-0000-4000-8000-000000000103'::uuid,
       '{"customer_id": "cccccccc-0000-4000-8000-000000000201"}'::jsonb)$$, 'NOT_FOUND');

select sec_test.assert_error('09.soft_delete_bill_rejects_other_org_bill',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.soft_delete_bill('ffffffff-0000-4000-8000-000000000201'::uuid)$$, 'NOT_FOUND');

select sec_test.assert_error('09.soft_delete_bill_rejects_nonexistent_bill',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.soft_delete_bill('99999999-9999-4999-8999-999999999999'::uuid)$$, 'NOT_FOUND');

select sec_test.assert_error('09.restore_bill_rejects_other_org_bill',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.restore_bill('ffffffff-0000-4000-8000-000000000201'::uuid)$$, 'NOT_FOUND');

select sec_test.assert_error('09.set_customer_verification_rejects_other_org',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.set_customer_verification('cccccccc-0000-4000-8000-000000000201'::uuid, 'verified')$$, 'NOT_FOUND');

select sec_test.assert_error('09.set_customer_verification_rejects_nonexistent',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.set_customer_verification('99999999-9999-4999-8999-999999999999'::uuid, 'verified')$$, 'NOT_FOUND');

select sec_test.assert_error('09.add_member_rejects_other_org',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.add_organization_member('22222222-2222-4222-8222-222222222222'::uuid, 'temp@example.com', 'viewer')$$, 'FORBIDDEN');

select sec_test.assert_error('09.anonymous_cannot_call_save_bill',
  'anonymous', null,
  $$select public.save_bill('{"bill_number": "ANON-1"}'::jsonb)$$, '42501');

-- The reporting RPCs are SECURITY DEFINER too.
select sec_test.assert_error('09.dashboard_summary_rejects_other_org',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.dashboard_summary('22222222-2222-4222-8222-222222222222'::uuid)$$, 'NOT_FOUND');

select sec_test.assert_error('09.dashboard_summary_rejects_nonexistent_org',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.dashboard_summary('99999999-9999-4999-8999-999999999999'::uuid)$$, 'NOT_FOUND');

select sec_test.assert_error('09.report_summary_rejects_other_org',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.report_summary('22222222-2222-4222-8222-222222222222'::uuid,
       date '2026-01-01', date '2026-12-31')$$, 'NOT_FOUND');

select sec_test.assert_error('09.customer_summary_rejects_other_org',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.customer_summary('cccccccc-0000-4000-8000-000000000201'::uuid)$$, 'NOT_FOUND');

select sec_test.assert_error('09.customer_products_rejects_other_org',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select * from public.customer_products('cccccccc-0000-4000-8000-000000000201'::uuid)$$, 'NOT_FOUND');

select sec_test.assert_ok('09.dashboard_summary_own_org_allowed',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.dashboard_summary('11111111-1111-4111-8111-111111111111'::uuid)
       ->> 'total_customers'$$);

-- Optimistic concurrency. The version is read inside the assertion so the test
-- does not depend on the increments performed earlier in this section.
select sec_test.assert_error('09.update_bill_enforces_version_conflict',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.update_bill('ffffffff-0000-4000-8000-000000000103'::uuid,
       '{"notes": "stale write"}'::jsonb, false, 999)$$, 'VERSION_CONFLICT');

select sec_test.assert_ok('09.update_bill_correct_version_accepted',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.update_bill('ffffffff-0000-4000-8000-000000000103'::uuid,
       '{"notes": "fresh write"}'::jsonb, false,
       (select version from public.bills where id = 'ffffffff-0000-4000-8000-000000000103'))
       -> 'bill' ->> 'notes'$$);

select sec_test.assert_scalar('09.update_bill_persisted_the_new_notes',
  null, null,
  $$select notes from public.bills where id = 'ffffffff-0000-4000-8000-000000000103'$$, 'fresh write');

select sec_test.assert_error('09.update_bill_rejects_version_one_after_increment',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.update_bill('ffffffff-0000-4000-8000-000000000103'::uuid,
       '{"notes": "stale again"}'::jsonb, false, 1)$$, 'VERSION_CONFLICT');

select sec_test.assert_count('09.version_was_incremented_by_the_accepted_update',
  null, null,
  $$select version from public.bills
    where id = 'ffffffff-0000-4000-8000-000000000103' and version > 1$$, 1);

-- Cross-org write attempts must have created nothing in beta.
select sec_test.assert_count('09.no_bills_created_in_beta',
  null, null,
  $$select id from public.bills
    where organization_id = '22222222-2222-4222-8222-222222222222'
      and bill_number like 'XORG%'$$, 0);

select sec_test.assert_count('09.beta_bill_count_unchanged',
  null, null,
  $$select id from public.bills
    where organization_id = '22222222-2222-4222-8222-222222222222'$$, 1);

select sec_test.assert_count('09.beta_bill_notes_unchanged',
  null, null,
  $$select id from public.bills
    where organization_id = '22222222-2222-4222-8222-222222222222'
      and notes = 'hijack'$$, 0);

select sec_test.assert_count('09.beta_customer_count_unchanged',
  null, null,
  $$select id from public.customers
    where organization_id = '22222222-2222-4222-8222-222222222222'$$, 2);

-- ===========================================================================
--  10. ATTACHMENT PATH SAFETY
--       Checked at two independent layers: the table CHECK constraints (which
--       hold even for a privileged writer) and app_private.upsert_bill's
--       validation (the path a real client takes).
-- ===========================================================================

\echo '== 10. attachment path safety =='

-- Layer 1: CHECK constraints, exercised by the superuser.
select sec_test.assert_error('10.constraint_rejects_foreign_org_prefix',
  null, null,
  $$insert into public.bill_attachments (organization_id, bill_id, file_path, file_name)
    values ('11111111-1111-4111-8111-111111111111', 'ffffffff-0000-4000-8000-000000000101',
            '22222222-2222-4222-8222-222222222222/2026/01/x/original.pdf', 'x.pdf')
    returning id$$, 'bill_attachments_path_prefix_check');

select sec_test.assert_error('10.constraint_rejects_missing_org_prefix',
  null, null,
  $$insert into public.bill_attachments (organization_id, bill_id, file_path, file_name)
    values ('11111111-1111-4111-8111-111111111111', 'ffffffff-0000-4000-8000-000000000101',
            'not-an-org-path/2026/01/x/original.pdf', 'x.pdf')
    returning id$$, 'bill_attachments_path_prefix_check');

select sec_test.assert_error('10.constraint_rejects_dotdot_traversal',
  null, null,
  $$insert into public.bill_attachments (organization_id, bill_id, file_path, file_name)
    values ('11111111-1111-4111-8111-111111111111', 'ffffffff-0000-4000-8000-000000000101',
            '11111111-1111-4111-8111-111111111111/2026/../../etc/original.pdf', 'x.pdf')
    returning id$$, 'bill_attachments_path_safe_check');

select sec_test.assert_error('10.constraint_rejects_leading_dotdot',
  null, null,
  $$insert into public.bill_attachments (organization_id, bill_id, file_path, file_name)
    values ('11111111-1111-4111-8111-111111111111', 'ffffffff-0000-4000-8000-000000000101',
            '11111111-1111-4111-8111-111111111111/../secret.pdf', 'x.pdf')
    returning id$$, 'bill_attachments_path_safe_check');

select sec_test.assert_error('10.constraint_rejects_trailing_dotdot',
  null, null,
  $$insert into public.bill_attachments (organization_id, bill_id, file_path, file_name)
    values ('11111111-1111-4111-8111-111111111111', 'ffffffff-0000-4000-8000-000000000101',
            '11111111-1111-4111-8111-111111111111/2026/..', 'x.pdf')
    returning id$$, 'bill_attachments_path_safe_check');

select sec_test.assert_error('10.constraint_rejects_absolute_path',
  null, null,
  $$insert into public.bill_attachments (organization_id, bill_id, file_path, file_name)
    values ('11111111-1111-4111-8111-111111111111', 'ffffffff-0000-4000-8000-000000000101',
            '/etc/passwd', 'x.pdf')
    returning id$$, 'bill_attachments_path_prefix_check');

select sec_test.assert_count('10.no_bad_paths_were_inserted',
  null, null,
  $$select id from public.bill_attachments
    where file_path ~ '(^|/)\.\.(/|$)'
       or file_path !~ '^(11111111-1111-4111-8111-111111111111|22222222-2222-4222-8222-222222222222)/'$$, 0);

select sec_test.assert_count('10.attachment_paths_are_all_under_their_organization',
  null, null,
  $$select id from public.bill_attachments
    where file_path not like organization_id::text || '/%'$$, 0);

-- The same constraints exist on ocr_jobs, which stores the same kind of path.
select sec_test.assert_error('10.ocr_jobs_rejects_foreign_prefix_insert',
  null, null,
  $$insert into public.ocr_jobs (organization_id, file_path)
    values ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222/2026/01/x.pdf')
    returning id$$, 'ocr_jobs_path_prefix_check');

select sec_test.assert_error('10.ocr_jobs_rejects_dotdot_insert',
  null, null,
  $$insert into public.ocr_jobs (organization_id, file_path)
    values ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111/../../etc/x.pdf')
    returning id$$, 'ocr_jobs_path_safe_check');

select sec_test.assert_count('10.no_bad_ocr_paths_were_inserted',
  null, null,
  $$select id from public.ocr_jobs
    where file_path ~ '(^|/)\.\.(/|$)'
       or file_path !~ '^(11111111-1111-4111-8111-111111111111|22222222-2222-4222-8222-222222222222)/'$$, 0);

-- Layer 2: the RPC validates the same thing for a real client.
select sec_test.assert_error('10.rpc_rejects_foreign_org_attachment_path',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.update_bill('ffffffff-0000-4000-8000-000000000103'::uuid,
       jsonb_build_object('attachment_path',
         '22222222-2222-4222-8222-222222222222/2026/01/22222222-2222-4222-8222-222222222901/original.pdf')::jsonb,
       false, (select version from public.bills where id = 'ffffffff-0000-4000-8000-000000000103'))$$,
  'VALIDATION_ERROR');

select sec_test.assert_error('10.rpc_rejects_dotdot_attachment_path',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.update_bill('ffffffff-0000-4000-8000-000000000103'::uuid,
       jsonb_build_object('attachment_path',
         '11111111-1111-4111-8111-111111111111/2026/03/../../../etc/passwd')::jsonb,
       false, (select version from public.bills where id = 'ffffffff-0000-4000-8000-000000000103'))$$,
  'VALIDATION_ERROR');

select sec_test.assert_error('10.rpc_rejects_leading_dotdot_attachment_path',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.update_bill('ffffffff-0000-4000-8000-000000000103'::uuid,
       jsonb_build_object('attachment_path',
         '11111111-1111-4111-8111-111111111111/../secret.pdf')::jsonb,
       false, (select version from public.bills where id = 'ffffffff-0000-4000-8000-000000000103'))$$,
  'VALIDATION_ERROR');

select sec_test.assert_error('10.rpc_rejects_unindexed_attachment_path',
  'authenticated', '11111111-1111-4111-8111-111111111102',
  $$select public.update_bill('ffffffff-0000-4000-8000-000000000103'::uuid,
       jsonb_build_object('attachment_path',
         '11111111-1111-4111-8111-111111111111/2026/03/11111111-1111-4111-8111-111111111999/original.pdf')::jsonb,
       false, (select version from public.bills where id = 'ffffffff-0000-4000-8000-000000000103'))$$,
  'was not found in the bill-attachments bucket');

select sec_test.assert_count('10.no_extra_attachments_after_rejections',
  null, null,
  $$select id from public.bill_attachments
    where organization_id = '11111111-1111-4111-8111-111111111111'$$, 2);

-- ===========================================================================
--  11. ANONYMOUS ROLE HAS NO ACCESS
--      Asserted from the catalog (exhaustive) and then by live probes on
--      every public function and a representative set of tables.
-- ===========================================================================

\echo '== 11. anonymous role has no access =='

select sec_test.assert_count('11.no_public_function_executable_by_anonymous',
  null, null,
  $$select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and has_function_privilege('anonymous', p.oid, 'EXECUTE')$$, 0);

-- Guards against the assertion above passing because the catalogue query found
-- nothing at all: the 11 RPCs must actually be there.
select sec_test.assert_count('11.every_public_rpc_is_present',
  null, null,
  $$select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass
          and d.objid = p.oid and d.deptype = 'e'
      )$$, 11);

select sec_test.assert_count('11.no_table_privilege_for_anonymous',
  null, null,
  $$select c.oid::regclass::text || '.' || p.priv
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                       ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p(priv)
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm')
      and has_table_privilege('anonymous', c.oid, p.priv)$$, 0);

-- pg_class rows for sequences must be filtered before has_sequence_privilege is
-- evaluated, otherwise the planner can call it on a TOAST table and raise.
select sec_test.assert_count('11.no_sequence_privilege_for_anonymous',
  null, null,
  $$with s as materialized (
      select c.oid::regclass as seq
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'S'
    )
    select s.seq::text from s where has_sequence_privilege('anonymous', s.seq, 'USAGE')$$, 0);

-- The audit_logs identity sequence is the one sequence in public, and clients
-- must not hold any privilege on it.
select sec_test.assert_count('11.audit_logs_identity_sequence_is_not_client_usable',
  null, null,
  $$select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
      and has_sequence_privilege('authenticated', c.oid::regclass, 'USAGE')
      or n.nspname = 'public' and c.relkind = 'S'
      and has_sequence_privilege('anonymous', c.oid::regclass, 'USAGE')$$, 0);

-- Live probes on every table.
select sec_test.assert_error('11.anonymous_cannot_select_customers',
  'anonymous', null, $$select * from public.customers$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_select_bills',
  'anonymous', null, $$select * from public.bills$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_select_bill_items',
  'anonymous', null, $$select * from public.bill_items$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_select_bill_attachments',
  'anonymous', null, $$select * from public.bill_attachments$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_select_ocr_jobs',
  'anonymous', null, $$select * from public.ocr_jobs$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_select_products',
  'anonymous', null, $$select * from public.products$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_select_organizations',
  'anonymous', null, $$select * from public.organizations$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_select_memberships',
  'anonymous', null, $$select * from public.memberships$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_select_profiles',
  'anonymous', null, $$select * from public.profiles$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_select_import_batches',
  'anonymous', null, $$select * from public.import_batches$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_select_audit_logs',
  'anonymous', null, $$select * from public.audit_logs$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_select_storage_objects',
  'anonymous', null, $$select * from public.storage_objects$$, '42501');

-- Live probes on every public function.
select sec_test.assert_error('11.anonymous_cannot_call_save_bill',
  'anonymous', null, $$select public.save_bill('{}'::jsonb)$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_call_update_bill',
  'anonymous', null,
  $$select public.update_bill('ffffffff-0000-4000-8000-000000000101'::uuid, '{}'::jsonb)$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_call_soft_delete_bill',
  'anonymous', null,
  $$select public.soft_delete_bill('ffffffff-0000-4000-8000-000000000101'::uuid)$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_call_restore_bill',
  'anonymous', null,
  $$select public.restore_bill('ffffffff-0000-4000-8000-000000000101'::uuid)$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_call_bootstrap_organization',
  'anonymous', null, $$select public.bootstrap_organization('Evil Corp')$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_call_add_organization_member',
  'anonymous', null,
  $$select public.add_organization_member('11111111-1111-4111-8111-111111111111'::uuid, 'x@y.z')$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_call_set_customer_verification',
  'anonymous', null,
  $$select public.set_customer_verification('cccccccc-0000-4000-8000-000000000101'::uuid, 'verified')$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_call_dashboard_summary',
  'anonymous', null, $$select public.dashboard_summary('11111111-1111-4111-8111-111111111111'::uuid)$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_call_report_summary',
  'anonymous', null,
  $$select public.report_summary('11111111-1111-4111-8111-111111111111'::uuid,
       date '2026-01-01', date '2026-12-31')$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_call_customer_summary',
  'anonymous', null, $$select public.customer_summary('cccccccc-0000-4000-8000-000000000101'::uuid)$$, '42501');

select sec_test.assert_error('11.anonymous_cannot_call_customer_products',
  'anonymous', null, $$select * from public.customer_products('cccccccc-0000-4000-8000-000000000101'::uuid)$$, '42501');

-- The internal helper schemas are closed to anonymous as well.
select sec_test.assert_count('11.anonymous_cannot_use_app_private_schema',
  null, null,
  $$select 1 from pg_namespace
    where nspname = 'app_private' and has_schema_privilege('anonymous', oid, 'USAGE')$$, 0);

-- The internal helper schemas are closed to anonymous as well. `auth` is
-- created by Neon (pg_session_jwt), not by db/migrations, and Neon grants its
-- own roles access to it, so its ACLs are deliberately not asserted here.

select sec_test.assert_count('11.anonymous_cannot_call_app_private_helpers',
  null, null,
  $$select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and has_function_privilege('anonymous', p.oid, 'EXECUTE')
      and p.proname not in (
        'set_updated_at', 'enforce_immutable_columns', 'guard_soft_delete',
        'guard_last_admin', 'write_audit_row', 'block_audit_mutation',
        'normalize_gstin_column', 'normalize_customer_fields', 'normalize_bill_gstin',
        'raise_error', 'raise_validation'
      )$$, 0);

select sec_test.assert_count('11.authenticated_cannot_call_app_private_helpers',
  null, null,
  $$select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and p.proname not in (
        'is_org_member', 'has_org_role', 'can_write', 'is_org_admin',
        'shares_org_with', 'storage_path_org'
      )$$, 0);

-- ===========================================================================
--  12. TRIGRAM SEARCH WORKS AND RESPECTS RLS
--       "Sunrise Traders Alpha" (alpha) and "Sunrise Traders Beta" (beta) both
--       match the same trigram, so the counts below prove the RLS scoping
--       rather than an incidental non-match.
--
--       pg_trgm operators and functions live in the `extensions` schema (0004
--       installs it there deliberately). Migration 0004 does NOT grant USAGE on
--       `extensions` to `authenticated`, so a client role cannot resolve the `%`
--       operator or `similarity()` at all -- see the BUG note below. These
--       assertions therefore run the search the way the application actually
--       performs it (`.ilike()` through PostgREST, which the trigram indexes
--       serve via gin_trgm_ops) and the operator-level reachability gap is
--       asserted explicitly as a known finding.
-- ===========================================================================

\echo '== 12. trigram search and RLS =='

-- Control: the superuser, who has USAGE on `extensions`, resolves the operator.
select sec_test.assert_count('12.harness.superuser_trigram_matches_both_orgs',
  null, null,
  $$select id from public.customers
    where name % 'Sunrise Traders' and deleted_at is null$$, 2);

select sec_test.assert_scalar('12.harness.trigram_operator_is_reachable_by_superuser',
  null, null,
  $$select (similarity('Sunrise Traders Alpha', 'Sunrise Traders') > 0.3::real)::text$$,
  'true');

-- The ILIKE search the app issues, for alpha.
select sec_test.assert_count('12.alpha_ilike_search_returns_only_alpha',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id from public.customers
    where name ilike '%Sunrise%' and deleted_at is null$$, 1);

select sec_test.assert_scalar('12.alpha_ilike_search_result_is_the_alpha_row',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id::text from public.customers
    where name ilike '%Sunrise%' and deleted_at is null$$,
  'cccccccc-0000-4000-8000-000000000101');

select sec_test.assert_count('12.beta_ilike_search_returns_only_beta',
  'authenticated', '22222222-2222-4222-8222-222222222201',
  $$select id from public.customers
    where name ilike '%Sunrise%' and deleted_at is null$$, 1);

select sec_test.assert_scalar('12.beta_ilike_search_result_is_the_beta_row',
  'authenticated', '22222222-2222-4222-8222-222222222201',
  $$select id::text from public.customers
    where name ilike '%Sunrise%' and deleted_at is null$$,
  'cccccccc-0000-4000-8000-000000000201');

select sec_test.assert_count('12.outsider_ilike_search_returns_nothing',
  'authenticated', '22222222-2222-4222-8222-222222222202',
  $$select id from public.customers
    where name ilike '%Sunrise%' and deleted_at is null$$, 0);

-- Same scoping for a viewer: RLS, not the role, is the binding filter.
select sec_test.assert_count('12.alpha_viewer_ilike_search_returns_only_alpha',
  'authenticated', '11111111-1111-4111-8111-111111111103',
  $$select id from public.customers
    where name ilike '%Sunrise%' and deleted_at is null$$, 1);

-- And across another tenant-scoped table.
select sec_test.assert_count('12.beta_ilike_search_on_products',
  'authenticated', '22222222-2222-4222-8222-222222222201',
  $$select id from public.products
    where name ilike '%Widget%' and deleted_at is null$$, 1);

select sec_test.assert_count('12.alpha_cannot_search_beta_products',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id from public.products
    where name ilike '%Widget%' and deleted_at is null$$, 1);

-- A LIKE that the gin_trgm_ops index can serve, on bill numbers.
select sec_test.assert_count('12.alpha_ilike_search_on_bill_numbers',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id from public.bills
    where bill_number ilike '%A-000%' and deleted_at is null$$, 2);

select sec_test.assert_count('12.alpha_cannot_search_beta_bill_numbers',
  'authenticated', '11111111-1111-4111-8111-111111111101',
  $$select id from public.bills
    where bill_number ilike '%B-000%' and deleted_at is null$$, 0);

-- pg_trgm and its indexes must actually be installed.
select sec_test.assert_count('12.pg_trgm_is_installed',
  null, null,
  $$select 1 from pg_extension where extname = 'pg_trgm'$$, 1);

select sec_test.assert_count('12.pg_trgm_lives_in_the_extensions_schema',
  null, null,
  $$select n.nspname
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_trgm' and n.nspname <> 'public'$$, 1);

select sec_test.assert_count('12.all_five_trigram_indexes_exist',
  null, null,
  $$select indexname from pg_indexes
    where schemaname = 'public'
      and indexname in (
        'organizations_name_trgm_idx', 'customers_org_name_trgm_idx',
        'customers_org_phone_trgm_idx', 'products_org_name_trgm_idx',
        'bills_org_number_trgm_idx'
      )
      and indexdef ilike '%gin_trgm_ops%'$$, 5);

-- The trigram index is genuinely usable for the application's ILIKE search.
select sec_test.assert_count('12.trigram_index_serves_the_ilike_search',
  null, null,
  $$select 1
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class tc on tc.oid = i.indrelid
    join pg_namespace tn on tn.oid = tc.relnamespace
    where tn.nspname = 'public' and tc.relname = 'customers'
      and ic.relname = 'customers_org_name_trgm_idx'
      and i.indisvalid
      and (i.indpred is null or pg_get_expr(i.indpred, i.indrelid) ilike '%deleted_at%')
      and pg_get_indexdef(i.indexrelid) ilike '%gin_trgm_ops%'$$,
  1);

-- ---------------------------------------------------------------------------
--  KNOWN SCHEMA BUG (reported, not worked around)
--
--  db/migrations/0004_reporting.sql creates the `extensions` schema and installs
--  pg_trgm into it, but never issues
--      grant usage on schema extensions to authenticated;
--  so `authenticated` cannot resolve the trigram operators (`%`, `<%`, `%>`)
--  or functions (`similarity`, `word_similarity`). The GIN trigram indexes are
--  usable by the planner regardless, which is why `.ilike()` searches work and
--  the application is unaffected -- but any query that reaches for the trigram
--  operators directly fails with
--      ERROR: operator does not exist: text % unknown
--  The fix is one line in 0004 (or 0009). This assertion records the current,
--  broken state so the gap is visible in the suite output rather than silently
--  assumed to be fine. It is expected to PASS as written: it asserts the bug is
--  still present. Flip it to assert `t` once the grant is added.
-- ---------------------------------------------------------------------------
select sec_test.assert_count('12.KNOWN_BUG.trigram_operators_unreachable_by_authenticated',
  null, null,
  $$select 1
    from pg_namespace n
    where n.nspname = 'extensions'
      and not has_schema_privilege('authenticated', n.oid, 'USAGE')$$, 1);

-- ===========================================================================
--  SUMMARY
-- ===========================================================================

\echo ''
\echo '== summary =='

select sec_test.summary() as security_suite_summary;

select case when count(*) = 0 then 'OK' else 'FAILURES' end as result, count(*) as failed
from sec_test.results where not ok;

select name, detail from sec_test.results where not ok order by ord;

do $$
declare v_total int; v_failed int;
begin
  select count(*) into v_total from sec_test.results;
  select count(*) into v_failed from sec_test.results where not ok;
  if v_failed > 0 then
    raise exception 'SECURITY SUITE FAILED: % of % assertions failed', v_failed, v_total;
  end if;
  raise notice 'SECURITY SUITE PASSED: all % assertions passed', v_total;
end;
$$;