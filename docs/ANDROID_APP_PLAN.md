# Android uploader plan

## Purpose

The Android app does not record calls. Samsung Phone performs native call recording; Linekeep discovers completed recording files, associates them with call-log entries, and uploads them reliably.

## Supported MVP environment

- Samsung Galaxy phones confirmed by the feasibility spike.
- Android versions represented in the employee fleet.
- Samsung Phone native automatic call recording.
- Cellular calls only.
- Privately distributed signed APK.

Maintain an explicit tested-device table once the spike begins:

| Model | Android | One UI | Region/CSC | Dual SIM | Recording readable | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | TBD | TBD | Populate during spike |

## User experience

### First launch

1. Explain what the app reads and uploads.
2. Ask the employee to acknowledge the company recording policy.
3. Show illustrated instructions to enable Samsung automatic recording for all calls.
4. Request audio/folder and notification permissions in context.
5. Ask for the employee invitation code or registration code.
6. Register the installation and run the first scan.
7. Show Ready only after the app can read the recording collection and expose a reliable settings entry.

### Settings screen and launcher visibility

Keep one settings screen with:

- Recording configuration reminder.
- Permission status.
- Last scan time.
- Last successful upload time.
- Pending and failed counts.
- Wi-Fi-only toggle.
- Sync now button.
- A short list of recent upload results.

The launcher alias is visible during onboarding. After onboarding, registration, notification permission, and recording-folder access all succeed, the app may disable only the launcher alias. The app remains visible under Android Settings and exposes the settings screen through an ongoing notification and a Quick Settings tile. Restore the launcher alias whenever those access paths are unavailable.

## Components

```text
MainActivity / Compose UI
          |
          +-- PermissionAndSetupChecker
          +-- LauncherAliasController
          +-- StatusNotification
          +-- CalltrackerTileService
          +-- SyncRepository
                    |
                    +-- RecordingScanner (MediaStore)
                    +-- RecordingMetadataParser
                    +-- LocalLedger (Room)
                    +-- UploadApi
                    +-- UploadWorker (WorkManager)
```

## Recording discovery

Query `MediaStore.Audio.Media` rather than traversing filesystem paths. Capture at least:

- Content URI.
- Display name.
- MIME type.
- Relative path when available.
- Size.
- Date added and date modified.
- Duration when available.

The spike should identify filters that are stable on supported Samsung firmware. Possible signals include the relative directory, filename prefix, MIME type, and the time the object appeared. Treat filenames as hints rather than the only source of truth.

Use the ContentResolver URI to stream the upload. Do not copy the complete recording into app-private storage unless a retry requirement makes it necessary.

## Recording metadata

The MVP does not require `READ_CALL_LOG`. Derive only metadata supported by the selected Samsung recording and MediaStore:

- Phone number.
- Direction when encoded reliably.
- Recording timestamp.
- Duration.
- Display name and content type.

Classify the source honestly:

1. `filename` when parsed from a proven filename convention.
2. `media_metadata` when supplied by MediaStore/audio metadata.
3. `unmatched` when the value cannot be supported.

Omit unknown number, direction, and timestamp fields. A future enhanced mode may add call-log matching only after an approved installer path is proven.

## Stable identity and deduplication

Create a local fingerprint without reading the whole file where possible:

```text
SHA-256(device_id | content_uri | size | modified_at | duration)
```

Send the fingerprint as the idempotency key. The server must reject or return the existing call for the same device and fingerprint.

Do not use the phone number as an identity key.

## Local state

Use a small Room table:

```text
recording_uploads
- id
- content_uri
- fingerprint
- discovered_at
- call_started_at
- call_duration_seconds
- remote_number
- direction
- state
- server_call_id
- attempt_count
- last_error
- uploaded_at
```

Suggested states:

```text
DISCOVERED -> PREPARING -> UPLOADING -> COMPLETING -> UPLOADED
      |             |            |             |
      +-------------+------------+-------------+--> RETRYABLE_FAILURE
                                                   PERMANENT_FAILURE
```

State changes must be persisted before network work so process death cannot create duplicate uploads.

## Background behavior

Use unique periodic WorkManager work and a manual one-time work request.

- Scan after installation and on the periodic schedule.
- Require network access for upload work.
- Respect the Wi-Fi-only setting with an unmetered-network constraint.
- Use exponential backoff.
- Upload oldest pending recordings first.
- Limit concurrent uploads to protect battery and bandwidth.
- Rescan a lookback window, such as seven days, because a prior scan may have been interrupted.

Android does not guarantee exact background execution times. The goal is eventual upload, not immediate call-end interception.

## Device authentication

An employee enters a short-lived invitation code. The server exchanges it for:

- A random device ID.
- A long random device token shown only once.

Store the token using Android Keystore-backed encrypted preferences. Send it as a bearer token over HTTPS. The server stores only a hash and can revoke one device without affecting others.

Never embed an R2 secret, Cloudflare account token, or shared company API key in the APK.

## Upload protocol

1. `POST /v1/device/uploads/prepare` with fingerprint, content type, byte size, and call metadata.
2. Receive the call ID, object key, and short-lived presigned `PUT` URL.
3. Stream the ContentResolver URI directly to that URL.
4. Capture the returned ETag when available.
5. `POST /v1/device/uploads/{callId}/complete` with ETag and observed byte size.
6. Mark the local row uploaded only after the server confirms that the R2 object exists.

If prepare returns an existing completed record for the fingerprint, mark the local row uploaded without uploading again.

## Permissions and disclosure

Request only permissions proven necessary by the spike. Likely capabilities include audio-media or user-selected-folder access, notifications on newer Android versions, and network access. Do not make the hard-restricted call-log permission part of the MVP.

The onboarding disclosure should plainly state:

- The app reads the selected Samsung call-recording collection.
- It uploads Samsung call recordings and metadata available from those files.
- Who can access them.
- The retention period.
- How to report a problem.

Do not request contacts unless showing contact names is an explicit requirement. A phone number is sufficient for the first version.

## Failure handling

| Failure | Behavior |
| --- | --- |
| Offline or timeout | Retry with backoff |
| Presigned URL expired | Prepare again, then retry |
| Permission removed | Stop scanning and show a clear action on the home screen |
| Source file removed | Mark permanent failure and show it locally |
| Server rejects token | Stop uploads and request re-registration |
| Duplicate fingerprint | Reuse the existing server record |
| Metadata cannot be matched | Upload as unmatched for admin review |
| R2 upload succeeds but completion fails | Retry completion before uploading bytes again |

## Verification

Test sequentially on real supported phones:

- Incoming and outgoing calls.
- Saved and unsaved numbers.
- Long and short calls.
- Rejected and missed calls, which should not produce recordings.
- Bluetooth and speaker calls.
- Dual-SIM calls if used.
- Offline call followed by reconnection.
- App process killed between upload and completion.
- Device reboot with pending work.
- Duplicate scan of the same recording.
- Filename containing unusual characters.

Avoid claiming Wi-Fi calling or VoIP support.
