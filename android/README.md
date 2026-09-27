# Linekeep Android

Linekeep shares permitted Android call history and existing recordings from a user-selected folder after explicit sharing consent. It does not record calls, read contacts, or delete local recordings or call history. Home contains the access checklist and **Sync now**; **Advanced** contains diagnostics and Android controls.

## Build and install

Requirements: Java 17, Android SDK platform 35 and build-tools 35.0.0, and Android 8.0+ (`minSdk 26`). Use the included Gradle wrapper. Dependencies require access to Google Maven, Maven Central and the Gradle distribution service.

First deploy your own [HTTPS backend](../server/README.md). From `android/`:

```sh
./gradlew --no-daemon \
  -Plinekeep.apiBaseUrl=https://linekeep-api-dev.YOUR-SUBDOMAIN.workers.dev \
  :app:assembleDebug
```

Set `JAVA_HOME` to your JDK 17 installation and `ANDROID_HOME` to your Android SDK if your development environment does not already configure them. The APK is `app/build/outputs/apk/debug/app-debug.apk`.

The backend is selected at build time, in this precedence order:

1. Gradle property `-Plinekeep.apiBaseUrl=https://...`.
2. Environment variable `LINEKEEP_API_BASE_URL`.
3. `apiBaseUrl=https://...` in `android/linekeep.local.properties` (ignored by Git).

The value must be an **HTTPS origin** without credentials, a path, query or fragment. There is no bundled shared backend, API key or cleartext fallback. A missing/invalid URL fails the build. The local backend guide supports browser/API development without deployment; end-to-end Android use requires a reachable trusted HTTPS endpoint.

Install from the repository root:

```sh
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.microorganics.calltracker/.Launcher
```

Version `0.4.1`, version code `5`. Application ID `com.microorganics.calltracker` is the historical compatibility identifier, not a credential. Namespace, components and persisted keys intentionally remain unchanged. For an existing installation, use the **same backend and signing key** and install over it without clearing app data. Changing the backend does not migrate enrollment or stored recordings. A different backend needs its own enrollment.

Debug builds are for development. Before distributing a release, configure and privately retain your own release-signing key; never commit keystores or passwords. Do not distribute debug-signed builds as production releases.

## Enrollment and reporting

1. An administrator creates an employee and generates a one-use invitation in the backend's **Employees** tab.
2. Enter the invitation in Android setup. Registration exchanges it for a per-installation bearer credential stored using Android Keystore-backed encryption.
3. Read the disclosure, confirm consent, then tap **Grant permissions**. The flow requests missing phone/notification/call-log permissions and folder access through Android's picker.
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
- Content changes and permitted public call-end events request work. Finalization checks run after approximately 35 and 120 seconds; a 15-minute periodic job is a recovery fallback. Network/429/server failures back off. Doze, battery restrictions, expedited quota, connectivity and provider behavior affect timing. Force-stop is respected.
- Uninstalling or clearing app data removes local credentials, grants and the upload ledger. It is not a recommended troubleshooting step for a queued backlog.

## Credential handling

The invitation exists only in the setup UI/in-flight request. Enrollment and heartbeat data are stored as AES-GCM ciphertext under `noBackupFilesDir` using an application-private Android Keystore key and atomic writes. Backups/device transfer are excluded. Bearer tokens never appear in Compose state, WorkManager input, notifications or HTTP logs.

The private Room ledger stores synchronization metadata, not audio copies. Keep build configuration and signing material out of Git. See [SECURITY.md](../SECURITY.md) for private vulnerability reporting.

## Focused verification

For the concurrency regression tests, use a reserved non-routable origin; they do not contact a backend:

```sh
./gradlew --no-daemon -Plinekeep.apiBaseUrl=https://linekeep.invalid \
  :app:testDebugUnitTest --tests com.microorganics.calltracker.RecordingBatchTest
```

The four cases cover the two-transfer ceiling/exactly-once processing, progress around one slow file, cancellation of sibling work after authorization failure, and resumption after an expired work budget. A controlled loopback HTTP experiment with 12 × 256 KiB transfers and 120 ms response latency measured 1,549 ms serially and 765 ms concurrently with exact bytes. This is not a guaranteed physical-phone speedup.

Earlier API 36 emulator checks exercised enrollment, upgrade, permission denial/grant, SAF access, event-driven synchronization, status notification/tile, and Home/Advanced layouts. Hardware behavior still needs representative Samsung models, Android/One UI versions, regions, dual-SIM setups and installer validation. Long-running scheduling, offline recovery, exact process interruption and two-device Samsung recording-folder access remain rollout gates. Use only synthetic audio and dedicated test identities during verification.
