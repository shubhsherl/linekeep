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

`/download` and `/download/*` (the employee download page, see [Android app download](#android-app-download)), `/app` and `/app/*` plus `/v1/web/*` (the employee web app, see [Employee web app](#employee-web-app)) and `/health` must stay **outside** the Access application: employees open them without a Cloudflare login. If your existing application covers the whole hostname (or `/*`), edit it so its destinations are exactly `/admin`, `/admin/*`, `/v1/admin` and `/v1/admin/*`.

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

## Managers and teams

An administrator can make an employee a **manager** (Employees tab: **Role**, **Reports to**) and assign employees to report to them (migration `0023_manager_role.sql`: `employees.role`, `employees.manager_id`, `employees.notify_team_messages`). One level only: a manager has no manager, an employee reports only to an active manager, a manager has at most 50 active reports. Demoting a manager who still has active reports asks where the team goes (another manager, or nobody; `moveTeamTo`); `409 manager_has_team` otherwise. Promoting an employee ends their own reporting line. Deactivating a manager detaches their reports.

A manager sees, and can do everything an employee can do for, **themselves and their team**, in the phone app and the web app: customers, WhatsApp chats and sending, call analytics, call history (including playing the team's recordings), adding and editing customers (name and notes, never the phone number), and **handing customers over** between the team and themselves. A customer is in a manager's scope when any of its handlers is. Managers get no administrator powers. The scope is resolved once per request (`src/data/scope.ts`) and every employee query binds `employee_id IN (...)` in SQL, so employees and managers of another team never see out-of-scope data. Details, parameters and error codes are in the [manager contract](../handoffs/SERVER_AGENT.md#manager-level--2026-11-13-owner-request).

Optional: tick **Notify manager of team messages** on a manager to push them new inbound messages of customers handled by their reports (off by default).

## Call history synchronization

The [history and unified-feed contracts](../handoffs/SERVER_AGENT.md#approved-simplified-setup-and-unified-calls--2026-09-26) define `POST /v1/device/call-logs/batch` and `GET /v1/admin/call-logs`. After explicit sharing acceptance, Android uses actual call-log and folder grants independently. Provider events trigger synchronization; periodic work is a recovery fallback.

Batches contain at most 50 entries. Device-scoped fingerprints make retries idempotent without changing the original start time or employee. Optional caller names come from cached call-log data, not contacts access. Local number, SIM label and phone-account ID describe the historical call, not the current default SIM.

The unified feed shows calls with inline audio and explicit **Unlinked recording** rows. Filters cover employee, call type, literal number text, time range and completed recording presence. Matching requires one unique same-device, same-employee incoming/outgoing call across the full candidate set, not just the filtered page. The observed Samsung filename format additionally corroborates caller identity, filename time, embedded media start/end and duration with bounded ringing/rounding differences. Other formats retain exact-second/equal-duration matching. Missing, competing or conflicting evidence stays unlinked; deleted candidates still preserve ambiguity. Upload/modification time never establishes a match. See the [Samsung rules](../handoffs/SERVER_AGENT.md#samsung-recording-association--2026-09-27).

**Delete call log** keeps audio as unlinked recordings; **Delete recording** removes its R2 bytes but keeps history. Both remove the selected item from the unified feed and leave phone originals untouched. History tombstones retain matching/deduplication metadata to prevent replay restoration and false associations: this is not full data erasure. Recording deletion invalidates previous playback capabilities while preserving legacy tombstone API semantics. See the [deletion contract](../handoffs/SERVER_AGENT.md#approved-linekeep-identity-and-independent-deletion--2026-09-27).

## Settings in the dashboard (Config)

WhatsApp, push notifications, the daily email and the Customers/WhatsApp switches are configured by admins in the dashboard's **Config** tab; each page lists its setup steps. Values live in D1 (`app_settings`, migration `0017_settings.sql`). Secrets (WhatsApp token, app secret and verify token, Mailgun API key, Firebase service account) are encrypted with AES-256-GCM before they are stored: the key is derived (HKDF-SHA256) from `TOKEN_HASH_SECRET`, every value has its own random IV and the setting's name is bound to the ciphertext. Secrets are write-only: no endpoint returns them. Saving a secret fails with `503 NOT_CONFIGURED` while `TOKEN_HASH_SECRET` is missing, and **rotating `TOKEN_HASH_SECRET` makes saved secrets unreadable** (they show as not set; enter them again).

Precedence per value: the database, then the Worker variable or secret of the same name (`WHATSAPP_*`, `FCM_SERVICE_ACCOUNT`, `FIREBASE_CLIENT_CONFIG`, `MAILGUN_*`, `EMAIL_IDS`, `CALL_SUMMARY_ENABLED`, `CALL_SUMMARY_SEND_TIME`, `WHATSAPP_APP_ID`), then unset. Existing deployments therefore keep working unchanged; **Import from deployment** copies the variables into the encrypted store. A middleware lays the effective values over `context.env`, from a ~15 s per-isolate cache that a save invalidates (another isolate can take up to 15 s to notice).

All routes need an administrator:

| Route | Purpose |
|---|---|
| `GET /v1/admin/settings` | Current settings; secrets only as `{set, source: "database"\|"deployment"\|"none"}`, plus `deployment.importable` |
| `PUT /v1/admin/settings/{features\|whatsapp\|email\|push\|employeeWeb\|activity}` | Partial update: absent = unchanged, `null` = clear, a string replaces a secret; `whatsapp.verifyToken: {"generate": true}` returns `generatedVerifyToken` once |
| `POST /v1/admin/settings/import-deployment` | Copy deployment values that are not yet in the database; returns `{imported}` |
| `POST /v1/admin/settings/whatsapp/test` | Check the token and phone number id against Meta's Graph API |
| `POST /v1/admin/settings/email/test` | Send a test email to the recipients |
| `GET /v1/admin/features` | `{customers, whatsapp}` for tab visibility |

**Feature switches.** Customers and WhatsApp are off on a new install; while off, their admin and device routes answer `404 feature_disabled` and the WhatsApp webhook answers 404. WhatsApp needs Customers. The migration switches them on when customers or WhatsApp data already exist, and an install that already has `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` variables keeps both on until someone turns them off, so deploying does not interrupt a working setup. Push token registration is not gated.

## Activity log

Everything employees and administrators do is recorded in one append-only table, `activity_log` (migration `0022_activity_log.sql`), and shown in the dashboard's **Activity** tab. `recordActivity` / `recordActivityBatch` / `recordMergedActivity` (`src/activity/record.ts`) never throw and never make a request wait: on a Worker the insert runs in `waitUntil`, and a failed write is only counted in the log (`{"job":"activity-log","status":"error","dropped":1}`). A request without an execution context (tests) awaits it.

**What a row holds.** `id` (`act_*`), `occurred_at` (UTC, ms), `actor_type` (`employee`, `admin`, `system`, `customer`), `actor_id` and `actor_name` (a snapshot; an administrator is the verified Cloudflare Access e-mail, `local` / "Local admin" in development), `category`, `action`, `target_type` (`customer`, `employee`, `device`, `call`, `template`), `target_id`, `target_label` (snapshot), `channel` (`app`, `web`, `admin`, `system`), `details` (small flat JSON) and, for `signin` rows only, `ip` (`CF-Connecting-IP`) and `user_agent`. Never stored: message text, notes, phone numbers, e-mail addresses, codes, tokens, setting values, file names or contents. The allowed actions and the allowed `details` keys of each are in `src/activity/catalog.ts`; anything else is dropped. A name that is only a phone number is stored masked (`••••1234`).

| Category | Actions (`details`) |
|---|---|
| `signin` | `code_requested` (method), `signed_in` (method), `sign_in_failed` (method, reason), `signed_out`, `rate_limited` (method, limit), `session_revoked` (count; admin). Only for a code requested for, or a session of, a real employee. |
| `device` | `enrolled` (model, androidVersion, appVersion, recovered), `revoked`, `recovery_invited`, `reassigned` (toEmployee), `invitation_created`, `invitation_revoked`, `call_sync` (calls, batches), `recording_uploaded` (count, bytes), `app_version_changed` (from, to). `call_sync` and `recording_uploaded` are one row per phone and 15 minutes: a later event in the window adds to the row's numbers and moves its time; `details.since` is when the row began. Heartbeats are not logged. |
| `customer` | `created` (source `employee_app`/`employee_web`/`admin`/`bulk_import`/`whatsapp_inbound`, assigned), `updated` (fields), `assigned` / `unassigned` (employees), `archived`, `customers_handed_over` (added, removed, to, from; actor is a manager) |
| `whatsapp` | `message_sent` / `message_failed` (type, templateName, mediaKind), `attachment_uploaded` (kind, bytes), `message_received` (type; actor `customer`, hidden in the feed unless asked for), `auto_reply_sent` (system), `bulk_intro_sent` (sent, failed, skipped, templateName) |
| `call` | `recording_played` (callId; logged when playback is opened), `call_log_deleted`, `recording_deleted`. The target is the customer when the call's number belongs to one. |
| `admin` | `employee_created`, `employee_updated` (fields: name, phone, email, notifyTeamMessages), `role_changed` (from, to), `manager_changed` (from, to), `team_detached` (count, employees, reason), `settings_saved` (section, keys), `settings_imported` (keys), `template_cache_refreshed` (count), `auto_replies_changed` / `quick_messages_changed` (change), `template_images_changed` (change, template) |

Not logged on purpose: reads (opening a chat or a customer, viewing calls or analytics), heartbeats, polling, failed requests for unknown identifiers (so guessing addresses adds nothing), recording-retention deletions and delivery receipts.

**Last active.** `employee_activity_summary` holds one row per employee, written at most once every five minutes from any authenticated phone or web request (`touchEmployeeActivity`); `GET /v1/admin/employees` items carry it as `lastActiveAt`.

**Reading it.** `GET /v1/admin/activity` (admin only) takes `employeeId` (an employee id, or `admin` / `system`; an employee's id also finds what administrators did to them), `category`, `action`, `channel`, `customerId`, `from` / `to` (IST calendar days, inclusive), `q` (literal match on actor, target label and the action's words), `includeCustomerMessages` (default `false`), `cursor` and `limit` (default 50, max 200), newest first, and answers `{items, nextCursor}`. `GET /v1/admin/activity/export` takes the same filters and returns up to 5000 rows as CSV (`X-Activity-Truncated: true` when there were more); cells that a spreadsheet would run as formulas are prefixed with `'`, and the address and browser appear on sign-in rows only.

**Retention.** The daily job deletes rows older than `activity.retentionDays` (settings section `activity`, `PUT /v1/admin/settings/activity {"retentionDays": 0..3650 | null}`; default 90, `0` keeps everything), shown on the Config page under **Activity log**.

**Backfill.** The migration also fills the table from earlier data, bounded to 90 days and with `details.backfilled = true`: outbound messages with `sent_by_employee_id`, `customers.created_by_employee_id`, web sessions, phone enrolments and revocations, and each employee's last-seen time. Row ids are derived from the source row (`act_bf_*`) and inserted with `INSERT OR IGNORE`, so running those statements again changes nothing. Messages sent by an administrator or automatically before this release cannot be reconstructed.

## Android app download

The server stores and serves no APK. Employees install the **Community Android build**, published in the open-source GitHub releases, and **Config → Android app** gives the admin the link and QR code to hand out.

- `GET /download` (public, always on, no settings): a small self-contained page with a strict CSP and no script. It names the community build, links to the releases page, and gives four install steps (including allowing **Install unknown apps** for the browser). It says the employer provides the enrollment QR or code separately.
- `GET`/`HEAD /download/linekeep.apk` (public): a `302` to `https://github.com/<repo>/releases/latest/download/linekeep.apk` with `Cache-Control: no-store`. The latest release must therefore carry an asset named `linekeep.apk`.
- `GET /v1/admin/app/qr.svg` (admin only): an SVG QR code encoding `<origin>/download`.
- The repository and asset name live in one place, `server/src/modules/app-download/community-build.ts` (`COMMUNITY_APK_REPO`, `COMMUNITY_APK_ASSET`). A fork that publishes its own APK changes them there; the page, the redirect and the Config page follow.
- Keep `/download*` outside the Cloudflare Access application (see [Cloudflare Access](#cloudflare-access)).

## Employee web app

Employees can use Linekeep in a browser at **`/app`** with the same limits as the Android app: their own customers (list, add, edit name and notes), their own WhatsApp chats (text, quick replies, templates, attachments), their own call analytics and call history, and listening to their own recordings. They see nothing of other employees, no settings, and cannot delete anything. The page and its API are public paths (employees are not in the Access policy), so they authenticate themselves.

**Managers in the web app.** An employee whose profile has `role: "manager"` also sees a **Manager** badge and a scope switch (All, Mine, Team, or one team member) in the header. The switch narrows Customers (`employeeId=me|team|<id>`), WhatsApp chats, Call analytics (`employeeIds=…`, plus a "By employee" table from `groupBy=employee`) and Call logs (which also get an Employee column and filter, and playback of the team's recordings). Customer rows and chat rows show the handlers and a Team tag, the customer drawer and the chat header offer **Hand over** / **Handled by** (a dialog with the manager and the team; handlers outside the team stay, `PUT /v1/web/customers/{id}/handlers`), and Add customer gets an **Assign to** select. Template and quick-reply placeholders name the customer's handler on the team (the manager when they handle it too). All of it is gated by the role in the page and enforced again by the server, and employees' pages are unchanged.

Setup is in **Config → Employee web access** (settings section `employeeWeb`: master switch `enabled` default off, `emailOtp` default on, `whatsappOtp` default off, `whatsappTemplate`). Migration `0020_employee_web.sql` adds `employees.email` (unique, case-insensitive), `web_sessions`, `web_login_codes` and `web_rate_counters`. Admins set an employee's email and phone number when creating or editing them (`email` and `phoneNumber` on `POST`/`PATCH /v1/admin/employees`; the email is lower-cased and answers `409 employee_email_exists` on a duplicate; a phone number already used by another **active** employee answers `409 employee_phone_exists`, checked only when a number is added or changed, so older shared numbers keep working and are flagged with `phoneShared: true`). Employee objects carry `email`, `webSessions` and `phoneShared`. `DELETE /v1/admin/employees/{id}/web-sessions` signs the employee out everywhere; deactivating an employee, or changing or clearing their email, does the same. A method is **usable** when its switch is on and its prerequisites are met (email: the Mailgun domain, key and From address; WhatsApp: access token, phone number ID, business account ID and a chosen, valid template). Web sign-in is **active** only when the master switch is on *and* at least one method is usable: otherwise `GET /v1/web/config` says `enabled:false`, every other `/v1/web/*` route answers `404 web_disabled` and existing sessions stop working. `PUT …/settings/employeeWeb` with `enabled:true` is refused with `400 no_sign_in_method` (the message says what is missing) when nothing is usable; to switch off the last usable method while access is on, send `enabled:false` in the same request. `GET /v1/admin/settings` reports for `employeeWeb` `methods`, `usable:{email, whatsapp}`, `active` and `prerequisites` per method (with `missing` names), and `GET /v1/admin/features` returns `employeeWeb` (active) and `employeeWebMethods`.

**Sign-in.** `POST /v1/web/auth/request` takes `{method:"email", email}` or `{method:"whatsapp", phone}` (any common way of writing the number; it is normalised like customer numbers). It always answers `202 {sent:true}` for a well-formed identifier while sign-in is active, whether or not it belongs to an employee: unknown addresses and numbers, numbers stored on no employee, on two active employees (ambiguous) or on an inactive employee, and numbers WhatsApp cannot deliver to all get the same answer and the same work (counters move, a code row is written, a decoy that can never be redeemed unless exactly one active employee matches), and delivery happens after the response. WhatsApp sign-in matches the last ten digits of the phone number the admin stored (`employees.phone_number`) and sends the code **only to that stored number**, never to what was typed. `POST /v1/web/auth/verify` takes `{method, email|phone, code}` and answers `200 {employee:{id,name,phoneNumber|null}, csrfToken, expiresAt}` plus the cookie, or a generic `401 invalid_code`; a code is bound to the method and identifier it was issued for. Codes are 6 digits from `crypto.getRandomValues` without modulo bias, stored as HMAC-SHA256 under a key derived (HKDF) from `TOKEN_HASH_SECRET`, valid 10 minutes, single use, compared in constant time and dead after 5 attempts (an attempt is spent atomically before the comparison); a new request replaces the previous code for that identifier. Limits: 30 seconds between requests per identifier, 5 per identifier and 30 per client IP (`CF-Connecting-IP`) per hour, answered `429 rate_limited` with `Retry-After`. Identifiers are stored only as keyed hashes. The email goes through the Mailgun account in Config (domain, key, From; no recipient list needed) with the subject "Your Linekeep sign-in code", the code and its lifetime, no links. WhatsApp uses an approved template through `sendOtpTemplate` in `src/modules/whatsapp/send.ts`: the body variable `otpParam` gets the code, `otherParams` are the employee's name or fixed text, and an AUTHENTICATION template also gets the code as the copy-code button parameter (`buttonParam`). Templates may be sent outside the 24-hour window. The sign-in message is not stored in `whatsapp_messages` (the recipient is an employee, not a customer) and delivery failures are logged only as a fixed reason. The code is never logged, stored or returned.

**Sentence for the code's variable.** By default the template variable chosen for the code (`otpParam`) receives only the six digits, so "Hello, {{1}} Thank you" renders as "Hello, 482913 Thank you". `whatsappTemplate` can instead carry `sentenceEnabled: true` and a `sentence` (for example `Your Linekeep sign-in code is {{code}}. It is valid for 10 minutes. Do not share it with anyone.`); the value sent for that variable is the sentence with every `{{code}}` replaced by the code. The sentence is trimmed and must be 1-200 characters on one line (no line breaks or tabs, no run of four or more spaces, because Meta rejects those in a template variable) and must contain `{{code}}`; otherwise the save is refused with `400 invalid_sentence` and a message saying why. Turning it off drops the stored sentence. The copy-code button of an authentication template (`buttonParam`) always gets the bare code. The sentence is not secret and `GET /v1/admin/settings` returns it; the code is never logged, stored or returned.

**Session.** Cookie `__Host-lk_session` (HttpOnly, Secure, SameSite=Strict, Path=/, no Domain), 12 hours in total and 2 hours idle (sliding, written at most once a minute). Only an HMAC of the cookie value is stored. `GET /v1/web/session` returns the sign-in body again; `POST /v1/web/auth/logout` ends it. `GET /v1/web/config` is public and says whether access is on and which methods are usable. Every change (POST/PUT/PATCH/DELETE) is refused with `403 csrf_invalid` unless it carries `X-Linekeep-CSRF: <csrfToken>` (an HMAC of the cookie value, so `GET /session` can return it again) and, when the browser sends `Origin` or `Sec-Fetch-Site`, comes from the same origin. A deactivated employee, a turned-off feature and an expired session all answer `401`/`404 web_disabled`; the feature flag and the employee's active state are checked in the same query as the session on every request.

**Data routes.** `/v1/web/*` mounts the same routers as `/v1/device/*` with the web session in place of the bearer token: `analytics`, `call-history`, `profile`, `customers` (list, `lookup`, create, `PATCH` name/notes, detail, `messages`), `whatsapp/{status,version,unread,chats,chats/{id}/read,quick-messages,templates,attachments,messages/{id}/media}` and `customers/{id}/messages`. Media and header-image URLs point at `/v1/web/...`. Attachments belong to the employee's web identity, which is separate from their phone. Not exposed: push token, uploads, call-log batch, anything administrative. Web-only additions: `GET /v1/web/customers/{id}/calls` (the employee's own calls with one of their customers, same items as `call-history`) and `GET /v1/web/call-history/{callId}/recording` → `{url, expiresAt, contentType}`, a five-minute signed link to `/v1/web/call-history/{callId}/recording/audio` (byte ranges supported; it also needs the session cookie and the call must be the caller's own, with a completed, undeleted recording; anything else is `404`).

**Local development.** With `ENVIRONMENT=development`, a `localhost` host and `WEB_OTP_DEV_LOG=true` in `.dev.vars`, a requested code is also printed to the Worker console (`web_sign_in_code_dev`) so you can sign in without Mailgun. It is ignored on any deployed Worker. Email still has to be "ready" for the method to be offered: dummy `MAILGUN_API_KEY` and `MAILGUN_DOMAIN` values are enough, and the real send then fails quietly.

`GET /app` and `/app/*` serve the single-page app (`src/web-app`) with a strict CSP and `Cache-Control: no-store`; the HTML needs no sign-in.

## Customers and WhatsApp conversations

Migration `0008_customers.sql` adds `customers`, `customer_employees` and `whatsapp_messages`, plus two virtual columns and a partial index on `call_logs` so a customer's calls are found by phone key without scanning history. See the [customer contract](../handoffs/SERVER_AGENT.md#customers-whatsapp-chats-and-employee-assignment--2026-10-06-approved-by-project-owner). Phone numbers are normalized once (`normalizePhone` in `src/data/customers.ts`) to `+<digits>`; the last 10 digits (`phone_key`) are unique among non-archived customers and are compared with the last 10 digits of `call_logs.remote_number`. Only common separators (space, `+ - ( ) . /`) are stripped from call-log numbers; numbers containing other characters or fewer than 10 digits never match.

Administrators manage customers and read chats and calls at `/v1/admin/customers*` and `/v1/admin/whatsapp/chats`. An enrolled device reads only customers assigned to its **current** employee at `/v1/device/customers*` and `/v1/device/whatsapp/*`; other customers return `404`. `message.sentAt` and all other timestamps are UTC RFC 3339 strings. Historical conversations are inserted by an operator (`whatsapp_messages.source = 'import'`); no endpoint imports them. There is no WhatsApp transport yet: `GET /v1/device/whatsapp/status` returns `{"canSend": false}` and `POST /v1/device/customers/{id}/messages` validates the request and returns `503 WHATSAPP_NOT_CONFIGURED` without storing anything. Customer phone numbers and message bodies are personal data; do not log them or copy them into fixtures.

### Outbound files and template header images

Migration `0019_whatsapp_outbound_media.sql` adds `whatsapp_attachments` (staged files) and an index on `whatsapp_messages.media_key`. `POST /v1/{admin,device}/whatsapp/attachments?fileName=` takes the raw file (`Content-Type` = the file's type; JPEG, PNG, WebP, MP4, PDF, Word/Excel/PowerPoint, plain text, CSV; at most 16 MB, images at most 5 MB, the first bytes must match the declared type) and stores it in the private bucket under `whatsapp-outbound/`. A device can use only its own uploads and administrators only theirs; at most 200 uploads per sender per day. Unsent uploads are deleted by the daily cron after two days. Sending (`{type:"media", attachmentId, caption?}`, or a template with `headerAttachmentId`) uploads the file to Meta (`POST /{phone-number-id}/media`) and reuses the returned media id for 25 days (Meta keeps it 30; it is only reused for the same phone number id, and replaced once if Meta rejects it). WebP uploads are accepted but cannot be sent as images, because WhatsApp only takes JPEG and PNG there.

Templates with an image, video or document header are sendable. Their default header file is chosen in **Config → WhatsApp Business → Template images** (stored in `app_settings` as `whatsapp.templateImage.<template name>`); a sender may override it per message. Without either the send fails with `400 template_header_image_required`. `GET /v1/{admin,device}/whatsapp/templates` lists `headerFormat`, `headerImageConfigured` and `headerImageUrl`. Free text and files are refused with `409 window_closed` when the customer has not written in the last 24 hours (also when Meta reports its re-engagement error); templates are always allowed. Customer detail and chat list items carry `whatsappWindow: {open, expiresAt}`.

### Bulk add customers

`POST /v1/admin/customers/bulk` (administrator; needs the `customers` feature, and the `whatsapp` feature plus a working send configuration only when `intro` is given). Body: `{rows: [{name, phone, notes?, employeeId?}], intro?: {template: {name, language, params: [{source: "customer_name" | "handler_name" | "handler_phone"} | {value: "fixed text"}], headerAttachmentId?}}}`. Response: `{requestId, results: [{index, status: "created" | "exists" | "invalid" | "duplicate_in_request", customerId?, reason?, assigned?, intro?: {status: "sent" | "failed" | "skipped", reason?}}]}`, one entry per row in order.

- **Limit: 25 rows per request** (`400 too_many_rows` otherwise, nothing is created). Workers Free allows 50 external subrequests (`fetch`) per invocation, and the intro messages and the push run inside it. A full request makes at most one template lookup, one header upload (or, when Meta rejects a cached media id, one re-upload and up to three re-sends), one send per row and the push calls; pushes only get what is left of a budget of 45 calls. D1 and R2 calls are a separate, larger allowance. The dashboard sends bigger lists in batches of 25 and allows 2000 rows in total. The body may be at most 256 KB.
- Phones use the same normaliser and last-ten-digits key as the unique index, which covers live (non-archived) customers only. A number that already exists is reported as `exists` with its `customerId` and is never modified, assigned or messaged, so sending the same rows again is harmless. A repeated number inside one request is `duplicate_in_request`. A row with a missing or over-long name, an invalid phone or an `employeeId` that is not an active employee is `invalid` with a fixed `reason` (`name_required`, `name_too_long`, `invalid_phone`, `notes_too_long`, `invalid_employee`); other rows are not affected.
- New rows are written in one D1 batch (one transaction): customer with `source = 'Bulk import'` and no `created_by`, plus the assignment to `employeeId`. `assigned` says whether the assignment was stored.
- **Intro message** (only for `created` rows, templates ignore the 24-hour window): the template, its parameters and the header file are checked before anything is created, so a bad template, an unknown override file or a Meta outage fails the whole request (`404`, `400`, `502`, `503`) with nothing created. Each row's parameters are filled from the row (`handler_*` use its employee; a row without one is `skipped` with `no_handler`, an empty value is `skipped` with `missing_value`). A media-header template uses `headerAttachmentId`, else the template's default file from Config, else every created row is `failed` with `header_image_required` without calling Meta again. Sends run three at a time and each is stored like a normal template send (`whatsapp_messages`, `status` sent or failed). A failed send leaves the customer created and reports a fixed reason (`send_failed`, `not_on_whatsapp`, `rate_limited`); Meta's own error text is never returned or logged.
- **Push**: each employee who received new customers gets at most one push per request (`type: "assigned"`, the first new customer's id and name, title "New customers assigned", body "N new customers"; a single customer is announced as a normal assignment), and none for rows that already existed.
- Nothing about rows (names, phones, notes) is logged.

### Default handler for new WhatsApp customers

`whatsapp.defaultHandlerId` (Config > WhatsApp Business > Default handler for new customers; `PUT /v1/admin/settings/whatsapp {defaultHandlerId: id|null}`, `400 invalid_employee` unless the employee exists and is active; `GET` returns `whatsapp.defaultHandler: {id, name, active} | null`). When an inbound message comes from a number with no live customer, the customer is created already assigned to that employee in the same D1 batch as the customer row; an inactive or missing employee leaves it unassigned and the message is still stored. Existing customers are never touched. The assignment is logged as `customer.assigned` (system actor, `{employees, auto: true, source: "default_handler"}`). No separate "New customer assigned" push is sent: the employee gets the normal new-message push for that first message (one push per employee; both would replace each other on the phone anyway).

### Template cache

Every template read (the picker lists, sends, bulk intros, auto replies, employee-web sign-in validation, header-image validation) goes through `getTemplates` in `src/whatsapp/template-cache.ts`. It keeps the full approved list (paged by cursor, never filtered by name) as JSON in `app_settings` under `cache.whatsappTemplates`, keyed by WABA id and Graph version and valid for 7 days, plus a 60 s per-isolate copy. A fresh copy needs no Meta call; an expired or missing copy is refetched (single flight per isolate), and if Meta fails a stale copy is still served. A template missing from a fresh copy triggers one refresh, then none for 5 minutes. A send failing with Meta code 132000, 132001, 132007, 132012, 132015 or 132016 marks the copy out of date so the next use refetches. `POST /v1/admin/whatsapp/templates/refresh` forces a fetch (once per 10 s, `429 rate_limited` otherwise); `GET /v1/admin/whatsapp/templates/cache` reports `{count, fetchedAt, expiresAt, stale}` without calling Meta. Template list responses (admin, device, web) also carry `cache: {fetchedAt, expiresAt}`. Keys starting with `cache.` are never loaded into the settings snapshot, listed or written by the settings API.

## Push notifications

Employees' phones are notified (Firebase Cloud Messaging, free) when a customer assigned to them sends a WhatsApp message and when a customer is newly assigned to them. Removing someone from a customer never notifies. The push carries only the customer's name, never the message text. Push is off until the service account and client config exist. The easiest way is **Config → Push** in the dashboard; the commands below set them as Worker secrets instead, which act as the fallback:

1. Create a Firebase project (console.firebase.google.com, Google Analytics off) and register an Android app with package `com.microorganics.calltracker`.
2. In Google Cloud IAM for that project create a service account with the **Firebase Cloud Messaging API Admin** role and download a JSON key.
3. Set the secrets per environment (values are read from stdin, never put in a file in the repository):

```sh
npx wrangler secret put FCM_SERVICE_ACCOUNT --env dev < service-account.json
echo '{"apiKey":"<current_key>","appId":"<mobilesdk_app_id>","projectId":"<project_id>","senderId":"<project_number>"}' \
  | npx wrangler secret put FIREBASE_CLIENT_CONFIG --env dev
```

`FCM_SERVICE_ACCOUNT` is the sending key and must stay private. `FIREBASE_CLIENT_CONFIG` holds the four public identifiers from `google-services.json` (`client[0].api_key[0].current_key`, `client[0].client_info.mobilesdk_app_id`, `project_info.project_id`, `project_info.project_number`). Enrolled phones fetch it from `GET /v1/device/push-config`, so one generic APK serves every deployment. Optionally restrict the Firebase API key to the app's package and signing certificate in Google Cloud, Credentials.

## Call analytics

`GET /v1/admin/analytics/calls?from=YYYY-MM-DD&to=YYYY-MM-DD&employeeIds=a,b&callTypes=incoming,outgoing` returns read-only aggregates (totals, previous-period totals for deltas, per-employee metrics, by type, by IST day, weekday-by-hour and duration buckets) over undeleted `call_logs`; see the [analytics contract](../handoffs/SERVER_AGENT.md#call-analytics--2026-10-18-approved-by-project-owner). Days are Asia/Kolkata (IST), both ends inclusive; the default window is the last 7 days ending today in IST and the maximum is 366 days. Malformed or unknown query values, duplicate keys, `from` after `to` and windows over 366 days return `400 INVALID_REQUEST`; a well-formed employee ID that matches nothing returns zeros. The implementation (`src/data/analytics.ts`) sends five statements in one D1 batch, computes IST day/hour/weekday in SQL from the UTC `started_at` text and fills zero days, all 168 weekday-hour cells and all eight call types in code. Responses contain no phone numbers, contact names or recording URLs. Run `node --test src/modules/analytics/analytics.test.mjs` for focused checks.

## Daily email summaries

The same Worker can send a Mailgun email **once a day at a time you choose in IST (default 6 PM)**. Cloudflare cron triggers are fixed in `wrangler.jsonc`, so the cron runs **every 30 minutes** (`*/30 * * * *`) and the Worker sends only when the current IST half-hour slot equals the configured send time (rounded down to :00 or :30) and that day has not been sent yet; the last date and status are kept in `app_settings`. Changing the time in **Config → Daily email** therefore needs no redeploy. No GitHub Actions runner or additional public endpoint is required. Reporting is disabled by default in the public configuration template.

Each email covers calls **starting from midnight up to, but not including, the send time (6 PM by default) IST that day**, as uploaded when the job executes. This is a **today-so-far snapshot**, not a complete-day report: calls after the send time and uploads arriving after generation are not carried into tomorrow's email. Delayed execution uses the scheduled event's date, not the current execution date.

The HTML and plain-text report includes overall and per-employee totals, connected calls (logged duration greater than zero), calls without duration, distinct stored-number counts, total duration and all eight Android call types. Only undeleted call history is counted; audio never adds duplicate calls. Attribution uses each log's historical employee, including employees no longer assigned to the device. Unique-contact counts represent distinct stored number strings, not deduplicated people. Individual phone-number fields, raw call rows and recordings are not emailed. A no-call day still produces a zero-call report.

### Configure and enable delivery

Use your verified Mailgun sending domain and its matching API key. From `server/`, enter values at the prompts rather than putting credentials or recipient addresses in committed configuration:

```bash
npx wrangler secret put MAILGUN_API_KEY --env dev
npx wrangler secret put MAILGUN_DOMAIN --env dev
npx wrangler secret put EMAIL_IDS --env dev
```

`EMAIL_IDS` follows the reference GitHub workflow's configuration: either `admin@example.com,manager@example.com` or `["admin@example.com","manager@example.com"]`. Supply plain email addresses, at most 1,000. Invalid lists fail without sending a partial report. Recipients appear together in the email's **To** field and can see each other's addresses. GitHub cannot return an existing repository secret's value; copy it from your own configuration or set a new approved list.

The recipients, Mailgun settings, send time and on/off switch can be entered in **Config → Daily email** (stored values win over the secrets above). To enable it from configuration instead, set these on the intended environment only in your ignored `wrangler.jsonc` (an install that still has the old once-a-day cron `30 12 * * *` keeps sending at 18:00 IST, but cannot change the time without the new cron):

```jsonc
"triggers": { "crons": ["*/30 * * * *"] },
"vars": {
  // Retain the environment's existing variables.
  "CALL_SUMMARY_ENABLED": "true",
  "CALL_SUMMARY_SEND_TIME": "18:00" // IST, optional
}
```

The sender is `Linekeep Reports <postmaster@MAILGUN_DOMAIN>`. Optionally set `MAILGUN_FROM_EMAIL` to another authorized sender and `MAILGUN_REGION` to `eu` for an EU domain; the default region is `us`. These can also be provisioned as Worker secrets. Do not copy Cratio login credentials or an unused email provider's key into Linekeep.

Deploy with `npm run deploy` for development. Configure production separately with `--env production` only when intended; enabling development does not enable production. Cron changes can take up to 15 minutes to propagate. To stop sending, turn it off in Config or set `CALL_SUMMARY_ENABLED` to `"false"` and redeploy. Set that environment's `triggers.crons` to `[]` as well if you want to remove its scheduled invocations.

### Verification and delivery status

Run `node --test src/reporting/call-summary.test.mjs` for isolated D1, timezone/cutoff, deletion/attribution, escaping/privacy and native Worker scheduling regressions. Email requests are intercepted; this command sends no real email. Local development remains disabled by default in `.dev.vars.example`. Enabling it with real credentials can send real messages.

Cloudflare **Cron Events** shows scheduled invocation outcomes. A successful request means **Mailgun accepted** the message, not that an inbox received it; inspect Mailgun delivery/bounce events for delivery status. Provider rejection fails the invocation without logging its response body, recipients or credentials. Redirects are not followed, and email open/click tracking is disabled. There is one send request per invocation, not an exactly-once delivery guarantee; manually replaying an event can resend its report.

## Recording retention

Optional and **off by default**. Set `RECORDING_RETENTION_DAYS` (a whole number of days, for example `"30"`) in the Worker's `vars` and the Worker also deletes recording audio older than that, once per IST day (at the first half-hourly cron tick after midnight; the last run is kept in `app_settings`): the R2 object is removed first, then the call is tombstoned as `deleted`, exactly like **Delete recording** (playback then reports it as deleted). Age is the call's recorded time, falling back to when the server received it, so old recordings uploaded late from a phone are removed too. Call logs, customers and chats are never touched. Each run handles at most 750 recordings and logs only counts; a remainder continues the next day, and an R2 failure leaves rows untouched so they retry. The same setting also makes the server **refuse to accept** audio whose recorded time is already older than the period: `POST /v1/device/uploads/prepare` answers `409`, stores nothing, and the Android app treats that as permanent ("stopped for this source") so it does not retry or waste uploads; audio without a recorded time is treated as new. Unset, `0` or a non-number disables both the job and the refusal. Pending and failed uploads are not touched. Test it on a development environment first (`node --test src/retention/recordings.test.mjs`).

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
