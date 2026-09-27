# MVP build plan

## Outcome

The first usable version proves this loop on real Samsung phones:

1. Samsung Phone automatically records a completed cellular call.
2. Linekeep finds the recording and derives the metadata supported by its filename and media entry.
3. The app uploads both when connectivity is available.
4. The call appears in a private browser panel and plays successfully.

The fastest path is to resolve device access first, then build Android and Cloudflare in parallel against a small written contract.

## Build-from-scratch decision

Linekeep is a new implementation. Do not fork or copy CallSync or use its FTP/MSSQL architecture. The Android discovery, metadata extraction, local state, upload protocol, Cloudflare schema, API, and administrator panel described here are the source of truth.

Using maintained general-purpose dependencies such as AndroidX, Room, WorkManager, OkHttp/Ktor, Hono, and Cloudflare SDKs is expected. "From scratch" means owning the Linekeep product logic and architecture, not rewriting platform libraries.

## Assumptions

- Employees use Samsung models and regional firmware that support automatic call recording.
- Employees voluntarily enable automatic recording and grant the app permissions.
- Wi-Fi calls and third-party VoIP calls are excluded.
- The app is distributed as a signed APK rather than through Google Play.
- There is one administrator.
- Recordings remain on the device after upload in the MVP.

## Phase 0: device feasibility spike

Target: half a day to one day.

Build a throwaway Android screen that lists recent audio items from `MediaStore`, including URI, display name, MIME type, size, creation time, duration, and relative path.

Test on at least two representative employee phones:

1. Enable Samsung Phone > Settings > Record calls > Auto record calls > All calls.
2. Make one incoming and one outgoing cellular call.
3. Test a normal handset call, a speaker call, and a Bluetooth call.
4. Verify that the spike can open and stream each recording.
5. Determine which timestamp, duration, direction, and remote-number values can be supported by the filename and media metadata alone.
6. Repeat after reboot and after the recording is several hours old.
7. Record the exact model, Android version, One UI version, SIM configuration, recording path, file type, and filename format.

Pass criteria:

- The app can discover and read recordings without broad all-files access.
- Each physical recording can be identified consistently without call-log access.
- Access continues after a reboot.

Stop criteria:

- Recordings are visible only inside Samsung Phone private storage.
- Required access depends on accessibility-service automation or screen scraping.
- Recording support differs across most employee devices.

If the spike fails, evaluate manual sharing, Samsung Knox enterprise APIs, or cloud telephony. Do not disguise microphone-only recording as a complete solution.

For a same-day pre-spike, [Round Sync](https://github.com/newhinton/Round-Sync) can copy a user-selected Samsung recording directory to an R2 test bucket. This proves file visibility and transfer, but not structured metadata extraction or a safe production credential model. See [existing solutions](EXISTING_SOLUTIONS.md).

## Phase 1: vertical slice

Target: one to two days after the spike.

Deliver one hard-coded test employee and one phone end to end:

- Android finds one recording.
- Worker returns a presigned R2 `PUT` URL.
- Android uploads the file directly to R2.
- Android completes the upload with metadata.
- The web page lists that call and obtains a short-lived playback URL.

Use plain HTML for the first panel if that saves setup time. Visual polish is not part of this milestone.

## Phase 2: reliable Android uploader

Target: two to three days.

- Onboarding and permission checks.
- Employee/device registration.
- Local Room database for discovered files and upload state.
- `WorkManager` job with network constraints and exponential retry.
- Duplicate protection using a stable local fingerprint.
- Pending, uploading, uploaded, and failed states.
- User-visible status and a manual Sync now action.
- Token storage in Android Keystore-backed preferences.
- Wi-Fi-only default with an opt-in mobile-data setting.

## Phase 3: usable admin panel

Target: one to two days.

- Protect the admin routes with Cloudflare Access.
- Search by employee or remote phone number.
- Filter by date and call direction.
- Paginate newest-first.
- Stream or play audio using an expiring URL.
- Download and delete a recording.
- Show calls whose metadata exists but whose upload failed.

## Phase 4: pilot

Target: three to five working days of observation.

Install on two or three employee devices. Compare the Samsung Phone call history with the admin panel daily.

Measure:

- Eligible calls on the phone.
- Recordings discovered.
- Recordings uploaded.
- Median time from call end to availability.
- Duplicate uploads.
- Incorrect recording-to-call matches.
- Battery and mobile-data use.

Suggested acceptance target:

- At least 95% of eligible cellular calls available within 15 minutes when the device has connectivity.
- No duplicate records.
- No incorrect employee assignment.
- Less than 1% incorrect call-to-audio matches during the pilot.

## Fast implementation choices

### Android

- Kotlin.
- A single-activity Jetpack Compose UI.
- `MediaStore` for recording discovery.
- `CallLog.Calls` for call metadata.
- Room for the local upload ledger.
- WorkManager for background work.
- Retrofit/OkHttp or Ktor Client for the small API.
- Android Keystore-backed secret storage.

Avoid dependency injection frameworks, multiple modules, account systems, and elaborate navigation in the MVP.

### Cloudflare

- TypeScript Worker.
- Hono or a minimal Worker router.
- D1 for relational metadata.
- R2 for private audio objects.
- Worker static assets or Pages for the panel.
- Cloudflare Access restricted to the administrator's email.
- Presigned R2 URLs for direct upload; short-lived Worker-controlled URLs for playback.

Keep the Worker and admin UI in one deployable project unless the frontend build becomes a constraint.

## Work that can proceed in parallel

After the spike fixes the recording metadata shape:

- Android: discovery, metadata extraction, upload state machine, and API client.
- Server: schema, registration, upload lifecycle, and playback authorization.
- Admin UI: list/filter/player using fixture JSON, then swap to the real API.

Agree on `DeviceRegistration`, `PrepareUpload`, and `CompleteUpload` JSON before parallel work begins.

## Initial deployment checklist

- Create a Cloudflare account and a private R2 bucket.
- Create the D1 database and apply migrations.
- Deploy the Worker and static admin panel.
- Put `/admin/*` behind Cloudflare Access.
- Set Worker secrets and never commit them.
- Configure an R2 lifecycle rule for the agreed retention period before production.
- Build a signed release APK.
- Install it on pilot phones and complete onboarding.
- Confirm that the R2 bucket has no public development URL.
- Confirm delete removes both the R2 object and D1 record.

## Definition of done

The MVP is done when multiple pilot employees can install the app themselves, recordings upload without manual file selection, the administrator can find and play them, failures retry automatically, and the pilot metrics meet the acceptance target.
