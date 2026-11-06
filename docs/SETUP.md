# Linekeep setup guide

This guide takes you from nothing to a running, protected Linekeep backend and a phone that is enrolled with it. It uses your own Cloudflare account; there is no shared hosted service.

- [What you will need](#1-what-you-will-need)
- [Create a Cloudflare API token](#2-create-a-cloudflare-api-token)
- [Run the interactive setup](#3-run-the-interactive-setup)
  - [WhatsApp and push notifications](#whatsapp-and-push-notifications)
- [Sign in and create the first employee](#4-sign-in-and-create-the-first-employee)
- [Build and install the Android app](#5-build-and-install-the-android-app)
- [Enroll a phone](#6-enroll-a-phone)
- [Day-two operations](#7-day-two-operations)
- [Manual setup (without the script)](#8-manual-setup-without-the-script)
- [Troubleshooting](#9-troubleshooting)

Obtain employee and call-participant consent, and decide your retention policy, **before** collecting real recordings or call history. See [Retention and deletion](../README.md#retention-and-deletion).

## 1. What you will need

| Need | Why | Notes |
| --- | --- | --- |
| A Cloudflare account | Hosts the Worker, D1 database and private R2 bucket | Free plan works to start. R2 asks for a payment method even inside its free allowance. |
| Node.js 22 or newer, npm, Git | Runs the setup script and Wrangler | `node --version` must print v22 or higher. |
| A Cloudflare **API token** | Lets the script create everything for you | Created in step 2. |
| Zero Trust enabled (free, up to 50 users) | Protects the admin pages with Cloudflare Access | Enabled once in the dashboard under **Zero Trust**; the script can create the organization if you consent. |
| Admin email addresses | The people allowed into the admin | They sign in with a Cloudflare account, or with an emailed one-time PIN if you enable that option. |
| *Optional:* a Mailgun account and a verified sending domain | The daily email summary | Mailgun is billed by Mailgun. |
| *Optional:* a Meta Business app with WhatsApp, and a WhatsApp Business Account | WhatsApp Business in the admin and app | See [WhatsApp and push notifications](#whatsapp-and-push-notifications) for the full list. Meta bills template messages. |
| *Optional:* a Firebase project and a service-account key | Push notifications to employees' phones | Free. See [WhatsApp and push notifications](#whatsapp-and-push-notifications). |
| *For the Android app:* JDK 17 and Android SDK 35 | Building the APK | Only needed on the machine that builds the app. |

You do **not** need a domain name: the backend runs on a free `*.workers.dev` address.

## 2. Create a Cloudflare API token

The setup script talks to Cloudflare with a token that you control and can delete afterwards.

1. Open <https://dash.cloudflare.com/profile/api-tokens> and choose **Create Token**, then **Create Custom Token**.
2. Name it `linekeep-setup`.
3. Add these **Account** permissions. Choose only the ones for the features you plan to use:

   | Permission | Level | Needed for |
   | --- | --- | --- |
   | Workers Scripts | Edit | Always: deploying the Worker, its secrets (hashing, Mailgun, WhatsApp and push alike, all set with one `wrangler secret bulk`) and the cron trigger |
   | D1 | Edit | Always: the database |
   | Workers R2 Storage | Edit | Always: the private recordings bucket |
   | Account Settings | Read | Always: finding your account |
   | Access: Apps and Policies | Edit | Admin protection |
   | Access: Organizations, Identity Providers, and Groups | Edit | Admin protection, including the One-time PIN login option |

4. Under **Account Resources**, choose **Include**, then your single account. Do not choose all accounts.
5. Set a **TTL** (expiry) a day or two from now.
6. Choose **Continue to summary**, then **Create Token**, and copy the token. It is shown once.

Keep the token out of Git, chat and shell history. The script reads it from the `CLOUDFLARE_API_TOKEN` environment variable or a hidden prompt, and never stores it. **Delete the token in the dashboard when setup is done.**

## 3. Run the interactive setup

```sh
git clone https://github.com/shubhsherl/linekeep.git
cd linekeep/server
npm ci
npm run setup
```

> **Status:** the setup script is new. Its logic is unit-tested and `--dry-run` works offline, but it has not yet been exercised end to end against every kind of Cloudflare account. If a step fails, it stops without deleting anything and a re-run resumes; please open an issue with the (secret-free) output. The [manual steps](#8-manual-setup-without-the-script) always work.

Paste the token when asked (the input is hidden), or run it as `CLOUDFLARE_API_TOKEN=... npm run setup`. The script then:

1. **Checks prerequisites** (Node version, installed dependencies, network).
2. **Verifies your token** and, after you pick features, checks that it has the permissions those features need. If something is missing it tells you exactly which permission to add and stops before changing anything.
3. **Asks what you want:**
   - environment name (`production` for real data, `dev` for a trial), Worker name, database name, bucket name, maximum recording size;
   - **Admin protection with Cloudflare Access** (strongly recommended): admin emails, session length, and whether to add the One-time PIN login method;
   - **Daily email summary**: Mailgun domain, region, sender, recipients and send time (IST; default 6 PM). The cron runs every 30 minutes and the Worker sends at that time;
   - **Recording retention**: delete recording audio older than N days (call logs are kept);
   - **WhatsApp Business** and **Push notifications**: each prints what you must have prepared first and asks whether to set it up now. See [below](#whatsapp-and-push-notifications).

   Customers, call analytics and QR-code device setup are always included.
4. **Shows a plan and asks for confirmation.** `--dry-run` prints the plan without changing anything.
5. **Provisions and deploys:** a `workers.dev` subdomain, the D1 database, a private R2 bucket (never made public), the generated `server/wrangler.jsonc`, database migrations, secrets, the first deployment, then the Access application and policy, then a redeploy with the Access settings.
6. **Verifies** `/health`, that `/admin` redirects to your Access login, and that device endpoints answer 401 without a token. If you chose WhatsApp it then offers to register the webhook with Meta.
7. **Prints a summary:** your admin URL and Worker URL (the value phones use), what was created or reused, and the next steps.

It is safe to re-run: existing resources are reused, nothing is deleted, and an existing hashing secret is never replaced. Replacing an existing `server/wrangler.jsonc` asks first and keeps a timestamped backup.

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--dry-run` | Print the plan and configuration; no writes, no API calls |
| `--yes` | Accept defaults and skip the final confirmation |
| `--answers file.json` | Take answers from a JSON file (never the Cloudflare token, Mailgun key, WhatsApp token or app secret, or key contents) |
| `--env name` | Environment to configure, default `production` |
| `--help` | Show usage |

The hashing secret `TOKEN_HASH_SECRET` is generated for you and stored only in Cloudflare. **Never change it after phones are enrolled:** that invalidates every device credential and invitation.

### WhatsApp and push notifications

The values you give setup become Worker secrets. They keep working as the fallback, and **you can change them later in the dashboard's Config tab** (WhatsApp and Push pages) without running setup again. Customers and WhatsApp stay switched off until turned on in Config, except that an install configured here with WhatsApp secrets starts with them on.

Both are optional and can be added later by running `npm run setup` again (existing resources are reused). In the feature list they appear as **WhatsApp Business** and **Push notifications to employees' phones**. Setup prints the prerequisites below before it asks for any value and then asks **Set up WhatsApp now? (y/N)** (and the same for push), so you can still back out. With `--yes`, selecting the feature in the answers file counts as yes; `"whatsapp": { "setup": false }` or `"push": { "setup": false }` skips it.

**Prepare for WhatsApp Business** (Meta, not Cloudflare):

1. A Meta developer account and a Business app with the WhatsApp product (developers.facebook.com), connected to your Meta Business.
2. A WhatsApp Business Account (WABA) with a registered phone number. The number must not be active in the consumer WhatsApp app; a test number from the app dashboard works for trying it.
3. A system user token that never expires: Business Settings → Users → System users, assign the app and the WhatsApp account with full control, then generate a token with `whatsapp_business_management` and `whatsapp_business_messaging`.
4. From the app: the **App ID** and **App secret** (App settings → Basic), and the **WABA ID** and **Phone number ID** (WhatsApp → API Setup).
5. Before real customers can reach you: a Privacy policy URL, app icon and category on App settings → Basic, then switch the app to **Live mode**. Until it is Live, customers' messages reach the webhook only for people with a role on the app.
6. Message templates approved in WhatsApp Manager (needed to start conversations), and a payment method on the WABA for paid template messages.

**What setup asks for WhatsApp:** the access token (hidden), Phone number ID, WABA ID, App ID and App secret (hidden). Ids are 5-32 digits; the token and secret must be non-empty without spaces. The two secrets come from the `WHATSAPP_TOKEN` and `WHATSAPP_APP_SECRET` environment variables or the hidden prompts, **never from the answers file** (like `MAILGUN_API_KEY`); the ids can be in it:

```json
{
  "features": ["whatsapp", "push"],
  "whatsapp": { "phoneNumberId": "123456789", "wabaId": "987654321", "appId": "555555555", "registerWebhook": false },
  "push": { "serviceAccountFile": "~/keys/service-account.json", "googleServicesFile": "~/keys/google-services.json" }
}
```

It sets the Worker secrets `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WABA_ID`, `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN`. These go through the same `wrangler secret bulk` call as the Mailgun secrets, which the **Workers Scripts: Edit** permission already allows, so the [permission table](#2-create-a-cloudflare-api-token) does not change.

**The webhook verify token** is a random value that setup generates; you never type or see it, and setup never prints it. It is generated once: if `WHATSAPP_VERIFY_TOKEN` already exists it is kept. Meta compares it only while a webhook is being registered, and Cloudflare cannot return an existing secret's value.

**Registering the webhook.** After the deployment is verified setup asks **Register the webhook with Meta now?** If you accept, it makes these calls (`--dry-run` prints them with placeholders and makes none):

- `POST https://graph.facebook.com/v23.0/{app-id}/subscriptions` with `object=whatsapp_business_account`, `callback_url=<worker url>/v1/webhooks/whatsapp`, `verify_token`, `fields=messages` and `access_token={app-id}|{app-secret}`;
- `POST https://graph.facebook.com/v23.0/{waba-id}/subscribed_apps` with the system user token.

If a verify token already exists, registering needs a new value, so setup asks before replacing it (answers file: `"replaceVerifyToken": true`); otherwise it keeps it and tells you to register by hand. If you decline (answers file: `"registerWebhook": false`, the default under `--yes`), setup prints the exact callback URL and the manual steps: store a verify token of your choice with `npx wrangler secret put WHATSAPP_VERIFY_TOKEN --env <env>` and enter the same value in the Meta dashboard (WhatsApp → Configuration → Webhook), subscribing to `messages`. A failed registration does not undo the deployment; setup says so and prints the same instructions.

**Stays manual (setup cannot do or verify it):** Live mode and the app-review prerequisites, creating and getting templates approved, the WABA payment method, and registering or verifying the phone number. The final report lists them, marking the webhook done only if setup registered it.

**Prepare for push notifications** (Google):

1. A Firebase project with an Android app for the package `com.microorganics.calltracker` (download `google-services.json`).
2. A service account with the **Firebase Cloud Messaging API Admin** role and its JSON key (Google Cloud → IAM). See [Push notifications](../server/README.md#push-notifications).

**What setup asks for push:** the path to the service-account JSON (it must parse and contain `client_email`, `private_key` and `project_id`) and either the path to `google-services.json` or the four values `apiKey`, `appId`, `projectId`, `senderId`. Both files must come from the same Firebase project. It sets `FCM_SERVICE_ACCOUNT` (the key file's JSON, stored only in Cloudflare) and `FIREBASE_CLIENT_CONFIG` (the four public identifiers). File paths may be in the answers file; file contents are never printed or accepted inline. Phones fetch the Firebase settings from the server, so no new app build is needed. **Stays manual:** creating the Firebase project, the service account and its key, and optionally restricting the API key in Google Cloud.

## 4. Sign in and create the first employee

1. Open the admin URL the script printed (`https://<worker>.<subdomain>.workers.dev/admin`).
2. Sign in through Cloudflare Access with one of the allowed emails.
3. Open **Employees**, create an employee, then generate an invitation. The admin shows a **QR code** and a one-time code. Both are shown once and cleared when you dismiss them.

To let more people in later, add their emails to the Access policy (see [Day-two operations](#7-day-two-operations)).

## 5. Build and install the Android app

The app is generic: it has no server address built in. The QR code carries the server address and the one-time code.

```sh
cd android
./gradlew --no-daemon -Plinekeep.apiBaseUrl= :app:assembleDebug     # trial build
```

Prerequisites: JDK 17, Android SDK 35 (set `ANDROID_HOME`), Android 8.0+ on the phone. For a release build you distribute to staff, create and back up a signing key first; see [Release build](../android/README.md#release-build). Install with `adb install -r <apk>` or any file transfer.

### Hand the APK to your team from the admin

Instead of sending the file around, upload the release APK to the server and share a link:

1. In the admin open **Config → Android app**, choose the release APK (not a debug build), check the version name and click **Upload APK**. The file is kept in your private bucket; the newest three uploads are retained.
2. Turn on **Share with employees**. While it is on, anyone who has the link or QR code can download the APK without signing in. Turn it off when everyone has installed the app. The release APK holds no server address or secrets.
3. Show the QR code or send the link (`https://<worker>/download`). Employees open it on their phone, tap **Download**, allow their browser to **Install unknown apps**, and install. They then scan the enrollment QR from step 6.

The `/download` pages must be reachable without an Access login. The setup script protects only `/admin*` and `/v1/admin*`, so they are. If you created the Access application by hand for the whole hostname, narrow it to those four paths (see [Cloudflare Access](../server/README.md#cloudflare-access)); do not add `/download*` to it.

## 6. Enroll a phone

1. Open Linekeep and tap **Scan QR code** on Home, then scan the QR code from the admin. Confirm the server name shown.
2. Read the sharing disclosure, then tap **Grant permissions** and follow the prompts: phone and call-log access, notifications, the recordings folder, and **unrestricted background activity**.
3. Tap **Sync now**. The calls and recordings appear in the admin.

If scanning is unavailable, open **Advanced → Connection** and enter the server address and code by hand. `READ_CALL_LOG` is a restricted Android permission: your installer may need to allow it. See the [Android guide](../android/README.md).

## 7. Day-two operations

- **Add an admin:** Cloudflare Zero Trust → Access → Applications → your Linekeep application → Policies → add the email. If those people have no Cloudflare account, enable the One-time PIN login method under Zero Trust → Settings → Authentication.
- **Change WhatsApp, push or daily-email settings (recipients, send time, on/off):** open the dashboard's **Config** tab; each page has step-by-step instructions. Values saved there are encrypted in the database and override what setup stored as Worker secrets, which stay as the fallback (**Import from deployment** copies them over). Customers and WhatsApp are switched on in Config too.
- **Enable or change retention:** set `RECORDING_RETENTION_DAYS` in your private `wrangler.jsonc` and deploy. See [Recording retention](../server/README.md#recording-retention).
- **Recover a phone after reinstall:** use **Recover enrollment** on the existing device and issue a recovery code. If the app shows *Connection rejected*, it offers to remove the old connection so you can scan a new code.
- **Backups and deletion:** see [Retention, billing, and rollback](../server/README.md#retention-billing-and-rollback).

## 8. Manual setup (without the script)

If you prefer to run each step yourself, follow [Cloudflare deployment](../server/README.md#cloudflare-deployment): create the D1 database and R2 bucket, copy `wrangler.example.jsonc` to `wrangler.jsonc` and fill in your IDs, create the Access application and policy, set `TOKEN_HASH_SECRET`, apply migrations and deploy. The script automates exactly those steps.

## 9. Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| The script says a permission is missing | Edit the token in the dashboard and add the permission it names, then re-run. |
| `/admin` returns 401 | Access is not configured for that environment. Re-run setup with admin protection enabled. |
| The Access login only offers "Cloudflare" | Add the One-time PIN login method (see Day-two operations) or have the person create a free Cloudflare account with the same email. |
| A new admin is refused after signing in | Their email is not on the Access policy. |
| Phones get 401 from the server | The device was revoked or its credential replaced. Use the app's *Remove old connection and scan again*, with a new code from the admin. |
| Uploads only happen when the app is open | Android battery management. Grant **Unrestricted background activity** and remove the app from "sleeping apps". |
| `npm run setup` cannot find Wrangler | Run `npm ci` in `server/`. |

More: [backend guide](../server/README.md), [Android guide](../android/README.md), [API contracts](../handoffs/SERVER_AGENT.md).
