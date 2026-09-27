# Implementation handoff

## Outcome

Two agents can implement the MVP concurrently and meet at a stable HTTP boundary:

- Android agent: prove Samsung recording access, then build the uploader under `android/`.
- Server agent: build the Cloudflare API, D1 schema, private R2 storage, and admin panel under `server/`.

The first integrated demo is complete when a real Samsung recording uploads from the app and can be played from the private admin page.

## Read order

Every implementation agent reads:

1. This document.
2. [API_CONTRACT.md](API_CONTRACT.md).
3. Its role brief in `handoffs/`.
4. Its detailed plan: [ANDROID_APP_PLAN.md](ANDROID_APP_PLAN.md) or [CLOUDFLARE_PLAN.md](CLOUDFLARE_PLAN.md).

The [existing-solutions report](EXISTING_SOLUTIONS.md) is background research, not implementation input.

## Fixed product decisions

- Clean implementation; no CallSync code or architecture.
- Samsung Phone records calls. Linekeep uploads existing recording files.
- Stock, unrooted Samsung devices.
- No uninstall or settings enforcement in version one.
- No Google Play release in version one.
- The initial metadata path does not require `READ_CALL_LOG`.
- A user selects or grants access to the Samsung recordings collection/folder.
- The launcher icon is present during onboarding and may be disabled afterward.
- A named ongoing notification and optional Quick Settings tile provide access after the launcher icon is disabled.
- If notification permission or folder access is missing, keep or restore the launcher icon.
- Every installation receives a distinct revocable device token.
- Audio is stored in a private R2 bucket; searchable metadata is stored in D1.
- Cloudflare Access protects production admin routes.
- No transcription, CRM, analytics, VoIP capture, or contacts permission in the MVP.

## Ownership

| Area | Owner | May edit |
| --- | --- | --- |
| Android application | Android agent | `android/**`, Android role brief status |
| Worker, D1, R2, admin UI | Server agent | `server/**`, server role brief status |
| HTTP contract | Project owner | `docs/API_CONTRACT.md` |
| Product decisions | Project owner | `docs/HANDOFF.md` and root README |

Agents do not edit each other's implementation directory. Contract mismatches are recorded as a short proposal in the relevant handoff file for reconciliation.

## Parallel sequence

```text
Android agent                         Server agent
-------------                         ------------
Recording-access spike                Scaffold Worker, D1, R2
Capture sample metadata               Implement contract with local resources
Build local upload ledger             Add fixture-backed admin page
Implement API client   <----------->  Publish development base URL
Upload a real recording ------------> Verify R2 object and D1 row
                                      Play it from admin page
```

The Android recording-access spike is the product gate. The server agent can work against fixtures while the spike runs, but broad rollout waits for the spike result.

## Shared integration fixtures

The server agent owns executable fixtures under `server/fixtures/` and must include:

- One registration request.
- One matched recording upload request.
- One filename-only/unmatched recording request.
- One completed call response.
- One paginated admin-list response.
- One standard error response.

The Android agent copies no fixture definitions into source code. Its contract tests load equivalent JSON from Android test resources and must preserve field names and nullability.

## Integration checkpoint

Before connecting a real phone:

1. Server agent publishes the development Worker URL and a single-use invitation code.
2. Android agent registers one emulator or test device.
3. Android uploads a small fixture audio file.
4. Server verifies the object before marking the call complete.
5. Admin page lists and plays the fixture.
6. Repeat with a real Samsung recording.

Completion criterion: the same `callId` survives prepare, audio upload, completion, list, and playback, and repeating prepare with the same fingerprint creates no duplicate.

## Escalation conditions

Stop and report evidence instead of inventing a workaround when:

- Samsung recordings are not readable through MediaStore or a user-selected folder.
- Samsung's filename and media metadata cannot provide a stable timestamp/duration identity.
- Browser playback does not support the discovered audio format.
- An API contract field is insufficient or ambiguous.
- A required Cloudflare feature needs account access or paid activation.

## MVP completion

- Two supported Samsung devices complete onboarding.
- The launcher icon can be removed after setup without removing settings access.
- The ongoing notification shows last sync, pending count, Sync now, Settings, and Pause.
- New readable recordings upload eventually after offline periods and reboots.
- Duplicate scans do not create duplicate server records.
- The private admin page filters, plays, downloads, and deletes recordings.
- Revoking one device token stops only that device.
- R2 remains private and playback access expires.

