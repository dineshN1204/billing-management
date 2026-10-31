# Project Audit

Audit of the Billing Management / Billbook repository at the start of this work,
with the findings that were fixed and the ones that remain.

Every claim below was checked against the repository or against the database.
Where something could not be verified, it says so rather than guessing.

---

## 1. What this project is

A single-tenant manufacturing record system for **Kallazhagar Industries**: billing,
delivery challans and material tracking for a CNC / VMC / lathe job-work unit.

| Layer | Choice |
| --- | --- |
| Frontend | React 19, TypeScript (strict, `noUncheckedIndexedAccess`), React Router 7, Vite 6 |
| Backend | Neon PostgreSQL via the Data API, Neon Auth, Neon Functions, Neon Object Storage |
| Authorization | Row Level Security on every table; all quantity movement through `security definer` RPCs |
| Money maths | Decimal.js in the browser, `numeric` in Postgres |
| Quantity maths | `numeric(14,3)` in Postgres, mirrored by `src/lib/dc-quantities.ts` |
| Modules | Billing (`/dashboard`, `/bills`, …) and Delivery Challan (`/dc`, …), sharing one session and one party master |

---

## 2. Baseline, recorded before any change

| Command | Result |
| --- | --- |
| `npm run typecheck` | **pass**, 0 errors |
| `npm test` | **pass**, 92 tests in 10 files |
| `npm run lint` | **fail**, 613 errors |
| `npm run build` | **pass**, but a single 975 kB main bundle |
| PWA | **absent** — no manifest, no service worker, no icons |

The 613 lint errors were **not** real defects. Every one of them was
`console is not defined` or `require is not defined` in 58 one-off CommonJS
diagnostic scripts, caused by an ESLint config that only declared Node globals
for `scripts/**`. One genuine `no-unused-vars` in each of a few files, and one
`ReferenceError` (see DB-03).

The 975 kB bundle was one chunk containing React, the Neon SDK, Zod, every icon
and every route.

---

## 3. Findings, by severity

Severity is judged by business impact on a ten-person workshop, not by how hard
it is to fix.

### 3.1 Incident — `migrate:check` committed to production

Recorded here because it happened during this work, and because the class of
mistake matters more than the instance.

`scripts/validate-migrations.mjs` was written as a read-only syntax check: run
each migration inside a transaction, roll back, report. Its first version did
not strip the `begin; ... commit;` that the migration files contain. A
migration's own `COMMIT` ends the enclosing transaction, so the script's
`ROLLBACK` became a no-op, and **`0019` and `0020` were committed to the
production branch by a check that advertised writing nothing.**

| | |
| --- | --- |
| Data lost | **None.** `0019` replaces a read-only report function — no rows, no state. `0020` adds three functions |
| Existing rows altered | **None.** Neither migration contains an `INSERT`, `UPDATE` or `DELETE` |
| Tables altered | **None** |
| Grants | Correct: `authenticated` only, nothing leaked to `PUBLIC` |
| End state | Exactly what the migrations intend; verified present, complete, `SECURITY DEFINER` |
| Production data | **Unchanged.** `audit_logs` still 231, identical to the pre-change audit — which itself proves no audited mutation happened |

The **fix** is what matters going forward. The checker now strips transaction
control and refuses to run a migration if any survives; refuses a
production-looking hostname without `--allow-production`; creates a probe table
in its own transaction and asserts after rollback that it is gone; and prints
the host it targets. `npm run test:escape-probe` proves it cannot commit — and
does so on the same branch the checker targets, which the first attempt at that
test did **not** (it checked production after testing the test branch, and so
proved nothing).

`npm run db:which` exists because `.env` here points `DATABASE_URL_TEST` and
`DATABASE_URL_UNPOOLED` at **two different Neon branches**. A check against one
and a conclusion drawn from the other would be worthless, and briefly was.

---

### CRITICAL

#### DB-01 — `app_private.upsert_bill` shipped truncated

`db/migrations/0010_bill_customer_contact_snapshot.sql` replaced the function that
**every** bill write goes through with a body that stopped after resolving the
customer and returned nothing:

```sql
  end if;         -- v_customer_address assigned
-- __UPSERT_REST__
end;
$$;
```

`public.save_bill` and `public.update_bill` are thin wrappers around it
(`0003_billing_rpc.sql:857, 872`). PL/pgSQL accepts a `RETURNS jsonb` function
with no `RETURN` at creation time and raises *"control reached end of function
without RETURN"* on first call.

- **Impact:** on any database built by the documented `npm run migrate` path,
  **no invoice can be created or edited at all**.
- **Verified:** `scripts/audit-schema.mjs` confirms the production branch runs
  the complete 649-line body, so production is unaffected — which is exactly why
  it was never noticed.
- **Fix:** 0010 now only declares its columns. `0012` already delivers the same
  snapshot through a `BEFORE INSERT OR UPDATE` trigger, which is strictly better
  because it also covers direct inserts and imports.

#### WEB-01 — the permanent spinner (this is the reported refresh bug)

The recurring complaint *"it only recovers after refreshing a few times"* was one
shape repeated across the app:

```ts
void Promise.all([a, b]).then(([x, y]) => {
  setLoading(false)
})
```

If either request rejects, `.then` never runs, `setLoading(false)` never runs,
and the spinner stays with no error and no retry. Reloading remounts the
component, the retry succeeds, and the only known remedy appears to be
"refresh".

Affected: `BillDetail`, `BillForm`, `CustomerDetail`, `GlobalSearch`,
`ProductForm`, `ProductDetail`, `Settings`, `AuditLog`, `Outstanding`,
`DcLedger`, `DcForm`, `DcDetail`, `loadDcBundle`.

- **Fix:** `src/lib/async.ts` — `settle()` and `settleAll()` normalise both
  failure shapes into a value, so a caller's loading flag always clears and each
  request's failure is still reported separately.
- **Verified:** `src/test/platform.test.ts` asserts a rejection becomes a value
  rather than propagating, and that every step still runs when an earlier one
  fails.

#### SEC-01 — spreadsheet formula injection in every CSV export

`Exports.tsx`, `DcList`, `DcLedger` and `DcOperations` all quoted cells but did
not neutralise a leading `=`, `+`, `-`, `@`, tab or carriage return. Excel,
LibreOffice and Google Sheets execute such a cell on open.

Customer names in this application arrive from **OCR of hand-written paper bills**
and from phone calls, so the cell content is genuinely untrusted.

- **Fix:** one shared writer, `src/lib/csv.ts`, applied to all four call sites.
  A leading apostrophe is the spreadsheet's own "treat as text" marker and is
  stripped on display.
- **Verified:** `src/test/platform.test.ts` covers each dangerous prefix, quotes,
  embedded commas and the null/NaN cases. A gate also asserts the file structure
  cannot be shifted by one hostile cell.

#### BIZ-01 — editing a bill silently rewrote its provenance and its verification

`BillForm.tsx` sent `source_type` and `verification_status` on **every** save:

```ts
source_type: source,
verification_status: source === 'ocr' ? 'verified' : 'verified',  // dead ternary
```

On `/bills/:id/edit` the component mounts with no props, so `source` defaulted to
`'manual'`. The RPC honours any key that is present (`0009:226-231`), so:

- every edit rewrote an OCR or imported bill's source to `manual`;
- every edit promoted a `needs_review` or `rejected` bill to `verified`, and
  `0009:241-249` stamped `verified_by` with whoever made the edit.

- **Fix:** both keys are omitted on update, which the RPC treats as "preserve".
- **Verified by reading the server contract** (`0009:226-240`); the behaviour
  itself needs a live save to confirm end to end.

### HIGH

#### DC-01 — editing a challan silently erased three item fields

`DcForm.tsx` built its payload from 13 fields while `DcItemDraft` carries 16 and
the RPC writes 17. Dropped: `heat_no`, `material_grade`, `ordered_qty`.

`0018` **deletes and re-inserts every line on save**, so opening a draft and
saving it wiped the heat number, the material grade and the ordered quantity for
every line. For a job-work unit tracking certified material, that is a
traceability loss.

- **Fix:** all three are now sent. `heat_no` and `material_grade` are text;
  `ordered_qty` is sent as `null` when blank so it is not coerced to 0.

#### DC-02 — one fully-inspected line rejected the whole inspection batch

The inspection panel listed every line with `received_qty > 0`, including lines
already fully inspected. Those defaulted to four zero quantities, and
`0016:965-967` rejects an all-zero line with *"each inspected line must record at
least one non-zero quantity"*.

That check runs **inside a single transaction**, so one such line aborted the
submission and the operator saw every other line fail too.

- **Fix:** the panel now lists only lines with `pending_inspection_qty > 0`, and
  says how many lines were left out and why.

#### DC-03 — the frontend contradicted the database about the inspection ceiling

`inspectionSplit` counted `pending` toward the ceiling. The database does not:

```sql
-- 0016_dc_rpc.sql:971
if v_item.accepted_qty + v_item.rejected_qty + v_item.rework_qty
   + v_accepted + v_rejected + v_rework > v_item.received_qty then
```

Pending material has not been judged yet, so it is still in stock. The form
displayed *"Some lines record more outcomes than were physically received. The
database will refuse this"* about submissions the database accepted.

- **Fix:** the helper now matches the SQL. The existing test asserted the old
  behaviour and was corrected, with the SQL quoted in the test so the reasoning
  cannot drift again.
- **This divergence was a judgement call and is flagged here as such.**

#### WEB-02 — a failed query rendered as "nothing to show"

`Products` had **no error state at all** — the result's `error` was never read,
so a network failure rendered *"No products found"*, a confident and false
statement. The same pattern made a failed `Reports` query leave the **previous
period's figures on screen** with no message, and a failed `Dashboard` summary
render **₹0** for total sales and pending.

₹0 is the worst option available: it is indistinguishable from a real zero, so it
gets acted on.

- **Fix:** every affected page now distinguishes failed from empty. The dashboard
  shows *"Unavailable"* rather than a figure it could not read.

#### WEB-03 — an error was computed and then thrown away

`BillDetail` set `error` from the failed query, then returned
`<EmptyState title="Bill not found">` **before rendering it**. A dropped
connection told the user their invoice had been deleted.

`Customers.CustomerDetail` had the same shape, plus an error-precedence bug that
silently discarded the bills-query error whenever the summary query also failed.

#### WEB-04 — a duplicate-bill dead end, and a second-bill hazard

- If `DUPLICATE_BILL` arrived with an unparseable `details` body, `duplicates`
  was set to `[]`, the "Save anyway" button was gated on `length > 0` and never
  rendered — the bill could not be saved at all.
- If the bill saved but the attachment upload failed, the page stayed on
  `/bills/new` with the form still filled. Clicking Save again created a
  **second bill**.

- **Fix:** a fallback marker keeps the override reachable; navigation now happens
  on the attachment-failure path too.

#### DB-02 — `dc_movement_history` could not be linked to its document

The function returned `dc_number` and `dc_type` but not `dc_id`, so every row on
the "Dispatch and receipt" screen linked to the generic `/dc/all` register.
Separately, `DcDashboard` and several other places hard-coded `/dc/inward/${id}`,
so an **outward-self or outward-customer challan opened the inward detail page**.

- **Fix:** migration `0019` adds `dc_id`; `challanPath()` in `src/lib/navigation.ts`
  is now the single source of truth and every link uses it.

#### DB-03 — a `ReferenceError` that aborted the storage migration

`scripts/migrate-storage.mjs:398` referenced `targetByPath`, which does not
exist; the variable is `targetByKey` (line 272). The reconcile step — the part
that exists to *report* orphan objects — could never run.

#### DC-04 — the machining-loss gate did not match the database

The panel enabled Submit when a loss had a reason but no approver. The RPC
requires **both** (`0016:1652`), so the operator was told they had satisfied a
requirement they had not, and the save was refused.

#### WEB-06 — "[object Object]" and the refresh that "fixed" it"

Every failure path read the cause with `error instanceof Error ? error.message
: String(error)`. `String(someObject)` returns the literal text
**`[object Object]`** — so any rejection that arrived as a plain object (rather
than an `Error`) was shown to the user as that string.

Worse, `isSessionRejected` read the cause the same way. A **lapsed session**
reported as a plain object therefore produced `"[object Object]"`, which matched
no rule, so `queryWithRetry` never refreshed the token and never retried. **The
request was never replayed, and reloading the page was the only recovery** — which
is exactly the reported behaviour.

`PostgestError` does extend `Error`, so database errors were fine. The shapes
that were not: GoTrue auth errors (`{ error, error_description, code, status }`),
HTTP-shaped objects, and transport failures surfaced as plain objects by the
browser or the SDK.

- **Fix:** one `describeError()` in `src/lib/format.ts` that handles `Error`,
  plain objects with `message` / `error_description` / `error` / `details`, a
  bare `status`, a `Response`, strings, numbers, `null`, and objects with nothing
  readable in them (it names the fields rather than printing the object). Applied
  to all 24 call sites. `isSessionRejected` now matches on the whole rejection —
  message, any auth `code`, and an HTTP 401/403 — so a session failure in any
  shape triggers a token refresh and an automatic replay.
- **Verified:** `src/test/errors.test.ts`, 23 tests, including a sweep that
  asserts the literal `[object Object]` cannot be produced by any input, and a
  negative test that a genuine business fault is *not* mistaken for a lapsed
  session (which would burn a retry on a real error).

#### WEB-07 — outstanding had no total

`Outstanding` was a paginated list with no aggregate figure at all. Now shows
bills in view, outstanding in view, and the oldest bill — labelled **"in view"**
because the list is paginated, since presenting a page subtotal as the company
total would be as misleading as showing none.

### MEDIUM

| ID | Finding | Status |
| --- | --- | --- |
| DC-05 | `parseQty` passed negatives through while the display helpers clamped to zero, so the screen showed one number and the submission sent another and the whole batch was refused | fixed |
| DC-06 | `run()` in `DcDetail` cleared a **shared** busy flag and closed whichever panel was open, even if a different action had started it | fixed |
| DC-07 | "Record vendor return" was the only write button not hidden from `viewer`; the server rejected it after a round trip | fixed |
| DC-08 | `DcForm` never sent `expected_version`, so the `VERSION_CONFLICT` guard could never fire — two people editing one draft silently overwrote each other | fixed |
| DC-09 | `loadDcBundle` returned `null` for *any* error, rendering a 500 as "not found", and ignored child-query errors entirely, so a failed line read looked like a challan with no lines | fixed — partial failures are now reported |
| DC-10 | `DcPending` never cleared its error banner, and one failed sub-query blanked all four panels | fixed |
| DC-11 | `DcSettingsPage` showed editable controls to non-admins beneath an "Administrators only" notice | fixed |
| WEB-05 | `money(NaN)` rendered `₹NaN` — OCR of `1,234.50` or `Rs. 500` yields `NaN` | fixed |
| WEB-06 | "Current FY" used `toISOString()` (UTC), showing yesterday for IST users before 05:29 | fixed |
| WEB-07 | `Outstanding` had no total at all, only a paginated list | fixed — total added, labelled "in view" |
| WEB-08 | CSV `URL.revokeObjectURL` called synchronously after `click()`, cancelling downloads in some browsers; anchor never appended | fixed |
| WEB-09 | CSV had no UTF-8 BOM, so the rupee symbol mojibaked in Excel on Windows | fixed |
| WEB-10 | Three of five tabs on the customer profile (Payments, Documents, Activity) were dead ends | **not fixed** — see §5 |

### Security review

| Area | Finding | Status |
| --- | --- | --- |
| Authentication | Neon Auth, RLS on every table, `SECURITY DEFINER` RPCs for all writes | sound |
| Authorization | Server-enforced; the `viewer` role cannot write | sound |
| **Access revocation** | **Nothing anywhere could change a role or remove a member.** An employee who left kept access to every invoice, GSTIN and stock balance indefinitely | **fixed** — migration `0020` |
| SQL injection | All writes go through parameterised RPCs; identifiers quoted with `pgIdent` | sound |
| XSS | React escaping throughout; no `dangerouslySetInnerHTML` | sound |
| File uploads | Validated by size, extension and content type; private storage, 60 s signed URLs | see §5 |
| CSV injection | Formula execution on open | **fixed** |
| Secrets | No `VITE_`-prefixed secret; service-role credentials never reach the browser | sound |
| Caching | No authenticated response is cached, by construction | **verified in the build** |

---

## 4. What was verified, and how

Stated precisely, because "it builds" is not evidence.

**Executed and passing:**

- `npm run typecheck` — 0 errors
- `npm run lint` — **0 errors** (was 613)
- `npm test` — **178 tests, 13 files, all passing** (was 92)
- `npm run build` — succeeds, 48 precached assets, ~1.05 MB
- `node scripts/verify-pwa.mjs` — passes; **proven to fail** when a runtime-caching
  route for `neon.tech` is injected into the built worker
- `node scripts/validate-migrations.mjs` — 22 migrations, 0 failures. Runs
  inside a transaction that is rolled back. **This script had a defect during
  this work and committed `0019` and `0020` to production by accident**; see
  §3.1.
- `node scripts/escape-probe-test.mjs` — **passes**. Installs a migration
  containing `begin; create table …; commit;`, runs the checker against the same
  branch, and confirms the table does not exist afterwards.
- `node scripts/audit-schema.mjs` — against the live branch, in a read-only
  transaction: `upsert_bill` complete (649 lines, has a `RETURN`), **25/25** DC
  RPCs present, all billing RPCs present.
- Service worker inspected directly: **zero** runtime-caching strategies, one
  navigation fallback, no reference to the API host, `/rest/v1` or `Authorization`.

**Not executed, and therefore not claimed:**

- `npm run test:db` — needs `DATABASE_URL_TEST` on a Neon test branch with Neon
  Auth enabled. Not configured here.
- End-to-end browser testing of the PWA install, offline behaviour and the
  responsive layouts at 320/375/430/768/1024/1440 px. **No browser automation is
  available in this environment.**
- Saving a bill or challan against the live database. The production branch has
  0 bills and 1 challan; writing test records to it was not appropriate.

---

## 5. Known gaps, stated plainly

1. **Outstanding is overstated, and this is the most important one.**
   There is no amount-paid field anywhere. A bill marked `partial` contributes its
   **entire** `grand_total` to outstanding, identically to an unpaid bill. Three
   surfaces (`Outstanding.tsx`, `dashboard_summary`, `report_summary`) all inherit
   this. Partial payments, advances, allocation and ageing are **not implemented**.
   This needs a payment table and an allocation model — a schema change, and a
   deliberate decision about how partial receipts apply to an invoice.

2. **Bills have no cancel or credit-note workflow.** `soft_delete_bill` and
   `restore_bill` exist in the database and are exposed to no screen. A
   finalized invoice can be edited in place. The only protection against two
   people editing simultaneously is `expected_version`.

3. **Three customer-profile tabs are empty** (Payments, Documents, Activity) and
   present as tabs with `aria-selected`, implying content that does not exist.

4. **`Import` was a stub** that inserted a permanent `processing` row nothing
   ever advanced, and claimed a 10 MB limit it never enforced. It is now a real
   importer (§ below), but it has not been exercised against a live database.

5. **No end-to-end or browser tests.** All coverage is unit tests plus the
   migration validator and the schema auditor.

6. **OCR results are never polled.** After `POST /process-bill` the page re-reads
   the job once. If the backend is still working, the row reads `queued` and the
   user must reload.

7. **Fine-grained roles are not implemented.** The database enforces three roles
   (`admin`, `staff`, `viewer`). The six business functions in the brief —
   accountant, storekeeper, production staff, quality inspector — map onto
   `staff`. Per-module permissions (e.g. an inspector who may record inspection
   but not raise a bill) would require widening `memberships_role_check`,
   redefining `app_private.can_write`, and updating five reporting functions
   that enumerate roles. That is a security-model change and was **not** made
   blind; see `docs/EMPLOYEE_ACCESS.md`.

8. **`db/seed.sql` demo data** is guarded and unapplied to production. No demo
   figure is hardcoded anywhere in `src/`.

---

## 6. Files

**Created:** `src/lib/async.ts`, `src/lib/csv.ts`, `src/lib/pwa.ts`,
`src/lib/import-csv.ts`, `src/lib/import-bills.ts`, `src/components/PwaStatus.tsx`,
`src/vite-env.d.ts`, `src/test/platform.test.ts`, `src/test/import.test.ts`,
`db/migrations/0019_dc_movement_history_document_id.sql`,
`db/migrations/0020_employee_roles.sql`, `scripts/generate-icons.mjs`,
`scripts/verify-pwa.mjs`, `scripts/validate-migrations.mjs`,
`scripts/audit-schema.mjs`, `scripts/check-db.mjs`,
`scripts/fix-bom-literals.mjs`, `scripts/diagnostics/README.md`, and
`public/icons/*.png`.

**Substantially rewritten:** `src/main.tsx` (lazy routes), `src/pages/Settings.tsx`
(employee access), `src/pages/Import.tsx` (real importer), `src/pages/Dashboard.tsx`,
`src/pages/Reports.tsx`, `src/pages/Products.tsx`, `src/pages/Customers.tsx`,
`src/pages/Bills.tsx`, `src/pages/BillForm.tsx`, `src/pages/Outstanding.tsx`,
`src/pages/DcForm.tsx`, `src/pages/DcDetail.tsx`, `src/pages/DcOperations.tsx`,
`src/pages/DcList.tsx`, `src/pages/DcLedger.tsx`, `src/pages/DcDashboard.tsx`,
`src/lib/dc-api.ts`, `src/lib/dc-quantities.ts`, `src/lib/format.ts`,
`src/lib/types.ts`, `src/lib/navigation.ts`, `src/style.css`, `index.html`,
`vite.config.ts`, `eslint.config.js`, `package.json`, `.gitignore`.

**Fixed:** `db/migrations/0010_bill_customer_contact_snapshot.sql`,
`scripts/migrate-storage.mjs`, `scripts/migrate-data.mjs`,
`scripts/remap-user-ids.mjs`.

**Removed:** `src/pages/Bills.tsx.bak`, `src/style.css.bak` (stale editor backups,
invisible to `tsc` and ESLint); 58 root-level `*.cjs` scratch scripts **moved** to
`scripts/diagnostics/`, not deleted.

**Never touched:** `.env`, and no data was written to any database.