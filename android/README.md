# Linekeep Android

Linekeep shares permitted Android call history and existing recordings from a user-selected folder after explicit sharing consent. It does not record calls, read contacts, or delete local recordings or call history. The app opens on four bottom destinations (Customers, WhatsApp, Call analytics, Settings); **Settings → Setup** contains the access checklist and **Sync now**, and **Settings → Advanced** contains diagnostics and Android controls.

## Build and install

Requirements: Java 17, Android SDK platform 35 and build-tools 35.0.0, and Android 8.0+ (`minSdk 26`). Use the included Gradle wrapper. Dependencies require access to Google Maven, Maven Central and the Gradle distribution service.

No backend URL is baked in: the generic APK asks for the server at runtime (setup QR code, or **Advanced → Connection**). Deploy your own [HTTPS backend](../server/README.md) first. From `android/`:

```sh
./gradlew --no-daemon :app:assembleDebug
```

Set `JAVA_HOME` to your JDK 17 installation and `ANDROID_HOME` to your Android SDK if your development environment does not already configure them. The APK is `app/build/outputs/apk/debug/app-debug.apk`.

A build may optionally pre-seed a **default** server, which is how the dev APK works and how an existing install keeps its backend on upgrade. In precedence order:

1. Gradle property `-Plinekeep.apiBaseUrl=https://...`.
2. Environment variable `LINEKEEP_API_BASE_URL`.
3. `apiBaseUrl=https://...` in `android/linekeep.local.properties` (ignored by Git).

```sh
./gradlew --no-daemon \
  -Plinekeep.apiBaseUrl=https://linekeep-api-dev.YOUR-SUBDOMAIN.workers.dev \
  -Plinekeep.appLabelSuffix=Dev \
  :app:assembleDebug
```

With no value (or an empty `-Plinekeep.apiBaseUrl=`, which overrides `linekeep.local.properties`) `BuildConfig.API_BASE_URL` is `""` and the APK is generic. A server saved in the app always wins over the build default; when nothing is saved the build default is used.

The optional `linekeep.appLabelSuffix` property (also `LINEKEEP_APP_LABEL_SUFFIX` or `appLabelSuffix` in `linekeep.local.properties`) labels a build, for example **Linekeep (Dev)**; it does not change the application ID, so it upgrades the existing installation. **Advanced → Upload destination** shows the effective server (or **Not set**), enrollment ID and a partially hidden device credential so testers can see where data uploads.

A server URL, whether from the build, a QR code or the Advanced form, must be an **HTTPS origin** without credentials, a path, query or fragment. There is no bundled shared backend, API key or cleartext fallback. A malformed build value fails the build. End-to-end Android use requires a reachable trusted HTTPS endpoint.

Install from the repository root:

```sh
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.microorganics.calltracker/.Launcher
```

Version `0.7.0`, version code `9`. Application ID `com.microorganics.calltracker` is the historical compatibility identifier, not a credential. Namespace, components and persisted keys intentionally remain unchanged. For an existing installation, use the **same backend and signing key** and install over it without clearing app data; with no saved server the app keeps using the build default, so a dev APK upgrades seamlessly. Room upgrades add discovery state without replacing the existing history/upload ledger. Changing the backend does not migrate enrollment or stored recordings. A different backend needs its own enrollment.

Debug builds are for development. Before distributing a release, configure and privately retain your own release-signing key; never commit keystores or passwords. Do not distribute debug-signed builds as production releases.

### Release build

`./gradlew -Plinekeep.apiBaseUrl= -Plinekeep.appLabelSuffix= :app:assembleRelease` produces the generic production APK (`app/build/outputs/apk/release/`): no embedded server, plain "Linekeep" label, not debuggable. Signing reads `.private/release/signing.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`), or the file named by `-Plinekeep.signingProperties=`; without it the APK is unsigned. Create the key once with `keytool -genkeypair -keystore linekeep-release.jks -storetype PKCS12 -alias linekeep -keyalg RSA -keysize 4096 -validity 10950`, keep it and its passwords outside Git (the `.private/` folder is ignored) and **back it up**: Android only upgrades an app when the new APK uses the same key, so a lost key means every phone must uninstall and re-enroll. A phone running a debug-signed build must be uninstalled before a release-signed build can be installed.

Release builds are shrunk and optimised with R8 (`isMinifyEnabled`, `isShrinkResources`; rules in `app/proguard-rules.pro`, otherwise the libraries' own consumer rules). Test a release APK, not only the debug build, after changing dependencies or adding reflection. Keep `app/build/outputs/mapping/release/mapping.txt` of every shipped build if you want readable crash stack traces.

## Enrollment and reporting

1. An administrator creates an employee and generates a one-use invitation (or a recovery code for an existing enrollment) in the backend's **Employees** tab.
2. On **Settings → Setup**, tap **Scan QR code** (Google's code scanner; no camera permission is needed). The QR payload is `linekeep://enroll?server=<https origin>&code=<code>`; `server` is optional and defaults to the already-configured server. A QR carrying a server asks "Connect this phone to <host>?" before anything is saved or sent; **Connect** saves the server and exchanges the code for a per-installation bearer credential stored using Android Keystore-backed encryption. Other QR codes are rejected with "This QR code is not a Linekeep setup code." If scanning is unavailable, use the manual path: type the code on Setup (when a server is already set), or enter **Advanced → Connection → Server URL**, the setup code and **Connect**.
   The server receives this phone's bearer token, so the **server URL is locked while the phone is enrolled** (read-only in Advanced; a QR scan is ignored with "This phone is already connected. Reset the app data to connect to another server."). To move to another server, clear the app's data or reinstall, then connect with a new setup or recovery code.
3. Read the disclosure, confirm consent, then tap **Grant permissions**. The flow requests missing phone/notification/call-log permissions, folder access through Android's picker, and **Unrestricted background activity** (Android's battery-optimization exemption).
4. Select the actual folder where Samsung Phone saves recordings. Only this tree and its subfolders are read; Android-restricted folders remain inaccessible.
5. Granted sources sync independently. Denying call-log access does not block readable recordings. Setup displays actual grants; permanently denied permissions require Android Settings or a supported installer.
6. Use **Sync now**, or let event-driven/background work run. **Advanced → Recent activity** shows specific failures; folder inspection samples readable files without uploading them.

The enrollment ID is public, immutable and not an authentication secret. SIM numbers are unverified metadata, not credentials. Historical line identity comes from the exact call's phone account, not a default SIM. Unknown metadata stays unknown; contacts permission is not requested.

After reinstall or cleared app data, ask the administrator to issue a **recovery code for the existing enrollment**. It retains server history while rotating the bearer credential. Permissions and folder access must be granted again. An ordinary enrollment invitation creates a new enrollment instead. A lost or consumed invitation is not silently retried to create another identity.

## Permissions and visibility

`READ_CALL_LOG` is a [hard-restricted Android permission](https://developer.android.com/reference/android/Manifest.permission#READ_CALL_LOG). The installer must allowlist it before the user can grant it. Opening an APK manually does not guarantee support; an ADB-installed emulator is not proof for a particular manual installer or Samsung model.

Activity in the app is recorded for the employer. The backend keeps an activity log of what each employee does in Linekeep (sign-ins, syncs, customers added or edited, messages sent, recordings uploaded) with the time and the customer concerned, but never message text, notes or phone numbers; employees are told this at enrollment, and it is described in the [privacy policy](../docs/PRIVACY.md). Linekeep stays named in Android Settings and the launcher and exposes an ongoing status notification. Notification actions open Settings or request sync. Android 13+ can add **Linekeep settings** to Quick Settings from Advanced; older Android versions use the system tile editor. Permissions, force-stop, notification settings and uninstall remain under the user's control. There is no covert activation, permission-evasion mechanism, or accessibility/root workaround.

## Synchronization and recovery

- Folder scanning checkpoints progress in Room. WAV, MP3 and M4A/MP4 audio up to 100 MiB is inspected through `ContentResolver`; temporary files are skipped.
- A file must have matching content hashes in observations at least 30 seconds apart before upload. Its document identity/content hash determine the device-scoped fingerprint. All bytes are streamed, not loaded into memory.
- Each run selects at most 12 distinct recordings. Two workers share the queue so a large file does not block all smaller files. After a 90-second start-work budget, remaining files stay queued while in-flight transfers may finish.
- Preparation, successful PUT and completion state survive restarts. Repeated preparation reuses server identity; completed uploads are not resent. Permission changes, cancellation and authorization failures stop work rather than bypassing the checks.
- Call history uses an independent durable outbox. Optional cached names and call-specific line metadata do not require bulk contacts access. Server-side [association rules](../handoffs/SERVER_AGENT.md#samsung-recording-association--2026-09-27) use corroborated metadata; uncertain audio stays unlinked.
- Call-end signals and call-log/folder observers request **local discovery without a network constraint**. Call-log and call-end signals run at once; signals that only name MediaStore or the recording folder (photos, downloads and thumbnails also notify them) wait 8 seconds so a burst shares one run. Call history is checkpointed independently of recording discovery and in-flight uploads; missing folder access does not disable the permitted call-end receiver. Network-constrained workers upload the durable queues.
- Recent answered incoming/outgoing calls with positive duration get a persisted five-minute recording-discovery window. Repeated signals do not extend it; missed, rejected, zero-duration calls and old imports do not create ordinary windows. An explicitly observed call-end delayed by Android retains its original deadline and reports uncertainty rather than restarting the timer.
- During a window, local checks run approximately every 15 seconds when Android permits. A confirmed recording ends discovery without waiting for upload completion. Checks use conservative source metadata and Samsung filename evidence; absent or ambiguous metadata remains unconfirmed, not falsely linked. Without call-log permission, an observed answered-call end can track audio activity without claiming association.
- After the deadline, Setup, Advanced and the ongoing notification show **No recording confirmed within 5 minutes**. Frequent discovery checks stop; observers and hourly recovery can still find late audio and clear the notice. Missing folder permission has its own immediate status. The deadline never cancels a transfer or deletes a pending entry.
- A separate **hourly recovery** job requests local reconciliation, upload work and device heartbeat. Content synchronization never sends a heartbeat. Enrollment, explicit manual sync, access/setup and SIM changes may also request a device-status refresh. Heartbeat failure does not block local capture or already authenticated content work.
- Already discovered files retain stable-file finalization checks at approximately 35 and 120 seconds, independent upload continuation and network/429/server backoff. The discovery timeout is not an upload timeout. Doze, battery restrictions, quotas and provider behavior can delay execution; neither the five-minute notice nor hourly work is an exact alarm. Force-stop is respected.
- **Unrestricted background activity is required.** The ongoing notification does not keep the process alive; closed-app sync depends on WorkManager and content triggers, which Android and Samsung defer for optimized, restricted or "sleeping" apps. Setup lists it under **Sharing & access**, treats access as incomplete without it and explains how to fix it; Advanced reports the specific problem. Detection uses the battery-optimization exemption, the Restricted background setting and the Restricted standby bucket. Samsung's "Sleeping apps" list has no public API, so it is detected only through those effects. The requirement does not stop foreground or manual sync.
- **Rejected connection.** If the server answers 401 (device revoked, or its credential replaced by a recovery on a reinstall), Setup shows **Connection rejected** with **Remove old connection and scan again**. After a confirmation it deletes only the stored credential and scheduled work, keeps the server setting and returns to the Scan QR / code screen. It is offered only after a 401, never for a working connection, and nothing is re-enrolled automatically. A revoked device cannot be recovered, so the manager issues a normal invitation (a new device); a replaced credential needs a recovery code for the existing device.
- Uninstalling or clearing app data removes local credentials, grants and the upload ledger. It is not a recommended troubleshooting step for a queued backlog.

## Customers and Chats

The **Customers** and **Chats** tabs read the customers assigned to this phone's current employee and their stored WhatsApp conversations through the device bearer token (`GET /v1/device/customers`, `.../customers/{id}`, `.../customers/{id}/messages`, `.../whatsapp/chats`, `.../whatsapp/status`). Customers are searchable, lists page with a cursor and refresh by pulling down, and a customer opens a detail view with facts, an optional dial button (standard dialer; no call permission) and the thread. An unassigned customer returns 404 and is treated as no longer available; a 401 revokes the enrollment like any other device request.

- **Memory only.** Customer lists, facts and messages are never written to disk, Room or logs. They are dropped when the process ends, the enrolled employee changes, access is revoked or a conversation is closed. Message bodies are rendered as literal text; media thumbnails are held in memory only.
- **Media viewing and saving.** Images and stickers show as thumbnails (fetched with the device token from `/v1/device/whatsapp/messages/{id}/media`, at most 25 MB, decoded at the size the screen shows, kept in a memory cache of at most 16 MiB (one sixteenth of the heap limit on small phones) that Android's low-memory callbacks empty); tapping opens a full-screen viewer with Save (system file picker, no storage permission) and Share (cache file via a `FileProvider`), and video, audio and documents offer Save or Open.
- **Automatic refresh.** While the app is in the foreground (started, screen on) it polls `GET /v1/device/whatsapp/version` every 5 s with a conversation open and every 15 s otherwise, and refreshes only the visible chat list, the open conversation's newest page and the unread totals when it changes. While nothing changes the interval stretches (open conversation: after 30 s, 10 s then 20 s at most; otherwise after two quiet polls, 30 s then 60 s) and doubles up to 60 s after errors. A change, opening another screen or conversation, the refresh button, sending a message, returning to the app or a push received while the app is open brings it back to the base interval. It stops entirely when the app is not visible.
- **Unread badges.** Chats show a count badge and bold text for customer messages this employee has not read, and the **Chats** tab shows the number of unread chats. Read state is per employee and independent of the administrator: opening a loaded conversation calls `POST /v1/device/whatsapp/chats/{customerId}/read` (failures are ignored and retried on the next open or refresh), totals come from `GET /v1/device/whatsapp/unread`, and nothing is stored on the phone.
- **Sending is disabled until the server has a WhatsApp transport.** The composer checks `GET /v1/device/whatsapp/status` when a conversation opens. While `canSend` is `false` it stays disabled with "Sending WhatsApp messages from this app is not set up yet. Ask your manager." If the server later reports `canSend: true`, the app sends with a generated `clientMessageId` (reused when the same text is retried), shows a sending state and keeps the typed text on failure; a `503 WHATSAPP_NOT_CONFIGURED` response shows the same not-set-up message. No manifest permission was added.

## Navigation, call analytics and call logs

A Material 3 bottom bar holds four destinations, in this order: **Customers**, **WhatsApp** (with the unread-chats badge), **Call analytics** and **Settings**. An open conversation fills the screen with its own top bar and hides the bottom bar. A notification tap lands on WhatsApp (new message) or Customers (new assignment). The bar is hidden while the keyboard is open. Navigation icons are small vector drawables in `res/drawable`; Back, Refresh, Clear and similar actions are 48dp icon buttons with content descriptions.

- **Settings** has two top tabs: **Setup** (connection, sync card, Sharing & access checklist) and **Advanced** (diagnostics, Android controls, connection details).
- **Call analytics** has two top tabs. **Analytics** shows only the signed-in employee's numbers from `GET /v1/device/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD` (the server forces the employee from the device credential): date presets (Today, Yesterday, Last 7 days, Last 30 days, This month) or a custom range of up to 366 days, summary cards (total, connected, not connected, unique contacts, incoming, outgoing, missed, rejected, connect rate, average call length, talk time) with the change against the previous period, calls by type, calls per day (long ranges are grouped) and calls by hour, drawn with Compose Canvas (no chart library). **Call logs** pages the employee's own calls from `GET /v1/device/call-history` (cursor, 50 per page) with a call-type filter, a phone-number search and a refresh icon button; rows show the linked customer's name (only the employee's own customers are matched), the number, type, time, duration and whether a recording exists, never a playback link.
- **Call sync banner.** Both Call analytics tabs open with a card, **Call sync is not fully enabled**, whenever something the call sync needs is missing: sharing consent, call history, phone information, SIM numbers, status notifications, unrestricted background activity or the recordings folder. It uses the same checks as Settings > Setup. One button acts on the first fix needed: it opens Settings > Setup (sharing not accepted), shows the standard Android permission prompt (only for permissions Android will still ask for), opens Android app settings (permanently denied permissions, notifications, restricted background), or runs the existing battery-exemption or folder-picker step. Nothing is requested without a tap, the card re-checks when the app resumes and disappears once everything is granted. A phone that is not connected yet shows a hint to open Settings > Setup instead.
- Analytics days, presets and call times use **Asia/Kolkata (IST)** like the admin dashboard, because the server buckets days in IST.
- Like customers and chats, analytics and call logs are held in memory only and dropped when the enrolled employee changes.

## Push notifications

The phone can alert the employee when a customer assigned to them sends a WhatsApp message and when a customer is newly assigned (never on unassignment). Pushes are Firebase Cloud Messaging **data-only, high-priority** messages with `type` (`message` or `assigned`), `customerId`, `customerName`, `title` and `body`. The app builds the notification itself on the **Chats and assignments** channel; the tag is the customer ID, so a newer message for the same chat replaces the older one. Tapping it opens Linekeep's main screen directly on that customer's conversation (Chats tab for messages, Customers tab for assignments), so it works even when the launcher icon is hidden. A message for the conversation currently open in the foreground is not shown (live polling already displays it). Customer names appear in notifications; the lock screen hides them (private visibility). Home's **Sharing & access** card shows a one-line hint when notifications are off. On Android 13+ the existing **Grant permissions** flow requests the notification permission.

The token is stored in plain app preferences (it is not a secret) and sent with `PUT /v1/device/push-token` after enrollment, on every app start while enrolled (skipped when this exact token is already registered for this enrollment) and on token refresh. Failures are silent and retried on the next start. **Remove old connection and scan again** sends a best-effort `DELETE /v1/device/push-token`, deletes the local copy and invalidates the FCM token.

Push is configured from the server, so one generic APK serves every deployment. After enrollment and on every app start while enrolled and authorized, the app calls `GET /v1/device/push-config` with its device token. The server answers `{"requestId": "...", "push": {"apiKey", "appId", "projectId", "senderId"} | null}`; these four values are public client identifiers, not secrets. They are stored in plain app preferences and used to initialize FirebaseApp manually (no `google-services` plugin or JSON file), both at the next process start (so a killed app still receives pushes) and immediately when this process has no FirebaseApp yet, after which the token registration above runs in the same pass.

- Resolution order at start: stored server options, then the optional Gradle fallback below, else push is disabled (no registration, no crash).
- If the call fails, whatever is stored is kept. If the server answers `push: null` after options were stored, the app removes them, clears the registered FCM token locally and stops registering.
- If the server switches to a different Firebase project while FirebaseApp already runs with the old one, the new options are stored and take effect at the next process start without a crash.
- **Remove old connection and scan again** also clears the stored Firebase options.

### Optional build-time fallback for custom builds

A custom build can still bake the four values in. They are used only when the server has not supplied any. Supply them in precedence order: Gradle property `-P`, environment variable, then `android/local.properties` (ignored by Git). If any of them is empty, the fallback is off.

| Gradle property / `local.properties` key | Environment variable | `google-services.json` field | Firebase console |
| --- | --- | --- | --- |
| `linekeep.firebase.apiKey` | `LINEKEEP_FIREBASE_API_KEY` | `client[].api_key[].current_key` | Project settings → General → Your apps (Android) → Web API key |
| `linekeep.firebase.appId` | `LINEKEEP_FIREBASE_APP_ID` | `client[].client_info.mobilesdk_app_id` | Project settings → Your apps → App ID |
| `linekeep.firebase.projectId` | `LINEKEEP_FIREBASE_PROJECT_ID` | `project_info.project_id` | Project settings → Project ID |
| `linekeep.firebase.senderId` | `LINEKEEP_FIREBASE_SENDER_ID` | `project_info.project_number` | Project settings → Cloud Messaging → Sender ID (the project number) |

Register the Android app with package name `com.microorganics.calltracker` in the Firebase project, then pass the values, for example:

```sh
./gradlew --no-daemon \
  -Plinekeep.firebase.apiKey=AIza... -Plinekeep.firebase.appId=1:1234567890:android:abc123 \
  -Plinekeep.firebase.projectId=my-project -Plinekeep.firebase.senderId=1234567890 \
  :app:assembleDebug
```

The backend needs the matching Firebase project's service account to send. The values end up in `BuildConfig`.

## Credential handling

The invitation exists only in the setup UI/in-flight request. Enrollment and heartbeat data are stored as AES-GCM ciphertext under `noBackupFilesDir` using an application-private Android Keystore key and atomic writes. Backups/device transfer are excluded. Bearer tokens never appear in Compose state, WorkManager input, notifications or HTTP logs.

The private Room ledger stores synchronization metadata, not audio copies. Keep build configuration and signing material out of Git. See [SECURITY.md](../SECURITY.md) for private vulnerability reporting.

## Focused verification

For the discovery and concurrency regressions, use a reserved non-routable origin; they do not contact a backend:

```sh
./gradlew --no-daemon -Plinekeep.apiBaseUrl=https://linekeep.invalid \
  :app:testDebugUnitTest
```

The 15 regressions cover fixed and deferred deadlines, unanswered/old-call exclusion, independent simultaneous windows, ambiguity and late resolution, permission-denied activity, matching boundaries, the two-transfer ceiling, progress around a slow file, authorization cancellation and upload-budget resumption. API 36 emulator checks also exercised the additive Room 2→3 migration with retained history/audio state, encrypted enrollment and watch persistence across restart, one-hour WorkManager scheduling, duplicate call-end signals, and local discovery without a heartbeat. A real emulator call while Wi-Fi and mobile data were disabled automatically produced a queued call-log row and a 300,000 ms discovery window without a manual sync. Native Home verification used Android's actual folder picker and confirmed distinct missing-access and timeout notices. Synthetic fixtures and temporary instrumentation were isolated from the delivered APK.

Earlier API 36 emulator checks exercised enrollment, upgrade, permission denial/grant, SAF access, event-driven synchronization, status notification/tile, and Home/Advanced layouts. Hardware behavior still needs representative Samsung models, Android/One UI versions, regions, dual-SIM setups and installer validation. Long-running scheduling, offline recovery, exact process interruption and two-device Samsung recording-folder access remain rollout gates. Use only synthetic audio and dedicated test identities during verification.
