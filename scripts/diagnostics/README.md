# Archived diagnostic scripts

These are the one-off investigation scripts written while tracking down specific
past incidents: auth trigger `search_path` problems, missing grants, missing
functions in the PostgREST schema cache, SECDEF privilege failures, bill column
drift, and so on. They are kept for reference and for reproducing those
investigations if they ever recur.

**They are archived, not part of the application.** Nothing in `src/`, `neon/`,
`db/`, `scripts/*.mjs` or `tests/` imports any of them, and no `package.json`
script runs them.

## Why they are not on the normal path

Read before running anything here.

Each script opens a `pg` client using `DATABASE_URL_UNPOOLED` taken straight out
of `.env`. That is the **owner** connection - it bypasses every Row Level
Security policy, every column grant, and every `SECURITY DEFINER` boundary the
application depends on. Several of them execute `grant`, `alter`, `create or
replace function`, or `drop` statements.

That means they can modify production data and permissions, they will not be
stopped by anything the application enforces, and several of them contain
`update` and `delete` statements. They are also written against a hard-coded
`d:/billing-management/` path, so they only run on the machine that created them.

Treat every file in this folder as a production-affecting script.

## If you need to run one

1. Point it at a **test branch**, never production:

   ```bash
   neonctl branches create --name scratch --parent production
   neonctl neon-auth enable --branch scratch
   $env:DATABASE_URL_UNPOOLED = (neonctl connection-string scratch --pooled false --role-name neondb_owner)
   ```

2. Read the whole file first and know what it will change.
3. Run it from the repository root, since several read `.env` by relative path.

## The supported replacements

| What these scripts were doing | What to use instead |
| --- | --- |
| Applying a migration (`apply-*.cjs`, `apply_*.cjs`) | `npm run migrate` - `scripts/apply-migrations.mjs`, which applies `db/migrations/*.sql` in order and refuses to touch a production-looking endpoint without `--allow-production` |
| Inspecting schema, columns, grants, triggers | `psql "$DATABASE_URL" -c "\d public.bills"` or the Neon SQL editor, on a branch |
| Checking the Data API / auth endpoint | `npm run dev`, then sign in and watch the browser console and the Network panel |
| Reproducing a DC quantity rule | `npm run test:db` - `tests/run-dc-tests.mjs`, which impersonates a real member and is therefore subject to RLS exactly as the browser is |
| Reproducing the billing regression | `npm test` |

If a diagnostic here turns out to be needed regularly, promote it into
`scripts/` as a proper `.mjs` module with Node globals, no hard-coded paths, and a
read-only default - rather than promoting it out of this folder as-is.