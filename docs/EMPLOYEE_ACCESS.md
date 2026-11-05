# Employee Access

This is a private application for Kallazhagar Industries. There is no
subscription, no licence fee, and no paid tier. Employees are not charged to use
it.

The intended size is **around ten named people**.

---

## The three roles the database enforces

| Role | What it can do |
| --- | --- |
| **Company admin** (`admin`) | Everything staff can do, plus managing team access and DC settings. Keep this to one or two people |
| **Staff** (`staff`) | Create and edit bills, challans, customers, products, stock. Day-to-day use |
| **Read-only** (`viewer`) | See every record, print and export. Cannot change or save anything |

Enforced by `app_private.can_write` (`admin` or `staff`) and
`app_private.is_org_admin`. Hiding a button in the browser is a convenience; the
server refuses the write regardless.

### Mapping your job titles onto these

| Job | Role |
| --- | --- |
| Company owner / director | `admin` |
| Accountant | `staff` |
| Storekeeper | `staff` |
| Production supervisor | `staff` |
| Quality inspector | `staff` |
| Management, reviewing only | `viewer` |

**Read this before relying on it:** the database does not currently distinguish
"may record inspection but not raise a bill". Every operational role is
`staff`, and `staff` may do anything an operational person may do. If you need
that separation — for example an inspector who must not be able to change an
invoice — it is not implemented. See *Finer-grained roles* below.

---

## Adding an employee

1. The person signs up at the app URL with **their own email address** and
   confirms it.
2. An admin opens **Settings → Employee access**.
3. Enters that email address and picks a role.
4. They can now sign in and work.

You never handle anyone's password. You never see it.

> Each person needs their own account. **Do not share one login.** Individual
> accounts are what make the audit log meaningful — it records who recorded a
> receipt, who cancelled a challan, and who changed whose role. A shared login
> makes all of that unattributable, and it is also how invoices end up with the
> wrong name on them.

### Joining an existing company

A person can also join a company that already exists without waiting for an
admin: on the setup screen they choose **Join an existing company**, enter the
company's GSTIN (or a partial GSTIN, or its name), pick it from the results, and
confirm. They join as **read-only**; an admin then changes their role in
**Settings → Employee access**.

The **Settings → Employee access** list shows each person's name (falling back
to their email). The database owner can also see who is who directly, via the
developer-only views described in `docs/DATABASE_MAINTENANCE.md`.

> Anyone who knows the company's GSTIN can join it read-only. That is by design
> — GSTINs are public tax identifiers — but it means every viewer can see all
> records. Check the audit log for unexpected joins, and remove anyone who
> should not have access.

### Deactivating an employee who leaves

1. **Settings → Employee access**.
2. **Remove** next to that person. Confirm.

Their access ends **immediately** — the membership row is deleted, so every read
and write is refused from that moment. Records they created are kept.

Do this when someone leaves. It is the single most important administrative
action in the system.

### Changing a role

Use the dropdown in the **Change access** column. The change is immediate and is
recorded in the audit log with the previous and new role.

---

## Things the system refuses to do

These are enforced in the database, so they hold however the request arrives.

| Attempt | Result |
| --- | --- |
| Demote the only admin | *"This is the only admin; promote someone else to admin first."* |
| Remove the only admin | Same |
| Remove your own access | *"You cannot remove your own access; ask another admin to do it."* |
| A non-admin changes a role | Refused by the server |
| A non-admin lists members | Refused by the server |
| A viewer writes anything | Refused, whatever the browser sent |

The last-admin guard exists twice on purpose: once in
`app_private.guard_last_admin` (a trigger) and once in the RPC, so the person
gets a sentence they can act on instead of a raw database exception.

---

## Recovery: everyone is locked out

If the last admin is somehow gone, access has to be restored with a direct
database connection. This is why at least two admins is strongly recommended.

```sql
-- 1. Find the organization and the accounts that exist.
select m.organization_id, m.user_id, u.email, m.role
from public.memberships m
left join neon_auth.user u on u.id = m.user_id;

-- 2. Promote one of them.
insert into public.memberships (organization_id, user_id, role)
values ('<organization-uuid>', '<user-uuid>', 'admin')
on conflict (organization_id, user_id) do update set role = 'admin';

-- 3. Record why, in the same place the application would have.
insert into public.audit_logs (organization_id, actor_id, action, table_name, new_data)
values ('<organization-uuid>', null, 'membership.recovered', 'memberships',
        '{"note":"no admin accounts remained"}'::jsonb);
```

Take a backup before doing this. See `docs/BACKUP_AND_RECOVERY.md`.

---

## Data isolation

Every table carries Row Level Security keyed on organization membership. One
organization's rows are invisible to another's, and the constraint is in the
database rather than in any query the application writes.

This is what keeps the architecture ready for more than one company later without
building any of it now. No subscription, plan or tenant-management feature is
implemented — only the isolation that already exists is relied on.

---

## Onboarding a new employee

- [ ] They create an account with their own email and confirm it
- [ ] Either an admin adds them with a role, or they join the company
      themselves from the setup screen (**Join an existing company**) as
      read-only
- [ ] They sign in and see the dashboard
- [ ] If they need challans, they read `docs/PWA_INSTALLATION.md` and install it
- [ ] If they handle money, they also read the GST section of this project's README

## Offboarding

- [ ] Remove their access from **Settings → Employee access**
- [ ] If they used a **shared** device, sign them out and clear the browser
      profile — the service worker's cached application shell survives on disk
- [ ] Confirm the audit log shows the removal
- [ ] Review `audit_logs` for anything they did before leaving that you did not
      expect

---

## Finer-grained roles

Not implemented, and deliberately not faked.

The database enforces exactly three roles. Splitting "record inspection" from
"raise a bill" would mean widening `memberships_role_check`, redefining
`app_private.can_write`, and updating five reporting functions that enumerate
the role list — a change to the authorization layer itself.

That change should be made deliberately, on a branch, with `npm run test:db`
passing against it, rather than landed blind alongside everything else in this
release. The current model is coherent and tested; extending it later is
straightforward and does not require a redesign.

---

## Audit trail

**Audit log** in the sidebar records changes to organizations, memberships,
customers, products, bills, bill items, attachments and OCR jobs, plus every DC
movement, cancellation and authorisation.

| Column | Meaning |
| --- | --- |
| `actor_id` | Who did it, from their session |
| `action` | What kind of change |
| `table_name` / `record_id` | What was affected |
| `old_data` / `new_data` | Before and after |
| `created_at` | When |

The table is **append-only**. Update, delete and truncate are blocked by a
trigger, so the trail cannot be edited even by someone with direct database
access.

Worth reviewing periodically, and always after anyone leaves.