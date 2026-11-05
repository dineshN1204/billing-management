# Known Issues and Limitations

Written so nothing here has to be discovered the hard way. Ordered by how much
it matters.

---

## 1. Outstanding was overstated for partially paid bills (fixed 2026-10-21)

**Severity: high. Affected every receivables figure in the system.**

There was no amount-paid field anywhere in the schema. A bill carried a
`payment_status` of `unpaid | partial | paid`, and nothing else.

A `partial` bill therefore contributed its **entire `grand_total`** to
outstanding — identically to an unpaid one. All three surfaces inherited this:

- `src/pages/Outstanding.tsx`
- `dashboard_summary` (`0004_reporting.sql`)
- `report_summary` (`0009_bill_rpc_cess_payment.sql`)

The bill form collected a payment **date** and **method**, but no amount,
because there was nowhere to store one.

**Consequence:** if a customer had paid half of a ₹10,00,000 bill, it was
counted as ₹10,00,000 outstanding. The real receivable was ₹5,00,000.

**Fixed by migration 0038** (2026-10-21). A bill now carries the amount that
has been received against it (`bills.paid_amount`), and the remaining is a
generated column (`bills.remaining_amount` = the total less the received), so
all three surfaces read the same figure and cannot disagree about it. Setting
the status to *partly paid* asks for the amount; the database refuses a
partly paid bill without one, and refuses one whose amount is the whole bill.
The remaining limitation — one figure rather than a payments history — is
issue 31.

---

## 2. Bills can be cancelled in the database but not in the application (partly fixed 2026-10-24)

`soft_delete_bill` and `restore_bill` exist and are correctly permissioned. No
screen called either.

So a finalized invoice can be **edited in place**. The only protection against
two people editing at once is optimistic concurrency: an edit sends the row
`version`, and the database refuses if it has moved on ("This record changed
elsewhere. Reload it before saving").

There is no finalized/locked state on a bill at all. Editing a raised GST
invoice to a different amount leaves no correction trail — only the audit log's
before/after.

**Fixed 2026-10-24 (the void/cancel half).** The bill page has a *Cancel bill*
button for admins (the database has always been admin-only, and the application
now agrees), which asks for the cancellation reason before anything is sent;
`bills.cancellation_reason` (migration `0041_bill_cancellation_reason.sql`)
records it, and the database refuses a cancellation without one. Cancelled
bills keep their number and reason in a *Show cancelled bills* sub-view of the
bills list, which only an administrator can open or see rows in (that is the
RLS policy, not just a hidden control), and each row has *Restore*, which puts
the bill back on the books and clears the reason. Cancelling also stops edits:
the write path already refused a deleted bill with "bill not found", so a
cancelled invoice can no longer be silently re-edited.

**Still open.** A linked credit note (the correction document a customer
actually receives) and a softer rule for *when* a bill stops being editable
with a reason recorded rather than a hard stop.

---

## 3. Fine-grained roles are not implemented

The database enforces three roles: `admin`, `staff`, `viewer`. The business
functions in the brief — accountant, storekeeper, production staff, quality
inspector — all map to `staff`.

There is no "may record inspection but may not raise a bill". A quality
inspector's account can do anything an operational person can.

Widening this means changing `memberships_role_check`, redefining
`app_private.can_write`, and updating five reporting functions that enumerate
the role list. That is a change to the authorization layer, so it should be done
deliberately on a branch with `npm run test:db` passing — not landed blind
alongside everything else. See `docs/EMPLOYEE_ACCESS.md`.

---

## 4. Purchasing does not exist

Suppliers and vendors exist as parties with a `party_type`, and they can appear
on a challan, but there is **no purchasing workflow at all**: no purchase
orders, no supplier invoices, no goods-receipt notes, no supplier payments, no
payables report.

"Customer outstanding" is a real number. "Supplier payable" is not available in
any form.

For a job-work unit that buys steel, aluminium and consumables, this is the
largest missing area after payments.

---

## 5. Dead-end tabs on the customer profile

`Customers → <customer>` has five tabs. Three of them — **Payments**,
**Documents**, **Activity** — render an empty state pointing elsewhere. They are
presented as tabs with `aria-selected`, so they look like real content.

**Fix:** either implement them or remove them until they exist. A tab that
promises something and shows nothing is worse than no tab.

---

## 6. OCR results are not polled (fixed 2026-10-24)

After `POST /process-bill`, the page re-read the job row **once**. If the
backend has not finished, the row reads `queued`, the UI says "Waiting for
extraction", and there is no poll and no refresh button — the user must reload
the page.

**Fixed 2026-10-24.** Both scan surfaces now poll at three seconds and stop on
their own: the *Recent scans* list refreshes only the rows that are still
`queued` or `processing` (one interval for the list, driven by a ref so the
interval is not rebuilt on every row change), and the review page — which the
single-file upload lands on immediately, often before the extraction exists —
polls its job row until it reaches `succeeded`, `failed`, `imported` or
`discarded`, then shows the real outcome. Failed jobs keep their Retry button;
the only change is that "waiting" now ends by itself.

---

## 7. Outstanding reports have no ageing and no customer roll-up

`/reports/outstanding` is a flat paginated list. It now shows a total for the
page in view, labelled "in view" because the list is paginated.

Missing: ageing buckets (0–30, 31–60, 61–90, 90+ days), a per-customer
roll-up, and a customer statement. These are all derivable from existing data
and need no schema change.

---

## 8. No end-to-end or browser tests

Every automated test is a unit test, a migration validator, or a read-only schema
auditor. **No browser automation was available in this environment**, so none of
the following has been exercised in a real browser as part of this work:

- PWA installation, update prompts, offline behaviour
- Responsive layouts at 320 / 375 / 430 / 768 / 1024 / 1440 px
- Camera capture for OCR
- Print output
- PDF output *in a browser*. The challan PDF is no longer taken on trust:
  `src/test/dc-pdf-render.test.ts` builds every document type through the real
  pdfmake engine and asserts PDF bytes come back, which is what caught the
  weighted-star column widths pdfmake 0.3 removed. That covers geometry, not the
  browser download, so the button still has not been clicked in a real browser.

The responsive CSS has breakpoints at 1100 / 850 / 640px, tables scroll
horizontally inside a container rather than overflowing the page, and
`body { min-width: 320px }`, so the smallest target is supported by
construction — but **construction is not a test**. See the manual checklist
below.

`npm run test:db` has been run against the Neon test branch (`ep-cool-rain`,
`DATABASE_URL_TEST`) and passes 50/50. It previously could not be trusted: that
branch had never had 0020–0022 applied, so cases 8c–8k were exercising the older
`0016` functions and failing for reasons that had nothing to do with the code
under test. Worth knowing before reading a failure from it as a real defect:
**bring the branch up to date with `npm run migrate` first**, and expect cases
written before a migration to assert the behaviour that migration changed.

The branch is now current through `0054` (`0044`, `0050`, `0051`, `0052`,
`0053`, `0054` all applied; ledger has 50 rows). The full suite (128 cases)
passes 128/128 as of 2026-11-02. The 14 pre-existing failures were three
independent problems, all now resolved:

- **16i/k/l/m — stale `dc_available_balance` body** (a genuine schema bug, not a
  test artifact). The branch carried the pre-0027 body, so the customer-material
  pool never moved on dispatch. Fixed by the forward-only migration `0053`,
  which restores the intended 0027 body. No history rewritten.
- **18b — the five unguarded report functions** from issue 26. Closed by
  `0054`, which drops and recreates them as `plpgsql` with the
  `is_org_member` guard.
- **21a–g, 22a–b — serial-space state leakage in the suite itself** (not a
  product bug). The serial-sensitive groups shared one `ORG`, so by group 21 the
  plain mirror serial was already taken and the documented `-2` collision
  fallback fired — which is the designed product behaviour, not a defect. The
  suite now runs those groups in a dedicated fresh organization (`JOB_ORG`).

A description of the identity-view default-ACL fix (`0052`) is in
`docs/DATABASE_MAINTENANCE.md`.

---

## 9. `migrate:check` committed two migrations to production — by accident

**This is an incident, recorded rather than buried.** It happened during this
work and the outcome was benign, but the process was wrong and it is documented
so it cannot recur unnoticed.

**What happened.** `scripts/validate-migrations.mjs` is advertised as a
read-only syntax check: it runs each migration inside a transaction and rolls
back. Its first version did not strip the `begin; ... commit;` that the
migration files contain themselves. A migration's own `COMMIT` ends the
enclosing transaction, so the script's `ROLLBACK` became a no-op and
**migrations `0019` and `0020` were committed to the production branch
(`ep-lingering-flower`)** by a check that claimed to write nothing.

**Assessment of the result — benign:**

| | |
| --- | --- |
| Data lost | **None.** `0019` replaces a read-only report function, which holds no rows and no state. `0020` adds three functions |
| Existing rows touched | **None.** No `INSERT`, `UPDATE` or `DELETE` in either migration |
| Tables altered | **None** |
| Existing behaviour changed | **None.** Both are additive |
| End state | Exactly what the two migrations intend — verified present, complete, `SECURITY DEFINER`, and granted to `authenticated` only |
| Production data | **Byte-identical.** `audit_logs` is still at 231 rows, unchanged from before, which proves no audited mutation occurred |

**The fix.** The checker now:

1. strips transaction control before sending the statement, and **refuses to run
   a migration if any survives**;
2. refuses to run against a production-looking hostname unless
   `--allow-production` is passed;
3. creates a probe table inside its own transaction and, after rolling back,
   asserts the probe is gone — if anything committed, the run aborts;
4. prints the hostname it targets on every run.

**The fix is proven, not asserted.** `npm run test:escape-probe` installs a
migration that contains `begin; create table ...; commit;`, runs the checker
against the same branch, and fails if the table survives.

```bash
npm run test:escape-probe   # PASS: migrate:check cannot write
```

`npm run db:which` prints which branch each variable points at, because the
scripts prefer `DATABASE_URL_TEST` — and the test branch here
(`ep-cool-rain`) is a **different database** from production. A check run
against one and a conclusion drawn from the other would be worthless.

**What I would do differently:** refuse to connect to any branch not named
`DATABASE_URL_TEST` unless explicitly told to, before writing the first line of
the script. The preference order should have been an error, not a fallback.

---

## 10. Production has almost no data in it

Read-only, on `ep-lingering-flower`, as of 2026-10-21:

```
organizations    2      bills           1
customers        4      bill_items      2
products         0      dc_documents   14
audit_logs     231      dc_items       16
```

**One bill.** It is the job-work example seeded by
`node scripts/seed-job-work.mjs` — an inward challan, the outward challan that
answers it, and the invoice that pays for it. Before that, the billing module
had never been exercised with real data on this branch.

The first invoice raised by hand is the first time `save_bill` runs against
data nobody wrote for a demonstration. Worth raising one carefully and checking
the totals before raising fifty.

The separate test branch `ep-cool-rain` does carry the worked DC example
(`npm run seed:dc`) — 10 challans — which is what `npm run test:db` should be
pointed at.

---

## 11. Reports are filter-and-fetch, not warehouse-scale

The DC register fetches its whole result set and filters in the browser, so
search is O(all documents) on every keystroke. Display is capped at 200 rows
with an explicit "showing N of M" notice.

For ten staff and a few thousand challans a year this is fine. It would need
server-side search and pagination beyond roughly 50,000 documents.

---

## 12. Export limits

| Export | Limit |
| --- | --- |
| Bills | First 5,000 rows |
| Customers, products | None |
| DC register | First 200 rows, with a notice |

The bill limit is disclosed in the button label, but **the exported file does not
record that it was truncated.** A user reconciling against a ledger will not know
rows are missing. Worth fixing: write the row count into the file or the
filename.

---

## 13. Storage URLs expire after 60 seconds

Private documents are served by a signed URL with a 60-second lifetime. The
caption says so, but an attachment left open on screen for inspection breaks
mid-view with no refresh control. Reloading the page gets a new link.

---

## 14. Single organization per account

A user belongs to one organization. The schema isolates by organization
throughout, so multi-tenancy is *possible*, but no UI exists for it, and none
is intended at this stage.

There is no subscription, plan or billing of any kind.

---

## 15. Errors are reported, never "[object Object]"

**Fixed.** Recorded here because the fix is easy to undo by accident.

Every failure path used to read a cause with
`error instanceof Error ? error.message : String(error)`. `String(object)`
returns the literal text `[object Object]`, so any rejection arriving as a plain
object was shown as that.

The same pattern was used by `isSessionRejected`. A **lapsed session** reported
as a plain object therefore read as `[object Object]`, matched no rule, and so
was never recognised: the token was not refreshed and the request was not
retried. **Reloading the page was the only way out** — which is why the symptom
looked like "refresh until it works".

Now:

- `describeError()` handles `Error`, plain objects carrying `message` /
  `error_description` / `error` / `details`, a bare HTTP `status`, a `Response`,
  strings, numbers, `null`, and objects with nothing readable (it names the
  fields rather than printing the object). Applied to all 24 call sites.
- `isSessionRejected()` matches the whole rejection — message, any auth `code`,
  and an HTTP 401 or 403 — so a session failure in **any** shape triggers a token
  refresh and an automatic replay without a refresh.
- `isAuthOriginRejected()` names the one 403 that is **not** a session failure:
  Neon Auth's `Invalid origin` (`INVALID_ORIGIN`), returned before the password is
  read when the page's origin is not on the branch's trusted-domain list. It is
  excluded from `isSessionRejected()` (a refresh cannot add a domain) and
  `friendlyError()` reports it as a trusted-domain problem instead of "your
  session has expired".

Covered by `src/test/errors.test.ts`, including a sweep proving the
literal string cannot be produced by any input, a negative test proving a
genuine business fault is not mistaken for a lapsed session, and an auth
origin rejection that must not be retried as one.

If you add a new error path, use `describeError(cause, 'Could not load X.')`
rather than `String(cause)`.

---

## 16. GSTIN format is checked; it is not verified

The format is validated (`^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$`, with
entity code `0` correctly excluded as a government entity).

**No government or third-party GSTIN verification service is integrated.**
Nothing in the application claims a GSTIN has been verified against a registry.
The `verification_status` field means "someone in your organisation has looked at
this", not "the government confirmed it".

---

## 16. Tax mode is asserted, never derived

Intra-state (CGST + SGST) versus inter-state (IGST) is a dropdown the operator
chooses. It is **not** derived from the customer's state code against the
organization's state code, even though both are stored and both are available.

The consequence of choosing wrong is real: charging IGST to a Tamil Nadu
customer, or splitting CGST/SGST for an out-of-state one.

Worth adding a default derived from the two state codes, with the dropdown
still available to override.

---

## 17. A receipt cannot be corrected once the challan has been inspected or returned against

A receipt is freely re-recordable until an inspection exists on that challan,
or until material refused at the gate has been returned or scrapped against it.
After either of those the whole call is refused and the "Record receipt" button
is disabled with the reason shown.

**Why.** Re-recording used to reset `pending_inspection_qty` to the full received
quantity while leaving `accepted_qty` / `rejected_qty` in place, so a single line
could report more material accounted for than had ever arrived — and the
inspection form was then pre-filled with a figure the database was guaranteed to
refuse. Silently discarding a quality record because a quantity was typed wrong
is worse than making a typo expensive, so the receipt is refused instead.

`RECEIPT_AFTER_RETURN` (0023) closes the same hole one step further along. A
gate rejection that already has material returned against it has a return challan
behind it and the paperwork has moved. Re-recording there would leave
`dc_items.rejected_qty` at zero while `dc_rejections` still reported the returned
quantity — the same fact stated two ways, disagreeing, with nothing recording
which is right.

**Consequence.** A mis-keyed *receipt* on a challan that has already been
inspected, or whose refused material has already gone back, cannot be corrected.
The challan has to be cancelled and re-raised.

**Also not built:** there is no way to reverse or amend an inspection. The
`dc_inspections.is_reversal` and `reverses_inspection_id` columns and their
foreign key exist, but no RPC writes them — inspections are append-only, and a
wrong inspection result can only be offset by a second one. Both the ledger and
the acceptance-rate report carry both.

---

## 18. An inward challan has no terminal state

An inward challan has no terminal state. `dc_documents_status_check` offers
`draft | issued | dispatched | partially_delivered | delivered | cancelled`, and
of those only `issued` is ever reachable for an inward document: issuing happens
once, inside `save_inward_dc`, and recording a receipt never moves it.

What the detail page shows instead is **derived**, not stored: `inwardCompletion`
in `src/lib/dc-quantities.ts` reports `not_received`, `awaiting_inspection` or
`complete` from the line quantities. This was a deliberate choice over adding a
stored status, because completion is a fact about the lines rather than a box
somebody ticks — deriving it means it cannot drift out of step with the numbers
underneath it, and a receipt re-recorded after the fact moves the challan back on
its own.

**Where you see it.** The detail page shows it as the *Job progress* badge, and
search shows it as a column of its own. Until migration 0040 the register showed
neither, so every inward challan read `issued` there for ever and the register's
status filter offered `Dispatched` and `Delivered` - values an inward challan can
never reach, which returned an empty table and read like a bug. The register now
carries the job status beside the receipt status with a filter of its own
(`app_private.dc_job_status_by_document`, reached only through `dc_register`),
and offers only the receipt statuses an inward challan can actually reach. The
two columns are kept apart deliberately: `issued` means the material arrived at
our gate, and it stays true after the work is finished.

**Consequence.** Nothing enforces that a challan is completed before, say, it is
reported on. There is no "close the month" check. `dc_variance_report` and the
challan register filtered by job status are the closest substitutes.

**Also not built:** a line that is still `pending` after a partial inspection can
be left that way indefinitely. The receipt and inspection forms both rebalance
the four outcomes to the remaining balance, so a partial submission is deliberate
rather than accidental — but nothing chases it up.

---

## 19. The outward challan used to have no terminal state at all (fixed 2026-10)

Before migration `0025`, an outward challan could reach `dispatched` and go no
further. `public.confirm_delivery` had existed since `0016` and
`dcApi.confirmDelivery` had wrapped it correctly, but **nothing in the
application ever called them** — the detail page offered Dispatch, Record
machining result and Cancel, and that was the whole menu. The consequences:

- Every outward challan sat at `dispatched` for ever.
- `partially_delivered` was in `dc_documents_status_check` and in the
  pending-delivery report, but no function had ever written it. It was a value
  the database could hold and the application could not reach.
- The "Pending customer delivery" report filtered on
  `issued | dispatched | partially_delivered`, so it could only ever grow.
- The **Delivered** filter on the DC register matched nothing.
- The proof-of-delivery reference typed on the dispatch form was written only to
  `dc_movements.reference`. It never reached `dc_documents`, so the challan it
  was typed on did not carry it.
- `actual_delivery_at` and `receiver_name` were stored, and rendered nowhere —
  not on screen, not on the printed challan, not in the PDF.

**Why it went unnoticed.** The RPC was tested (`scripts/seed-dc.mjs` calls it
directly), the browser wrapper was tested (`src/test/dc-rpc-calls.test.ts`
asserts it wraps the payload correctly), and the report that depends on it was
tested. Nothing tested that anything *invoked* it. Three layers of a feature
existed and the one that mattered — a button — was absent.

**Now fixed.** `0025` adds `dc_items.qty_delivered`, rewrites `confirm_delivery`
to take per-line quantities and derive the status from them, and adds the
Confirm-delivery panel. The derived-status rule and the reason for not
re-deducting stock are documented in the migration and in FEATURE_INVENTORY.

**Still not built:** no acknowledgement is sent to the customer, and a
dispatched-then-never-delivered challan produces no reminder beyond the report.

---

## 21. Dispatching customer material never reduced the balance (fixed 2026-10)

`app_private.dc_available_balance` computed the `customer_material` pool as

```
sum(inward accepted_qty)
- sum(outward_self qty_sent - returned_qty)
+ sum(outward_self accepted_return_qty)
```

and migration `0024` deleted the `outward_self` document type. Both deducting
terms were therefore permanently zero, so the pool was **"everything this
customer has ever sent us" and it never moved**. Dispatching did not reduce it.

The same 90 accepted pieces could be dispatched on outward challan after
outward challan, each dispatch individually inside the guard, for ever.

**Why it was invisible.** The `finished_stock` branch of the same function
always subtracted `outward_customer.qty_dispatched` and was correct, so anyone
shipping their own stock saw sensible numbers. The defect only showed on
customer-owned material, which is the job-work case.

**Second defect, found while fixing it.** The machining panel filed every result
against `bundle.items[0]` (`source_dc_item_id: bundle.items[0]?.id`), whatever
quantities were typed. On a challan with several lines, a machining rejection
was attributed to line one regardless of which line the material came from, so
it could never be subtracted from the right inward line. The panel also sent
`material_owner_id` as the item's, which is null unless typed — and
`dc_available_balance` only credits machining output where
`material_owner_id = party`, so the finished quantity was credited to **no pool
at all**.

**Now fixed.** Migration `0027` makes the `customer_material` balance subtract
`outward_customer.qty_dispatched`, and `record_dispatch` guards a linked line
against its own inward line's availability (accepted − machining rejection −
already dispatched) rather than against the pool. The machining panel selects
the line it is recording for and fills its input from that line's inward
accepted quantity, and credits the output to the customer.

**Existing history is untouched.** `qty_dispatched` is only ever incremented and
the guard runs against the incremental amount, so a challan dispatched under the
old rule keeps what it already dispatched and simply cannot be increased. That
is the "block going forward, leave history" rule, and it needs no backfill.

**The report side was never fixed, and is now.** `customer_material_ledger`
computed the same pool as `accepted - issued + returned`, where `issued` and
`returned` both read `outward_self`. It therefore never fell either. Fixed by
`0033`; see issue 23.

---

## 22. The outward challan never said which inward material it was made from

`dc_items.source_inward_item_id` existed from `0014` with its foreign key, and
`dc_documents.reference_inward_dc_id` from the same migration, and
`dc_register` already resolved the latter into `reference_inward_number`
(`0017`). **None of it had any user interface.** The outward form offered only a
purchase-order reference and a delivery-schedule reference
(`src/pages/DcForm.tsx`), so `reference_inward_dc_id` was `null` in every row
created through the application, and every outward line was unlinked.

Consequences: the outward challan printed no customer DC number, the inward
challan had no way to show that its work had been sent back, and dispatch was
guarded only by a pool shared across every inward challan of that customer for
that part — so material from one inward challan could silently pay for a
delivery made against another.

**Now fixed** by migrations `0026`–`0031`, documented in FEATURE_INVENTORY
under "Inward and outward are linked". The customer's own challan number is
recorded per line, the outward line names its inward line, and the dispatch cap
follows that line.

**Still not built:** the job status is derived on read rather than stored, so it
cannot be filtered on in the DC register without a join. The register's status
filter is unchanged and still filters the receipt lifecycle. The bill↔challan
link is raised from the challan and attached on save; there is no DC picker on
the bill form itself, and a bill raised without one is not connected to the
delivery it bills for.

---

## 24. The customer material ledger was wrong in six separate ways (fixed 2026-10)

`customer_material_ledger` was written in `0017` and never revised. Six later
migrations changed the rules it reads from and left it behind. Every symptom
below was reproduced against live data before `0033` was written.

**Finished stock read as zero or went negative.** The machining CTE matched
`material_owner_id = p_customer_id` strictly. The machining panel sent a NULL
owner, so accepted output read zero while the dispatch still counted:

```
TYFGUHI-9652    output 0   dispatched 50   finished stock  -50
DRTRCFG-54151   output 0   dispatched 10   finished stock  -10
FCUKJ-8456      output 0   dispatched 20   finished stock  -20
```

`0027` had already established the correct rule for `dc_available_balance` — an
owner, or a party with no owner — and this function never picked it up.

**Customer material never fell.** See issue 21: the balance subtracted
`outward_self` quantities, which `0024` deleted.

**Four columns could only ever print 0.** `issued_for_processing`,
`returned_from_processing`, `still_at_vendor` and `accepted_return` all read
`outward_self`. `0025` deleted the equivalent dashboard fields for exactly this
reason; the ledger was missed. They are removed rather than left as four
permanent zeros.

**Parts appeared that had never been inwarded.** The part list took
`select distinct part_number, unit` over every document of the customer with no
`dc_type` filter, so a `material_return` document was enough to put a row of
sixteen zeros on the screen — `HG-5562`, `DFHRF-424`, `DFR-545` and others on
production. A part whose unit was typed differently on two challans also
appeared twice, and the page keyed its rows on `part_number` alone.

**The date filter was half applied.** `inward` filtered on `dc_date` and
`machining` on `operation_date`, but `outward_customer`, `outward_self` and
`orders` carried no date predicate at all. A filtered month computed *March
receipts minus all-time dispatches*, with no opening balance. This was the
largest arithmetic error in the function.

**Any authenticated user could read any workspace's ledger.** The function is
`SECURITY DEFINER`, so the RLS policies in `0015` do not apply, and it never
called `app_private.is_org_member`. Every sibling that reports on material —
`dc_dashboard_summary`, `dc_inward_lines`, `dc_job_progress` — does call it.

### What `0033` changed

Two pools, each drained only by what actually left it:

```
raw      = accepted material - machining input consumed - dispatched unmachined
finished = machining output + accepted finished - dispatched machined
```

A dispatch out of one pool can no longer reduce the other. Machining attribution
takes the `0027` rule. The part list comes from inward and outward only, one
deterministic unit per part, and a part with nothing in any bucket is not
reported. Every movement column is date filtered; **the balances are lifetime**
and carry no date predicate, because a period balance with no opening figure is
not a balance. A balance is never negative — the shortfall is returned as
`unaccounted_dispatch` and named on screen. `dc_pending_at_vendors` is dropped;
it read `outward_self` and nothing in the application calls it.

### What is still not right

**The ledger and the dispatch guard now disagree, deliberately.**
`app_private.dc_inward_line_available` (`0026`) caps a dispatch at
`accepted - machining rejection - dispatched`. The ledger deducts machining
*input consumed* instead, because a rejection is already inside the input that
was consumed and counting it twice understates the raw pool. With 90 accepted, 5
rejected in machining and 85 shipped the guard reports 0 and the ledger reports
0, but on other figures the ledger is stricter. Aligning the guard is a decision
about the dispatch cap, not about this screen, and is not done here.

**Raw/finished attribution is approximate per part.** A dispatch counts as
finished if the outward line is declared `finished_stock`, or a machining result
is credited to this customer for this part. Where the same part has both
machined dispatches and unprocessed returns, the split is made at part level.
`dc_machining_results.source_dc_item_id` would make it exact per line and `0026`
/ `0028` use it, but it cannot be relied on: a machining result filed without
naming an outward line carries a null source, and relying on it classified 400
genuinely finished pieces as unprocessed raw. Nothing else in the schema
distinguishes the two cases.

**The ledger and the ten report functions it calls are now guarded** — see
**0034** below. Before that, only the ledger had a membership check; every report
function in the module could be read across workspaces.

---

**Two seeded machining results were deleted on the test branch.** They were
attached to the seeded `outward_self` challans, so `0024` removed them with those
challans (see issue 20). KI-101 there consequently reports 400 finished pieces as
`unaccounted_dispatch` rather than showing the 160 that were previously credited
to output that no longer exists. That is the honest reading of the data now, but
it is a data loss, not a calculation.

**Ten report functions had the same missing membership guard** as the ledger had
(fixed by `0034`). An earlier draft of this section said five and named
`dc_register`, `dc_acceptance_rate`, `dc_rejection_trend`, `dc_movement_history`
and `dc_variance_report`. The audit found ten, and the five listed above were not
the right five. The complete set:

```
dc_register              dc_pending_inspection      dc_material_rejections
dc_machining_rejections  dc_variance_report         dc_pending_customer_delivery
dc_acceptance_rate       dc_rejection_trend         dc_movement_history
dc_linked_bills
```

All ten are `SECURITY DEFINER`, so the RLS policies in `0015` do not apply, and
none called `app_private.is_org_member` — any authenticated user could pass any
`p_org` and read another workspace's challans, rejections, machining results and
movement history. `0034` rewrites each as plpgsql behind the same guard the
ledger got in `0033`. Same signature, same `RETURNS TABLE`, same query; the
bodies are byte-for-byte the originals, verified against the live definitions
before and after.

**The billing RPCs look identical and are not affected.** `save_bill`,
`update_bill`, `soft_delete_bill` and `restore_bill` are also `SECURITY DEFINER`
with no guard of their own, but each is a one-line delegate to
`app_private.upsert_bill` or `app_private.soft_delete_state`, and both of those
check membership and scope by `organization_id`.

**How the scope was established.** By audit, not by reading the source: every
`SECURITY DEFINER` function in `public`, in both languages, tested for any
authorization reference (`is_org_member`, `can_write`, `is_org_admin`,
`current_uid`, `has_org_role`, `shares_org_with`). An earlier survey of this
issue filtered on `language sql` only, which would have missed an unguarded
plpgsql function; the two-language sweep is what confirmed the set was complete.

---

## 25. `npm run migrate` cannot be run twice (found 2026-10; fixed 2026-10-24 for the record-keeping half)

`scripts/apply-migrations.mjs` applies **every** file in `db/migrations/` from
`0001` on every run. It has no ledger of what has been applied and no
`if not exists` guard of its own, so on a branch that is already migrated it
aborts at `0002`:

```
FAIL  0002_security_rls.sql
      42723 function "is_org_member" already exists with same argument types
```

It also `break`s on the first failure (line 83), which is how `0024` was skipped
for so long: the chain stopped there and `0025`–`0032` were applied individually
afterwards, leaving the two branches in a state no single replay reproduces.

**Consequence.** `npm run migrate` is only usable against a branch that has
**nothing** applied. To land a new migration on an existing branch, apply the new
file(s) directly. `npm run migrate:check` is the safe tool — it replays all of
them inside a rolled-back transaction and reports `0 failed`, and it is what
should be run before applying anything.

**Fixed 2026-10-24 for the record-keeping half.** The runner now keeps its own
ledger: `app_public_schema_migrations` (public schema, one row per migration
with who and when). On every run it skips what is already recorded, records the
migrations whose objects are already on the branch (Postgres's
duplicate-object/`already exists` errors and the superseded-function case - the
temporary state the older runner used to die on), skips the one migration that
needs a role above `neondb_owner` (`0010_auth_schema_grants`) with a notice
rather than failing, and records every success. A run therefore converges:
running it twice in a row leaves both branches with the same 42-row ledger. It
still does **not** wrap migrations in its own transaction — a migration's own
`begin`/`commit` is the boundary, and migrations remain forward-only.

---

## 23. Report rows linked to `/dc/inward/undefined` (fixed 2026-10)

Clicking a DC number in Rejection Management, or in most of the DC reports,
produced **"Challan not found"** for a challan that plainly existed.

**Cause.** The pages build a link out of the row's id:

```tsx
<Link to={`/dc/inward/${row.dc_id}`}>{row.dc_number}</Link>
```

but several report functions returned a DC **number** and no DC **id**:

| Function | Returned | Effect |
| --- | --- | --- |
| `dc_material_rejections` | `dc_number`, no `dc_id` | link built `/dc/inward/undefined` |
| `dc_variance_report` | `dc_number`, no `dc_id` | no link at all |
| `dc_machining_rejections` | neither | no DC column to click |
| `dc_pending_customer_delivery` | `dc_id`, no `dc_type` | the page hardcoded `/dc/outward/customer/` to compensate |

`/dc/inward/undefined` matches the route, loads the detail screen, and reports
that the challan does not exist. `dc_machining_rejections` was worse in a quieter
way: its table had no DC column, and the part number was styled `table-primary`
— the same class every real link uses — so it *looked* clickable and was not.

**Why nobody caught it.** The numbers were correct and the rows were real. Only
the link was broken, and only on the pages that had never been clicked through.
The alias route kept `dc_pending_customer_delivery` working, which is exactly
why that one looked healthy.

**Now fixed** by migration `0032`, which adds the missing ids and types, plus a
single rule in `ReportTable` (`src/pages/DcReports.tsx`) that turns any DC
number whose row carries an id into a link. One rule now covers all nine
reports instead of nine hand-written links.

**The general rule this exposes:** a report that prints a DC number and offers
no way to open it is the same defect. It is worth checking that a new report
function returns `dc_id` *and* `dc_type` alongside every number it displays.

---

## 20. Migration 0024 could not be applied to any branch (fixed 2026-10)

**This was the reason 0024 had never run anywhere.** Both the production branch
(`ep-lingering-flower`) and the test branch (`ep-cool-rain`) still carried
`outward_self` documents, still permitted the type in `dc_documents_type_check`,
and still had `save_outward_self_dc` in place. `scripts/apply-migrations.mjs`
applies files in order and **stops at the first failure** (`break`, line 83), so
0024 aborted the chain — and 0027 through 0032 were landed individually after it.

**The failure.** 0014 puts an append-only trigger on three tables this migration
deletes from:

```
dc_machining_results   deleted explicitly
dc_inspections         reached through ON DELETE CASCADE
dc_movements           reached through ON DELETE CASCADE
```

PostgreSQL fires row triggers for a cascaded delete, so all three refused the
statement:

```
APPEND_ONLY: dc_machining_results records cannot be modified or deleted;
record a reversing entry instead
```

The note below named only `dc_machining_results`, because the migration aborted
on its first error and never reached the other two.

**Second defect, found only by unblocking it.** Once 0024 could run, it tightened
`dc_settings_type_check` to reject `outward_self` — and `app_private.dc_seed_options`
(0016) still inserted a settings row for that type on **every document save**.
Every save then failed:

```
new row for relation "dc_settings" violates check constraint "dc_settings_type_check"
```

This had never been seen because 0024 had never run, so the constraint it adds had
never rejected anything. `npm run test:db` case 12 is the regression guard.

**Fixed.** 0024 now disables all three triggers around its deletes and re-enables
them in the same transaction, and its `dc_seed_options` no longer lists
`outward_self`. It remains safe to edit in place: it has never been applied
anywhere, so no branch has run the old version.

**Forward-only caution.** On a branch that still holds `outward_self` rows this
migration deletes them and their machining results irreversibly. That is by
design. Two of the test branch's seeded machining results were attached to the
seeded `outward_self` challans and went with them — see issue 23.

**Applied to production on 2026-10-21.** The production branch was thirteen
migrations behind the code, which is why the per-line customer DC number, the
bill-to-challan link and the job progress could not be read there at all. The
chain `0024`–`0033` and `0035`–`0036` was applied in order. `0024` deleted the
two `outward_self` records the branch still held:

| Deleted | Lines | Movements | Note |
| --- | --- | --- | --- |
| `KI/OUT-S/2026-27/0001` | 1 | 1 | declared quantity 0, party was our own company |
| `KI/OUT-S/2026-27/0002` | 1 | 0 | declared quantity 10, party was our own company |

Both were test records for the feature the migration removes — no customer, no
purpose, no remarks. The deletion is irreversible, as the migration says it is.

---

## 26. Migration 0034 cannot be applied after 0032 (found 2026-10-21)

**The hole.** `0034_report_membership_guard.sql` rewrites ten report functions
as `plpgsql`, with a membership guard on each. Six of those functions were
created earlier as `language sql` — `dc_acceptance_rate` and `dc_register` by
`0017` and `0026`, `dc_machining_rejections`, `dc_material_rejections` and
`dc_variance_report` by `0032` — and `CREATE OR REPLACE FUNCTION` will not
change a function's language:

```
42P13 cannot change return type of existing function
DETAIL Row type defined by OUT parameters is different.
HINT Use DROP FUNCTION dc_machining_rejections(uuid,date,date) first.
```

The error names the return type rather than the language, because a function
with OUT parameters owns the row type those parameters define.

**Why it was never seen.** On the test branch `0034` was applied *before*
`0032`, when the functions were still the `0017` ones and were already
`plpgsql`. It therefore applied cleanly there, and `0032` then replaced those
same functions with `language sql` versions — quietly undoing the guards
`0034` had added. The earlier note here said `0032` carries the same
`is_org_member` check, so the protection was deemed intact.

**Checked against the live test branch (2026-11-02), that is only partly true.**
Five of the ten functions still carry `is_org_member` (`dc_register`,
`dc_pending_inspection`, `dc_acceptance_rate`, `dc_rejection_trend`,
`dc_linked_bills`); **five do not** — `dc_material_rejections`,
`dc_machining_rejections`, `dc_variance_report`, `dc_pending_customer_delivery`
and `dc_movement_history`. That is a live authorization gap: those five are
`SECURITY DEFINER` reports that a caller from another workspace could read by
passing a foreign `p_org`. It is exactly the gap `0034` was written to close,
and it is why `tests/run-dc-tests.mjs` case `18b` ("refuses every report
function to a caller from another workspace") fails on this branch. The recent
migrations (`0044`, `0050`, `0051`, `0052`) do not touch these functions and
are not the cause.

**Fixed 2026-11-02 by `0054_report_membership_guard_final.sql`.** It drops and
recreates the five unguarded functions as `plpgsql` with the same signature,
return type and body, prepending the same `is_org_member` guard `0034` uses.
`drop function if exists` + `create function` (not `CREATE OR REPLACE`) is the
correct mechanism because the originals are `language sql` and cannot be switched
in place. `tests/run-dc-tests.mjs` case `18b` now passes on the test branch.
An unguarded `language sql` version would still be recreated by applying `0032`
(or an older `0034`) on a branch that does not have `0054`, so `0034` still
cannot be applied to the production branch before `0054` — see the migration
ordering note in `docs/DATABASE_MAINTENANCE.md`.

---

## 27. The bill number is the challan's serial, and four things are still open (added 2026-10-21)

Migration `0039` made the bill number carry the serial of the challan it pays
for: the outward `KI/OUT-C/2026-27/0020` is billed `2026-27/0020`, and a
serial in a financial year means one job. Four things are not finished.

> The migration was written as `0037_bill_number_series.sql` and renumbered to
> `0039` the same day, because two other migrations landed on `0037` and `0038`
> while it was being written. Nothing in it changed: every statement is
> `create or replace` or `create table if not exists`, so it applies cleanly
> under either name and re-running it is a no-op. It has already been applied
> to the test branch under the old name.

### The one bill in production still carries the old number

The production branch holds a single bill, `KI/2026-27/0031`, raised against
the inward and outward `…/0012` — the mismatch this migration exists to
remove. **The migration renames nothing**, on purpose: an invoice that has
gone out keeps the number it went out with.

Renaming it is a business decision, not a code change, so it has not been
made. The statement, if it is authorised, is:

```sql
update public.bills
set bill_number = '2026-27/0012'
where organization_id = '<org>'
  and bill_number = 'KI/2026-27/0031';
```

The seed script (`npm run seed:job-work`) already writes the new form, so the
test branch and any fresh seed are correct.

### The CSV import path writes the number from the spreadsheet directly

`src/lib/import-bills.ts` calls `save_bill` with the number in the
spreadsheet. That is right for a historical bill — the number printed on the
paper is the number on the record — but it means an imported number is never
checked against the serial space. A spreadsheet carrying `2026-27/0020` for a
bill that is not the one for challan `0020` would be taken at face value.

**Not fixed here.** The import is for history, and rewriting it to reserve a
number would change what an import means. Worth a decision.

### A bill that already exists keeps its number when its links change

A bill raised by hand as `INV-99` and later attached to a challan keeps
`INV-99`. That is deliberate — a number from outside the series names no
challan, so the check in `0039` leaves it alone — but it means the "a bill
and its challan carry the same number" rule holds only for bills raised
*from* a challan, and not for every bill that ends up attached to one.

### The inward and outward challan counters are separate, and the bill number inherits that

`0035` made the outward challan that answers an inward one take the same
serial. The outward's **own** counter is separate, and is only used when an
outward is raised with no inward to answer. So in one financial year the
inward `KI/IN/2026-27/0020` and an unrelated outward `KI/OUT-C/2026-27/0020`
can both exist, and they are two different jobs wearing one serial.

`0039` does not create that: it inherits it. A bill raised from that outward
is numbered `2026-27/0020`, and a search for `0020` would answer with the
inward as well, because the inward's number contains the same digits.

**Not fixed here.** Closing it means the inward and outward sequences share
one counter, which changes the numbers the challan allocator hands out and
therefore renumbers documents that already exist. That is a decision about
history, not a drive-by.

### A reserved number that is abandoned leaves a gap

The bill number is reserved immediately before the save, so a save that is
never completed leaves the number unusable. This is the same rule the
challan numbers have followed since `0016` — a number is never given out
twice — and it is the price of that rule. The form shows the number it
*would* use before the save, and the number it is actually saved with is the
one the database returns, so the gap only appears when a form is abandoned
between the reservation and the save.

---

## 28. The job-work seed script only runs once per workspace (found 2026-10-21)

`npm run seed:job-work` is a demo, and it is not re-runnable. Two separate
things stop it, both of them pre-existing and neither of them related to the
bill number:

**The bill it raises is a duplicate of the one already there.** The script
raises the same customer, the same date and the same two lines every time, so
the second run trips the duplicate check in `save_bill` — the check that
fires on *customer + date + total* as well as on the bill number. The run
aborts and the transaction is rolled back, so nothing is left behind.

**The customer it wants already exists under another name.** The script looks
the customer up by name and creates it if it is not there, with a fixed
GSTIN. In a workspace where the customer exists under a different name, the
lookup misses, the insert is attempted, and `customers_org_gstin_key` refuses
it: `duplicate key value violates unique constraint "customers_org_gstin_key"`.

**Not fixed here.** The script is a demonstration of the job-work chain, and
making it re-runnable means deciding what a second run should do with the
first one's documents — replace them, or sit beside them. That is a decision
about the demo, not a defect in the application.

---

## 30. The dispatch guard now stops material going out before it was machined (2026-10-21)

**What changed.** Migration 0037 changed what a line with machining records can
send back. It used to be `accepted − machining rejection − already dispatched`,
which never looked at what the process actually produced: 2000 accepted with
1900 finished, 10 rejected, 5 for rework and 5 scrapped still offered 1990 to
send back, and the 10 that were not finished goods included. It is now what
came out **finished**, less what has already gone.

**The consequence worth knowing about.** The "Not accounted" column of the
customer material ledger reported material that went out with no machining
result behind it, and `tests/run-dc-tests.mjs` case 17q created that gap on
purpose: a machining result that under-reported its output, and a shipment the
guard let through. The guard no longer lets it through, so the gap can only be
created by **dispatching before the machining result is recorded** — which is a
legal order, and is what the case now does. The figures it asserts are
unchanged.

**What it means in the shop.** A challan cannot be dispatched for more than the
process produced, so a mistake is caught at the gate rather than in a report
weeks later. The cost is that the ledger's "Not accounted" column is now
mostly empty for a well-run job, which is what it is for.

**Lines that shift.** A line changes only if it has a machining record. In the
production branch at the time of writing, exactly one inward line does, and its
availability is 0 before and 0 after: nothing moved.

---

## 31. The amount received is one figure, not a history of payments (2026-10-21)

**What was built.** Migration 0038 gives a bill the amount that has been
received against it, and the balance that follows from it. Setting the status
to *partly paid* asks for the amount, and the database refuses a partly paid
bill without one.

**What it does not do.** The amount is a single figure on the bill: the total
received so far. It is not a record of payments.

- A customer who pays twice produces **one** figure, and the second payment
  overwrites the first. The bill cannot say that ₹5,000 came in on the 3rd and
  ₹3,000 on the 20th.
- A payment that covers **several** bills cannot be split between them. Each
  bill carries its own amount, and the money has to be apportioned by hand.
- An **advance** — money received before the bill was raised — has nowhere to
  go. It is not a payment against a bill that does not exist yet.

**Why it was built this way.** A payments table needs an allocation model
(one payment across several bills, or several payments against one), and the
rules of that model are a business decision, not a technical one. Guessing at
it and shipping it would put wrong money figures in front of a business, which
is worse than a limitation that is written down. The figure that is built
answers the question that was actually asked — *how much is still owed* — and
does it with one number that every screen reads the same way.

**When the payments table is built**, `bills.paid_amount` becomes the sum of
the bill's payments, the generated column stays the balance, and nothing on
the screens has to change.

---

## 29. A part-delivery was told it needed no proof of delivery, and then refused for having none (fixed 2026-10-21)

**The symptom.** On the *Confirm delivery* panel, the proof-of-delivery
reference is optional for a part-delivery: the field says so, and the button
is enabled with it empty. The operator records a part-delivery, and the
database refuses it:

```
VALIDATION_ERROR: proof_of_delivery_ref is required to mark a delivery as delivered
```

**The cause.** `confirm_delivery` (0025) reads the `delivered` flag as:

```sql
v_delivered := coalesce((payload ->> 'delivered')::boolean, true);
```

so a caller that omits the key is taken to mean *true*. The rule is then:

```sql
if (v_delivered or v_complete) and v_pod is null then
  perform app_private.raise_validation('proof_of_delivery_ref', 'is required to mark a delivery as delivered');
```

The panel never sent the flag, so `v_delivered` was always true, and the
reference was compulsory on **every** delivery — including a part-delivery,
which is not a delivery. The screen and the database were answering different
questions about the same field. Verified against the live function on both
the production branch and the test branch: identical.

**Why the flag exists at all.** It is not a way to skip the reference on a
closing delivery. 0025 says so in terms: *"a stronger rule than the old
`delivered` flag: a caller cannot pass delivered = false to close a challan
without a POD reference"*. The `v_complete` half of the condition enforces
that on the quantities alone. So `delivered = false` can only ever mean
"this is a part-delivery", which is what the flag was for.

**Fixed.** The panel now sends `delivered: closesChallan` — the flag says
what the panel means, and the database's own rule stands: a challan still
cannot be closed without a reference, because that is decided by `v_complete`
and not by the flag.

The rule that decides it — *does this delivery close the challan* — was
inside a React component, where nothing could test it. It is now
`deliveryClosesChallan` in `src/lib/dc-quantities.ts`, and it is what decides
three things that have to agree: the button's label, whether the reference is
required, and the flag sent to the database.

**Also fixed.** The proof-of-delivery and received-by fields had no
`maxLength`, so the browser accepted a value the database refuses at 120
characters. They now carry the limit the database enforces, and the value is
caught in the browser rather than in a server error.

## 32. A migration that opens a transaction but never commits is recorded as applied — and does nothing (fixed 2026-10-24)

**The symptom.** Recording a machining result on the second line of a two-line
outward DC returned:

```
PGRST202: Could not find the function public.record_machining_batch
without parameters in the schema cache
```

even though `db/migrations/0043_dc_machining_batch.sql` defined
`public.record_machining_batch`. The function genuinely did not exist.

**The cause.** `0043_dc_machining_batch.sql` opened `begin;` (to make the
`SECURITY DEFINER` function and its helper atomic) and never closed it.
`scripts/apply-migrations.mjs` does **not** issue a commit on the caller's
behalf — each migration file is expected to commit itself, which is why every
migration that uses a transaction (0010 onward, with rare exception) ends in
`commit;`. PostgreSQL then rolls every change back when the connection closes at
the end of the run, and discards everything the migration wrote.

`apply-migrations.mjs` had already inserted a row into
`app_public_schema_migrations`, so the run reported

```
OK    0043_dc_machining_batch.sql
Applied migrations on record: 44
```

and exited 0. The next run skipped `0043` as "already recorded", so the
missing function was never retried. A migration can therefore report success
and be marked applied while its schema changes are silently discarded.

**Fixed by:**
- adding the missing `commit;` to the end of `0043_dc_machining_batch.sql`;
- `src/test/migration-guards.test.ts`, which fails the build if any migration's
  `begin;` count does not equal its `commit;` count.

---

## 33. The audit that checks for missing RPCs could not see some of them (fixed 2026-10-24)

**The symptom.** `npm run db:check` reported `49 / 49 present` against the
branch that was still missing `0043`, so it never flagged the function the
frontend was actually calling.

**The cause.** The name-extraction regex in `scripts/check-db.mjs:50` and
`scripts/audit-schema.mjs:86` was

```
/(?:call\|rows)<[^>]*>\(\s*'([a-z_]+)'/g
```

The frontend calls RPC functions through a TypeScript generic:

```ts
call<Record<string, number>>('record_machining_result', ...)
call<Record<string, unknown>>('record_machining_batch', ...)
```

`[^>]*` cannot cross a `>` character, so any `call<SomeGeneric<Inner>>('name',…)`
was split: `<[^>]*>` matched only up to the inner `>`, then the regex demanded a
`(` and found another `>` instead. `record_machining_result` and
`record_machining_batch` were never extracted — 38 names were checked instead of
41, and those two slipped through invisible.

**Fixed by** changing the pattern to `<.*?>`, which lets `.` match the inner `>`
and span to the outer one:

```
/(?:call\|rows)<.*?>\(\s*'([a-z_]+)'/g
```

`npm run db:check` now reports the true total (`52 / 52 present`) and names the
machining RPCs explicitly. `node scripts/audit-schema.mjs`, which targets
production, now correctly reports `record_machining_batch` as missing until the
migration is applied.

---

## Manual browser checklist

These need a real browser and, in places, a real device. They are the things
most likely to be wrong and least likely to be caught by the existing tests.

### Customer material ledger (rewritten by 0033 — never opened in a browser)

- [ ] Open the ledger for a customer with real data. **Every** column shows a
      figure or a deliberate `—`, and no row is a wall of zeros.
- [ ] Confirm **no balance is negative** anywhere on the screen.
- [ ] Set a From/To range. The movement columns narrow, the two **available**
      columns do not, and the note saying so appears.
- [ ] If any material gap exists, the amber banner names the part and the
      quantity. Click nothing; just confirm it reads sensibly.
- [ ] A part recorded as a unit conversion shows a `⚠` beside the part number.
- [ ] Export to CSV and confirm the header has all 18 columns and the row count
      matches what is on screen.
- [ ] Scroll the table horizontally at 375 px. It scrolls inside its container
      and does not push the page sideways.
- [ ] Cross-check one part by hand against its challans: accepted material,
      less machining input and unmachined dispatch, equals **Customer material**.
      Accepted output plus accepted finished inward, less machined dispatch,
      equals **Finished stock**. The ledger still performs these calculations
      even though some component columns are hidden.

### The bill number (added 2026-10-21 — never opened in a browser)

- [ ] Open **New bill**. The bill number field shows a number, and the hint under it says it is the next free one in the financial year.
- [ ] Pick an outward challan in section 03. The bill number changes to the challan's serial — `2026-27/0020` for `KI/OUT-C/2026-27/0020` — and **the field cannot be typed in**.
- [ ] Save. Open the bill: the number on the invoice and in the PDF is the serial, with no `KI/` prefix and no `IN` / `OUT-C` segment.
- [ ] Type `0020` into the search box in the header. The inward challan, the outward challan and the bill all come back.
- [ ] Type `0020` into the search box on **Bills**. The bill comes back.
- [ ] Raise a bill with two challans selected. The number carries the lower serial. Search the *other* serial: the bill still comes back.
- [ ] Raise a bill with no challan. The number is the next free one, and the field **can** be typed in. Type a paper invoice number such as `INV-99` and save: it is kept exactly as typed.
- [ ] Take a challan off the selection. The field becomes editable again and shows the free number again.
- [ ] Change the bill date so that it falls in another financial year. The free number follows it.
- [ ] Open a bill for editing. Its number is the one it was saved with, and it does not change when its challans are added or removed.
- [ ] Print the invoice and open the PDF. The bill number is on both, and the file name is not broken by the `/` in it.

### Confirm delivery (fixed 2026-10-21 — never opened in a browser)

- [ ] Open an outward challan that has something dispatched and click **Confirm delivery**. Each line is pre-filled with its outstanding balance.
- [ ] Leave the proof-of-delivery reference **empty** and record a **part-delivery** (enter less than the outstanding on a line). It saves. *(It used to be refused with "proof_of_delivery_ref is required to mark a delivery as delivered" — issue 29.)*
- [ ] Enter the full outstanding on the last line, so the challan closes. The reference field now says *"Required to close this challan as delivered."* and the button is disabled until something is typed.
- [ ] Type a reference and confirm. The challan closes, the status reads **Delivered**, and the reference appears in the DELIVERY block of the printed challan and of the PDF.
- [ ] Enter **more** than the outstanding. The panel says *"More entered than is outstanding on …"* and refuses to save.
- [ ] Type 121 characters into the proof-of-delivery or received-by field. The browser stops you at 120, rather than the server refusing the save.
- [ ] Record a part-delivery, then a second one that takes the remainder. The challan closes, and the **latest** reference wins.

### The register's job status (added 2026-10-21 — never opened in a browser)

- [ ] Open **Inward challans**. There is a **Job status** column beside **Status**, and it reads *Job not started*, *Work in process*, *Partly delivered* or *Delivered* — not a wall of *Issued*.
- [ ] Open one of those challans. The header **Status** still reads *Issued* (it is the receipt), and the **Job progress** card shows the same value the register showed. The two must never disagree.
- [ ] Filter the inward register by **Status: Issued**. Every row still comes back — the receipt status does not move when the work does.
- [ ] Confirm the inward register's **Status** filter no longer offers *Dispatched*, *Partially delivered* or *Delivered*. An inward challan can never reach them, and picking one used to return an empty table.
- [ ] Choose **Job status: Work in process**. Only challans with work under way come back, and the count in the footer matches the rows on the page.
- [ ] Choose **Job status: Delivered**. Only finished jobs come back.
- [ ] Raise an outward challan against an inward one that had none, then reload the register. The inward challan moves from *Job not started* to *Work in process*, with nothing saved against the inward challan itself.
- [ ] Deliver the last of it. The inward challan reads *Delivered*.
- [ ] Open **Outward challans**. There is no **Job status** column — an outward challan is its own delivery and its **Status** already carries the answer.
- [ ] Open **All Delivery Challans**. The **Job status** column is there; outward rows read as an em dash.
- [ ] Export the inward register to CSV. **Job status** is a column, between **Status** and **Party**. Export the outward register: it is not there.

### The amount received against a bill (added 2026-10-21 — never opened in a browser)

- [ ] Open a bill and change the payment status to **Partially paid**. The **Amount received** field appears, empty, and the **Remaining** field shows the whole total.
- [ ] Type `5000` into **Amount received**. The **Remaining** field falls by 5000 as you type, before anything is saved.
- [ ] Type the whole bill into **Amount received**. The save is refused with "That is the whole bill. Set the payment status to paid instead."
- [ ] Leave **Amount received** empty and save. The save is refused with "Type how much the customer has paid against this bill."
- [ ] Save with an amount. Open the bill: **Amount received** and **Balance due** are on the invoice, under INVOICE DETAILS.
- [ ] Open the **Bills** list. The **Source** column is gone, and **Remaining** sits right after **Total** — `0.00` for a paid bill.
- [ ] Open **Outstanding**. The page total is what is owed, not what was invoiced, and each row shows an **Outstanding** column.
- [ ] Open a bill that is paid. **Remaining** is `0.00` on the invoice and in the PDF, and the bill does not appear on the outstanding report.

### On a phone

- [ ] Install from the banner. Launch from the home screen. No address bar.
- [ ] **320 px** — nothing overflows horizontally, no sideways scrolling.
- [ ] **375 px** — every form is reachable and the keyboard does not cover fields.
- [ ] **430 px** — the same, on a large phone.
- [ ] **768 px** — the sidebar collapses to a drawer; the backdrop dismisses it.
- [ ] Open the sidebar drawer on a small phone. The bottom links — Challan settings and Company settings — are reachable without scrolling past the organisation footer; the nav is its own scroll region.
- [ ] Raise an inward challan end to end: item, quantity, transport, save, finalize.
- [ ] Record a receipt, then an inspection, and confirm the quantities reconcile.
- [ ] Issue material to a vendor and record a **partial** return.
- [ ] Print a challan and check the A4 layout.
- [ ] Open the downloaded challan PDF. The Prepared by / Authorized by / Receiver signature rules start at the same left edge as the item table, and none of them run past the right edge of the page.
- [ ] Camera capture for scanning a paper bill.

### PWA

- [ ] Install, then go offline. The app opens. The banner appears. The status dot is amber.
- [ ] Back online. The banner clears.
- [ ] Deploy a change, reopen, accept the update banner, confirm the new build.
- [ ] Deep link `/dc/inward/<id>` pasted into a fresh tab. Works after refresh.
- [ ] Confirm no business data appears in DevTools → Application → Cache Storage.

### Data integrity

- [ ] Raise a bill with multiple items and a discount. Check CGST/SGST and the total against a manual calculation.
- [ ] Save the same bill number twice. Confirm the duplicate warning appears.
- [ ] Save a bill with an attachment upload that fails. Confirm it navigates anyway and cannot create a second bill.
- [ ] Edit a bill's notes only, and confirm its `source_type` and `verification_status` are unchanged.
- [ ] Open a challan draft, edit it, save. Confirm the heat number, material grade and ordered quantity survive.
- [ ] Inspect a challan where one line is already fully inspected. Confirm only lines awaiting inspection appear.
- [ ] Record a receipt with a gate rejection. Confirm it appears under Rejections and can be returned. *(The database half is now automated — test:db cases 8c, 8g2 and 8g3. This is the browser check for it.)*
- [ ] Record a receipt with a gate rejection, then **reopen** the receipt form. Confirm the rejection reason is still in the field.
- [ ] Record a receipt with a gate rejection, then **save it again with a different rejection quantity**. Confirm the Rejections panel still lists one row for that part, not two.
- [ ] Record a receipt, then an inspection. Confirm the new **Inspection results** panel lists it, and that the header badge changes from "awaiting inspection" to "Fully received and inspected".
- [ ] Reject some material at the gate, record an inspection, then reject more at inspection. Confirm the Rejections panel shows **two** rows for that part and the return dropdown names both.
- [ ] Record a receipt with **inspection unchecked**. Confirm the line is accepted and nothing is awaiting inspection.
- [ ] Type the full received quantity into **Accepted**. Confirm rejected, rework and pending all drop to zero.
- [ ] Confirm "Record receipt" is disabled on a challan that has already been inspected.
- [ ] Dispatch an outward challan in full. Confirm the header reads **Dispatched** and the badge reads "Awaiting customer delivery".
- [ ] Confirm delivery for **part** of a line. Confirm the status reads **partially delivered**, the badge shows the outstanding quantity, and the challan stays on the pending-delivery report with the right outstanding figure.
- [ ] Confirm the rest. Confirm the status reads **Delivered**, the badge reads "Fully delivered", and the challan has left the pending-delivery report.
- [ ] Check the **printed challan** and the **PDF** show a DELIVERY block with the POD reference, receiver and timestamp.
- [ ] Confirm entering more than the outstanding quantity is refused in the panel before saving.
- [ ] Confirm the Confirm-delivery button is **absent** on an `issued` challan that has not been dispatched.
- [ ] Confirm the Dispatch panel's default quantity is what is still to be dispatched, not the full declared figure.
- [ ] Export a bill to CSV and open it in Excel. Confirm the rupee symbol is correct.
- [ ] Add a customer named `=1+1`. Export. Confirm the cell is not executed.

### Employee access

- [ ] Add an employee, change their role, remove them. Confirm access ends immediately.
- [ ] Try to demote the only admin. Confirm it is refused with a readable message.
- [ ] As `viewer`, confirm no write button is enabled and a crafted request is refused.

### Billing arithmetic, after the payments gap is addressed

- [ ] Partial payment, advance, and full settlement.
- [ ] Overdue detection against the due date.
- [ ] Customer statement totalling correctly over a period.
 - - - 
 
 # #   B a t c h   m a c h i n i n g   r e s u l t s   f o r   m u l t i - l i n e   o u t w a r d   D C s   ( f i x e d   2 0 2 6 - 1 0 - 2 4 ,   m i g r a t i o n   0 0 4 3 ) 
 
 P r e v i o u s l y   t h e   o p e r a t o r   c o u l d   r e c o r d   a   m a c h i n i n g   r e s u l t   f o r   l i n e   1   o f   a   2 - l i n e   o u t w a r d   c u s t o m e r   D C   a n d   f o r g e t   l i n e   2 ;   t h e   d a t a b a s e   a c c e p t e d   t h e   p a r t i a l   b a t c h   a n d   t h e   P D F   d i d   n o t   s h o w   w h i c h   l i n e   a   r e s u l t   b e l o n g e d   t o . 
 
 F i x e d :   ` r e c o r d _ m a c h i n i n g _ b a t c h `   w r i t e s   a l l   r e q u i r e d   j o b - w o r k   l i n e s   a t o m i c a l l y ;   i t   r e f u s e s   t h e   b a t c h   i f   a n y   r e q u i r e d   l i n e   l a c k s   a   r e s u l t .   T h e   e x i s t i n g   ` r e c o r d _ m a c h i n i n g _ r e s u l t `   i s   p r e s e r v e d   f o r   s i n g l e - l i n e   D C s .   T h e   p a n e l   s h o w s   e a c h   r e q u i r e d   l i n e   w i t h   i t s   s t a t u s   ( R e c o r d e d   /   P e n d i n g   /   N o t   a p p l i c a b l e )   a n d   t h e   l i n e   n u m b e r   a p p e a r s   i n   t h e   m a c h i n i n g   r e s u l t s   t a b l e ,   P D F   a n d   d a t a b a s e   a u d i t   t r a i l .   U n l i n k e d   f i n i s h e d - s t o c k   l i n e s   a r e   m a r k e d   N o t   a p p l i c a b l e   a n d   d o   n o t   b l o c k   s u b m i s s i o n .  
 