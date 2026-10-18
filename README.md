<p align="center">
  <img src="docs/assets/linekeep-logo.svg" width="96" height="96" alt="Linekeep handset and ledger logo">
</p>

# Linekeep

**Calls, kept together.**

Linekeep is a self-hosted Android call-history and recording workspace. The Android app shares permitted call history and existing recordings from a user-selected folder. A private web administrator panel brings them together for search, playback, download, and deletion.

**Linekeep does not record calls.** Samsung Phone creates the recordings. People using the app control installation, Android permissions, folder access, force-stop, and uninstall. Use it only with appropriate employee and caller notice, consent, and a lawful purpose.

## What it does

- Synchronizes available call history and readable recordings after explicit sharing consent, with durable local state and recovery after offline periods.
- Combines call logs and recordings in an administrator feed, including cached caller names and call-specific line information when available.
- Associates recordings conservatively: ambiguous audio stays visibly unlinked rather than being attached to the wrong call.
- Provides separate **Delete call log** and **Delete recording** actions.
- Uses one-use enrollment and recovery codes, individually revocable device credentials, and Cloudflare Access for administrators.
- Keeps a visible launcher, a named status notification, and a Quick Settings entry. There is no covert activation or permission evasion.

Android can defer background work; immediate delivery is not guaranteed. Linekeep does not capture VoIP calls, transcribe audio, read contacts, enforce installation, or prevent permission removal. It is not currently distributed through Google Play.

Physical Samsung folder access and manual-installer support for `READ_CALL_LOG` need verification on representative devices, Android/One UI versions, and regions before rollout. An emulator or successful build does not prove those capabilities.

## Architecture

```text
Android app                          Administrator browser
Kotlin · Compose                     Cloudflare Access
Room · WorkManager                           |
       |                                     |
       +------------ Cloudflare Worker ------+
                     TypeScript · Hono
                          /       \
                 D1 metadata     Private R2 audio
```

The app uses a device-specific bearer token. The Worker stores metadata in D1 and audio in private R2, with short-lived upload and playback capabilities. The app never receives account-level storage credentials. The backend and administrator UI deploy as one Worker.

## Quickstart

### 1. Run the backend locally

Prerequisites: Git, Node.js **22 or newer**, npm, and OpenSSL for the example secret-generation commands. Local development uses Wrangler's local D1/R2 emulation; no Cloudflare deployment is needed to use the browser and server locally.

```sh
git clone https://github.com/shubhsherl/linekeep.git
cd linekeep/server
npm ci
cp wrangler.example.jsonc wrangler.jsonc
cp .dev.vars.example .dev.vars
openssl rand -hex 32
openssl rand -hex 32
```

Put the **first** generated value in `TOKEN_HASH_SECRET` and the **second**, independent value in `LOCAL_ADMIN_SECRET` in `.dev.vars`. Do not reuse them or commit them. Keep `TOKEN_HASH_SECRET` stable once devices are enrolled: changing it invalidates existing hashed credentials and signed capabilities.

`server/wrangler.jsonc` and `server/.dev.vars` are private, ignored configuration. The example configuration is the public template; local npm scripts use your private copy.

```sh
npm run db:migrate:local
npm run dev
```

Open `http://localhost:8787/admin` and sign in with your `LOCAL_ADMIN_SECRET`. This bypass is restricted to local development and **never works on a remote deployment**.

### 2. Deploy your own development backend

Device integration requires an actual hosted **HTTPS** backend. From `server/`:

```sh
npx wrangler login
npx wrangler d1 create linekeep-dev
npx wrangler r2 bucket create linekeep-recordings-dev
```

Then configure your own resources:

1. Set the returned D1 database ID in `env.dev.d1_databases` in private `wrangler.jsonc`. If account selection is ambiguous, add your account ID as the top-level `account_id`. Use your own resource names if the example names are unavailable. Keep the `DB` and `RECORDINGS` binding names unchanged.
2. Configure a Cloudflare Access application and an explicit administrator allow policy for your Worker host's `/admin` and `/v1/admin` paths **and their descendants**. Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUDIENCE` in the private `dev` configuration. Do not put an Access browser challenge in front of `/v1/device`: those routes use device credentials.
3. Keep the R2 bucket private: do not enable a public `r2.dev` URL or public bucket custom domain.
4. Generate a separate stable remote hashing secret with `openssl rand -hex 32`, then paste it into Wrangler's secret prompt. Do not deploy `LOCAL_ADMIN_SECRET`.

```sh
npx wrangler secret put TOKEN_HASH_SECRET --env dev
npm run db:migrate:remote
npm run deploy
```

Use the Worker URL reported by deployment; `https://linekeep-api-dev.YOUR-SUBDOMAIN.workers.dev` below is a placeholder. Sign in through Access at that host's `/admin`. Verify anonymous administrator access is blocked and device endpoints are not redirected to an Access login before enrolling a phone.

The template also includes a `production` environment. Provision separate production D1/R2 resources, Access configuration, and secrets; do not point production at development data. See the [backend guide](server/README.md) for configuration, fixtures, deployment, and operational details.

### 3. Build the Android app

Prerequisites: **JDK 17**, **Android SDK 35**, and a configured Android SDK location (`ANDROID_HOME` or private `android/local.properties`). Android 8.0/API 26 or newer is required on the device.

From the repository root, replace the placeholder with **your deployed HTTPS origin**:

```sh
cd android
./gradlew --no-daemon \
  -Plinekeep.apiBaseUrl=https://linekeep-api-dev.YOUR-SUBDOMAIN.workers.dev \
  :app:assembleDebug
```

The debug APK is `android/app/build/outputs/apk/debug/app-debug.apk` relative to the repository root. With a device connected and ADB configured, install from `android/`:

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Backend URL configuration precedence is:

1. Gradle property `linekeep.apiBaseUrl`.
2. Environment variable `LINEKEEP_API_BASE_URL`.
3. Key `apiBaseUrl` in ignored `android/linekeep.local.properties`.

A missing URL, a non-HTTPS URL, or a URL that is not an origin fails the build. There is no default private deployment URL and no editable backend URL in the app. Build against the same backend you intend to administer.

Current Android version: **0.5.0** (`versionCode` **6**). Call-end/folder events drive synchronization, recording discovery is bounded to five minutes, and independent hourly recovery/heartbeat handles missed work. Android may defer execution. The application ID remains `com.microorganics.calltracker` for upgrade compatibility; it is not a credential. See the [Android guide](android/README.md) for installation, permissions, folder selection, and device checks.

### 4. Enroll and sync

1. In the administrator UI, create an employee and issue a single-use enrollment code. Share it privately with the intended user.
2. Open Linekeep on the phone and enter the code. Read the sharing disclosure and confirm the applicable consent and retention requirements.
3. Tap **Grant permissions** and select the recordings folder through Android's folder picker. Check the granted-access indicators on Home.
4. Use **Sync now**, then find the available call history and recordings in the administrator UI. Android scheduling and stable-file checks may delay uploads.

`READ_CALL_LOG` is a [hard-restricted Android permission](https://developer.android.com/reference/android/Manifest.permission#READ_CALL_LOG). The installer must allowlist it before the user can grant it; manually opening an APK does not guarantee this support. Linekeep does not replace the dialer or bypass the restriction. Denied call-log access blocks history collection, not otherwise accessible recording uploads.

For a reinstall or cleared app data, use **Recover enrollment** on the existing device in the administrator UI. A recovery code retains the enrollment and history; redemption rotates the device credential and invalidates the previous installation. Permissions and folder access must be granted again.

## Retention and deletion

Choose and operate a retention policy before uploading real data. **Linekeep does not automatically enforce a retention schedule.** R2 lifecycle rules alone do not coordinate deletion with D1 metadata.

- **Delete call log** removes the history entry from the feed and leaves its recordings as unlinked audio.
- **Delete recording** removes the server's audio and leaves the call log. Previous playback capabilities no longer retrieve the deleted audio.
- Neither action deletes originals from the phone or copies someone already downloaded.
- Internal metadata/tombstones remain to prevent ordinary synchronization from restoring deleted entries and to preserve conservative matching. These actions are **not a full-data-erasure API**.

Define who may listen, how long data is kept, how backups and downloaded copies are handled, how erasure requests are fulfilled, and how access is revoked when someone leaves. Use the administrator UI/API for coordinated server deletion. See [backend retention guidance](server/README.md#retention-billing-and-rollback).

## Upgrading an existing installation

Linekeep is the new display name of Calltracker. Existing users must keep the **same backend, application ID, and signing key**. Install an update without uninstalling or clearing app data to preserve enrollment and queued uploads. A newly generated debug signing key cannot update an installation signed with a different key. Do not replace an existing deployment's private configuration with the public template or rotate its hashing secret as part of this rename.

## Documentation and contributing

- [Backend setup and administration](server/README.md)
- [Android build and device behavior](android/README.md)
- [Frozen v1 API contract](docs/API_CONTRACT.md) and [approved additive contracts](handoffs/SERVER_AGENT.md#approved-employee-and-enrollment-extension)
- [Implementation handoff and ownership](docs/HANDOFF.md)
- [Contributing](CONTRIBUTING.md)
- [Private security reporting](SECURITY.md)

Linekeep is available under the [MIT License](LICENSE).
