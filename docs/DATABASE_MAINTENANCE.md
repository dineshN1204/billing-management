# Database maintenance

This page is for the developer / database owner. The application itself never
deletes or exposes the things described here; all of this is direct-database
work done manually, on purpose, and (for deletion) through a safety-guarded
script.

---

## Seeing who the users are

The application shows email + name on **Settings → Employee access** (via the
`list_organization_members` RPC). If you need to look at the raw tables and
know who a UUID belongs to, two developer-only read-only views join profiles /
memberships to the auth table so you get email and name alongside the id:

```sql
-- Every profile (user), with email and name when present.
select * from public.v_user_profiles order by created_at;

-- Every membership (who belongs to which organization, and their role).
select * from public.v_org_members order by organization_id, member_since;
```

These views are **not** granted to signed-in app users. They skip RLS (views
run with the owner's privileges), so a grant would expose every email to every
user — they are for the database owner only, via psql, the Neon console, or a
SQL client connected with your owner credentials.

> **Neon default-ACL caveat.** Neon branches can carry a default ACL that
> grants the `authenticated` role full DML on every new relation in `public`
> (`neondb_owner` → `authenticated` = `arwd`). This fires at creation time, so
> a migration that creates the views and revokes only from `public`/`anonymous`
> is not enough — the views come into existence already granted to
> `authenticated`. Migration `0052` revokes them explicitly from
> `authenticated`, `anonymous` and `public`. If you recreate these views
> yourself, revoke from all three roles, not just `public`/`anonymous`.

> `profiles.full_name` is only set for the person who created the company;
> invited and self-joined members have `NULL` names and appear by email. That is
> by design — the system does not fabricate names.

---

## Correcting a mistake in the data

The audit trail (`public.audit_logs`, append-only) keeps a before/after JSON
snapshot of every change to customers, products, bills, memberships and so on.
Most "I updated the wrong thing" mistakes are fixed by **updating the record
back to its old value**, which you can read from the `old_data` column of the
audit row — not by deleting anything:

```sql
-- Find what a bill looked like before the last edit.
select old_data, new_data, created_at
from public.audit_logs
where table_name = 'bills' and record_id = '<bill-uuid>'
order by created_at desc;
```

Where a table supports soft delete (`deleted_at` column), prefer that over
hard deleting. Never hard-delete records that only contain a *wrong value* —
update them.

---

## Hard-deleting erroneous records

When a record genuinely must be removed (for example a duplicate customer or a
bill created against the wrong company that must not exist at all), use the
guarded script rather than ad-hoc SQL:

```bash
# Preview without changing anything (default target is the test branch):
node scripts/maintenance-delete.mjs --table customers --id <uuid>

# Also preview by predicate (a --limit is compulsory):
node scripts/maintenance-delete.mjs --table bills --where "created_at < '2026-01-01'" --limit 5

# Delete after reviewing the preview (add --confirm):
node scripts/maintenance-delete.mjs --table customers --id <uuid> --confirm
```

The script has been exercised end-to-end against the Neon test branch
(`ep-cool-rain` / `DATABASE_URL_TEST`): both preview forms display rows and
abort without `--confirm`, a `--confirm` delete of a throwaway customer removed
the row and recorded it in `audit_logs` as `maintenance.delete` (plus the
table's own `z_audit` DELETE snapshot), and the blocklist/force guards refused
`audit_logs` and `organizations` (without `--force`) as documented above.

Guards built into the script:

| Guard | What it means |
| --- | --- |
| Test branch default | Runs against `DATABASE_URL_TEST` unless `--target app` is given |
| Production refusal | Refuses a production-looking host unless `--allow-production` |
| Preview first | Prints matching rows + count; writes nothing until `--confirm` |
| One selector | Exactly one of `--id` (parameterized) or `--where` (with `--limit`) |
| Injection guard | `--where` rejects semicolons / SQL comments |
| Base table only | Refuses views and foreign tables |
| Blocklist | `audit_logs` always refused; `organizations`/`profiles` need `--force` |
| Audit record | Every deleted row is inserted into `audit_logs` as `maintenance.delete` with its JSON `old_data` |

The audit insert is the intent marker; where a table also has its own
`z_audit` trigger, that trigger writes its own faithful `DELETE` snapshot too.
Neither is double-billing — on tables without a trigger, the script's row is
the only record.

`organizations` and `profiles` are identity-critical (deleting an organization
cascades to everything it owns; deleting a profile can strand accounts), so
they require `--force` and explicit thought. `audit_logs` is refused outright —
the audit trail must never be trimmed.

---

## Forward-only fixes for already-applied migrations

A recorded migration never re-runs, so if a migration file is edited *after* it
was applied to a branch, the live schema can diverge from the file. Two migrations
exist purely to bring branches that compiled older revisions back in line; both are
forward-only (no history rewritten) and change no data:

- **`0053_dc_available_balance_fix.sql`** restores the intended body of
  `app_private.dc_available_balance`. Branches that compiled an earlier revision
  of `0027` were running the pre-0027 body, which never reduced the
  customer-material pool on dispatch. `0053` re-issues the 0027 body
  (part-filtered `sum(accepted_qty) − sum(qty_dispatched)`).
- **`0054_report_membership_guard_final.sql`** closes the five report-guard gaps
  from KNOWN_ISSUES #26. Because the originals are `language sql`,
  `CREATE OR REPLACE` cannot convert them; `0054` drops and recreates them as
  `plpgsql` with the `is_org_member` guard. Applying `0034` (or `0032`) on a
  branch without `0054` will recreate unguarded `language sql` versions, so
  migrate in order and land `0054` before re-applying those.

---

## Related

- `docs/BACKUP_AND_RECOVERY.md` — snapshot/dump/restore, and the runbook.
- `docs/EMPLOYEE_ACCESS.md` — the three roles, and the last-admin recovery SQL.
- `scripts/apply-migrations.mjs` — how migrations are applied safely.
