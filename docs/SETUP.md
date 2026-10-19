# Linekeep setup guide

This guide takes you from nothing to a running, protected Linekeep backend and a phone that is enrolled with it. It uses your own Cloudflare account; there is no shared hosted service.

- [What you will need](#1-what-you-will-need)
- [Create a Cloudflare API token](#2-create-a-cloudflare-api-token)
- [Run the interactive setup](#3-run-the-interactive-setup)
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
| *For the Android app:* JDK 17 and Android SDK 35 | Building the APK | Only needed on the machine that builds the app. |

You do **not** need a domain name: the backend runs on a free `*.workers.dev` address.

## 2. Create a Cloudflare API token

The setup script talks to Cloudflare with a token that you control and can delete afterwards.

1. Open <https://dash.cloudflare.com/profile/api-tokens> and choose **Create Token**, then **Create Custom Token**.
2. Name it `linekeep-setup`.
3. Add these **Account** permissions. Choose only the ones for the features you plan to use:

   | Permission | Level | Needed for |
   | --- | --- | --- |
   | Workers Scripts | Edit | Always: deploying the Worker, secrets and the cron trigger |
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
   - **Daily email summary**: Mailgun domain, region, sender, recipients and send time (shown in IST; default 6 PM IST);
   - **Recording retention**: delete recording audio older than N days (call logs are kept).

   Customers, call analytics and QR-code device setup are always included.
4. **Shows a plan and asks for confirmation.** `--dry-run` prints the plan without changing anything.
5. **Provisions and deploys:** a `workers.dev` subdomain, the D1 database, a private R2 bucket (never made public), the generated `server/wrangler.jsonc`, database migrations, secrets, the first deployment, then the Access application and policy, then a redeploy with the Access settings.
6. **Verifies** `/health`, that `/admin` redirects to your Access login, and that device endpoints answer 401 without a token.
7. **Prints a summary:** your admin URL and Worker URL (the value phones use), what was created or reused, and the next steps.

It is safe to re-run: existing resources are reused, nothing is deleted, and an existing hashing secret is never replaced. Replacing an existing `server/wrangler.jsonc` asks first and keeps a timestamped backup.

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--dry-run` | Print the plan and configuration; no writes, no API calls |
| `--yes` | Accept defaults and skip the final confirmation |
| `--answers file.json` | Take answers from a JSON file (never the token or Mailgun key) |
| `--env name` | Environment to configure, default `production` |
| `--help` | Show usage |

The hashing secret `TOKEN_HASH_SECRET` is generated for you and stored only in Cloudflare. **Never change it after phones are enrolled:** that invalidates every device credential and invitation.

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

## 6. Enroll a phone

1. Open Linekeep and tap **Scan QR code** on Home, then scan the QR code from the admin. Confirm the server name shown.
2. Read the sharing disclosure, then tap **Grant permissions** and follow the prompts: phone and call-log access, notifications, the recordings folder, and **unrestricted background activity**.
3. Tap **Sync now**. The calls and recordings appear in the admin.

If scanning is unavailable, open **Advanced → Connection** and enter the server address and code by hand. `READ_CALL_LOG` is a restricted Android permission: your installer may need to allow it. See the [Android guide](../android/README.md).

## 7. Day-two operations

- **Add an admin:** Cloudflare Zero Trust → Access → Applications → your Linekeep application → Policies → add the email. If those people have no Cloudflare account, enable the One-time PIN login method under Zero Trust → Settings → Authentication.
- **Change daily-email recipients:** `npx wrangler secret put EMAIL_IDS --env <env>` with a comma-separated list.
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
