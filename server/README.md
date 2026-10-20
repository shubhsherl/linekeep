# Linekeep Cloudflare backend

One Cloudflare Worker hosts the device API and admin UI. D1 stores searchable metadata; a private R2 bucket stores recordings. You deploy and control your own resources—this repository provides no hosted service or shared credentials.

The [frozen v1 contract](../docs/API_CONTRACT.md) defines the original API. The [server handoff](../handoffs/SERVER_AGENT.md) records approved additive management, call-history, recovery, deletion and matching contracts. For architecture background, see the [Cloudflare plan](../docs/CLOUDFLARE_PLAN.md).

## Before you start

- Use Node.js 22 or newer and npm. The lockfile installs the project's Wrangler version; a global install is unnecessary.
- Local browser/API development needs no Cloudflare account. Remote deployment needs a Cloudflare account with Workers, D1, R2 and Zero Trust/Access available, plus permission to provision them. Check current service limits and billing requirements.
- Obtain required employee and call-participant consent before collecting recordings or call history. The operator is responsible for lawful collection, access and retention.
- Samsung Phone records the audio; Linekeep uploads existing files. Android call-history access requires actual `READ_CALL_LOG` permission, which a manual APK installer may restrict. Denial is an unsupported history state, not something the server or app bypasses. Folder access and recording uploads are independent.
- Use synthetic identities and audio in development. Keep real recordings, database exports, credentials, screenshots containing personal data and populated configuration outside Git.

## Local setup

From the repository root:

```bash
cd server
npm ci
cp wrangler.example.jsonc wrangler.jsonc
cp .dev.vars.example .dev.vars
```

`wrangler.example.jsonc` is the public template. `wrangler.jsonc` is your ignored, private configuration; existing npm scripts read it automatically. Keep its top-level local bindings and variables for local development. Do not replace an existing deployment's private configuration with the example.

Generate **two independent** random secrets. Run this command twice:

```bash
node -p "require('node:crypto').randomBytes(32).toString('hex')"
```

Put one generated value in `TOKEN_HASH_SECRET` and the other in `LOCAL_ADMIN_SECRET` in `.dev.vars`. Each must contain at least 32 bytes. Neither example values nor fixture credentials are suitable. Never commit the populated file.

Keep `TOKEN_HASH_SECRET` stable: changing it invalidates stored invitation/device hashes and outstanding media capabilities. It is not a routine release-time rotation.

```bash
npm run db:migrate:local
npm run dev
```

Open `http://localhost:8787/admin` and sign in with `LOCAL_ADMIN_SECRET`. Local sessions last one hour and use an HttpOnly, SameSite=Strict cookie; cookie-authenticated mutations require the same origin. `/health` is unauthenticated. Local D1/R2 state lives under ignored `.wrangler/`; deleting that directory discards local state.

### Local API access

Local scripts can send `Authorization: Bearer <LOCAL_ADMIN_SECRET>` to admin endpoints. Supply your own secret securely to the script rather than committing it. For example, with `LOCAL_ADMIN_SECRET` already set in the shell:

```bash
curl http://localhost:8787/health
curl --fail-with-body http://localhost:8787/v1/admin/employees \
  -H "Authorization: Bearer ${LOCAL_ADMIN_SECRET}"
```

The bypass requires both `ENVIRONMENT=development` and a loopback hostname (`localhost`, `127.0.0.1` or `[::1]`). A LAN address, tunnel or remotely deployed Worker requires Cloudflare Access even in development mode. Device endpoints use their own invitation/bearer credentials, never the local admin secret.

## Cloudflare deployment

> Prefer a guided setup? `npm run setup` provisions everything below from a Cloudflare API token and asks which optional features you want. See the [setup guide](../docs/SETUP.md). The steps below are the manual equivalent.

### Private configuration and resources

The template's names are examples for a new installation; you may choose your own:

| Environment | Worker | D1 database | Private R2 bucket |
| --- | --- | --- | --- |
| `dev` | `linekeep-api-dev` | `linekeep-dev` | `linekeep-recordings-dev` |
| `production` | `linekeep-api-production` | `linekeep-production` | `linekeep-recordings-production` |

Use distinct resources, secrets and Access applications/policies for each environment. Never connect a development Worker to production data. Configure D1, R2 and variables explicitly in each named environment; resource bindings are not inherited.

From `server/`, authenticate and create your development resources:

```bash
npx wrangler login
npm run cf:whoami
npx wrangler d1 create linekeep-dev
npx wrangler r2 bucket create linekeep-recordings-dev
```

In private `wrangler.jsonc`, add your account ID as the top-level `account_id` if account selection is ambiguous. Fill `env.dev.d1_databases` with the returned database ID and chosen database name, retaining binding `DB`. Set the chosen R2 bucket name under `env.dev.r2_buckets`, retaining binding `RECORDINGS`. Update `env.dev.name` if you chose a different Worker name.

Keep the bucket's public `r2.dev` URL disabled and add no public custom domain. Upload/playback is mediated by scoped Worker capabilities; neither the phone nor the browser needs R2 credentials.

### Cloudflare Access

Before using remote administration, create a self-hosted Access application for your Worker hostname (or your own routed hostname). Protect **all** of these paths:

- `/admin` and `/admin/*`, including assets.
- `/v1/admin` and `/v1/admin/*`, including playback/download routes.

Use an explicit allow policy for your administrators through your chosen identity provider. Configure an appropriate session lifetime; one hour is a reasonable starting point. Keep `/v1/device/*` outside the browser login challenge: device registration, bearer tokens and upload capabilities provide its authentication. `/health` remains public. Do not apply a whole-host Access challenge that prevents Android from reaching device routes.

Fill the matching environment's `vars` in private `wrangler.jsonc`:

| Variable | Value |
| --- | --- |
| `ENVIRONMENT` | `development` for `dev`; `production` for `production`. Remote hosts require Access in either mode. |
| `MAX_RECORDING_BYTES` | Recording size ceiling; the template uses `104857600` (100 MiB). |
| `ACCESS_TEAM_DOMAIN` | Your exact issuer, for example `https://YOUR-TEAM.cloudflareaccess.com`, without a trailing slash. Replace the placeholder with your actual team domain. |
| `ACCESS_AUDIENCE` | Audience tag for this environment's Access application. |

The Worker independently verifies the Access assertion's RS256 signature, issuer, audience, expiry, subject and email. Missing configuration is an error, not a bypass. Never provision `LOCAL_ADMIN_SECRET` remotely.

Access can be configured in the Cloudflare dashboard. If automating it, use a temporary account-restricted control-plane token with `Access: Apps and Policies Edit` and `Access: Organizations Read`; Wrangler OAuth alone does not administer Access. Keep such a token out of Worker bindings, scripts committed to Git and logs; revoke it after provisioning. It is not an administrator login credential.

### Development deployment

Generate a fresh random secret of at least 32 bytes for the remote environment, separate from your local values. Enter it at Wrangler's prompt:

```bash
npx wrangler secret put TOKEN_HASH_SECRET --env dev
npm run db:migrate:remote
npm run deploy
```

Both npm scripts above explicitly select `dev`. Always pass `--env dev` or `--env production` for other remote commands. The unqualified top-level configuration is for local emulation; do not deploy it as an unintended third Worker.

Use the HTTPS URL printed by Wrangler. A template example is `https://linekeep-api-dev.YOUR-SUBDOMAIN.workers.dev`; it is not a working service URL. Open that deployment's `/admin` path and complete your Access login. Before enrolling real devices, verify health, authorized administration, rejection without Access and the synthetic recording lifecycle below. Anonymous admin routes should redirect to Access; unauthenticated device routes should return JSON `401`, not an HTML login page.

For later deployments, keep the same resources and hashing secret. Back up before migrations, then run `npm run db:migrate:remote` and `npm run deploy` again. Do not recreate the database or rotate the secret during ordinary releases.

### Production provisioning gate

First complete the development upload, playback, deletion and recovery flow with synthetic data. Then create isolated production resources:

```bash
npx wrangler d1 create linekeep-production
npx wrangler r2 bucket create linekeep-recordings-production
```

Fill `env.production` in private `wrangler.jsonc` with its own Worker name, database ID, bucket binding and Access issuer/audience. Configure the production Access application and private bucket before use. Generate a different production hashing secret, then deploy:

```bash
npx wrangler secret put TOKEN_HASH_SECRET --env production
npx wrangler d1 migrations apply DB --env production --remote
npx wrangler deploy --env production
```

Repeat the authentication, bucket-privacy and synthetic-lifecycle checks against production before uploading real recordings. No resources, retention job or billing alerts are created automatically by this guide.

## Connecting Android

Device integration requires a real hosted HTTPS origin; the local browser/server flow above works without deploying. Build with Java 17 and Android SDK 35, using your own deployed URL. From the repository root:

```bash
cd android
./gradlew --no-daemon \
  -Plinekeep.apiBaseUrl=https://linekeep-api-dev.YOUR-SUBDOMAIN.workers.dev \
  :app:assembleDebug
```

Replace the example hostname. Configuration precedence is Gradle property `linekeep.apiBaseUrl`, then environment variable `LINEKEEP_API_BASE_URL`, then ignored `android/linekeep.local.properties` key `apiBaseUrl`. Missing, non-HTTPS or non-origin values fail the build; there is no default private backend. See [Android setup](../android/README.md) for device permissions and installation.

For an existing installation, keep the **same backend, application ID `com.microorganics.calltracker` and signing key**. Public Linekeep resource names describe new installations, not an automatic migration. A differently signed APK cannot upgrade the existing app, and a different backend does not have its enrollment/history.

## Employees and enrolled devices

The admin workspace has **Call history** and **Employees** tabs. Employees includes people with no calls. Edit a person's name to correct it; when a phone changes hands, reassign its device rather than renaming the previous person. Technical IDs are available in expandable details.

The immutable `deviceId` is the public enrollment ID, not a credential. Every authenticated device operation needs its installation's revocable bearer token. SIM numbers are unverified, read-only device metadata; an omitted report preserves the last value and an empty list clears it. A number or enrollment ID alone never authenticates anything.

For a handover:

1. Create the new employee if necessary.
2. Find the existing device under Employees and select **Reassign**.
3. The change takes effect when saved. The same installation/token continues working, and its next heartbeat returns the new employee.
4. Existing recording ownership stays unchanged. Newly prepared offline recordings with source timestamps use assignment history. A new timestamp-less recording after handover returns `409` rather than guessing; already-prepared recordings can still complete while the device and relevant employees remain active.

Invitation history shows IDs, purpose, enrollment/recovery target and active/redeemed/expired/revoked status—not recoverable code text. Codes are random, single-use, expiring and shown once. Revoked devices and invitations are hidden unless **Show revoked** is enabled. Revoking an invitation does not revoke an already-enrolled device; use the separate device action.

**Setup QR code.** Generating an enrollment or recovery invitation also shows a QR code (and returns additive `enrollmentUri` and `qrSvg` fields). It encodes `linekeep://enroll?server=<this Worker's HTTPS origin>&code=<invitation code>`; scanning it in the Android app (Home → Scan QR code) supplies both the backend address and the one-time code, so a single generic APK works for every deployment. The origin comes from the request the administrator used, so open `/admin` on the public hostname you want phones to use. The QR is as sensitive as the code: it is shown once, not stored, and cleared when dismissed or expired.

After reinstall or cleared app data, select **Recover enrollment** on the existing device and issue a one-use recovery code. Enter it through normal Android setup. Issuing it supersedes outstanding recovery codes without interrupting the current installation. Redemption atomically retains the enrollment/history, rotates its bearer credential and invalidates the old installation. Original/latest invitation IDs record provenance. Permissions and folder access must be granted again. A normal enrollment invitation creates a new device instead.

See the [management contract](../handoffs/SERVER_AGENT.md#approved-employee-and-enrollment-extension) and [recovery contract](../handoffs/SERVER_AGENT.md#approved-simplified-setup-and-unified-calls--2026-09-26). The heartbeat fixture needs the actual registered device ID and that device's token.

## Call history synchronization

The [history and unified-feed contracts](../handoffs/SERVER_AGENT.md#approved-simplified-setup-and-unified-calls--2026-09-26) define `POST /v1/device/call-logs/batch` and `GET /v1/admin/call-logs`. After explicit sharing acceptance, Android uses actual call-log and folder grants independently. Provider events trigger synchronization; periodic work is a recovery fallback.

Batches contain at most 50 entries. Device-scoped fingerprints make retries idempotent without changing the original start time or employee. Optional caller names come from cached call-log data, not contacts access. Local number, SIM label and phone-account ID describe the historical call, not the current default SIM.

The unified feed shows calls with inline audio and explicit **Unlinked recording** rows. Filters cover employee, call type, literal number text, time range and completed recording presence. Matching requires one unique same-device, same-employee incoming/outgoing call across the full candidate set, not just the filtered page. The observed Samsung filename format additionally corroborates caller identity, filename time, embedded media start/end and duration with bounded ringing/rounding differences. Other formats retain exact-second/equal-duration matching. Missing, competing or conflicting evidence stays unlinked; deleted candidates still preserve ambiguity. Upload/modification time never establishes a match. See the [Samsung rules](../handoffs/SERVER_AGENT.md#samsung-recording-association--2026-09-27).

**Delete call log** keeps audio as unlinked recordings; **Delete recording** removes its R2 bytes but keeps history. Both remove the selected item from the unified feed and leave phone originals untouched. History tombstones retain matching/deduplication metadata to prevent replay restoration and false associations: this is not full data erasure. Recording deletion invalidates previous playback capabilities while preserving legacy tombstone API semantics. See the [deletion contract](../handoffs/SERVER_AGENT.md#approved-linekeep-identity-and-independent-deletion--2026-09-27).

## Customers and WhatsApp conversations

Migration `0008_customers.sql` adds `customers`, `customer_employees` and `whatsapp_messages`, plus two virtual columns and a partial index on `call_logs` so a customer's calls are found by phone key without scanning history. See the [customer contract](../handoffs/SERVER_AGENT.md#customers-whatsapp-chats-and-employee-assignment--2026-10-06-approved-by-project-owner). Phone numbers are normalized once (`normalizePhone` in `src/data/customers.ts`) to `+<digits>`; the last 10 digits (`phone_key`) are unique among non-archived customers and are compared with the last 10 digits of `call_logs.remote_number`. Only common separators (space, `+ - ( ) . /`) are stripped from call-log numbers; numbers containing other characters or fewer than 10 digits never match.

Administrators manage customers and read chats and calls at `/v1/admin/customers*` and `/v1/admin/whatsapp/chats`. An enrolled device reads only customers assigned to its **current** employee at `/v1/device/customers*` and `/v1/device/whatsapp/*`; other customers return `404`. `message.sentAt` and all other timestamps are UTC RFC 3339 strings. Historical conversations are inserted by an operator (`whatsapp_messages.source = 'import'`); no endpoint imports them. There is no WhatsApp transport yet: `GET /v1/device/whatsapp/status` returns `{"canSend": false}` and `POST /v1/device/customers/{id}/messages` validates the request and returns `503 WHATSAPP_NOT_CONFIGURED` without storing anything. Customer phone numbers and message bodies are personal data; do not log them or copy them into fixtures.

## Call analytics

`GET /v1/admin/analytics/calls?from=YYYY-MM-DD&to=YYYY-MM-DD&employeeIds=a,b&callTypes=incoming,outgoing` returns read-only aggregates (totals, previous-period totals for deltas, per-employee metrics, by type, by IST day, weekday-by-hour and duration buckets) over undeleted `call_logs`; see the [analytics contract](../handoffs/SERVER_AGENT.md#call-analytics--2026-10-18-approved-by-project-owner). Days are Asia/Kolkata (IST), both ends inclusive; the default window is the last 7 days ending today in IST and the maximum is 366 days. Malformed or unknown query values, duplicate keys, `from` after `to` and windows over 366 days return `400 INVALID_REQUEST`; a well-formed employee ID that matches nothing returns zeros. The implementation (`src/data/analytics.ts`) sends five statements in one D1 batch, computes IST day/hour/weekday in SQL from the UTC `started_at` text and fills zero days, all 168 weekday-hour cells and all eight call types in code. Responses contain no phone numbers, contact names or recording URLs. Run `node --test src/modules/analytics/analytics.test.mjs` for focused checks.

## Daily email summaries

The same Worker can send a Mailgun email at **6 PM IST every day**, using Cloudflare Cron `30 12 * * *` (UTC). No GitHub Actions runner or additional public endpoint is required. Reporting is disabled by default in the public configuration template.

Each email covers calls **starting from midnight up to, but not including, 6 PM IST that day**, as uploaded when the job executes. This is a **today-so-far snapshot**, not a complete-day report: calls after the cutoff and uploads arriving after generation are not carried into tomorrow's email. Delayed execution uses the scheduled event's date, not the current execution date.

The HTML and plain-text report includes overall and per-employee totals, connected calls (logged duration greater than zero), calls without duration, distinct stored-number counts, total duration and all eight Android call types. Only undeleted call history is counted; audio never adds duplicate calls. Attribution uses each log's historical employee, including employees no longer assigned to the device. Unique-contact counts represent distinct stored number strings, not deduplicated people. Individual phone-number fields, raw call rows and recordings are not emailed. A no-call day still produces a zero-call report.

### Configure and enable delivery

Use your verified Mailgun sending domain and its matching API key. From `server/`, enter values at the prompts rather than putting credentials or recipient addresses in committed configuration:

```bash
npx wrangler secret put MAILGUN_API_KEY --env dev
npx wrangler secret put MAILGUN_DOMAIN --env dev
npx wrangler secret put EMAIL_IDS --env dev
```

`EMAIL_IDS` follows the reference GitHub workflow's configuration: either `admin@example.com,manager@example.com` or `["admin@example.com","manager@example.com"]`. Supply plain email addresses, at most 1,000. Invalid lists fail without sending a partial report. Recipients appear together in the email's **To** field and can see each other's addresses. GitHub cannot return an existing repository secret's value; copy it from your own configuration or set a new approved list.

In your ignored `wrangler.jsonc`, set these on the intended environment only:

```jsonc
"triggers": { "crons": ["30 12 * * *"] },
"vars": {
  // Retain the environment's existing variables.
  "CALL_SUMMARY_ENABLED": "true"
}
```

The sender is `Linekeep Reports <postmaster@MAILGUN_DOMAIN>`. Optionally set `MAILGUN_FROM_EMAIL` to another authorized sender and `MAILGUN_REGION` to `eu` for an EU domain; the default region is `us`. These can also be provisioned as Worker secrets. Do not copy Cratio login credentials or an unused email provider's key into Linekeep.

Deploy with `npm run deploy` for development. Configure production separately with `--env production` only when intended; enabling development does not enable production. Cron changes can take up to 15 minutes to propagate. To stop sending, set `CALL_SUMMARY_ENABLED` to `"false"` and redeploy. Set that environment's `triggers.crons` to `[]` as well if you want to remove its scheduled invocations.

### Verification and delivery status

Run `node --test src/reporting/call-summary.test.mjs` for isolated D1, timezone/cutoff, deletion/attribution, escaping/privacy and native Worker scheduling regressions. Email requests are intercepted; this command sends no real email. Local development remains disabled by default in `.dev.vars.example`. Enabling it with real credentials can send real messages.

Cloudflare **Cron Events** shows scheduled invocation outcomes. A successful request means **Mailgun accepted** the message, not that an inbox received it; inspect Mailgun delivery/bounce events for delivery status. Provider rejection fails the invocation without logging its response body, recipients or credentials. Redirects are not followed, and email open/click tracking is disabled. There is one send request per invocation, not an exactly-once delivery guarantee; manually replaying an event can resend its report.

## Recording retention

Optional and **off by default**. Set `RECORDING_RETENTION_DAYS` (a whole number of days, for example `"30"`) in the Worker's `vars` and the daily Cron job also deletes recording audio older than that: the R2 object is removed first, then the call is tombstoned as `deleted`, exactly like **Delete recording** (playback then reports it as deleted). Age is the call's recorded time, falling back to when the server received it, so old recordings uploaded late from a phone are removed too. Call logs, customers and chats are never touched. Each run handles at most 750 recordings and logs only counts; a remainder continues the next day, and an R2 failure leaves rows untouched so they retry. The same setting also makes the server **refuse to accept** audio whose recorded time is already older than the period: `POST /v1/device/uploads/prepare` answers `409`, stores nothing, and the Android app treats that as permanent ("stopped for this source") so it does not retry or waste uploads; audio without a recorded time is treated as new. Unset, `0` or a non-number disables both the job and the refusal. Pending and failed uploads are not touched. Test it on a development environment first (`node --test src/retention/recordings.test.mjs`).

## Fixture workflow and focused checks

`fixtures/` contains the shared request/response examples and `synthetic.wav`, a generated two-second, 32,044-byte WAV without employee audio. Sample invitation codes and IDs are examples, not working credentials.

1. In Employees, create a synthetic employee and issue a fresh invitation.
2. Register using the [API contract](../docs/API_CONTRACT.md); keep the returned token private and replace fixture IDs with the actual enrollment ID.
3. Prepare the fixture recording, then PUT `synthetic.wav` to the exact returned URL with the required headers. Complete the upload. Repeated prepare must preserve the call ID.
4. Find it in `/admin`, play it and download it. Confirm the downloaded bytes match the fixture.
5. Exercise independent call-log/recording deletion with synthetic history. Deleted history must not return after a device replay; deleting audio must invalidate prior playback URLs.
6. Test one-use recovery: the enrollment/history stays intact, replay and the old token fail, and the replacement token can send heartbeat.
7. Revoke the synthetic device and remove synthetic audio when finished. Remember deletion tombstones are retained.

JSON POST/PATCH bodies are limited to 16 KiB except enriched history batches, which allow 256 KiB. Signed audio PUTs stream separately and enforce both `MAX_RECORDING_BYTES` and the prepared size.

Focused regression commands, subject to the repository's local-check policy:

```bash
node --test src/data/repositories.test.mjs src/security/credentials.test.mjs
node --test src/modules/identity/identity.test.mjs
node --test src/modules/recordings/capabilities.test.mjs src/modules/recordings/recordings.test.mjs
node --test src/modules/admin-calls/admin-calls.test.mjs src/http/app.test.mjs
node --test src/modules/call-history/call-history.test.mjs
node --test src/reporting/call-summary.test.mjs
```

Backend checks do not establish physical Samsung folder access, installer-granted call-log permission, dual-SIM behavior or background reliability on a particular phone. Verify those on your intended devices.

## D1 usage and plan limits

The Workers **Free** plan caps D1 at **5 million rows read and 100,000 rows written per day for the whole account** (all databases). When a cap is reached every D1 query fails, including migrations, until 00:00 UTC. A paid Workers plan has far larger allowances. A phone's first sync uploads up to a few thousand call-log rows, so a free account can reach the cap during onboarding. Migration `0009` keeps association work per call or recording to a handful of rows; the admin call feed and analytics still read in proportion to history, so budget accordingly. Inspect usage with `npx wrangler d1 insights DB --env <env> --time-period 1d --sort-by reads`.

## Retention, billing, and rollback

Apply every ordered migration in `migrations/`; do not cherry-pick a later migration into a fresh database. Use `npm run db:migrate:local` locally, `npm run db:migrate:remote` for remote development, and the explicit production command above. Existing deployments should export D1 before schema changes and retain the export securely outside the repository, with restrictive permissions and a defined backup retention period. Exports may contain personal metadata and credential hashes.

Choose a lawful retention period before collecting real recordings. Delete audio through the admin API so R2 removal and D1 tombstones stay coordinated. Bucket lifecycle deletion alone leaves stale D1 metadata; it is not an implemented application retention workflow. History deletion is separate, retains internal metadata and is not a complete privacy-erasure endpoint. A full erasure policy must account for that metadata, phone originals and backups.

Configure Cloudflare billing/usage notifications and review Workers, D1 and R2 storage/request usage. Limits, budgets and retention schedules are deployment-owner decisions; the application does not configure them for you.

Record the deployed Worker version before each release. Use Wrangler deployment history and rollback to restore a prior **schema-compatible** Worker version. D1 migrations are forward-only: do not delete migration records or run destructive down migrations against live data. Repair schema/data through a new migration and check compatibility before a code rollback. A Worker rollback does not restore deleted audio; deletion is irreversible unless separately backed up.

Application logs allowlist request ID, method, matched route, status and duration. Do not add bodies, raw errors, headers, credentials, capability query strings, phone numbers or recordings to logs; review platform logging settings before production as well.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Local startup or hashing error | Run `npm ci`; copy both templates; fill two independent secrets of at least 32 bytes; restart Wrangler after changing variables. |
| Missing tables/columns | Apply all migrations to the same local or named remote environment that serves the request. Local migrations do not update remote D1. |
| Local admin returns `401` | Use the local secret, a loopback hostname and development mode; re-login after session expiry. Cookie mutations need the same origin. A LAN address/tunnel is not a local-auth bypass. |
| Remote admin cannot log in | Check Access exact/base and descendant paths, allow policy, issuer (no trailing slash) and application audience. Confirm the Worker receives a valid Access assertion. Never fix this by exposing admin routes or deploying the local secret. |
| Android receives an HTML login page | Access is challenging a device path. Restrict Access to admin paths while preserving the Worker's device authentication. |
| Enrolled device returns `401` | Check revocation, recovery credential rotation, correct backend and unchanged hashing secret. Knowing a device ID or SIM number does not recover its bearer token. |
| Recording prepare returns `409` after reassignment | A new recording without a source timestamp cannot be assigned safely after handover. Preserve true source metadata; do not invent a timestamp. |
| Upload is rejected or remains pending | Check content type, prepared byte size, configured ceiling and capability expiry. Retry prepare for a fresh capability without changing the fingerprint; attempt completion before retransmitting a successful PUT. |
| Recording stays unlinked | Check the documented caller/time/duration evidence and full candidate set. Missing or ambiguous evidence is intentionally not guessed; upload time is not call time. |
| Browser cannot play audio | Try download to distinguish unsupported media from missing data/authentication. No server transcoding workflow is provided. Deleted or expired playback capabilities must fail. |
| History is missing but recordings upload | Check actual Android consent and call-log permission, including installer restrictions. A folder grant cannot grant `READ_CALL_LOG`. |

## Agent workflow

Claim a ready backend task in [tasks.json](../tasks.json) and respect its owned paths. Shared contract changes belong in the [server handoff](../handoffs/SERVER_AGENT.md); the original API contract remains frozen. Coordinate integration and validation with the task owner rather than editing another agent's implementation slice.
