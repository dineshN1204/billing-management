# Deployment

Two separate deployables: a static frontend, and Neon (database, functions,
object storage). Neither holds secrets that belong in the other.

---

## Release checklist

Run this before every deployment.

```bash
npm ci
npm run verify        # typecheck + lint + test + build
npm run verify:pwa    # re-run against dist/ (included in build, this is belt-and-braces)
```

`npm run verify` must be clean. Do not deploy around a failure — every one of
them is a real finding, and the build is fast.

Then:

1. **Back up the database.** See `docs/BACKUP_AND_RECOVERY.md`. Non-negotiable
   before applying migrations.
2. Apply pending migrations, in order.
3. Deploy the frontend.
4. Deploy the Neon Functions.
5. Smoke-test on a phone.

---

## 1. Database

Migrations are **never applied automatically**. Applying them to a live branch is
a deliberate, human-authorised step.

```bash
psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0019_dc_movement_history_document_id.sql
psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0020_employee_roles.sql
```

Or, for a full replay on an empty branch:

```bash
npm run migrate
```

Since 2026-10-24 every run is also **recorded** in `app_public_schema_migrations`
(one row per migration: version, file, who, when). The runner skips what is
already recorded, records migrations whose objects already exist on the branch,
and skips `0010_auth_schema_grants` (needs a role above `neondb_owner`) with a
notice. Running it twice in a row is therefore safe, and `npm run db:audit`
reports what each branch has on record. Two flags matter:

```bash
node scripts/apply-migrations.mjs                       # test branch (the default target)
node scripts/apply-migrations.mjs 0041                  # only this one
node scripts/apply-migrations.mjs --target app --allow-production   # app branch, deliberately
```

`--allow-production` exists because the refusal to run against a
production-looking host is the guard that once stopped small mistakes from
becoming big ones — pass it only when the step in front of you is genuinely a
production application.

### Check before applying

```bash
npm run migrate:check    # syntax-checks every migration; commits nothing
npm run db:audit         # read-only audit of the target branch
```

`migrate:check` runs each migration inside a transaction that is **rolled back**.
It is safe against production and catches the mistakes that are invisible by
reading — including a `CREATE OR REPLACE FUNCTION` that tries to change a
`RETURNS TABLE` shape, which is a real bug this project had.

### Migration rules

- **Forward-only.** Never edit a migration that has already been applied to a
  branch anyone depends on; add a new one.
- **Idempotent where practical.** Use `IF EXISTS` / `IF NOT EXISTS`.
- **`CREATE OR REPLACE` cannot change a return type.** `DROP` the function first.
- **Take a backup first.** Every time.
- **Never run migrations as part of the frontend deploy.** A half-applied
  migration with a new frontend is worse than either alone.

### Currently pending

Nothing. `0019` and `0020` are applied to the production branch
(`ep-lingering-flower`); both are purely additive.

> They were applied by `npm run migrate:check`, which was supposed to write
> nothing — it did not strip the `commit;` inside the migration files, so its
> wrapping `ROLLBACK` was a no-op. No data was lost and no existing row or column
> was altered, but the checker was unsafe. It now strips transaction control,
> refuses production-looking hosts without `--allow-production`, and asserts its
> own rollback took effect. `npm run test:escape-probe` proves it cannot commit.
> Full account: `docs/KNOWN_ISSUES.md` §9.

The separate **test** branch (`ep-cool-rain`, from `DATABASE_URL_TEST`) does not
have them. `npm run migrate:check` and `npm run db:check` target the test branch
when that variable is set — `npm run db:which` prints which is which.

### Before you ever run these again

```bash
npm run db:which            # confirm which branch you are pointed at
npm run migrate:check       # syntax only; writes nothing
npm run test:escape-probe   # prove the checker cannot commit
npm run db:audit            # confirm the application can still reach every RPC
```

`npm run db:audit` uses `DATABASE_URL_UNPOOLED` (production) deliberately, so it
is the command that tells you whether the **live** branch is healthy.

---

## 2. Frontend

```bash
npm run build
```

Produces `dist/` — a static site. Deploy to Vercel, Netlify, Cloudflare Pages,
GitHub Pages, or any static host.

### Required host configuration

**The single most important setting: every unknown path must serve
`index.html`.** This is a single-page application with client-side routing.
Without it, opening `/dc/inward/123` directly — or refreshing on any screen —
returns a 404.

| Host | Setting |
| --- | --- |
| Vercel | `vercel.json` with `"rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]` |
| Netlify | `public/_redirects` with `/* /index.html 200` |
| GitHub Pages | `public/404.html` (SPA redirect shim) + `public/CNAME` (custom domain). GitHub Pages has no rewrite engine, so unknown paths hit `404.html`, which forwards to `index.html?__path=…`; `src/main.tsx` restores the route with `history.replaceState`. Deploy with `npm run deploy` (`gh-pages -d dist --dotfiles`) so `.nojekyll` ships too. **If `public/CNAME` is missing, GitHub unbinds the custom domain and the whole site returns `Site not found`.** |
| Cloudflare Pages | `_routes.json` with a catch-all fallback to `/index.html` |
| Nginx | `try_files $uri $uri/ /index.html;` |

**Required HTTP headers:**

| Header | Value | Why |
| --- | --- | --- |
| `Service-Worker-Allowed` | `/` | Scopes the worker to the whole origin |
| `Cache-Control` on `sw.js` | `no-cache` | Otherwise the worker itself is cached and updates never arrive |
| `Cache-Control` on `/assets/*` | `public, max-age=31536000, immutable` | Filenames are content-hashed |

**HTTPS is mandatory.** Service workers, installation, and camera capture all
require a secure context. `localhost` is exempt, which is why `vite preview`
works for testing.

### Environment variables at build time

`VITE_NEON_DATABASE_URL`, `VITE_NEON_API_URL`, `VITE_NEON_PROCESS_BILL_URL` are
baked into the bundle at build time. Set them in the host's build environment,
then rebuild. No other variable is needed, and **no secret may be set here** —
everything `VITE_`-prefixed is readable by any visitor.

### Neon Auth trusted domains

Neon Auth accepts a browser sign-in only from an origin on the branch's trusted
list. A deployment domain that has never been added fails with
`403 INVALID_ORIGIN` **before the password is checked** — the same 403 a lapsed
session produces, which is why the app now names it explicitly. Localhost is
pre-approved by default, so `npm run dev` can work while production cannot.

Add every deployed origin (scheme + host, no trailing slash, no wildcards):

```bash
neon neon-auth domain add https://billing.kallazhagarindustries.com
neon neon-auth domain list
```

Do this once per branch that serves a deployment. It is configuration, not code:
changing it needs no rebuild.

### Redirects for a single-page app on an existing host

If `/dc/*` is already served by something else, scope the rewrite to the app's
own paths rather than `/(.*)`.

---

## 3. Neon Functions

Two functions in `neon/`:

| Function | Purpose |
| --- | --- |
| `api` | Document upload, presigned URLs |
| `process-bill` | OCR extraction |

Deploy both and record the URLs:

```bash
neon functions deploy api
neon functions deploy processbill

neon functions get api
neon functions get processbill
```

Set `WEB_ORIGIN` to the exact frontend origin(s) — **no trailing slash**. It is
the CORS allow-list; a mismatch is the usual cause of a function call failing
only in production. Comma-separate several origins (for example the live site
plus `http://localhost:5173` for local development); spaces around commas are
ignored.

Optional: `OCR_API_KEY`. Without it, scanning fails with a clear message rather
than returning wrong data.

---

## 4. Security review

| Area | Status |
| --- | --- |
| Row Level Security on every table | Enforced in the database |
| Quantity columns have **no client write grant** | The browser can only call validated RPCs |
| Service-role credentials | Never reach the browser |
| Signed document URLs | 60-second expiry |
| `audit_logs` | Append-only; update, delete and truncate are blocked by trigger |
| Admin-only operations | Enforced server-side, not by hiding buttons |
| Secrets | Not in the bundle, not in version control, placeholders in documentation |

Before a public launch:

- [ ] `npm audit` is clean, or every remaining advisory is understood and accepted
- [ ] HTTPS enforced with HSTS
- [ ] `WEB_ORIGIN` is the real origin
- [ ] `DATABASE_URL` appears in no build variable
- [ ] Employee accounts created and roles assigned
- [ ] A backup taken and a restore rehearsed
- [ ] `robots: noindex` is in place (it is by default)

---

## 5. Post-deploy smoke test

On a **real phone**, on mobile data if possible — it is the only way to catch a
service-worker or viewport problem.

1. Open the app. Sign in.
2. Install it. Launch from the home screen. It opens without browser chrome.
3. Open a challan by deep link (`/dc/inward/<id>`). Works after a refresh.
4. Turn on airplane mode. Open the app.
   - The app opens and navigation works.
   - An offline banner appears.
   - No data is shown as though it were current.
5. Turn the connection back. The banner clears.
6. Create a customer. Save. Confirm it appears in the list.
7. Raise a challan, finalize it, and print it.
8. Check **Settings → Employee access**: can you change a role? Can you remove
   someone? Is the last admin protected?
9. Open the browser console on desktop. No errors.

---

## 6. Rollback

**Frontend:** redeploy the previous `dist/`. Because vendor chunks are
content-hashed and precached, a rollback is a normal deploy. Anyone who has not
accepted the pending update will get the old build automatically.

**Database:** migrations are forward-only. There is no automated rollback —
reverting a schema change that has already run requires a new migration that
undoes it. For the two pending migrations, rollback means not applying them.

This is the main reason the rules lean heavily toward *additive* migrations:
they can be withheld, and the application is written to work without them.

---

## 7. Monitoring

There is no telemetry in this application, deliberately — it handles customer
GSTINs and financial records, and shipping those to a third party would be a
decision nobody made on purpose.

What to watch instead:

- **Neon dashboard** — compute hours, storage, connection limits.
- **Neon logs** — function errors.
- **Browser console** on a real device after each deploy.
- **`audit_logs`** — every role change, cancellation and quantity adjustment is
  recorded with actor and timestamp. Review it periodically.
- **`npm run db:audit`** — verifies the branch the application is talking to
  actually has every RPC the frontend calls. Worth running after any migration.