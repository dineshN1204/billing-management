# Neon backend layer

Two Neon Functions plus a `neon.ts` config that replace the Supabase Edge Functions for
document storage and OCR processing.

| Slug | Source | Purpose |
| --- | --- | --- |
| `api` | `neon/api/index.ts` | Object Storage upload / presign / download |
| `process-bill` | `neon/process-bill/index.ts` | OCR of a queued `ocr_jobs` row |

Both functions share JWT verification and membership lookup from `neon/shared/auth.ts`.

## Deploy

```bash
neon deploy --env .env.local
```

`--env` is required: the secrets below are read from the file into the deployed
functions, they are not inherited from your shell.

### Required secrets in `.env.local`

| Variable | `api` | `process-bill` | Notes |
| --- | --- | --- | --- |
| `OCR_API_KEY` | no | yes | OCR.space key. Declared on `process-bill` only, because `api` never calls OCR. |
| `WEB_ORIGIN` | yes | yes | Comma-separated exact origin allowlist, e.g. `https://billing.example.com`. Required. |

Do **not** declare these in `neon.ts` — Neon injects them per function automatically:

`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEON_BRANCH`, `NEON_AUTH_BASE_URL`,
`NEON_AUTH_JWKS_URL`, `NEON_DATA_API_URL`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`.

### Region requirement

Neon Object Storage is only available on branches in **aws-us-east-2**, **us-east-1**,
**eu-central-1** or **ap-southeast-1**. Create the branch in one of those regions before
the first `neon deploy`, otherwise the `bill-attachments` bucket cannot be created and
every storage route fails at runtime.

## Ordering: Auth before migrations

Neon Managed Better Auth must be enabled **before** the Postgres migrations run.

`db/migrations/0001_core_schema.sql` and `0006_membership.sql` reference `auth.uid()`
and create policies scoped `to authenticated`. Those roles and the `auth` schema come
from Managed Better Auth, not from your SQL files. Apply the schema in this order:

1. `neon deploy` (enables `auth`, creates the bucket and both functions).
2. Apply `db/migrations/0001` … `0009` against the Neon branch.
3. Seed users through Better Auth so `auth.uid()` resolves, then run `db/seed.sql`.

Deploying the migrations first fails on `auth.uid()`.

## Why `WEB_ORIGIN` is required instead of `*`

Both functions are called directly from the browser with an `Authorization` header.
`Access-Control-Allow-Origin: *` is not an acceptable default here because these are
state-changing, tenant-scoped endpoints: a wildcard tells any site on the internet that
its own JavaScript may drive this API, and any token it manages to obtain becomes a
read/write capability against your tenants.

So the allowlist is explicit:

- `WEB_ORIGIN` unset or not containing the request's `Origin` → the request is refused
  with **403** and no CORS headers are emitted. The browser surfaces a CORS failure
  rather than a readable error, which is the intended outcome: a disallowed origin
  learns nothing.
- `WEB_ORIGIN` set and matching → the exact origin is echoed with `Vary: Origin`.
- Requests with **no** `Origin` header (server-to-server, curl, Neon-to-Neon) are not
  cross-origin requests, so they proceed and still pass JWT + membership checks.

Set it to the SPA's exact origin(s), comma-separated. Do not include a trailing slash.

## Endpoint contract

All authenticated routes require `Authorization: Bearer <Neon Auth access token>`.
Errors are JSON: `{ "error": string }`.

### `GET /health`

No auth. Returns `200 { "ok": true }`.

### `POST /documents/upload` (`api`)

Auth: required, role `admin` or `staff` (viewer → 403).

- **Query**: `organizationId` (uuid), `path` (object key)
- **Body**: `multipart/form-data` with a `file` part, **or** the raw bytes with a
  matching `Content-Type` header.

Validation, all failures → `400`:

- `path` starts with `${organizationId}/`, no `.`/`..` segments, no leading or doubled
  `/`, ≤ 512 chars, restricted to `[A-Za-z0-9._/-]`.
- size 1 byte … 10 MB (`413`-style limit enforced as `400`).
- extension **and** magic bytes must agree, per the allowlist in
  `src/lib/documents.ts`:
  | Declared type | Extensions | Magic bytes |
  | --- | --- | --- |
  | `application/pdf` | `pdf` | `%PDF-` |
  | `image/jpeg` | `jpg`, `jpeg` | `FF D8 FF` |
  | `image/png` | `png` | `89 50 4E 47` |
  | `image/webp` | `webp` | `RIFF`…`WEBP` |

On success the object is written to the private `bill-attachments` bucket and a row is
upserted into `public.storage_objects`.

- **201**: `{ "object_path": string, "content_type": string, "size_bytes": number }`

### `POST /documents/presign` (`api`)

Auth: required, any role incl. viewer, membership only.

- **Body**: `{ "objectPath": string }`
- The organization is derived from the **first path segment** of `objectPath`. A
  client-supplied organization id is never accepted here, and the row lookup is keyed
  on `(organization_id, object_path)` so the derived org and the stored row must agree.
- `403` if the caller has no membership in the derived org.
- `404` if no `storage_objects` row exists for that org + path.

- **200**: `{ "url": string, "expires_in": 60 }`

`expires_in` is fixed at 60 seconds to match the previous
`createSignedUrl(path, 60)` behaviour.

### `GET /documents/download/:encodedPath` (`api`)

Auth: required, membership only.

`:encodedPath` is the object key passed through `encodeURIComponent` (so `/` becomes
`%2F` and the key stays a single path segment). Hono decodes it exactly once.

The object must have a `storage_objects` row for the org derived from its first
segment. The body is streamed from Object Storage with the stored content type and a
`private, no-store` cache policy.

- **200**: the file bytes
- **403** / **404** as above.

### `POST /` (`process-bill`)

Auth: required. Port of the previous Edge Function; behaviour is preserved.

- **Body**: `{ "job_id": uuid }`
- **405** non-POST, **400** missing/invalid `job_id`, **404** unknown job,
  **403** no membership in the job's org, role `viewer`, or `created_by ≠ caller`,
  **409** status not in `(queued, failed)` or the lock was lost,
  **429** more than 20 jobs by this caller in the last hour,
  **503** `OCR_API_KEY` missing.
- **200**: `{ "job_id": string, "status": "succeeded" }`
- **422**: `{ "error": string }` — job marked `failed`, `error_message` truncated to
  2000 chars.

Field extraction is unchanged from `supabase/functions/process-bill/index.ts`: the same
regexes and the same deliberately low confidences (bill number/date `0.55`, GSTIN `0.35`,
grand total `0.4`, `company_name` always `null`, `item_count` always `0`), and
`staging.reviewed` is always `false`. Values are never guessed and never rounded up.

## Elevated-privilege warning for `process-bill`

`DATABASE_URL` is the branch **owner** role, not a scoped user. Both functions bypass
Postgres RLS entirely.

The client-side insert policy in `db/migrations/0005` still applies to the browser: a
client may only `INSERT` `ocr_jobs` rows with `status = 'queued'` and empty `staging`,
and cannot update them at all. Everything after that — the `processing` lock, the
`succeeded` write, the `failed` write — happens here, over the owner connection.

Consequences you must accept before deploying:

- **`process-bill` is a fully trusted database principal.** It performs no RLS check of
  its own. All authorization is in application code, so a bug here is a
  cross-tenant data-access bug, not a database-enforced one.
- It therefore **must** verify the JWT and re-check membership on every request, which
  it does, and it **must never** trust a client-supplied organization id. It does not
  accept one: the org is read from the `ocr_jobs` row that the requested `job_id`
  points at, and the caller must both hold a non-viewer role there and be the row's
  `created_by`.
- There is no defence in depth beyond that check. Keep the function's surface minimal.
- `attachDatabasePool` and the `pg` `Pool` use the pooled `DATABASE_URL`; do not point
  this function at the unpooled URL, or it will exhaust the branch's connections under
  concurrent OCR calls.

## Typechecking

```bash
npx tsc --noEmit -p neon/tsconfig.json
```

`neon/tsconfig.json` extends the root config but only includes the `neon` folder and
swaps `types` to `["node"]`.

`pg` ships no type declarations and `@types/pg` is not yet a dependency of this
project, so `neon/pg.d.ts` declares the small surface the two functions use. Replace it
with the real types once available:

```bash
npm install --save-dev @types/pg
rm neon/pg.d.ts
```