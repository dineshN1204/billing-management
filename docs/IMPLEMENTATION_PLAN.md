# Implementation Plan

What was done in this pass, what was deliberately left alone, and what the next
pass should be. Written so the work can be continued without re-auditing.

---

## Guiding decisions

Three rules decided almost every judgement call.

**The database wins.** Where the browser's quantity helpers disagreed with the
SQL, the SQL was correct and the helper was changed. `src/lib/dc-quantities.ts`
is a *mirror* of `0016_dc_rpc.sql`, and a mirror that disagrees is worse than no
mirror: it tells the operator the database will refuse a save it would accept.

**No API was changed to accommodate a bug.** The session-refresh problem in
`src/lib/db.ts` was already correctly reasoned and needed no change. The
permanent-spinner class of bug was fixed with helpers rather than by adding
retry buttons or loops.

**Absent is better than lying.** A page that cannot load now says so. A screen
that showed `₹0` when the query failed, or "No products found" when the network
was down, or "Import batch created" when nothing was imported, each stated
something false and looked correct doing it.

---

## Completed

### Phase 1 — Audit

- Read the whole application: 30 source files, 22 migrations, the Neon functions,
  the scripts, the tests and the build configuration.
- Established the baseline by **running** every available command before changing
  anything: typecheck pass, 92 tests pass, lint **613 errors**, build pass at a
  975 kB bundle, **no PWA**.
- Wrote `docs/PROJECT_AUDIT.md`, `docs/FEATURE_INVENTORY.md` and this file.
- Verified the live branch read-only: `upsert_bill` complete, **25/25** DC RPCs
  present, all billing RPCs present.

### Phase 2 — Stability

- **New `src/lib/async.ts`.** `settle()` / `settleAll()` normalise rejection into
  a value. Applied to every page that had `Promise.all(...).then(...)` with no
  `.catch()`, which was the actual cause of "only recovers after a few
  refreshes".
- Every affected page now distinguishes **failed** from **empty**. The dashboard
  shows "Unavailable" rather than `₹0`.
- Errors that were computed and then discarded before rendering now render.
- Fixed a race where a slow response from a previous challan could overwrite the
  one on screen.
- `Outstanding`'s "Current FY" used UTC and showed yesterday before 05:29 IST.

### Phase 3 — Billing

- Editing a bill no longer rewrites `source_type` or escalates
  `verification_status`.
- The duplicate-bill override is reachable even when the detail body cannot be
  parsed; previously the bill could not be saved at all.
- A failed attachment upload now navigates, so a second click cannot create a
  second bill.
- The discount check compares against the **rounded** line value, as the server
  does.
- Outstanding now shows a total, labelled "in view" because the list is paginated.

### Phase 4 — Partners

- Verified the unified party master already covers suppliers and vendors without
  duplication. No change needed.
- GSTIN format validation confirmed; explicitly documented as *not*
  registry-verified.

### Phase 5 — Delivery Challan

- **Data loss fixed:** editing a challan no longer erases `heat_no`,
  `material_grade` or `ordered_qty`. The RPC deletes and re-inserts every line,
  so this was losing traceability data on a job-work unit.
- `expected_version` is now sent, so two people editing one draft are detected.
- The inspection panel lists only lines awaiting inspection. Previously one
  already-inspected line aborted the entire batch.
- `inspectionSplit` now matches the SQL ceiling. The test asserting the old
  behaviour was corrected, with the SQL quoted in it.
- The machining-loss gate now requires an approver, as the RPC does.
- Shared-`busy` race, missing viewer gate, missing effect cleanup, swallowed
  errors, and hard-coded `/dc/inward/` links all fixed.

### Phase 6–7 — Material and production

- No changes. The DC ledger already distinguishes customer-owned from
  company-owned material, and the reconciliation formulas were verified against
  the SQL.
- **Purchasing does not exist** and was not started. Documented as a gap.

### Phase 8 — Payments

- **Outstanding was investigated and the defect confirmed:** there is no
  amount-paid field, so a `partial` bill counts its full total.
- **Not fixed.** This needs a schema decision — a payments table, an allocation
  model, and a decision about advances — and guessing would have put wrong money
  figures in front of the business. Documented as limitation #1.

### Phase 9 — Reports and dashboard

- Dashboard now reports each half of its load separately and marks a figure
  "Unavailable" rather than showing `₹0`.
- `Reports` clears stale figures when the date range is cleared.
- Named the mislabelled "Grand total (GST + cess)" as "Tax payable".

### Phase 10 — Employee access

- **New migration `0020`** adds role change, member deactivation and a member
  list with email addresses. Admin-only, audit-logged, last-admin protected.
- Settings rewritten as a proper Employee Access page that states exactly what
  each role can do.
- This closes a real gap: **nothing in the system could revoke access**. An
  employee who left kept access to every invoice, GSTIN and stock balance.

### Phase 11 — Responsive

- Verified the existing breakpoints at 1100 / 850 / 640px and the horizontal
  scroll containment.
- **Not verified in a browser** — no automation available. A manual checklist is
  in `docs/KNOWN_ISSUES.md`.

### Phase 12 — PWA

- Built from nothing.
- `vite-plugin-pwa` + Workbox, **`registerType: 'prompt'`** so an update never
  swaps code under a half-filled form.
- **`runtimeCaching` is deliberately absent.** No runtime route exists, so no
  authenticated response can be cached — by construction rather than by policy.
- Manifest, six generated icons (including maskable), offline banner, update
  prompt, install banner, and per-platform install instructions in-app.
- **Excluded the 1.9 MB PDF engine from the precache** so an install costs ~1 MB
  rather than ~2.9 MB of mobile data. The browser print dialog still works
  offline.
- `scripts/verify-pwa.mjs` gates the build. **Proven to fail** when a runtime
  caching route for `neon.tech` is injected.

### Phase 13 — Database

- **`0010` fixed.** It replaced `app_private.upsert_bill` — the function every
  bill write goes through — with a body that returned nothing. Any database built
  by `npm run migrate` could not save an invoice at all. Production was never
  affected, which is why it survived; verified read-only.
- **`0019` added** for `dc_movement_history`.
- **`0019`'s own first draft had a real bug**, caught by the new validator:
  `CREATE OR REPLACE FUNCTION` cannot change a `RETURNS TABLE` shape. Fixed with
  a preceding `DROP`.
- **`0020` added** for employee roles.
- `scripts/validate-migrations.mjs` checks all 22 inside a rolled-back
  transaction. Currently: 15 apply cleanly, 6 already on this branch, 1 needs a
  privileged role, **0 failures**.

### Phase 14 — Security

- CSV formula injection fixed everywhere. Customer names come from OCR of paper
  bills, so the cell content is genuinely untrusted.
- CSV `revokeObjectURL` race, missing DOM append and missing UTF-8 BOM fixed.
- The 58 root-level `*.cjs` scripts each read `.env` and run arbitrary SQL as the
  **database owner**. **Moved** to `scripts/diagnostics/` with a README, not
  deleted.
- `.env.example` un-ignored so the template can actually be shared.

### Phase 15 — Performance

- **Main bundle 975 kB → 45 kB**, via route-level lazy loading and vendor
  splitting. A one-line change no longer invalidates the whole bundle, so an
  update on mobile data costs kilobytes instead of ~700 kB.
- Route chunks: `DcDetail` 41 kB, `DcOperations` 17 kB, `Import` 16 kB, and the
  rest under 20 kB.
- `pdfmake` and its 855 kB font file isolated into one lazily loaded chunk that
  is never precached.

### Phase 16 — Testing

- **155 tests** (was 92), in 12 files.
- New: `platform.test.ts` (CSV safety, async helpers, routing, dates, money) and
  `import.test.ts` (43 tests over the CSV parser and bill grouping).
- **The import tests found two real bugs in my own new code**: `looksLikeCsv`
  counted commas as non-printable and rejected short valid files; and the
  template's example row had an unquoted comma in the description, which shifted
  every column and produced a bill with a 220 mm quantity and 145% tax.
- The DC test that asserted the *old*, database-contradicting inspection ceiling
  was corrected rather than left failing.

### Phase 17 — Build and verification

All green, every run:

```
typecheck  0 errors
lint       0 errors   (was 613)
test       155 passed (was 92)
build      48 precached assets, ~1.05 MB
verify:pwa passed
```

### Phase 20 — Documentation

Eight documents, all written from what was actually observed rather than from
what was intended.

---

## Changed, in summary

| Area | Effect |
| --- | --- |
| Data integrity | 1 critical save-path bug, 1 silent data-loss bug, 1 aborted-batch bug |
| Security | CSV injection, access revocation, owner-credential scripts moved |
| Stability | The refresh/retry root cause fixed at the class level |
| Correctness | 6 frontend/database logic disagreements resolved |
| PWA | Built from nothing, with a build-time safety gate |
| Performance | 975 kB → 45 kB main bundle |
| Tooling | Lint baseline clean; 3 verification scripts added |
| Tests | 92 → 155 |

---

## Deliberately not done

Each of these was considered and rejected with a reason, rather than skipped.

**Partial payments and true outstanding.** Needs a payments table and an
allocation model. Inventing one and putting wrong money figures in front of a
business is worse than a documented gap.

**Finer-grained roles.** Requires changing `memberships_role_check`,
`app_private.can_write`, and five reporting functions — a change to the
authorization layer. Must be done on a branch with `test:db` passing, not
alongside everything else.

**Purchasing.** Large. Out of scope for a stability pass.

**Credit notes and bill cancellation.** Needs a business decision about what
happens to GST reports and to already-issued PDFs.

**Offline write queue.** A challan queued offline and synced twice creates a
duplicate record, and a duplicate material movement cannot be undone by editing
a number. Online-only writes are the safe answer.

**Applying `0019` and `0020` to production.** Both were syntax-verified in a
rolled-back transaction against the live branch, but applying a schema change to
a production branch needs the owner's confirmation and a verified backup.

---

## Recommended order for the next pass

**1. True outstanding** *(largest business impact)*
Add `bill_payments` with amount, date, method and reference; an allocation table
for one payment across several bills; and an advance concept. Change
`payment_status` to be **derived** rather than stored. Update
`dashboard_summary`, `report_summary` and the Outstanding page together — they
must never disagree. Then ageing buckets and a customer statement.

**2. Bill cancellation and a finalized lock**
`soft_delete_bill` and `restore_bill` already exist and are permissioned; wire
them to a screen with a mandatory reason. Decide when an invoice stops being
editable.

**3. Browser end-to-end tests**
Playwright against a seeded test branch. Cover: sign-in, raise an invoice,
print, install the PWA, go offline, record a receipt and an inspection, verify
the quantities reconcile. This closes the largest gap in the current test suite.

**4. Responsive verification at the six target widths**
Automated viewport screenshots. Cheap once a browser runner exists.

**5. Purchasing**
Purchase orders → goods receipt → supplier invoice → payment → payable ageing.

**6. Finer-grained roles**
On a branch, with `test:db` green. Value grows with headcount, not before.

**7. OCR polling**
Small: a `setInterval` on a `queued` job. Removes a visible "hang".

**8. Remove the dead-end customer-profile tabs**
Ten minutes. Either implement or delete.

**9. Server-side search and pagination for the DC register**
Only worth it past ~50,000 documents.

---

## Two things to do first

Before any of the above, on the real machine:

1. **Apply `0019` and `0020`** to production, after a backup. Role changes and
   member removal do not work until `0020` is applied.

2. **Raise one invoice and check it by hand.** Production holds zero bills. The
   billing module has never run against real data on this branch, and the first
   `save_bill` is the first time the tax arithmetic, duplicate detection and
   snapshot trigger all execute together.

Then work through the manual checklist in
[`docs/KNOWN_ISSUES.md`](KNOWN_ISSUES.md) — the PWA install, the offline
behaviour and the challan workflows are the parts no automated test here could
reach.