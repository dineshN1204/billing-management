# Backup and Recovery

This database holds invoices, customer GSTINs, material balances and payment
records for a real business. A backup taken and never restored from is a guess,
so **restore is rehearsed, not assumed.**

---

## Backups

### Neon branched snapshots

Neon snapshots a branch automatically, and keeps a history you can restore to or
branch from. This is the cheapest and most reliable option for a hosted Neon
database, and it needs nothing from us.

- Console → your project → **Branches** → **Create snapshot**, or
- Point-in-time restore to any second in the retention window.

Check the retention window on your plan. If it is shorter than you want, add the
`pg_dump` below as a second layer.

### Logical dump

```bash
# Custom format: compressed, restorable selectively, pg_dump's own choice.
pg_dump "$DIRECT_DATABASE_URL" \
  --format=custom \
  --file="billbook-$(Get-Date -Format 'yyyy-MM-dd-HHmm').dump"
```

Linux / macOS:

```bash
pg_dump "$DIRECT_DATABASE_URL" \
  --format=custom \
  --file="billbook-$(date +%F-%H%M).dump"
```

Store it somewhere the application machine cannot reach, and keep more than one
copy in more than one place.

**Verify it is not empty.** A zero-byte dump is the classic silent backup
failure:

```bash
ls -lh billbook-*.dump        # expect a few MB, not 0
pg_restore --list billbook-*.dump | head -20   # expect table entries
```

### Documents and attachments

`pg_dump` does **not** include the scanned bills and photographs in Neon Object
Storage. They live in a separate bucket.

```bash
aws s3 sync "s3://$AWS_S3_BUCKET" ./backup/documents-$(date +%F) \
  --endpoint-url "$AWS_ENDPOINT_URL_S3"
```

A database row pointing at a missing object shows a broken preview, so these two
must be restored together or neither.

### What to keep, and for how long

| What | Frequency | Keep |
| --- | --- | --- |
| Neon snapshot | Automatic | As long as your plan retains |
| `pg_dump` | Nightly | 30 days |
| Object storage sync | Weekly | 3 copies |
| Before any migration | Every time | Until the release is confirmed good |

---

## Restoring

### From a dump — into an empty database

> **Do not restore over production without a tested plan.** Restoring is
> destructive: it replaces the contents of the target database.

```bash
createdb billbook_restore
pg_restore -d billbook_restore --no-owner --no-privileges billbook-2026-10-12-0300.dump
```

Then check it before believing it:

```sql
select count(*) as organizations from public.organizations;
select count(*) as customers     from public.customers;
select count(*) as bills         from public.bills;
select count(*) as dc_documents  from public.dc_documents;
select count(*) as audit_logs    from public.audit_logs;
```

Compare against `npm run db:audit` output from before the failure. A restore that
returns the right row counts but no functions is useless — the application calls
procedures, not just tables.

### From a Neon snapshot

Console → branch → **Restore** → point in time, or **Branch** from the snapshot
so you can inspect it before promoting. Branching first is the safe option and
costs nothing.

### Restoring object storage

```bash
aws s3 sync ./backup/documents-2026-10-12 "s3://$AWS_S3_BUCKET" \
  --endpoint-url "$AWS_ENDPOINT_URL_S3"
```

Verify against the `storage_objects` index:

```sql
select count(*) from public.storage_objects;
```

---

## Rehearsing a restore

**Once, on a throwaway branch, before you need it.**

```bash
# 1. A branch to restore into.
neonctl branches create --name restore-drill --parent production

# 2. Restore into it.
createdb "restore_drill"
pg_restore -d "restore_drill" --no-owner --no-privileges billbook-2026-10-12-0300.dump

# 3. Neon Auth must be enabled before 0001 is applied on any branch.
neonctl neon-auth enable --branch restore-drill

# 4. Point the app at the drill branch and use it.
#    Sign in, open a bill, open a challan, generate a PDF.

# 5. Record what happened, and how long it took.
```

Write the result down, including the time it took. Under pressure, knowing it
takes twenty minutes rather than four hours is worth as much as the backup.

Repeat whenever the procedure or the tooling changes.

---

## What a backup does and does not protect you from

**Covered:** accidental deletion, a bad migration, a corrupted table, a lost
instance, ransomware on the application machine.

**Not covered:**

- **Malicious or accidental deletion that is also in the backup.** The audit log
  records who did what, and `audit_logs` is append-only — but nothing stops a
  wrong `DELETE` being legitimate-looking. Review the audit log.
- **A fire in the Neon project itself**, if snapshots and dumps live in the same
  account. Keep at least one copy elsewhere.
- **A credential leak.** See *If a secret is exposed*.

---

## If a secret is exposed

Treat it as compromised and rotate it. Do not hope nobody noticed.

| What | Action |
| --- | --- |
| `DATABASE_URL` / `DIRECT_DATABASE_URL` | Reset the database password in Neon. Update `.env` and the Neon function environment variables |
| `AWS_SECRET_ACCESS_KEY` | Create a new access key, delete the old one, update both places |
| `OCR_API_KEY` | Reissue in the OCR.space dashboard |
| Neon Auth signing secret | Rotate in the Neon dashboard. **Every session is invalidated**, so tell everyone to sign in again |
| `.env` committed to git | Rotate everything in it, then purge the history. Removing the file in a later commit does not remove it from history |

After rotating, check the audit log for access you did not expect.

---

## Disaster runbook

### "The application is down"

1. `npm run db:check` — is the database reachable?
2. `npm run db:audit` — do the functions the frontend calls still exist?
3. Check the Neon dashboard for compute status and connection limits.
4. Check the deploy: `npm run build` on the current source.

### "Someone deleted a record"

1. **Stop. Do not write anything**, or the restore gets harder.
2. Find the actor and time in `audit_logs`.
3. Restore the affected table from the most recent dump or snapshot.
4. Re-apply migrations newer than that snapshot — the restore will be older than
   the current schema.

### "The database is corrupt"

1. Leave the live branch alone.
2. Create a branch from the most recent good snapshot.
3. `npm run db:audit` against it.
4. Repoint `VITE_NEON_DATABASE_URL` at the recovered branch.
5. Restore object storage.
6. Re-apply any migrations applied since the snapshot.

---

## Before every migration

Non-negotiable, and the reason `npm run migrate` refuses a production-looking
endpoint unless explicitly told otherwise.

```bash
# 1. Snapshot the branch in the Neon console, or:
neonctl branches create --name pre-migrate-$(date +%F)

# 2. Take a dump.
pg_dump "$DIRECT_DATABASE_URL" -Fc -f "pre-migrate-$(date +%F-%H%M).dump"

# 3. Confirm the dump is real.
ls -lh pre-migrate-*.dump

# 4. Syntax-check the migrations without committing anything.
npm run migrate:check

# 5. Apply, one file at a time, in order.
psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/00XX_*.sql

# 6. Confirm the application can still reach every RPC.
npm run db:audit
```

If step 6 reports a missing function, stop and roll back rather than deploying a
frontend that calls it.