# Feature Inventory

Status key: **A** verified working · **B** implemented, lightly tested · **C**
partial · **D** broken (fixed) · **E** missing · **F** blocked by credentials or
an external service.

---

## Authentication and access

| Feature | Status | Notes |
| --- | --- | --- |
| Email/password sign-in and sign-up | A | Neon Auth via `SupabaseAuthAdapter` |
| Session restoration on refresh | A | `AuthProvider` reads the session on mount; the session gate lives inside the router so the URL always matches the screen |
| Expired-session recovery | A | `recoveringFetch` in `src/lib/db.ts` re-reads the token and replays the failed request; a 15-minute token no longer leaves a tab broken until a manual reload |
| Background token keep-alive | A | Every 10 min, plus on `visibilitychange` |
| Sign out | A | Always re-reads the session afterwards, so a rejected sign-out cannot leave the UI stuck |
| Route protection | A | `RequireSession` wraps every protected route |
| **Role change** | A | Migration `0020`, admin-only, audit-logged |
| **Member deactivation** | A | Migration `0020`; deletes the membership, so access ends immediately |
| **Member list with email** | A | Migration `0020`, admin-only |
| Last-admin protection | A | Enforced twice: `app_private.guard_last_admin` trigger and an explicit check with a readable message |
| Password reset | E | Depends on the Neon Auth provider's email delivery |
| Public self-registration | E | Deliberately absent — this is a private system for ~10 named employees |
| Fine-grained per-module roles | E | See `docs/EMPLOYEE_ACCESS.md` |

---

## Billing

| Feature | Status | Notes |
| --- | --- | --- |
| Customer master | A | Name, GSTIN, phone, email, structured address, state code, payment terms |
| Customers that are also suppliers/vendors | A | One `customers` table, `party_type` ∈ customer / supplier / vendor / other. No duplicate party master |
| GSTIN validation | A | Format-checked, normalised, unique per organization. **Not** government-verified, and the UI does not claim it is |
| Product / service master | A | Code, HSN, unit, default rate, GST rate |
| HSN on bill lines | A | Validated `^[0-9]{2,8}$` on both the product form and the bill form |
| Invoice entry | A | Number, date, customer, place of supply, tax mode, line items |
| **Bill number carries the challan's serial** | A | Migration 0037. A bill raised from an outward challan is numbered `2026-27/0020`, the same serial the challan carries, and the field is locked. A bill raised by hand takes the next free number in the financial year, and the field stays editable |
| Intra-state CGST + SGST | A | `taxable × rate ÷ 200` each, per line, rounded half-up to 2dp |
| Inter-state IGST | A | `taxable × rate ÷ 100` |
| Discount | A | Flat ₹ per line; refused if it exceeds the **rounded** line value, matching the server |
| Cess | A | Either a rate or a fixed amount, never both |
| Taxable value, subtotal, totals | A | Decimal.js; `ROUND_HALF_UP` matches Postgres `round(numeric,2)` on ties |
| Rounding | A | Per line before accumulation, as the RPC does |
| PDF generation | A | pdfmake, lazy-loaded; print path needs no download |
| Printing | A | Dedicated A4 layout, `@page { size: A4 }` |
| Duplicate-bill detection | A | Number, or customer + date + amount, under an advisory lock; operator can override explicitly |
| **A bill is found by the number of the challan it pays for** | A | Migration 0037, `bill_ids_for_dc_number`. Searching a serial answers with the inward challan, the outward challan and the bill |
| **Bill edit no longer clobbers provenance** | A | `source_type` / `verification_status` omitted on update |
| Optimistic concurrency | A | `expected_version` on update; `VERSION_CONFLICT` reported |
| Invoice search, filter, pagination | A | By number, payment status, financial year |
| CSV export | A | Bills, customers, products; formula-injection safe |
| OCR scan of a paper bill | B | Upload → OCR function → review. **No polling**: the job is re-read once, so a slow backend still reads `queued` until reload |
| **Bill import from CSV** | B | Real implementation, 43 unit tests. Not yet exercised against a live database |
| **Partial payments / allocations** | B | Migration 0038: a bill carries the amount received, and the remaining is the database's own figure. A partly paid bill without an amount is refused. **Allocations across bills, and a history of payments, are not built** — see KNOWN_ISSUES §31 |
| **Credit notes / bill cancellation** | E | `soft_delete_bill` and `restore_bill` exist in the database and are wired to no screen |
| **Finalized-bill lock** | E | A finalized invoice can still be edited in place |
| **Outstanding ageing / customer statement** | E | |

---

## Delivery Challan

The rule the module is built on: **physical receipt is not quality acceptance.**

### Inward DC

| Field group | Status |
| --- | --- |
| Party, GSTIN, number, date, reference, notes, contact, address | A |
| Mode of transport, vehicle, transporter, LR/docket, e-way bill | A |
| Expected arrival | **Removed 2026-10** — no longer on the DC form or in its output; the stored value still prints as "Required by" |
| Received date and time | A |
| Item code, description, customer part number, heat number, grade | A |
| Line editor columns — batch / lot and supply from removed for every DC type; "Declared qty" is now "Quantity" (2026-10) | A |
| Transport details — only mode / transporter / vehicle / LR / e-way bill; prepared by and authorized by print once, above the bottom signature lines, received by stays an empty line (2026-10) | A |
| Quantity, unit, material condition, inspection notes | A |
| Printed line columns - #, part, description, drawing, declared, received, accepted, rejected, unit; shortage and the inspection state stay off the paper, on the screen and in the receipt summary; the A4 paper and the PDF print the same table (2026-10) | A |
| Accepted / rejected / pending quantities | A |
| Rejection reason (configurable list, not an enum) | A |
| Attachments, remarks, created by / approved by | A |

### Outward self DC

Destination, purpose, material, quantity, transport, expected and actual return —
all present. **Material ownership is recorded separately** from the header party
(`dc_items.material_owner_id`), because the header is the destination, not the
owner.

### Outward customer DC

Customer, GSTIN, delivery address, number and date, PO / customer reference,
items, dispatch, transport, expected delivery, acknowledgement, received and
pending quantity, remarks, attachments — all present.

Delivery completion (2026-10): the confirmation that the customer took delivery
was **missing entirely** and is now built. `confirm_delivery` and its browser
wrapper had existed since `0016`, but no screen called them, so an outward
challan reached `dispatched` and stopped there. It now records per line:

| Capability | Status |
| --- | --- |
| Dispatch, with the eligible balance enforced in the database | A |
| Part-delivery per line (`qty_dispatched` / `qty_delivered`) | A — added 2026-10, migration 0025 |
| Status derived from the lines: `dispatched` / `partially_delivered` / `delivered` | A — added 2026-10, migration 0025 |
| Dispatch reopens a delivered challan when material remains | A — added 2026-10, migration 0042 |
| Proof of delivery reference, receiver name, delivered-at | A — added 2026-10, migration 0025 |
| Proof of delivery required to close the challan | A — enforced in `confirm_delivery` |
| Delivery confirmation shown on screen, on the printed challan and in the PDF | A — added 2026-10 |
| Outstanding dispatched / delivered / outstanding on the pending-delivery report | A — added 2026-10, migration 0025 |
| Customer acknowledgement sent to the customer by email | E |

**Delivery confirmation moves no material.** Stock leaves at dispatch;
`confirm_delivery` never touches `qty_dispatched`. It records arrival at the
customer, which is a fact about the paperwork rather than a second movement of
goods. Re-deducting on delivery would halve every finished-stock balance. There
is a database test (`14d10`) that pins this.

### Inward and outward are linked

A customer does not send one challan. They send several of their own, each with
its own number, each carrying different parts and drawings. What arrives at our
gate is recorded as **one inward challan of ours**, whose lines each name the
customer's challan they arrived on, and the finished goods go back out on **one
or more outward challans** whose lines each name the inward line they came from.

```
INW-0021 (ours)
  line 1  part A  drawing X  <- customer CUST-4411
  line 2  part B  drawing Y  <- customer CUST-4412
  line 3  part C  drawing Z  <- customer CUST-4413

  receipt      100 received -> 90 accepted, 10 rejected
  machining    input 90 -> 5 machining rejection -> 85 accepted output

OUT-0034 / OUT-0035 (ours, one or many), each line -> source_inward_item_id
  prints "Against customer DC: CUST-4411, CUST-4412"
```

| Capability | Status |
| --- | --- |
| Customer's own DC number recorded **per line** on an inward challan | A — added 2026-10, migration 0026 |
| Several of the customer's challans on one inward challan | A — `dc_items.customer_dc_number` |
| Outward line names the inward line it came from | A — `dc_items.source_inward_item_id`, `dc_inward_lines` picker |
| Source link refused across customers | A — `SOURCE_PARTY_MISMATCH`, enforced in the database |
| Source link refused for a different part | A — `SOURCE_PART_MISMATCH`, enforced in the database |
| Dispatch capped at the **inward line's** availability, not a pool | A — added 2026-10, migration 0027 |
| Availability = what came out **finished**, less what has gone, on a line that has machining records | A — changed 2026-10-21, migration 0037. A line with no machining record is unchanged: the whole accepted quantity |
| A machining record may be **part finished**, and the material it leaves behind is held back | A — migration 0037. The record carries the remaining; the next record on that line starts from it |
| Every customer DC number the challan touches, printed | A — screen, printed challan and PDF |
| Search by customer DC returns the inward challans **and** the outward ones | A — added 2026-10, migration 0030 |
| Search by our DC number, part, drawing, customer, GSTIN or bill number | A — `dc_search` |
| The same search in the global search box, in either module | A — added 2026-10, migration 0032 |
| A bill linked to the challans it bills for | A — added 2026-10, migration 0029 |
| **Bill this challan** — a bill opened from an outward challan, with its customer, parts and dispatched quantities filled in | A — added 2026-10, migration 0032 |
| The challans a bill pays for, listed on the bill | A — `bills_for_dc_summary` |
| A bill found by the customer's DC number in the bill list | A — `bill_ids_for_customer_dc` |
| Every DC number in any report or operations screen opens that challan | A — fixed 2026-10, migration 0032 |
| The outward picker says how much of each inward line is still un-inspected | A — added 2026-10, migration 0032 |
| Machining result filed against the correct inward line | A — fixed 2026-10; it was always filed against line one |
| Batch machining results for all lines at once (multi-line DCs, atomic, no partial saves) | B — frontend wired to `record_machining_batch` (migration 0043); all job-work lines shown in one form, input per line derived from the database, submit disabled until every required line reconciles |
| Machining input pre-filled from the inward accepted quantity | A |

**The link is optional.** A line of finished stock the company holds itself has
no inward material behind it and is left unlinked; the pooled balance then
applies as before.

**Material becomes available to send back once it is judged, not once it
arrives.** `dc_inward_lines` reports `pending_inspection_qty` and a
`fully_inspected` flag for each line, and the outward form shows an inspection
column with an optional "fully received and inspected" filter. A part-judged
line is **shown and marked, not hidden** — silently omitting it reads as though
the inward challan had no such line, and the operator has no way to tell "not
inspected yet" from "not there". What can actually go back is the accepted
quantity, which is on the row either way. A line that is 90 accepted and 10
rejected counts as fully inspected: the 90 is exactly what can go back.

**A challan carries no price.** `dc_items` has no rate and no amount column,
because a challan records the movement of material rather than its value. So
**Bill this challan** brings across the customer, the parts, the units and the
dispatched quantities, and leaves every rate at zero for the operator to type.
That is a deliberate limit, not an oversight, and it is stated on the bill form
as well as in the migration.

**The job status is derived, not stored.** `dc_documents.status` on an inward
challan means the *receipt* lifecycle — `delivered` there means the material
arrived at our gate. How far the work on it has got is a separate value from
`dc_job_progress`, shown as its own badge:

| Derived status | Meaning |
| --- | --- |
| `not_started` | accepted material that no outward line draws from yet |
| `in_progress` | an outward challan has been raised against it: the work is under way |
| `partially_delivered` | the customer has acknowledged some of it |
| `delivered` | every linked outward line fully acknowledged |

Both a line-level figure and a rollup to the challan are returned, and neither
is written anywhere, so neither can drift out of step with the quantities.

**The register shows it too.** Migration 0040 brought the job status to the
challan register, beside the receipt status and with a filter of its own. It
was added rather than substituted: the receipt column reads `issued` on every
inward challan and always will, because it is the material arriving at our
gate, and a challan awaiting inspection is issued but not yet judged. The two
columns answer two different questions, which is why the search page has always
shown them side by side. An outward challan has no job status - it is its own
delivery - so that column reads as an em dash there, and the outward register
does not carry the column at all.

### The job-work chain (added 2026-10-21)

| Capability | Status |
| --- | --- |
| An outward challan that answers an inward one takes the same serial | A — migration 0035. Inward `KI/IN/2026-27/0012` is answered by `KI/OUT-C/2026-27/0012`; a second outward for the same inward is `0012-2` |
| The inward challan names the outward one, and the outward names the inward | A — the header reference and the per-line source link |
| A challan that names an inward may not draw a line from another one | A — refused by the database, because the number would be a lie |
| The inward challan reads *Work in process* the moment the outward is raised | A — derived, not stored |
| **Create outward DC** on an inward challan, once it is received and inspected | A — the button is disabled until every line has been judged |
| The outward form opens with the inward's lines and the customer's challan numbers | A |
| A bill names the outward challans it pays for, several at once | A — migration 0036, `bill_dc_links` |
| A bill carries the customer's own challan number, typed by hand | A — for a bill raised without a challan |
| The invoice PDF prints the customer DC and the outward DC | A |

### The bill number (added 2026-10-21)

A bill and the challan it pays for are the same job, so they carry the same
number. Migration 0037 makes that true by construction rather than by
convention.

| Rule | Status |
| --- | --- |
| A bill raised from an outward challan carries that challan's serial: the outward `KI/OUT-C/2026-27/0020` is billed `2026-27/0020` | A — the number is made by the database and the field is locked, so it cannot be typed wrong |
| The number is the financial year and the serial, and nothing else — no `KI/` prefix, no `IN` / `OUT-C` segment | A |
| The financial year on the number is the bill's own, so the number and the "Financial year" line on the invoice cannot disagree | A |
| A bill covering several challans carries the lowest serial among them | A — and the bill is found by any of the others, because it is linked to them |
| A bill raised by hand takes the next free number in the financial year, and the field stays editable | A — so a paper invoice's own number can be typed as printed |
| A serial in a financial year means one job: a challan never takes a serial a bill holds, and a bill never takes a serial a challan holds | A — enforced in the database, in both directions |
| A number that names a challan the bill does not pay for is refused | A — at the reservation and again when the bill is linked to the challan |
| A bill in the series form may not be attached to a challan with a different serial | A |
| A number from outside the series — a paper invoice number such as `INV-99` — is kept exactly as typed | A — it holds no serial and competes for nothing |
| An invoice that has gone out is never renumbered | A — the migration renames nothing, and an edit keeps the number the bill was saved with |

**What it buys.** One search answers a whole job. Typing `0020` into the
search box returns the inward challan `KI/IN/2026-27/0020`, the outward
challan `KI/OUT-C/2026-27/0020` and the bill `2026-27/0020`, because all three
carry the same serial and no unrelated document can carry it.

**The cost.** A number is never given out twice. A manual bill whose number is
reserved and then abandoned leaves a gap in the series — the same rule the
challan numbers have followed since 0016, and the same price.

### Job work and subcontracting

| Capability | Status |
| --- | --- |
| Send customer- or company-owned material to a vendor | **Retired 2026-10** — migration 0024 removed `outward_self`, `issue_material` and `record_vendor_return` |
| Sent / returned / accepted / pending / scrap tracked separately | B — columns retained, always zero since 0024 |
| Material rejection vs machining rejection kept distinct | A |
| Partial returns | B — only via `record_material_return` against an inward rejection |
| Vendor process, supporting documents | **Retired 2026-10** with the vendor round trip |
| Unit-converting processes (weight → piece count) | A |

### Quantity rules, and where they are enforced

All of these are enforced **in the database**, not by the browser:

1. Receipt is recorded separately from the declared quantity, and material
   refused at the gate is recorded as rejected on the receipt itself — so it can
   be returned or scrapped through the normal rejection flow. Rejected cannot
   exceed received.
2. Inspection reconciles **exactly**: `accepted + rejected + rework + pending`
   must equal the quantity still to be inspected, cumulative across inspections.
   Editing any one of the four in the form rebalances the other three.
3. Only accepted material can be issued for processing.
4. Subcontracted material stays traceable until reconciled.
5. Machining reconciles: `input = finished machining + machining rejection +
   rework + scrap + authorised loss + remaining`. Loss needs a reason **and** an
   approver. The remaining is worked out by the form, not typed, and a record
   that leaves material behind is a record that balances (migration 0037).
6. Dispatch cannot exceed the eligible balance. For a line linked to an inward
   line, the eligible balance is that line's own: what came out **finished**,
   less what other outward challans have already taken from it. Material that
   has not been machined yet is not finished, so it stays where it is until a
   second record finishes it. A line with no machining record keeps the older
   balance — the whole accepted quantity, less the machining rejection.
7. Partial movement is supported everywhere.
8. Cancellation never deletes.
9. Concurrency is safe: row lock plus a transaction-scoped advisory lock on
   (organization, party, part).
10. Every adjustment is audited.
11. Every line's quantity must be greater than zero. The form refuses to save,
    names the offending line and focuses its field; the database constraint is
    still `declared_qty >= 0`, so this is a form rule, not a schema change.
12. `inspected_qty` counts judged material only, and the database refuses any
    write that would push it above `received_qty`.
13. A receipt may be corrected freely **until** the challan has been inspected.
    After that the whole receipt is refused (`RECEIPT_AFTER_INSPECTION`); see
    `docs/KNOWN_ISSUES.md`.

Browser-side helpers in `src/lib/dc-quantities.ts` exist for live feedback only.
They are a deliberate mirror of the RPCs, and every disagreement found between
them during the audit was resolved in favour of the database.

### What "inspection not required" means

Unchecking **Inspection required** on the receipt is final for that line. Nobody
is going to judge the material, so it is accepted on arrival
(`accepted = received − rejected`, `pending = 0`, status `not_required`) and the
challan is complete. Leaving `accepted_qty` at zero — which is what this used to
do — made the whole receipt invisible to `available_customer_material`, because
that balance is computed from accepted material only.

### The retired `damaged` quantity

`dc_items.damaged_qty` existed and was written by the receipt form, but nothing
ever read it: it appeared on no challan, no ledger column, no report and no
balance. `rejected` already carried that information and was already printed. It
has been removed from every screen and report; the column itself is left in place
and stays zero. Dropping it is a separate, irreversible decision and has not been
taken.

---

## Inventory and material

| Feature | Status | Notes |
| --- | --- | --- |
| Customer-owned vs company-owned material | A | `material_owner_id`; the two are never conflated |
| Material receipts, issues, dispatches, returns, rejections, scrap | A | |
| Item-level balances | A | Accepted material, accepted finished stock, still at vendor |
| Traceable movement ledger | A | Every movement has source, quantity, date and reference |
| Customer material ledger | A | Per part: receipt, acceptance, processing, dispatch and available balances; raw/finished attribution remains in the balance calculation |
| Location / store tracking | B | `storage_location` exists on the item; no store master, no store-level balance |
| Reorder alerts | E | |
| Purchase orders, material receipts, supplier invoices, supplier payables | E | Phase 6 in the brief is largely unbuilt |
| Double-count protection | A | Dispatch and issue take an advisory lock; `available_balance` is computed from source rows, never stored and hand-edited |

---

## Customers, suppliers and vendors

| Feature | Status |
| --- | --- |
| Unified business-partner model | A |
| Party-type classification | A |
| Credit limit, payment terms | B | Stored and displayed; **not enforced** on bill creation |
| Outstanding per party | B | Derived from what is owed — the bill total less what has been received (migration 0038) |
| Transaction history | A |
| Active/inactive | A | `deleted_at`, soft delete only |
| Purchase orders, supplier invoices, supplier payments | E |
| Vendor job-work history | A | Through the DC module |

---

## Production and quality

| Feature | Status | Notes |
| --- | --- | --- |
| Part-wise output, rejection, rework, scrap | A | Derived from DC machining results. Printed on the outward customer DC itself (screen preview and PDF): quantity, finished, rejected, rework, scrap, loss, **remaining** |
| Rejection reason, operation-wise and part-wise reporting | A | |
| Acceptance rate, rejection trend by month | A | |
| Downtime and reason | E | |
| **Production entry screen** | E | The figures exist; there is no data-entry form. Operators record machining results against a challan |
| Machine / operator / shift | E | No machine master, no operator roster. **No machine integration is claimed** |
| Production orders, job work orders | B | Tables exist (`0013`); no screens |

---

## Reports, exports and dashboard

| Feature | Status |
| --- | --- |
| Billing dashboard | A |
| DC dashboard | A |
| Date-ranged reports with filters | A |
| Outstanding report | B — shows a total, and counts **what is owed** rather than what was invoiced (migration 0038); no ageing |
| Customer statement | E |
| Supplier / vendor statement | E |
| 25+ DC reports | A |
| CSV export everywhere | A |
| PDF for bills and challans | A | The challan PDF and the on-screen A4 layout carry the same sections. The **tax invoice PDF** (added 2026-10-21) carries the company letterhead, `Bill No`, the customer DC and outward DC references, a rate-wise tax summary and the total in words |
| Hardcoded demo figures | **None.** Every number comes from a query or RPC |

Every metric is **"Unavailable"** rather than `0` when its query fails, so a
broken connection can never be mistaken for a real zero.

---

## Progressive Web App

| Feature | Status | Notes |
| --- | --- | --- |
| Web app manifest | A | Verified: name, short name, standalone, theme and background colour, 192/512, maskable |
| Icons | A | Generated deterministically by `scripts/generate-icons.mjs`; PNG-signature-checked in CI |
| Service worker | A | 48 precached assets, **zero runtime caching** |
| **No authenticated response is cached** | A | Verified by inspecting the built `sw.js`; enforced by `scripts/verify-pwa.mjs`, which is proven to fail on a violation |
| Controlled updates | A | `registerType: 'prompt'` — a waiting worker never swaps code under a half-filled form |
| Offline indication | A | Banner plus a topbar dot |
| Navigation fallback | A | Deep links and refresh work offline |
| Installation instructions | A | In-app dialog with per-platform steps, plus `docs/PWA_INSTALLATION.md` |
| Usable without installation | A | The app is a normal website first |
| HTTPS installability | A | Requires HTTPS; see deployment docs |
| **Offline data entry** | **Deliberately not implemented** | A queued challan that synced twice would create a duplicate record, and a duplicate material movement cannot be undone by editing a number |

---

## Responsive layout

| Feature | Status |
| --- | --- |
| Sidebar → off-canvas drawer under 850px | A |
| Grids collapse at 1100 / 850 / 640px | A |
| Tables scroll horizontally rather than overflowing the page | A |
| `min-width: 320px`, no accidental horizontal overflow | A |
| Touch-friendly controls, readable type on a phone | A |
| Print layout, separate from screen | A |
| Same validated services on phone and desktop | A — one codebase, no duplicated logic |
| **Verified at 320 / 375 / 430 / 768 / 1024 / 1440 px in a real browser** | **F** — no browser automation available in this environment |

---

## Quality gates

| Gate | Status |
| --- | --- |
| `npm run typecheck` | A |
| `npm run lint` | A — 0 errors, was 613 |
| `npm test` | A — 155 tests |
| `npm run build` | A |
| `npm run verify:pwa` | A — part of `npm run build` |
| `npm run verify` | A — all of the above in one command |
| Migration syntax validation | A — rolled back, nothing committed |
| Read-only schema audit | A — against the live branch |
| `npm run test:db` | **F** — needs a Neon test branch |
| End-to-end browser tests | **F** — no browser automation available |
| Dependency audit | A — `npm install` reports 0 vulnerabilities |

---

## Summary of what is missing

Ordered by business impact, not by difficulty.

1. **Payment allocations and a history of payments** — the outstanding figures
   are now true (migration 0038: a bill says what has been received, and every
   report counts what is owed). What is still missing is the money *behind*
   the figure: a payment that covers several bills, an advance, and the record
   of each instalment. See KNOWN_ISSUES §31.
2. **Bill cancellation / credit notes** — and a finalized-bill lock.
3. **Purchasing** — purchase orders, supplier invoices, supplier payments,
   payables. Suppliers and vendors exist as parties with no purchase workflow.
4. **End-to-end and browser testing.**
5. **Finer-grained roles** beyond admin / staff / viewer.
6. **OCR job polling** so a scan does not need a manual reload.
7. **Customer statements, ageing, supplier statements.**
8. **Dead-end tabs** on the customer profile.