# Android agent brief

## Objective

Build the stock-Samsung uploader under `android/`. First prove that an ordinary app can read native Samsung call recordings on representative phones. Then implement onboarding, transparent background operation, local deduplication, and the frozen HTTP contract.

## Ownership

You may edit `android/**` and the status section at the bottom of this file. Treat `docs/API_CONTRACT.md` as read-only. Do not edit `server/**`.

## Step 1: recording-access spike

Create the smallest installable Kotlin application that:

1. Requests only audio/media or user-selected-folder access.
2. Lists candidate recordings with URI, name, MIME type, bytes, duration, created/modified time, and relative path when available.
3. Opens and streams a selected recording.
4. Exports a redacted JSON sample of discovered metadata for contract testing.

Test on at least two representative Samsung devices. Record model, Android, One UI, region/CSC, SIM configuration, filename examples, path/URI behavior, MIME type, and whether access survives reboot.

Completion criterion: two devices expose readable recordings through MediaStore or a persisted Storage Access Framework grant. If this fails, stop after recording the evidence; do not add shell, root, accessibility, or hidden-API workarounds.

## Step 2: application shell

Implement:

- Kotlin Android app using one application module.
- Compose onboarding/settings UI.
- A retained launcher `activity-alias` that opens the settings activity.
- A non-exported settings activity reachable from notification and tile.
- An ongoing, plainly named Calltracker status notification.
- A Quick Settings tile that opens settings.

The notification exposes sync status, pending count, Sync now, and Settings. Sharing begins through the explicit Grant permissions flow; no in-app pause or per-feature switches remain. Android's permission, notification, force-stop, clear-data, and uninstall controls stay available.

Completion criterion: Calltracker remains named in the launcher and Android Settings, with working notification/tile navigation and an accurate permission checklist.

## Step 3: local pipeline

Implement modules for:

- Recording discovery.
- Conservative extraction of readable source metadata without filename-based call guesses.
- Stable fingerprinting.
- Room upload ledger.
- Event-triggered WorkManager synchronization, stable-file finalization checks, and periodic recovery/retries.
- Keystore-backed device-token storage.
- API client generated manually from the frozen contract.

Do not request contacts. Do not make `READ_CALL_LOG` a prerequisite. Represent unknown number, direction, or timestamp by omitting the field and setting an honest `matchStatus`.

Completion criterion: repeated scans create one ledger row per physical recording; offline work resumes; process death between upload and completion does not duplicate bytes or metadata.

## Step 4: integration

Connect to the development Worker:

1. Register with a single-use invitation.
2. Prepare an upload.
3. Stream the ContentResolver input directly to the signed URL.
4. Complete the upload.
5. Send heartbeat/status.

Completion criterion: a real Samsung recording reaches complete state and a second prepare with the same fingerprint returns the existing `callId`.

## Required tests

- Source-metadata extraction using captured redacted samples.
- Fingerprint stability.
- Upload-state transitions and retries.
- API serialization for every device endpoint.
- Launcher-alias state rules.
- Real-device incoming/outgoing, Bluetooth, speaker, dual-SIM if applicable, offline recovery, reboot, and duplicate scan.

Run only tests allowed by the repository's local-check policy.

## Deliverables

- Buildable source under `android/`.
- `android/README.md` with setup, supported devices, APK build/install, and test evidence.
- Redacted spike evidence under `android/docs/device-spike.md`.
- No production secrets or real recordings in the repository.

## Status

- Android version 0.7.0 (versionCode 9), branded Linekeep. Keep `com.microorganics.calltracker`, component identities, persisted keys and signing identity for upgrades. Room v3 adds only `recording_watches` through migration 2→3; migration 1→2 remains. Existing history, recording state and encrypted enrollment are preserved.
- The backend is no longer required at build time. `linekeep.apiBaseUrl` / `LINEKEEP_API_BASE_URL` / `apiBaseUrl` in ignored `android/linekeep.local.properties` are optional: when given they are validated as an HTTPS origin and become the default server (`BuildConfig.API_BASE_URL`, so existing dev installs upgrade seamlessly); otherwise it is `""` and the APK is generic. `ServerConfig` ("server-config" SharedPreferences) holds a saved origin that wins over the default, and `DeviceApi` reads it per request (`ServerNotSet` when none). Onboarding scans `linekeep://enroll?server=<origin>&code=<code>` with Google's code scanner (`play-services-code-scanner` 16.1.0, QR only, no camera permission), confirms the exact host in a dialog, saves the server and enrolls; Advanced → Connection allows fully manual URL + code entry. The server URL is read-only while enrolled. Parsing/validation (`ServerUrl.kt`) has JVM tests; camera scanning is unverified on a device.
- Home/Advanced, the original adaptive handset-ledger mark, one permission flow, actual granted checks, Sync now, named ongoing notification and Quick Settings remain. Sharing requires explicit acceptance and actual Android access; there are no hidden activation paths or permission workarounds.
- History and recording access remain independent. Cached call-log names require no contacts access; line metadata comes from the call's exact phone-account handle rather than the preferred SIM.
- Call-end signals and observers dispatch network-independent `DiscoveryWorker` capture, then separate network-constrained content work. The call-end receiver works with call-log access even without a recording folder. `RecordingDiscovery` persists per-call five-minute deadlines and bounded local checks; expired/ambiguous cases remain informational, and late recordings can resolve them. No discovery timeout cancels uploads. `RecoveryWorker` runs hourly and dispatches independent heartbeat work; ordinary content synchronization has no heartbeat prerequisite. Android can defer work; force-stop is respected.
- `RecordingBatch.kt` runs two structured-concurrency workers over a shared queue. `ContentSync` selects at most 12 distinct entries and supplies a 90-second start-work deadline. Existing transfers may finish after the deadline; unstarted entries remain durable. Each worker checks its own cancellation context. Recent-activity writes are synchronized; stable-file/hash checks remain intact.
- Fifteen JVM discovery/concurrency regressions and the debug build passed. API 36 runtime checks proved additive Room 2→3 migration, retained enrollment/watch state across restart, one-hour recovery scheduling, duplicate-call-end coalescing, local discovery without heartbeat, and automatic offline call capture with a 300,000 ms window. Android's real picker and Home screen were exercised for missing access and timeout notices. Temporary synthetic runtime instrumentation is excluded from the delivered APK. These checks do not establish physical Samsung timing or throughput.
- Earlier API 36 emulator checks covered upgrade, consent/access denial and grant, SAF selection, event-driven sync, Home/Advanced layouts and visible system entrypoints. Physical Samsung folder/installer support, dual-SIM behavior, Android 26–32 behavior, exact process-interruption recovery and long-running background scheduling need hardware verification. Use synthetic audio and dedicated test identities, and keep operational evidence/credentials outside the public repository.
