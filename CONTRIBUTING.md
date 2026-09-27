# Contributing to Linekeep

Small, focused contributions are welcome. Explain the user-visible problem and keep unrelated refactoring out of a fix. Discuss changes to enrollment, authentication, consent, deletion, or the device/server contract before implementing them.

Report security vulnerabilities through [private security reporting](SECURITY.md), not public issues.

## Set up a development environment

Follow the [README quickstart](README.md#quickstart) for local Worker/D1/R2 setup and the Android build. The backend needs Node.js 22 or newer; Android needs JDK 17 and Android SDK 35. A hosted HTTPS backend is required for device integration, but the local administrator UI works without deployment.

Copy `server/wrangler.example.jsonc` to private `server/wrangler.jsonc` and `server/.dev.vars.example` to private `server/.dev.vars`. Generate independent random values of at least 32 bytes for `TOKEN_HASH_SECRET` and `LOCAL_ADMIN_SECRET`. Never commit the private copies. Android builds require your own HTTPS origin through `-Plinekeep.apiBaseUrl`, `LINEKEEP_API_BASE_URL`, or ignored `android/linekeep.local.properties` (`apiBaseUrl`).

Before changing behavior, read the relevant [Android guide](android/README.md) or [backend guide](server/README.md). The [v1 API contract](docs/API_CONTRACT.md) is frozen; discuss contract changes and record an approved extension rather than silently rewriting it. Existing additive behavior is documented in the [server handoff](handoffs/SERVER_AGENT.md#approved-employee-and-enrollment-extension). Agent contributors should also follow [AGENTS.md](AGENTS.md) and the [ownership handoff](docs/HANDOFF.md).

## Check the behavior you change

Use focused checks, then exercise the actual changed flow. Describe what you ran and any unverified behavior in the pull request. Do not claim physical-device compatibility from an emulator or a successful build.

From `server/`, after `npm ci`, select the relevant existing regression files:

```sh
# Data and credential handling
node --test src/data/repositories.test.mjs src/security/credentials.test.mjs

# Enrollment, reassignment, and recovery
node --test src/modules/identity/identity.test.mjs

# Recording lifecycle and scoped upload/playback capabilities
node --test src/modules/recordings/capabilities.test.mjs src/modules/recordings/recordings.test.mjs

# Administrator API and authentication
node --test src/modules/admin-calls/admin-calls.test.mjs src/http/app.test.mjs

# Call history, association, and independent deletion
node --test src/modules/call-history/call-history.test.mjs
```

For Android recording-batch changes, from `android/`, supply a configured development backend origin and run the existing focused regression class:

```sh
./gradlew --no-daemon \
  -Plinekeep.apiBaseUrl=https://linekeep-api-dev.YOUR-SUBDOMAIN.workers.dev \
  :app:testDebugUnitTest \
  --tests com.microorganics.calltracker.RecordingBatchTest
```

Replace the example origin with your own. Other Android changes should be built and exercised on an emulator or an authorized test device as appropriate; use the [Android guide](android/README.md) for the setup and known permission restrictions.

For administrator UI or API changes, run the local backend and exercise the affected flow with synthetic data. `server/fixtures/synthetic.wav` is generated audio for upload/playback/deletion checks. For example, recording deletion should make the audio unavailable while preserving the call log; call-log deletion should preserve unlinked audio. Check enrollment recovery, authentication failures, and replay behavior when those boundaries change. Keep tests for meaningful observable regressions, not assertions about source text or incidental presentation.

## Consent, visibility, and compatibility

- Do not add covert activation, misleading app identity, hidden notifications, or permission evasion.
- Keep sharing consent explicit and denied permissions visible. Android permission revocation, force-stop, and uninstall remain user controls.
- Do not work around the installer restriction on `READ_CALL_LOG` or imply that manual APK installation always grants it.
- Preserve independent call-log/recording deletion and disclose retained metadata. Do not describe tombstone deletion as full erasure.
- Preserve the historical Android application ID `com.microorganics.calltracker` and enrollment compatibility. Existing installations require their original backend and signing key.
- Keep migrations compatible with existing data. Use new forward migrations rather than editing an already-applied migration; explain operational requirements in the pull request.

## Keep private data out of contributions

Use invented people, clearly synthetic phone metadata, and generated audio only. Do not attach real call recordings, call logs, employee/caller data, database exports, or screenshots containing them. Crop or redact diagnostic screenshots before sharing; prefer a fresh synthetic reproduction.

Never commit or paste credentials, invitation/recovery codes, device tokens, cookies, Access JWTs, signing keys/keystores, `.dev.vars`, private Wrangler configuration, local backend settings, backups, account IDs, resource UUIDs, administrator emails, private deployment hosts, or workstation paths. Review logs and command output as well as source changes. The retained Android application ID is a compatibility identifier, not a secret.

## Open a pull request

1. Make one coherent change and explain why it is needed.
2. Include reproduction steps for a bug and the observable result after the fix.
3. Update the relevant setup or behavior documentation when the change affects users.
4. List the focused checks and manual flows exercised, plus remaining limits.
5. Confirm the diff and attachments contain no secrets, personal data, or real recordings.

Contributions are made under the repository's [MIT License](LICENSE).
