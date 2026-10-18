# Linekeep Android

Linekeep shares permitted Android call history and existing recordings from a user-selected folder after explicit sharing consent. It does not record calls, read contacts, or delete local recordings or call history. Home contains the access checklist and **Sync now**; **Advanced** contains diagnostics and Android controls.

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

## Enrollment and reporting

1. An administrator creates an employee and generates a one-use invitation (or a recovery code for an existing enrollment) in the backend's **Employees** tab.
2. On **Home**, tap **Scan QR code** (Google's code scanner; no camera permission is needed). The QR payload is `linekeep://enroll?server=<https origin>&code=<code>`; `server` is optional and defaults to the already-configured server. A QR carrying a server asks "Connect this phone to <host>?" before anything is saved or sent; **Connect** saves the server and exchanges the code for a per-installation bearer credential stored using Android Keystore-backed encryption. Other QR codes are rejected with "This QR code is not a Linekeep setup code." If scanning is unavailable, use the manual path: type the code on Home (when a server is already set), or enter **Advanced → Connection → Server URL**, the setup code and **Connect**.
   The server receives this phone's bearer token, so the **server URL is locked while the phone is enrolled** (read-only in Advanced; a QR scan is ignored with "This phone is already connected. Reset the app data to connect to another server."). To move to another server, clear the app's data or reinstall, then connect with a new setup or recovery code.
3. Read the disclosure, confirm consent, then tap **Grant permissions**. The flow requests missing phone/notification/call-log permissions, folder access through Android's picker, and **Unrestricted background activity** (Android's battery-optimization exemption).
4. Select the actual folder where Samsung Phone saves recordings. Only this tree and its subfolders are read; Android-restricted folders remain inaccessible.
5. Granted sources sync independently. Denying call-log access does not block readable recordings. Home displays actual grants; permanently denied permissions require Android Settings or a supported installer.
6. Use **Sync now**, or let event-driven/background work run. **Advanced → Recent activity** shows specific failures; folder inspection samples readable files without uploading them.

The enrollment ID is public, immutable and not an authentication secret. SIM numbers are unverified metadata, not credentials. Historical line identity comes from the exact call's phone account, not a default SIM. Unknown metadata stays unknown; contacts permission is not requested.

After reinstall or cleared app data, ask the administrator to issue a **recovery code for the existing enrollment**. It retains server history while rotating the bearer credential. Permissions and folder access must be granted again. An ordinary enrollment invitation creates a new enrollment instead. A lost or consumed invitation is not silently retried to create another identity.

## Permissions and visibility

`READ_CALL_LOG` is a [hard-restricted Android permission](https://developer.android.com/reference/android/Manifest.permission#READ_CALL_LOG). The installer must allowlist it before the user can grant it. Opening an APK manually does not guarantee support; an ADB-installed emulator is not proof for a particular manual installer or Samsung model.

Linekeep stays named in Android Settings and the launcher and exposes an ongoing status notification. Notification actions open Settings or request sync. Android 13+ can add **Linekeep settings** to Quick Settings from Advanced; older Android versions use the system tile editor. Permissions, force-stop, notification settings and uninstall remain under the user's control. There is no covert activation, permission-evasion mechanism, or accessibility/root workaround.

## Synchronization and recovery

- Folder scanning checkpoints progress in Room. WAV, MP3 and M4A/MP4 audio up to 100 MiB is inspected through `ContentResolver`; temporary files are skipped.
- A file must have matching content hashes in observations at least 30 seconds apart before upload. Its document identity/content hash determine the device-scoped fingerprint. All bytes are streamed, not loaded into memory.
- Each run selects at most 12 distinct recordings. Two workers share the queue so a large file does not block all smaller files. After a 90-second start-work budget, remaining files stay queued while in-flight transfers may finish.
- Preparation, successful PUT and completion state survive restarts. Repeated preparation reuses server identity; completed uploads are not resent. Permission changes, cancellation and authorization failures stop work rather than bypassing the checks.
- Call history uses an independent durable outbox. Optional cached names and call-specific line metadata do not require bulk contacts access. Server-side [association rules](../handoffs/SERVER_AGENT.md#samsung-recording-association--2026-09-27) use corroborated metadata; uncertain audio stays unlinked.
- Call-end signals and call-log/folder observers request **local discovery without a network constraint**. Call history is checkpointed independently of recording discovery and in-flight uploads; missing folder access does not disable the permitted call-end receiver. Network-constrained workers upload the durable queues.
- Recent answered incoming/outgoing calls with positive duration get a persisted five-minute recording-discovery window. Repeated signals do not extend it; missed, rejected, zero-duration calls and old imports do not create ordinary windows. An explicitly observed call-end delayed by Android retains its original deadline and reports uncertainty rather than restarting the timer.
- During a window, local checks run approximately every 15 seconds when Android permits. A confirmed recording ends discovery without waiting for upload completion. Checks use conservative source metadata and Samsung filename evidence; absent or ambiguous metadata remains unconfirmed, not falsely linked. Without call-log permission, an observed answered-call end can track audio activity without claiming association.
- After the deadline, Home, Advanced and the ongoing notification show **No recording confirmed within 5 minutes**. Frequent discovery checks stop; observers and hourly recovery can still find late audio and clear the notice. Missing folder permission has its own immediate status. The deadline never cancels a transfer or deletes a pending entry.
- A separate **hourly recovery** job requests local reconciliation, upload work and device heartbeat. Content synchronization never sends a heartbeat. Enrollment, explicit manual sync, access/setup and SIM changes may also request a device-status refresh. Heartbeat failure does not block local capture or already authenticated content work.
- Already discovered files retain stable-file finalization checks at approximately 35 and 120 seconds, independent upload continuation and network/429/server backoff. The discovery timeout is not an upload timeout. Doze, battery restrictions, quotas and provider behavior can delay execution; neither the five-minute notice nor hourly work is an exact alarm. Force-stop is respected.
- **Unrestricted background activity is required.** The ongoing notification does not keep the process alive; closed-app sync depends on WorkManager and content triggers, which Android and Samsung defer for optimized, restricted or "sleeping" apps. Home lists it under **Sharing & access**, treats access as incomplete without it and explains how to fix it; Advanced reports the specific problem. Detection uses the battery-optimization exemption, the Restricted background setting and the Restricted standby bucket. Samsung's "Sleeping apps" list has no public API, so it is detected only through those effects. The requirement does not stop foreground or manual sync.
- **Rejected connection.** If the server answers 401 (device revoked, or its credential replaced by a recovery on a reinstall), Home shows **Connection rejected** with **Remove old connection and scan again**. After a confirmation it deletes only the stored credential and scheduled work, keeps the server setting and returns to the Scan QR / code screen. It is offered only after a 401, never for a working connection, and nothing is re-enrolled automatically. A revoked device cannot be recovered, so the manager issues a normal invitation (a new device); a replaced credential needs a recovery code for the existing device.
- Uninstalling or clearing app data removes local credentials, grants and the upload ledger. It is not a recommended troubleshooting step for a queued backlog.

## Customers and Chats

The **Customers** and **Chats** tabs read the customers assigned to this phone's current employee and their stored WhatsApp conversations through the device bearer token (`GET /v1/device/customers`, `.../customers/{id}`, `.../customers/{id}/messages`, `.../whatsapp/chats`, `.../whatsapp/status`). Customers are searchable, lists page with a cursor and refresh by pulling down, and a customer opens a detail view with facts, an optional dial button (standard dialer; no call permission) and the thread. An unassigned customer returns 404 and is treated as no longer available; a 401 revokes the enrollment like any other device request.

- **Memory only.** Customer lists, facts and messages are never written to disk, Room or logs. They are dropped when the process ends, the enrolled employee changes, access is revoked or a conversation is closed. Message bodies are rendered as literal text; media is labelled, not downloaded.
- **Sending is disabled until the server has a WhatsApp transport.** The composer checks `GET /v1/device/whatsapp/status` when a conversation opens. While `canSend` is `false` it stays disabled with "Sending WhatsApp messages from this app is not set up yet. Ask your manager." If the server later reports `canSend: true`, the app sends with a generated `clientMessageId` (reused when the same text is retried), shows a sending state and keeps the typed text on failure; a `503 WHATSAPP_NOT_CONFIGURED` response shows the same not-set-up message. No manifest permission was added.

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
