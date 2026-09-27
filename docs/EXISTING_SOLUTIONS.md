# Existing open-source solutions

Research date: 2026-09-22.

## Conclusion

There is no mature open-source project that cleanly provides all three required pieces on stock Samsung phones:

1. Reliable cellular call recording or access to Samsung's native recordings.
2. Automatic upload of recordings and call logs to a private server.
3. A central multi-employee web panel for search and playback.

Several projects solve one or two pieces, but none will be used as the Linekeep application foundation. Linekeep will be a clean implementation using maintained platform libraries. The projects below are recorded only to explain why they were rejected or where a temporary feasibility tool may save time.

## Comparison

| Project | Records calls | Uploads | Central panel | Root/shell needed | Fit |
| --- | --- | --- | --- | --- | --- |
| [CallSync](https://github.com/duadhruv/CallSync) | Uses Samsung/selected recording directory | MSSQL + FTP | In-app shared call list | No claim of root | Rejected: legacy project; do not use or copy |
| [CallVault](https://github.com/madkongo/CallVault) | Yes, including both sides | Google Drive backup | No company panel | Embedded ADB or Shizuku | Interesting fallback if native Samsung files are inaccessible |
| [ShizuCallRecorder](https://github.com/kitsumed/ShizuCallRecorder) | Yes | No | No | Shizuku/ADB shell | Fragile hidden-API fallback, not a simple employee install |
| [BCR](https://github.com/chenxiaolong/BCR) | Yes | Deliberately no network | No | Root or custom firmware | High-quality reference; disqualified for normal employee phones |
| [AndroidCallLogSync](https://github.com/MarkoBL/AndroidCallLogSync) | No | Call logs to arbitrary HTTP endpoint | No | No | Useful API/data-model reference only |
| [Round Sync](https://github.com/newhinton/Round-Sync) | No | Files to S3-compatible storage | Storage browser only | No | Fast recording-file pilot, but no call matching or safe provisioning |
| [Syncthing-Fork](https://github.com/researchxxl/syncthing-android) | No | Folder sync to another Syncthing node | No call panel | No | Self-hosted folder replication only |
| [OpDesk](https://github.com/Ibrahimgamal99/OpDesk) | Server-side through Asterisk | Server-side | Yes | Not applicable | Good only if calls move to VoIP/PBX |
| [Astradial](https://github.com/astradial/astradial) | Server-side through Asterisk/SIP | Server-side/local or cloud | Yes | Not applicable | Complete open-source VoIP alternative, not native SIM-call capture |

## Detailed assessment

### CallSync: explicitly rejected

CallSync describes a superficially similar workflow:

- The user selects the phone's recording directory.
- It automatically matches recordings to call details on Samsung One UI.
- It stores unsynced work locally.
- It sends call data to MSSQL and recordings over FTP.
- It can play recordings and search shared company call history.

It is not part of Linekeep. Do not fork it, copy its implementation, port its schema, or preserve its FTP/MSSQL protocol. Reasons include:

- It is a legacy project and does not represent current Android background-work, storage, or security practices.
- The repository is very small and shows only 19 commits and six stars at the research date.
- GitHub does not display a license for the repository. Public source is not automatically permission to copy, modify, or redistribute it.
- Direct MSSQL and FTP connectivity from employee phones is a dated and risky architecture.
- Its README recommends removing the app from battery optimization rather than using modern constrained background work.
- It has no Cloudflare/R2 support or browser administration panel.

It remains in this document solely as a rejected historical search result so future contributors do not rediscover it and assume it was overlooked.

Source: [CallSync repository](https://github.com/duadhruv/CallSync).

### CallVault: strongest free recorder fallback

CallVault is GPLv3-licensed and says it records both sides without root. It obtains shell-level access through an embedded ADB pairing flow or Shizuku. It provides automatic recording, local playback, search, optional on-device transcription, and Google Drive backup. Its README reports testing on a Galaxy S24 FE with One UI 8.5.

Why it is not the primary plan:

- It replaces Samsung's recorder instead of simply uploading Samsung recordings.
- The employee must grant shell-level capability through an ADB/Shizuku setup.
- Android or OEM updates can break hidden/internal API behavior.
- Its backup target is Google Drive, not a multi-employee R2 service.
- It has no central administrator panel.
- GPLv3 and its additional attribution/trademark terms must be reviewed before distributing a modified build.

Relevant capabilities when comparing behavior, without copying its implementation:

- Opus at 24 kbps for small recordings.
- Explicit failure notifications when recording or backup stops.
- BCR-compatible sidecar metadata.
- A folder chosen through Android's Storage Access Framework.

Sources: [CallVault repository](https://github.com/madkongo/CallVault) and [CallVault build/license section](https://github.com/madkongo/CallVault#building-from-source).

### ShizuCallRecorder: simpler but operationally awkward

ShizuCallRecorder is a GPLv3 non-root recorder for Android 11+ that uses Shizuku and Android shell permissions. It records both sides and emits BCR-compatible files.

Its own documentation warns that it uses hidden Android APIs, can break across Android/OEM updates, may start recording several seconds late, and can produce silence or one-sided audio on unsupported devices. Enabling ADB/Shizuku also creates employee setup and security concerns.

This is a useful fallback experiment if Samsung native recordings are inaccessible, not the default employee experience.

Sources: [ShizuCallRecorder README](https://github.com/kitsumed/ShizuCallRecorder/blob/main/README.md) and [configuration guide](https://github.com/kitsumed/ShizuCallRecorder/blob/main/docs/configuration.md).

### BCR: mature reference, but root is a hard blocker

BCR is a GPLv3 recorder with automatic recording, several codecs, output-directory selection, direct-boot support, metadata-rich filenames, and separate uplink/downlink support on some devices.

It explicitly requires root, installation as a system app, or custom firmware. It also intentionally has no Internet permission and will not implement cloud upload. Rooting employee phones would increase support and security risk and is outside this MVP.

Its filename template and recording metadata are useful references for our matching and object naming.

Source: [BCR repository](https://github.com/chenxiaolong/BCR).

### AndroidCallLogSync: reusable reference for call-log delivery

AndroidCallLogSync is a small GPLv3 Android app that posts call-log entries to a configurable endpoint with a device token. Its JSON includes the Android call ID, number, type, timestamp, and duration.

It does not discover or upload recordings, and it cannot solve the important recording-to-call matching problem. Its compact HTTP contract is still a useful reference for the Linekeep spike.

Source: [AndroidCallLogSync repository](https://github.com/MarkoBL/AndroidCallLogSync).

### Round Sync: fastest way to test file upload

Round Sync is a GPLv3 Android frontend for rclone. It supports cloud remotes, scheduled tasks, Android's Storage Access Framework, and S3-compatible storage. That makes it a possible one-day experiment:

1. Select Samsung's call-recording directory.
2. Configure a restricted R2/S3 credential.
3. Schedule a one-way copy to a per-employee prefix.
4. Confirm that recordings arrive reliably.

Limitations:

- It syncs files, not call-log metadata.
- It does not provide a company call-recording panel.
- R2 credentials must be provisioned to the device; presigned per-object uploads are safer.
- Filename-only matching is less reliable than the proposed Android uploader.
- Employee onboarding across several remotes/tasks is cumbersome.

Use Round Sync only as a quick validation that the Samsung directory is accessible and background transfer works. It does not eliminate the need for Linekeep.

Source: [Round Sync repository](https://github.com/newhinton/Round-Sync).

### Syncthing-Fork: useful for a self-hosted folder pilot

Syncthing-Fork can replicate the Samsung recording folder to a computer or VPS running Syncthing. It supports per-folder conditions and send-only behavior, but it has no R2 destination, call-log ingestion, matching, or admin panel.

It can validate folder accessibility without handing an app cloud credentials. Operating another always-on server merely to feed Cloudflare is unnecessary for the finished MVP.

Source: [Syncthing-Fork repository](https://github.com/researchxxl/syncthing-android).

## Open-source VoIP alternative

If the business later accepts making calls through a managed VoIP number rather than each Samsung SIM, open-source PBX systems are much closer to a complete solution.

### OpDesk

OpDesk works with Asterisk/FreePBX and includes call history, recording playback, agent/supervisor views, WebRTC calling, search, and analytics. Asterisk records calls server-side, so Android recording restrictions disappear.

It requires a PBX, SIP trunk, business numbers, employee extensions, and a different calling workflow. The software may be free, but telephone numbers and minutes are not.

Source: [OpDesk repository](https://github.com/Ibrahimgamal99/OpDesk).

### Astradial

Astradial packages Asterisk, phone numbers/SIP trunks, queues, CRM, roles, API/webhooks, and consent-aware call recording. Its default open-source authentication uses an organization API key/secret and local JWTs.

This is worth piloting instead of Linekeep if central recording reliability becomes more important than preserving native Samsung/SIM calling.

Source: [Astradial repository](https://github.com/astradial/astradial).

## Recommendation

### For the intended MVP

Build the Android uploader, upload protocol, database, and Cloudflare panel from scratch according to the Linekeep plans. Use official Android and Cloudflare documentation as the primary implementation reference.

Open-source projects may be used only as independent feasibility tools or behavioral comparisons. Do not copy CallSync code or architecture. Any future source dependency must be maintained, necessary, and license-compatible.

This keeps the employee flow to one Linekeep APK plus the native Samsung recorder.

### For the fastest possible proof, before writing the app

Use Round Sync on one test phone to copy the Samsung recordings directory into an R2 test bucket. This answers two questions within hours: whether the directory is readable and whether background transfer is viable.

Do not roll that configuration out to the whole team. Move to per-device tokens and presigned URLs in the Linekeep app before handling real employee recordings.

### If native Samsung access fails

Try CallVault on one representative phone. If it reliably records both sides and the shell-level setup is acceptable, decide whether to integrate/fork it under its GPL obligations or keep it as a separate recorder feeding Linekeep. If that is too fragile, move to the VoIP/PBX approach rather than rooting employee phones.
