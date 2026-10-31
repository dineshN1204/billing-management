# Neon / Lakebase Postgres port

Port of the Supabase schema in `../supabase/` to Neon Lakebase Postgres. The originals under
`../supabase/` are untouched and remain the historical reference; everything here is the Neon variant.

## Prerequisites (order matters)

1. **Create the Neon project / branch** with Postgres 17.
2. **Enable Neon Auth on the branch, BEFORE running any migration.**
   Neon Auth creates the `neon_auth.user` table. It does not exist until Auth is enabled, and every
   foreign key that used to point at `auth.users(id)` now points at `neon_auth.user(id)`.
   Also enable the **Data API** — it ships the `pg_session_jwt` extension that provides `auth.uid()`.
   `auth.uid()` still exists on Neon and still returns `uuid`; it is **not** replaced by
   `auth.user_id()`. All `auth.uid()` call sites are unchanged from the Supabase original.
3. Optionally enable Data API **default grants** for the `public` schema. This port does not depend
   on them: `grant usage on schema public to authenticated;` is issued explicitly in `0002`.

Roles `authenticated` and `anonymous` are created by a guarded `DO` block at the top of
`migrations/0002_security_rls.sql` if they are missing. Neon creates them by default; the block is
belt-and-braces and is idempotent.

## Migration order

Apply strictly in numeric order:

| file | contents |
| --- | --- |
| `migrations/0001_core_schema.sql` | schemas, tables, indexes, FKs to `neon_auth.user(id)` |
| `migrations/0002_security_rls.sql` | roles, `app_private` helpers, 37 triggers, RLS policies, grants |
| `migrations/0003_billing_rpc.sql` | parse/validate helpers, `upsert_bill`, `save_bill`, `update_bill`, `soft_delete_bill`, `restore_bill`, `bootstrap_organization` |
| `migrations/0004_reporting.sql` | `dashboard_summary`, `customer_summary`, `customer_products`, `report_summary`, `pg_trgm` in `extensions` + 5 trigram indexes |
| `migrations/0005_ocr_hardening.sql` | tightened `ocr_jobs_insert` policy and UPDATE grant |
| `migrations/0006_membership.sql` | `add_organization_member` |
| `migrations/0007_customer_gstin_verification.sql` | customer address/verification columns, GSTIN format checks, normalizer triggers, `set_customer_verification` |
| `migrations/0008_bill_fy_payment_cess.sql` | `financial_year` / payment / cess columns and the reworked bill + item CHECK constraints |
| `migrations/0009_bill_rpc_cess_payment.sql` | `upsert_bill` with cess + payment handling, `report_summary` with `cess` |
| `migrations/0041_bill_cancellation_reason.sql` | `bills.cancellation_reason`, `soft_delete_state` demands a reason, `soft_delete_bill` grows an optional `reason` argument |
| `seed.sql` | demo customers/products/bills (optional) |

Migrations between the rows above and `0041` are applied strictly in numeric
order and are recorded in `app_public_schema_migrations` by
`scripts/apply-migrations.mjs`; every branch also carries its own state, so
`npm run db:audit` is the source of truth for what is actually applied.

Example with `psql`:

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_core_schema.sql
...
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f seed.sql
```

`seed.sql` needs a target organization: set `app.seed_organization_id` or `app.seed_user_email`, or run
it with a JWT whose `sub` matches a member. It self-skips with a NOTICE when it cannot resolve one,
and when the organization already has `SEED-%` bills. Run it as a privileged role — it inserts into
`customers`, `products`, `import_batches` and `bills` directly and writes `created_by`, which is not a
client-grantable column.

## The `neon_auth.user` ordering problem

`neon_auth.user` only exists after Neon Auth is enabled. So `0001` creates all 13 user FKs from a
guarded, idempotent `DO` block at the end of the file rather than inline in the `CREATE TABLE`
statements:

- if `to_regclass('neon_auth.user')` is NULL, it raises a `NOTICE` naming the manual step and returns —
  it does **not** fail, so the rest of `0001` still applies;
- if the table exists, it adds any FK whose constraint is missing;
- re-running `0001` after enabling Neon Auth adds the FKs and then no-ops.

`0007` does the same for `customers.verified_by`, whose column is created by that migration, so the FK
cannot live in `0001`'s `CREATE TABLE`. `0001`'s block skips that entry with a NOTICE while the column
does not exist yet.

Recovery if you applied `0001` before enabling Auth: enable Neon Auth, then re-run
`migrations/0001_core_schema.sql` (every statement is `if not exists`) and re-run the `DO` block at the
bottom of `migrations/0007_customer_gstin_verification.sql` if that migration already ran.

Verified FK targets — all 13 target the primary key `neon_auth.user(id)`:

| table | column | on delete |
| --- | --- | --- |
| `organizations` | `created_by` | set null |
| `profiles` | `id` | cascade |
| `memberships` | `user_id` | cascade |
| `customers` | `created_by` | set null |
| `customers` | `verified_by` | set null |
| `products` | `created_by` | set null |
| `import_batches` | `created_by` | set null |
| `bills` | `created_by` / `updated_by` / `deleted_by` / `verified_by` | set null |
| `bill_attachments` | `created_by` | set null |
| `ocr_jobs` | `created_by` | set null |

## Storage

Neon has no `storage` schema, so everything touching `storage.buckets` / `storage.objects` is gone: the
bucket insert and the four `storage.objects` policies from the Supabase migration were dropped.
`app_private.storage_path_org()` is kept as-is.

In their place, `0001` creates:

```sql
create table public.storage_objects (
  organization_id uuid not null,
  object_path text not null,
  content_type text,
  size_bytes bigint,
  created_at timestamptz not null default now(),
  primary key (organization_id, object_path)
);
```

This is a server-maintained index of the objects that exist in **Neon Object Storage** under the
`bill-attachments` prefix. RLS in `0002`: `SELECT` for org members, `INSERT`/`UPDATE` for admin/staff
(writers), **no client `DELETE`** — the server maintains it.

`app_private.upsert_bill` now validates attachments against `public.storage_objects` (org-scoped)
instead of `storage.objects`, keeping the same validation order, the same `<org_id>/` prefix and `..`
checks, and the same user-facing error `was not found in the bill-attachments bucket`. MIME type and
size fall back to the indexed `content_type` / `size_bytes` columns. The object-storage upload path
must write this table using a privileged role.

`bill_attachments.file_path` CHECK constraints (`<org_id>/` prefix, no `..`, length) are unchanged.

## Extensions

`pg_trgm` is installed into a dedicated `extensions` schema, never `public` (Neon's advisor flags
extensions in `public`):

```sql
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
```

The 5 trigram indexes still resolve `gin_trgm_ops` dynamically from `pg_extension.extnamespace`, so
they work regardless of the extension's actual schema.

## Roles, grants, function security

- `anon` → `anonymous` everywhere. `authenticated` unchanged.
- Explicit `grant usage on schema public to authenticated;` and
  `grant usage on schema app_private to authenticated;`.
- The Supabase original also granted `app_private` usage to `service_role`. Neon has no `service_role`
  role, so that grant is wrapped in a `pg_roles` check and simply does not fire on Neon.
- Every `security definer` function keeps its `security definer` + `set search_path` exactly as in the
  source. Nothing was stripped.
- All 11 `public` RPCs have an explicit `grant execute ... to authenticated`, plus the existing
  `revoke all ... from public, anonymous`. All `app_private.*` revokes are kept
  (`from public, anonymous, authenticated`).

## Preserved deliberately

All 40 triggers (37 in `0002` + 3 normalizers in `0007`): `set_updated_at`, `enforce_immutable_columns`,
`guard_soft_delete`, `guard_last_admin`, `write_audit_row`, `block_audit_mutation` / truncate,
`normalize_gstin_column`, `normalize_customer_fields`, `normalize_bill_gstin`. Plus:

- append-only `audit_logs` (UPDATE/DELETE/TRUNCATE blocked by trigger, no client INSERT/UPDATE/DELETE grants)
- every CHECK constraint, including GSTIN format, totals consistency, cess consistency, payment unpaid/date rules
- generated columns `bills.bill_number_normalized`, `bills.financial_year`, `customers.customer_name`
- all partial and unique indexes, `pg_advisory_xact_lock` duplicate detection, `version` / `expected_version` `VERSION_CONFLICT`
- soft delete with admin-only delete and restore
- `(select auth.uid())` in the RLS policies it already appeared in (`profiles_*`, `ocr_jobs_insert`) so they stay InitPlans; non-policy call sites are untouched

## Row counts

No count RPCs were added. The frontend uses PostgREST's `Prefer: count=exact`, which works against the
Neon Data API.

## Verifying

`0001` applies cleanly whether or not Neon Auth is enabled yet, and re-running it is safe. `0002`
through `0009` assume Neon Auth is enabled.