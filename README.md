# Billbook — Kallazhagar Industries

A business record system for a CNC / VMC / lathe job-work manufacturing unit.
Billing, delivery challans and material tracking, in one application, usable on
a desktop and installable on a phone.

One database. One sign-in. A challan recorded on the shop floor is the same
record seen on the office computer.

| | |
| --- | --- |
| **Audience** | ~10 named employees, one company |
| **Devices** | Desktop, laptop, Android phone, tablet — as a website or an installed app |
| **Billing** | Invoices, GST, payments, duplicate detection, PDF and print |
| **Delivery challans** | Inward, outward self, outward customer, job work, material returns |
| **Material** | Customer-owned vs company-owned, inspection, rejection, reconciliation |
| **Cost** | None. No subscription, no licence, no per-user fee |

---

## Contents

- [Quick start](#quick-start)
- [What it does](#what-it-does)
- [The rules that matter](#the-rules-that-matter)
- [Technology](#technology)
- [Commands](#commands)
- [Project layout](#project-layout)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Documentation](#documentation)
- [Security](#security)
- [Known limitations](#known-limitations-read-this)
- [Migrations](#migrations)

---

## Quick start

```bash
npm install
cp .env.example .env      # Windows: Copy-Item .env.example .env
# edit .env - see docs/LOCAL_DEVELOPMENT.md
npm run migrate
npm run dev
```

Open `http://localhost:5173`. The first person to sign up creates the company
and becomes its admin. Everyone after that either joins an existing company by
searching its GSTIN from the setup screen (read-only until an admin upgrades
them) or is invited from **Settings → Employee access**.

Full instructions, including what each variable is for, are in
**[docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md)**.

---

## What it does

### Billing

- Customers and suppliers and vendors in **one party master**, classified rather
  than duplicated
- GSTIN validation, unique per company. *Format-checked, not registry-verified*
- Products with HSN codes
- Invoices with per-line discount, CGST + SGST or IGST, cess
- Duplicate detection by number, or by customer + date + amount
- CSV import from a spreadsheet, with a dry run
- **Tax invoice PDF** with the company letterhead, the customer's challan
  references, a rate-wise tax summary and the total in words, plus print and CSV
  export
- **Company details** (name, GSTIN, address, phone, email) edited in
  *Company settings* and printed on every invoice and challan
- A bill can name the **outward challans it pays for** — several of them at
  once — and carries the **customer DC numbers** those challans carry

### Delivery challans

| Document | What it records |
| --- | --- |
| **Inward DC** | Material received from a customer or supplier |
| **Outward customer DC** | Finished goods delivered to a customer |
| **Material return DC** | Rejected or surplus material going back |

Each records transport details, vehicle and transporter, expected and actual
return, acknowledgements, and a full item table with **separate** sent,
received, accepted, rejected, pending and scrap quantities.

An outward DC runs `draft → issued → dispatched → partially delivered →
delivered`. Dispatch is the truck leaving; the delivery confirmation is the
customer taking delivery, recorded per line with a proof-of-delivery reference,
a receiver name and a timestamp. Part-deliveries are supported: the challan
closes only once every dispatched quantity has been acknowledged.

**Outward self** (material to a vendor) was removed in migration `0024`, along
with `issue_material` and `record_vendor_return`. The ledger still reports
`issued_for_processing`, `returned_from_processing` and `still_at_vendor`, which
are now always zero.

### Job work and subcontracting

Material sent to an external vendor for heat treatment, plating or grinding stays
traceable until it is returned and reconciled — not when it leaves the gate.

### The job-work chain, end to end

A customer sends material for job work on **their** challan; the material is
received, inspected and machined; the finished parts go back on **our** outward
challan; and the invoice names both.

- The inward challan carries the customer's own challan numbers, on its lines —
  one inward can carry several of theirs (`500` and `503`).
- The outward challan that answers it takes **the same serial**: inward
  `KI/IN/2026-27/0012` is answered by outward `KI/OUT-C/2026-27/0012`. A second
  outward for the same inward is `0012-2`.
- The inward challan says **Work in process** from the moment the outward is
  raised, and **Delivered** when the customer has acknowledged everything. The
  receipt status keeps its own meaning: `delivered` on an inward challan means
  the material reached our gate.
- The bill carries the **customer DC numbers** and the **outward challan
  number**, and prints both on the invoice PDF.
- A machining record may be **part finished**. The input is split into finished
  machining, machining rejection, rework, scrap, any authorised loss and the
  **remaining** — the material that has not been machined yet, which the form
  works out as you type. Material still at the machine is **held back**: only
  what came out finished can be dispatched, and the next record on that line
  starts from what is left.

### What a bill has been paid

A bill says how much has been received against it, and what is still owed.

- Setting the status to **Partially paid** asks for the amount. The form works
  out the balance as you type, and the database refuses a partly paid bill
  without an amount — and refuses one whose amount is the whole bill, because
  that is a paid bill.
- **Paid** means the whole total is received, so the balance is zero. **Unpaid**
  means nothing is received, so the balance is the whole bill.
- The balance is the **database's own figure** (`bills.remaining_amount`), so
  the bills list, the outstanding report, the dashboard and the invoice all
  read the same number.
- The bills list carries **Remaining** next to **Total**, and the outstanding
  report counts what is owed rather than what was invoiced.

The amount is one figure — the total received so far — not a history of
payments. A customer who pays twice, or a payment that covers several bills,
still has to be apportioned by hand. `docs/KNOWN_ISSUES.md` §31 has the
detail.

### Material and quality

Physical receipt is not quality acceptance. A challan declares a quantity, the
gate records what arrived, and inspection records what is usable. Three separate
numbers, never merged. Rejected material is not available for machining.

### Reports

Around thirty DC reports — pending inspection, material rejection, machining
rejection, rework, scrap, acceptance rate, rejection trend, material pending at
vendors, customer material balance — plus billing reports and a dashboard.

Everything reads real rows. A report says "no history" rather than showing an
invented figure.

---

## The rules that matter

Most DC bugs come from breaking one of these, so they are enforced by the
**database**, not by the forms.

1. **Receiving is not accepting.** Declared, received and accepted are separate
   numbers.
2. **Inspection reconciles.** `accepted + rejected + rework ≤ received`,
   measured cumulatively across inspections.
3. **Only accepted material can be issued.** Rejected stock is not available.
4. **Subcontracted material stays traceable** until returned and reconciled.
5. **Machining reconciles.** `input = accepted + rejection + rework + authorised
   loss`. Process loss needs a reason **and** a named approver.
6. **Dispatch cannot exceed the eligible balance.**
7. **Partial movement is supported** everywhere.
8. **Cancellation never deletes.** It records a reason and produces a controlled
   reversal.
9. **Concurrency is safe.** A row lock plus a transaction-scoped advisory lock,
   so two people cannot consume the same quantity.
10. **Every adjustment is audited.**

The browser has **no** `INSERT` or `UPDATE` grant on any quantity column. Moving
material is only possible by calling a validated function. A crafted request
cannot set a number directly, and `npm run test:db` asserts this.

### Customer-owned is not company-owned

Sending 600 pieces to a machine shop does not say *whose* 600 pieces they are.
The header party is the **destination**, not the owner. Material ownership is
recorded per line, and the balance is checked against the owner. Issuing
material without stating the owner is refused — otherwise the only computable
balance would be the vendor's own, which is zero, and therefore wrong in a way
that would block all legitimate work.

---

## Technology

- **Frontend** — React 19, TypeScript (strict), React Router 7, Vite 6, Zod,
  Decimal.js, Lucide
- **Backend** — Neon PostgreSQL via the Data API, Neon Auth, Neon Functions,
  Neon Object Storage
- **Authorization** — Row Level Security on every table; all writes through
  `security definer` RPCs
- **Validation** — Zod in the browser, `app_private.parse_*` in the database
- **Money** — Decimal.js. **Quantities** — `numeric(14,3)`, mirrored by
  `src/lib/dc-quantities.ts`
- **PWA** — `vite-plugin-pwa` with Workbox, configured so that **no
  authenticated response is ever cached**

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server. **No service worker** — it would serve stale bundles |
| `npm run verify` | typecheck → lint → test → build. **Run before committing** |
| `npm run build` | Production build, then verifies the PWA output |
| `npm run typecheck` | `tsc -b`, strict |
| `npm run lint` | ESLint |
| `npm test` | Vitest — 178 unit tests |
| `npm run test:db` | Database tests. Needs `DATABASE_URL_TEST` on a **test branch** |
| `npm run migrate` | Apply `db/migrations/*.sql`. Refuses production without `--allow-production` |
| `npm run migrate:check` | Syntax-check every migration. **Commits nothing** |
| `npm run db:audit` | Read-only audit of the connected branch |
| `node scripts/maintenance-delete.mjs` | Hard-delete erroneous records (preview first, guarded). See `docs/DATABASE_MAINTENANCE.md` |
| `npm run icons` | Regenerate PWA icons after a brand-colour change |

**Tests are real.** `npm run test:db` impersonates an actual workspace member the
way the Data API does, so RLS, column grants and the `security definer` RPCs are
exercised exactly as the browser exercises them — not bypassed with owner
privileges. It refuses to run against a production-looking hostname.

---

## Project layout

```
db/migrations/       Forward-only SQL, applied in filename order
neon/                Neon Functions: document upload, OCR
scripts/             Migration runner, imports, seed, verification tools
scripts/diagnostics/ Archived one-off DB scripts — READ THE README FIRST
src/components/      Shared UI, shell, document capture, DC paper, PWA status
src/lib/             Data access, domain logic, quantities, CSV, import, PWA
src/pages/           One file per route group
src/test/            Vitest unit tests
tests/run-dc-tests.mjs  Database tests
```

`src/lib/async.ts` is worth knowing about: it exists because
`Promise.all(...).then(...)` skips its callback on rejection, which left pages
spinning forever with no error. `settle()` and `settleAll()` make a failure a
value, so a loading flag always clears.

---

## Configuration

Three variables are compiled into the browser bundle. **Only public URLs may
ever sit behind a `VITE_` prefix** — anything there is readable by anyone who
loads the page.

```env
# Browser-safe. No secrets.
VITE_NEON_DATABASE_URL=https://<endpoint>/<database>
VITE_NEON_API_URL=https://<endpoint>-api.compute.<region>.aws.neon.tech
VITE_NEON_PROCESS_BILL_URL=https://<endpoint>-processbill.compute.<region>.aws.neon.tech

# Server-only. Never commit real values.
WEB_ORIGIN=http://localhost:5173
DIRECT_DATABASE_URL=postgresql://<user>:<password>@<endpoint>/<database>?sslmode=require
OCR_API_KEY=<optional>
```

Service-role credentials are never exposed to the browser.

---

## Deployment

Two deployables.

**Frontend** — `npm run build` produces `dist/`. Deploy to any static host over
HTTPS. The one setting that matters: **every unknown path must serve
`index.html`**, or a refresh on any screen 404s. Per-host configuration is in
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

**Backend** — Neon. Apply the migrations in order, deploy the two functions in
`neon/`, and set `WEB_ORIGIN` to the exact frontend origin.

Take a backup first, every time.

---

## Documentation

| Document | What is in it |
| --- | --- |
| **[docs/PROJECT_AUDIT.md](docs/PROJECT_AUDIT.md)** | Full audit: every finding, severity, root cause, fix and verification |
| **[docs/FEATURE_INVENTORY.md](docs/FEATURE_INVENTORY.md)** | Every feature, with honest status |
| **[docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md)** | Setup, configuration, commands, troubleshooting |
| **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** | Deploying both halves, security review, rollback |
| **[docs/PWA_INSTALLATION.md](docs/PWA_INSTALLATION.md)** | Installing on Android, iOS and desktop; what works offline |
| **[docs/EMPLOYEE_ACCESS.md](docs/EMPLOYEE_ACCESS.md)** | Roles, adding and removing employees, lockout recovery |
| **[docs/BACKUP_AND_RECOVERY.md](docs/BACKUP_AND_RECOVERY.md)** | Backups, rehearsed restores, disaster runbook |
| **[docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md)** | **What is not finished, and the manual checks to run** |
| **[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)** | What was done, and what is next |

---

## Security

- **Row Level Security** on every table, keyed on organization membership.
- **No client write grants on quantity columns.** The browser reads numbers and
  calls validated functions; it cannot set one.
- **Admin-only operations** enforced server-side. Hiding a button is a
  convenience, never the protection.
- **`audit_logs` is append-only** — update, delete and truncate are blocked by
  trigger.
- **Documents are private**, served by 60-second signed URLs, validated by size,
  extension and content type.
- **The service worker caches no authenticated response.** Not by policy — by
  construction: there is no runtime caching route at all. `npm run build`
  verifies this and the check is proven to fail if one is introduced.
- **No secrets in the bundle.** `.env` is gitignored; documentation uses
  placeholders.
- **CSV exports are formula-injection safe.** Customer names arrive from OCR of
  paper bills, so a cell beginning `=` is neutralised.

No telemetry of any kind ships in this application — it handles customer GSTINs
and financial records, and sending those to a third party would be a decision
nobody made on purpose.

---

## Known limitations (read this)

The complete list is in **[docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md)**. The
ones that matter most:

1. **Outstanding is overstated for partially paid bills.** There is no
   amount-paid field, so a `partial` bill counts its whole total. Treat
   "Outstanding" as an upper bound until this is built. *This is the largest
   single gap and it is not fixed.*
2. **Bills have no cancel or credit-note workflow**, and no finalized-bill lock.
   A raised invoice can be edited in place.
3. **No purchasing.** Suppliers exist as parties; there are no purchase orders,
   supplier invoices or payables.
4. **No end-to-end or browser tests.** All coverage is unit tests, a migration
   validator and a read-only schema auditor. No browser automation was available.
5. **Three roles only** — `admin`, `staff`, `viewer`. Not per-module.
6. **`migrate:check` accidentally committed `0019` and `0020` to production.**
   Benign outcome, no data lost, but a checker that could write was a real
   defect. Now fixed and covered by a test. Full account in
   `docs/KNOWN_ISSUES.md` §9.
7. **GSTIN is format-checked, not registry-verified.** Nothing claims otherwise.

Production currently holds very little data — no bills, no products. The first
real invoice is the first time `save_bill` runs against live data; raise one
carefully and check the totals before raising many.

---

## Migrations

Forward-only, applied in filename order, **never automatically**. Taking a backup
beforehand is not optional.

| File | Contents |
| --- | --- |
| `0001`–`0002` | Core schema; roles, helpers, triggers, RLS, grants |
| `0003`–`0004` | Billing RPCs; reporting functions |
| `0005`–`0006` | OCR hardening; `add_organization_member` |
| `0007`–`0009` | Customer GSTIN, bill FY/payment/cess, billing RPC |
| `0010`–`0012` | Auth trigger fixes; bill customer contact snapshot |
| `0013`–`0017` | DC parties and orders; core schema; security; RPCs; reporting |
| `0018` | DC save-document upsert by id |
| `0019` | `dc_movement_history` gains `dc_id` so rows link to their challan |
| `0020` | Employee roles: change a role, remove a member, list members |
| `0021`–`0024` | DC session-expiry guard; inward receipt rejections; gate rejection records; outward-self DC removed |
| `0025` | Outward delivery completion: `qty_delivered` per line, `confirm_delivery` rewritten, proof of delivery saved on the challan |
| `0026` | Customer DC number per inward line, source-link guard, inward-line availability |
| `0027` | Dispatch guard corrected (customer material now depletes), per-source-line cap, inward-line picker |
| `0028` | `dc_job_progress`: derived job status on an inward challan |
| `0029` | `bill_dc_links`, so a bill number finds the challans it bills for |
| `0030` | `dc_search`: one search over customer DC, our DC, part, drawing, customer, GSTIN and bill number |
| `0031` | `dc_line_sources`: reads where each line of a challan came from |
| `0032` | Report identifiers: `dc_id` on material rejections and the variance report, challan on machining rejections, inspection state on the outward picker, bill-to-challan reads |
| `0033` | Customer material ledger, rebuilt: the buckets are reported separately and never go negative |
| `0034` | Membership guards on the ten report functions |
| `0035` | An outward challan that answers an inward one takes the same serial (`KI/IN/2026-27/0012` is answered by `KI/OUT-C/2026-27/0012`), and the inward challan reads *Work in process* from the moment the outward is raised |
| `0036` | A bill can carry the customer's own challan number, and the new bill screen offers the outward challans that can be invoiced |
| `0037` | A machining record can be part finished: the input is split into finished machining, rejection, rework, scrap, loss and the **remaining**, and the material that has not been machined is held back from dispatch |
| `0038` | A bill carries the amount received against it: a partly paid bill says how much has been received, the **remaining** is the database's own figure, and the outstanding reports count what is owed |
| `0039` | The bill number carries the challan's serial: the outward `KI/OUT-C/2026-27/0020` is billed as `2026-27/0020`, and a serial in a financial year means one job |
| `0040` | The challan register shows the job status of an inward challan beside its receipt status and can be filtered on it: *Job not started*, *Work in process*, *Partly delivered*, *Delivered* |
| `0041` | A bill can be cancelled in the application: Cancel records a reason (admin-only, refusal without one), Restore clears it, and a cancelled bill is excluded from every write path |
| `0042` | A delivered outward challan can be dispatched against again when the inward line it draws from still has material. Dispatch reopens the challan to `partially_delivered`; the balance guard is the real protection |
| `0043` | Every job-work line on an outward DC requires a machining result before submission; batch saves atomically (`record_machining_batch`, `require_machining_coverage`). Multi-line DCs must cover all required lines. Existing single-line path preserved. |

`0042` and `0043` are **applied** to the branch the browser uses
(`ep-cool-rain-b3ba9y2y`, which is also `DATABASE_URL_TEST`) — `0043` as of
2026-10-24, after the missing `commit;` was restored. **Neither is applied to
production** (`ep-lingering-flower`), which is still at `0041`. The batch
machining form on the production branch will return PGRST202 until they are.
See `docs/KNOWN_ISSUES.md` §32 (the silent-rollback trap that hid the missing
`commit;`) and §33 (the audit blind spot that let it go unchecked).

`0019` and `0020` are **applied** to the production branch (`ep-lingering-flower`).
Both are purely additive — new columns on a read-only report function, and three
new functions. No existing row or column was altered, and `audit_logs` is
unchanged. See `docs/KNOWN_ISSUES.md` §9 for the full account, including how
they came to be applied.

The production branch was brought up to date with `0024`–`0033` and `0035`–`0036`
on 2026-10-21. `0024` removed the outward-self challan type, which deleted the
two outward-self records the branch still held; they were test records for a
feature the project removed, and the deletion is irreversible by that
migration's own design. `0034` was **not** applied: it rewrites functions that
`0032` had already created as SQL, and PostgreSQL will not let a function's
language change under `CREATE OR REPLACE`. The report functions it guards are
already guarded, because `0032` carries the same membership check.

Two notes on history:

- **`0010_bill_customer_contact_snapshot.sql` used to replace
  `app_private.upsert_bill` with a truncated body** that returned nothing, which
  would have made *every* invoice save fail on any freshly migrated database. It
  now declares only its columns; `0012` delivers the same snapshot through a
  trigger, which also covers imports. Production was never affected — verified
  read-only.
- **The historical migrations (`0001`–`0008`) are not re-runnable.** They use
  plain `CREATE FUNCTION` without `IF NOT EXISTS`, so replaying the whole chain
  on a populated database fails on "already exists". Apply only what is
  pending.

Check before applying — this writes nothing:

```bash
npm run db:which         # which branch is this pointed at?
npm run migrate:check    # syntax-checks all 22, rolls each back
npm run test:escape-probe  # proves migrate:check cannot commit
npm run db:audit         # confirms every RPC the frontend calls exists
```

`migrate:check` has already earned its place twice: it caught that
`CREATE OR REPLACE FUNCTION` cannot change a `RETURNS TABLE` shape (which is how
`0019` had to be written), and `test:escape-probe` exists because the checker's
first version could commit.