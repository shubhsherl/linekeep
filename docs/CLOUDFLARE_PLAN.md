# Linekeep Cloudflare service plan

## Purpose

The Cloudflare service registers devices, coordinates recording uploads, stores searchable call metadata, and serves a private administrator panel.

This is the original design background, not an executable deployment specification. Use [server/README.md](../server/README.md) for current self-hosting and operations, the frozen [API_CONTRACT.md](API_CONTRACT.md) for the original v1 boundary, and the [server handoff](../handoffs/SERVER_AGENT.md) for approved additive management/history/recovery/deletion/matching contracts. Current source and ordered migrations under `server/` are authoritative for implementation details where this older plan differs. In particular, uploads stream through scoped Worker capabilities into private R2; the SQL and API sketches below are historical illustrations, not migration files or client fixtures.

## Components

```text
Android app
    |
    | device bearer token
    v
Cloudflare Worker -------- D1
    |
    | scoped Worker upload/playback capabilities
    v
Private R2 bucket (no public access)

Administrator -- Cloudflare Access --> Worker admin routes and UI
```

## Resource layout

- Worker: API and admin static assets.
- D1 binding: `DB`; environment-specific database names are defined below.
- Private R2 binding: `RECORDINGS`; environment-specific bucket names are defined below.
- Cloudflare Access application: `/admin`, `/admin/*`, `/v1/admin` and `/v1/admin/*` on the deployment hostname.
- Worker secret: `TOKEN_HASH_SECRET` for keyed credential hashes and capabilities. `LOCAL_ADMIN_SECRET` is local-only; it is not provisioned remotely. The implementation uses the R2 binding rather than client-visible R2 signing credentials.

Use synthetic data in development and separate resources for production. Keep device routes outside Access's browser challenge; device invitations, bearer credentials and scoped capabilities still apply.

## Account and environment strategy

Deploy Linekeep to your own Cloudflare account. One account can contain multiple Worker applications, D1 databases and R2 buckets; a separate account per project is not required. [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/) share source while isolating deployed Workers, bindings and secrets.

Copy `server/wrangler.example.jsonc` to ignored `server/wrangler.jsonc`. The template contains generic resource names, not a shared account or usable deployment. Keep your account ID, returned D1 IDs, chosen resource names and Access issuer/audience in the private copy.

| Environment | Worker | D1 database | Private R2 bucket |
| --- | --- | --- | --- |
| Development | `linekeep-api-dev` | `linekeep-dev` | `linekeep-recordings-dev` |
| Production | `linekeep-api-production` | `linekeep-production` | `linekeep-recordings-production` |

These names are for new installations. Existing installations must preserve their backend and resource identities; branding is not an enrollment migration. The pinned Wrangler dependency lives in `server/package.json`. Check current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and R2 availability/billing rather than assuming a free allowance covers your usage.

Environment rules:

- The top-level configuration is for local development; declare remote `dev` and `production` under `env`.
- Always pass `--env dev` or `--env production` for remote migration, secret and deployment commands. Do not deploy an unintended third Worker from the unqualified top-level configuration.
- Configure D1, R2 and variables explicitly in each environment; resource bindings are not inherited.
- Use synthetic data in development. Never bind a development Worker to a production database or bucket.
- Generate separate stable `TOKEN_HASH_SECRET` values and configure separate Access applications/policies for the environments.
- Keep R2 public development URLs and public custom domains disabled. Do not deploy `LOCAL_ADMIN_SECRET`.

Provision development first. After installing dependencies and creating the private configuration as described in the server README, run from `server/`:

```bash
npx wrangler login
npx wrangler d1 create linekeep-dev
npx wrangler r2 bucket create linekeep-recordings-dev
```

Fill your account ID, returned D1 ID and bucket name in the matching private environment. Configure Access for both admin path families, without challenging `/v1/device/*`, and populate `ACCESS_TEAM_DOMAIN` and `ACCESS_AUDIENCE`. Generate a random secret of at least 32 bytes and enter it at Wrangler's prompt:

```bash
npx wrangler secret put TOKEN_HASH_SECRET --env dev
npx wrangler d1 migrations apply DB --env dev --remote
npx wrangler deploy --env dev
```

Only after the synthetic development lifecycle passes, provision isolated production D1/R2:

```bash
npx wrangler d1 create linekeep-production
npx wrangler r2 bucket create linekeep-recordings-production
```

Populate `env.production` with its own bindings and Access configuration, then set a different secret and deploy:

```bash
npx wrangler secret put TOKEN_HASH_SECRET --env production
npx wrangler d1 migrations apply DB --env production --remote
npx wrangler deploy --env production
```

Use the HTTPS URL Wrangler prints, not a hostname copied from someone else's deployment. See the server README for local browser/API setup, Android endpoint configuration, consent and installer restrictions, migration backups, retention and rollback.

## Data model

The following schema is the initial conceptual model. Apply `server/migrations/` in order instead of executing this sketch: later migrations add assignment history, call history, invitation provenance/recovery, independent-deletion tombstones and corroborated association. Implemented timestamp/field names also differ from this early sketch.

```sql
CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone_number TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  token_hash TEXT NOT NULL UNIQUE,
  model TEXT,
  android_version TEXT,
  one_ui_version TEXT,
  app_version TEXT,
  last_seen_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  fingerprint TEXT NOT NULL,
  remote_number TEXT,
  direction TEXT NOT NULL,
  started_at TEXT,
  duration_seconds INTEGER,
  match_status TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL,
  actual_bytes INTEGER,
  object_etag TEXT,
  upload_status TEXT NOT NULL,
  uploaded_at TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(device_id, fingerprint)
);

CREATE INDEX calls_started_at_idx ON calls(started_at DESC);
CREATE INDEX calls_employee_started_idx ON calls(employee_id, started_at DESC);
CREATE INDEX calls_remote_number_idx ON calls(remote_number);
```

Store timestamps as UTC ISO-8601 strings or integer epoch milliseconds consistently. Format them in the administrator's timezone only at the UI boundary.

## API contract

The frozen [API_CONTRACT.md](API_CONTRACT.md) defines the original request/response, nullability, enumeration and error boundary. Approved additive interfaces are documented in [the server handoff](../handoffs/SERVER_AGENT.md#approved-employee-and-enrollment-extension). The historical examples below are explanatory and may use superseded field names; use the contract, handoff and `server/fixtures/` when implementing a client.

All JSON responses should include a request ID. Use predictable error bodies:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "expectedBytes must be positive"
  },
  "requestId": "req_..."
}
```

### Register a device

`POST /v1/device/register`

```json
{
  "invitationCode": "short-lived-code",
  "device": {
    "model": "SM-S921B",
    "androidVersion": "...",
    "oneUiVersion": "...",
    "appVersion": "0.1.0"
  }
}
```

Response:

```json
{
  "deviceId": "dev_...",
  "deviceToken": "random-secret-shown-once"
}
```

Invitation codes are random, single-use, expiring and employee-scoped; only keyed hashes are stored. The returned device token is shown once and hashed before D1 storage. Recovery rotates the target enrollment's token atomically while retaining its ID and history; see the approved recovery contract.

### Prepare an upload

`POST /v1/device/uploads/prepare`

Authorization: device bearer token.

```json
{
  "fingerprint": "sha256-hex",
  "contentType": "audio/mp4",
  "expectedBytes": 1234567,
  "call": {
    "remoteNumber": "+12025550123",
    "direction": "outgoing",
    "startedAt": "2026-09-22T07:30:00Z",
    "durationSeconds": 182,
    "matchStatus": "matched"
  }
}
```

Response for a new upload:

```json
{
  "callId": "call_...",
  "status": "pending",
  "upload": {
    "method": "PUT",
    "url": "https://...signed...",
    "expiresAt": "2026-09-22T07:45:00Z",
    "headers": {
      "Content-Type": "audio/mp4"
    }
  }
}
```

Response for an idempotent repeat should return the same `callId` and either another upload URL or `status: "complete"`.

Server validation:

- Accept only an allowlist of audio content types found during the spike.
- Set a practical maximum recording size.
- Generate the object key on the server.
- Never accept an arbitrary bucket key from the device.
- Use a short upload expiry, such as 15 minutes.

Suggested object key:

```text
recordings/{employee_id}/{yyyy}/{mm}/{call_id}.{extension}
```

### Complete an upload

`POST /v1/device/uploads/{callId}/complete`

```json
{
  "etag": "...",
  "actualBytes": 1234567
}
```

Before marking complete, the Worker should issue an R2 `HEAD` and verify that the object exists and its size is plausible. Completion must be idempotent.

### Device heartbeat

`POST /v1/device/heartbeat`

This is not enforcement. It updates last-seen and app/device version fields so upload problems can be diagnosed.

### List calls

`GET /v1/admin/calls?employeeId=&direction=&number=&from=&to=&cursor=`

Return a bounded page, newest first. Never return a permanent public R2 URL.

### Play or download

`POST /v1/admin/calls/{callId}/playback`

Return a short-lived read URL or stream through an authorized Worker route. Set `Content-Disposition` appropriately for playback versus download.

### Delete

`DELETE /v1/admin/calls/{callId}`

Delete the R2 object and retain the D1 tombstone idempotently. Current history deletion is a separate operation: deleting history preserves audio as unlinked recordings, while deleting audio preserves history. Tombstones prevent replay restoration and retain matching ambiguity; this is not a full privacy-erasure workflow. See the [approved deletion contract](../handoffs/SERVER_AGENT.md#approved-linekeep-identity-and-independent-deletion--2026-09-27).

## Authentication

### Devices

- Unique random bearer token per installation.
- Store only a slow or keyed hash in D1.
- Compare tokens without leaking timing information.
- Allow individual revocation.
- Treat invalid-token rate limiting as an operational hardening requirement, not an implied implemented control.

### Administrator

Use Cloudflare Access with an explicit administrator allow policy protecting `/admin`, `/admin/*`, `/v1/admin` and `/v1/admin/*`. The Worker also validates Access JWT signature, issuer, audience, expiry, subject and email. Keep device routes outside the Access browser challenge and do not reuse device bearer tokens for administration.

The explicit local admin secret is accepted only in development on a loopback hostname. It is never compiled into the UI or deployed remotely; LAN hosts and tunnels still require Access.

## Admin panel

One responsive page is sufficient:

```text
+--------------------------------------------------------------+
| Linekeep   Employee [All]  Dates [...]  Number [...]          |
+--------------------------------------------------------------+
| Time        Employee   Direction  Number      Duration  Audio |
| 10:42       Example A  Outgoing   [number]    03:02     [Play] |
| 10:10       Example B  Incoming   [number]    01:14     [Play] |
+--------------------------------------------------------------+
```

This wireframe is illustrative. The current admin UI combines call history and recordings in one feed and provides a separate employee-management tab; see the approved unified-feed contract for item shapes, filters and association semantics.

Required behaviors:

- Server-side pagination and filters.
- Native HTML audio player where the recording format is browser-compatible.
- Download action.
- Delete action with confirmation.
- Clear missing, pending, and failed upload states.
- Mask part of phone numbers in list views if full display is unnecessary.

If Samsung's format is not supported by the target browser, defer transcoding until after the vertical slice. First test direct playback; otherwise provide download for the pilot or add a small asynchronous conversion step later.

## Security and privacy controls

- Keep the R2 bucket private.
- Use HTTPS only.
- Do not log device tokens, presigned URLs, or complete request bodies.
- Redact phone numbers from infrastructure logs where possible.
- Limit accepted content type and byte size.
- Generate object keys on the server.
- Use short-lived upload and playback URLs.
- Choose a retention policy before production. Delete through the admin API; bucket lifecycle removal alone does not coordinate D1 tombstones or implement application retention.
- Back up or export D1 according to the importance of the metadata.
- Evaluate an audit trail for administrative actions if more than one administrator is added; this is a design recommendation, not a claim that audit logging is implemented.

API-key authentication alone does not protect recording URLs if the bucket becomes public; storage privacy and expiring URLs are separate requirements.

## Observability

The implemented application log allowlist contains request ID, method, matched route, status and duration. It excludes raw URLs/query strings, headers, bodies, credentials, raw errors and personal metadata. Review platform logging settings before production. Future operational diagnostics must preserve that privacy boundary rather than automatically logging the identity/call details envisioned in the initial plan.

Useful operational queries:

- Devices not seen recently.
- Pending uploads older than one hour.
- Repeated completion failures.
- R2 objects without completed D1 records.
- D1 completed records whose R2 object is missing.

Do not build a monitoring dashboard for the MVP; a small admin diagnostics section or D1 query is enough.

## Cost expectations

Estimate cost from your own recording volume, retention period, Worker requests, D1 operations and R2 storage/requests. Consult current Cloudflare pricing and limits; the project does not guarantee a free tier or a particular monthly bill.

Set billing/usage notifications and a coordinated retention policy rather than relying on a pilot estimate.

## Deployment sequence

1. Install dependencies and copy the public Wrangler and local-variable templates.
2. Generate independent local secrets, apply local migrations and exercise local admin/API flows.
3. Authenticate to your own Cloudflare account and provision isolated development D1/R2 resources.
4. Populate private `env.dev` bindings, stable hashing secret and Access issuer/audience.
5. Protect both admin path families with Access; leave device routes outside its browser challenge.
6. Apply all development migrations and deploy with `--env dev`.
7. Verify health, Access enforcement, private storage and the synthetic upload/playback/deletion/recovery lifecycle.
8. Connect an Android build configured with that real HTTPS origin and verify actual device permissions.
9. Provision isolated production bindings, secrets and Access policy only after the development flow passes.
10. Configure lawful retention, secure backups and billing alerts before collecting real data.
11. Apply production migrations, deploy with `--env production` and repeat the security/lifecycle checks.

## Server definition of done

- Device registration creates a revocable per-device credential.
- Prepare and complete are validated and idempotent.
- Audio streams through scoped Worker capabilities into private R2.
- Search metadata lives in D1.
- An Access-protected administrator can list, play, download, and delete.
- No permanent audio URL or storage credential reaches the APK or browser.
