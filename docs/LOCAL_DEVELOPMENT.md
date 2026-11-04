# Local Development

Everything needed to run the application locally on Windows, macOS or Linux.

---

## Prerequisites

| Requirement | Version | Why |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | 22.12.0+ or 24.0.0+ | Vite 6 and Vitest 5 |
| [npm](https://www.npmjs.com/) | 10+ | Ships with Node |
| Neon project | — | PostgreSQL with the Data API and Neon Auth enabled |

Neon CLI is optional; it is only needed to create a test branch.

---

## 1. Install

```bash
npm install
```

`node_modules/` is not in version control. `package-lock.json` is, and it is the
source of truth — use `npm ci` in CI to get exactly the reviewed tree.

---

## 2. Configure

Copy the template and edit it:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

`.env` is gitignored and must stay that way. **Never commit it.** Nothing in
`.env` is read by the browser except the three `VITE_`-prefixed URLs, which are
not secrets by design.

### Variables

| Variable | Read by | Required | Notes |
| --- | --- | --- | --- |
| `VITE_NEON_DATABASE_URL` | browser | **yes** | `https://<endpoint>/<database>` — no credentials, no query string. Safe to expose; it identifies the project, not a user |
| `VITE_NEON_API_URL` | browser | **yes** | Deployed `api` function URL. `neon functions get api` |
| `VITE_NEON_PROCESS_BILL_URL` | browser | **yes** | Deployed `process-bill` function URL |
| `WEB_ORIGIN` | functions | **yes** | Exact SPA origin, no trailing slash. Enables CORS |
| `DIRECT_DATABASE_URL` | scripts | for migrations | Direct, unpooled connection as `neondb_owner`. `neon branches url --pooled=false` |
| `DATABASE_URL_UNPOOLED` | scripts | for migrations | Used by `npm run migrate` when `DATABASE_URL_TEST` is absent |
| `DATABASE_URL_TEST` | scripts | for `test:db` | **Point this at a test branch, never production** |
| `OCR_API_KEY` | `process-bill` only | optional | [OCR.space](https://www.ocr.space/ocrapi). Without it, scanning reports the failure instead of returning wrong data |

Neon injects `DATABASE_URL`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL` and the
AWS credentials at function runtime. Do not redeclare them in `.env`.

> **Branch alignment.** The browser, the auth token, the membership check and the
> S3 write all have to agree on one branch:
> - `VITE_NEON_DATABASE_URL` names the branch the **browser** reads and writes.
> - `VITE_NEON_API_URL` / `VITE_NEON_PROCESS_BILL_URL` name the functions, and each
>   function verifies the bearer token against the **auth server of the branch it
>   was deployed to**, then looks the org up in its **own** `DATABASE_URL` branch.
>
> A token issued by branch A will be rejected as "Your session has expired" by a
> function deployed on branch B, and a membership that exists on one branch will
> be "no access" on another. When you switch `VITE_NEON_DATABASE_URL` to a test
> branch, you must either deploy fresh `api`/`process-bill` on that branch and
> point these two variables at them, or swap back to the production trio. Do not
> mix one branch's URLs with another's.

### No secrets in the browser

Anything prefixed `VITE_` is compiled into the JavaScript bundle and is readable
by anyone who loads the page. Only ever put a public URL behind that prefix. A
`DATABASE_URL` with a password must never appear there.

---

## 3. Database

Migrations live in `db/migrations/` as plain SQL, applied in filename order.

```bash
npm run migrate
```

The runner refuses to apply anything to an endpoint whose hostname looks like
production unless you pass `--allow-production`, and it prints the surrounding
source text if a statement fails. **Take a backup first** — see
`docs/BACKUP_AND_RECOVERY.md`.

### Ordering

Migrations must be applied in filename order. They are not individually
idempotent: the historical files (`0001`–`0008`) use plain `CREATE FUNCTION` and
`ADD COLUMN` without `IF NOT EXISTS`, so re-running the whole chain against a
populated database fails on "already exists". That is expected.

### Recommended: a test branch for everything

```bash
neonctl branches create --name dev --parent production
neonctl neon-auth enable --branch dev
```

Point `VITE_NEON_DATABASE_URL` at that branch's Data API host, set
`DATABASE_URL_TEST`, and run `npm run migrate`. Your production branch stays
untouched.

> Vite reads `.env` when the dev server starts. After changing a `VITE_` value,
> restart `npm run dev`.

---

## 4. Run

```bash
npm run dev
```

Open `http://localhost:5173`.

The first person to sign up bootstraps the organization and becomes its admin.
Everyone after that needs to be invited from **Settings → Employee access**.

If the browser shows *"Configuration required"* or *"Backend not configured"*,
a `VITE_` value is missing — see step 2.

---

## 5. Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload. **No service worker** — see below |
| `npm run build` | Type-check, build, then verify the PWA output. Emits `dist/` |
| `npm run typecheck` | `tsc -b`, strict |
| `npm run lint` | ESLint over everything |
| `npm test` | Vitest, 155 unit tests |
| `npm run verify` | typecheck → lint → test → build. **Run this before committing** |
| `npm run verify:pwa` | Re-check an existing `dist/` |
| `npm run icons` | Regenerate PWA icons after a brand-colour change |
| `npm run migrate` | Apply `db/migrations/*.sql` |
| `npm run migrate:check` | Syntax-check every migration; commits nothing |
| `npm run db:audit` | Read-only audit of the connected branch |
| `npm run db:check` | Read-only connectivity probe |
| `npm run test:db` | Database tests. **Requires `DATABASE_URL_TEST`** |
| `npm run seed:dc` | Worked example challans on a **test branch** only |

### Why the service worker is off in development

`devOptions.enabled` is `false` in `vite.config.ts`. A worker in front of the
dev server serves stale bundles, so a change appears not to have taken effect and
you end up debugging the browser's cache instead of your code.

To exercise installability and offline behaviour, build and serve the output:

```bash
npm run build
npx vite preview --port 4173
```

Note that service workers require a secure context. `localhost` counts, so
`vite preview` is enough to test it.

---

## 6. Database tests

`npm run test:db` needs a test branch. It refuses to start against a hostname
that looks like production, and every case impersonates a real member the way the
Data API does — so RLS, column grants and the `SECURITY DEFINER` RPCs are
exercised exactly as the browser exercises them.

```bash
neonctl branches create --name dc-test --parent production
neonctl neon-auth enable --branch dc-test
$env:DATABASE_URL_TEST = (neonctl connection-string dc-test --pooled false --role-name neondb_owner)

npm run migrate
npm run test:db
```

Covers inward/outward/self/customer creation, partial receipts, inspection
reconciliation, material rejection with partial return, subcontracting, machining
rejection and rework, process-loss authorisation, unit conversion, dispatch
balance enforcement, two connections racing for one balance, DC-number
uniqueness, cancellation and audit history, the customer material ledger,
organization isolation, absence of client write grants on quantity columns,
viewer permissions, and a Billing regression check.

---

## 7. Project layout

```
db/migrations/     Forward-only SQL, applied in filename order
db/seed.sql        Demo data, guarded, never applied to production
neon/              Neon Functions (document upload + presign, OCR)
scripts/           Migration runner, data/storage migrations, seed, verification
scripts/diagnostics/  Archived one-off DB scripts — read the README before running
src/components/    Shared UI, shell, document capture, DC paper, PWA status
src/lib/           Data access, domain logic, formatting, CSV, import, PWA
src/pages/         One file per route group
src/test/          Vitest unit tests
tests/             Database tests (Node, not Vitest)
dist/              Build output
```

### Data flow

Everything is a `SELECT` or a call to an RPC. The browser has **no** `INSERT`,
`UPDATE` or `DELETE` grant on any quantity column — moving material or saving a
bill is only possible through a `security definer` function that validates the
business rule. This is enforced by the database, not by the UI, and `test:db`
asserts it.

---

## 8. Troubleshooting

**"Configuration required"** — a `VITE_NEON_DATABASE_URL` is missing. Check
`.env` exists and restart `npm run dev`.

**"Backend not configured"** — `VITE_NEON_API_URL` or
`VITE_NEON_PROCESS_BILL_URL` is missing. Get them from `neon functions get`.

**Sign-up succeeds but lands on the onboarding form** — that is the intended
path for a genuinely new workspace. If you already have one, the membership
lookup failed and the app is telling you so; use **Retry**. It will not send you
to create a second workspace.

**"You already have a workspace"** — the account belongs to an organization.
Sign in instead.

**`auth.uid()` does not exist** — Neon Auth and the Data API must be enabled on
the branch *before* `0001` is applied. See `db/README.md`.

**A DC screen shows zero data** — migrations through `0017` are not applied to
that branch. Run `npm run db:audit`.

**"Could not find function" / PGRST202** — a PostgREST compute is serving a
schema cache older than the last migration. The app retries automatically up to
three times; if it persists, restart the branch's compute.

  If the message names a function the app calls in code (for example
  `record_machining_batch`), the migration that creates it has not landed on the
  branch the browser is pointed at. Run `npm run db:check` (it reports which
  RPCs the frontend references and which are missing) and, if one is absent,
  apply the migration that defines it. A migration that opens `begin;` without
  a matching `commit;` is recorded as applied but does nothing — see
  `docs/KNOWN_ISSUES.md` §32.

**"Your session has expired." when attaching a document or scanning, on a test
branch only (works on production)** — the three endpoints are not all on the same
branch. The api/processbill functions verify the bearer token against the auth
server of the branch they were deployed to, and look the organization up in their
own `DATABASE_URL` branch. Switching `VITE_NEON_DATABASE_URL` to a test branch
does *not* switch which branch the functions belong to, so a token issued by the
test-branch auth server is rejected as expired, and the org's membership rows may
not exist on the function's copy. Either deploy `api` and `processbill` on the
test branch and point `VITE_NEON_API_URL` / `VITE_NEON_PROCESS_BILL_URL` at them,
or run the frontend against the production trio. See "Branch alignment" in
section 2.

The frontend now retries once on a `401` after forcing a session refresh
(`backendRequest` in `src/lib/db.ts`), so a lapsed 15-minute access token
self-heals instead of showing "the request could not be completed". If the
refresh fails, the error names "Sign in to continue." and the UI shows
"Your session has expired. Sign in again to continue." rather than the generic
fallback.

The upload and insert paths are otherwise identical between branches — the
failure is configuration, not a code or schema bug.

**A save fails with a quantity error** — the database refused the business rule.
The message is shown verbatim; `src/lib/format.ts` maps the known codes to
sentences a storekeeper can act on.

**The installed PWA still serves the old version** — open the app and accept the
*"A new version is ready"* banner. Updates are deliberately not automatic.

**Lint fails on `scripts/diagnostics/*.cjs`** — it should not. Those files are
CommonJS and are covered by a dedicated ESLint block. If it does fail, the
`scripts/diagnostics/**/*.cjs` entry in `eslint.config.js` has been removed.

**`npm run migrate` says "already exists"** — expected when replaying the whole
chain on a populated database. Apply only the migrations after the last applied
one.