# Calltracker API contract

Contract version: `v1`.

This is the integration source of truth for Android and server work. All timestamps are UTC RFC 3339 strings. IDs are opaque strings. JSON uses camelCase. Optional metadata is represented by omitted fields, not invented placeholder values.

## Transport and errors

- Base path: `/v1`.
- Content type: `application/json`, except the signed R2 `PUT`.
- Device authorization: `Authorization: Bearer <deviceToken>`.
- Admin authorization: Cloudflare Access in production.
- Every API response includes `requestId`.
- Retrying a request with the same recording fingerprint is safe.

Standard error:

```json
{
  "requestId": "req_01...",
  "error": {
    "code": "INVALID_REQUEST",
    "message": "expectedBytes must be positive"
  }
}
```

Required error codes:

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | Invalid fields or unsupported media |
| 401 | `UNAUTHORIZED` | Missing, invalid, or revoked device token |
| 404 | `NOT_FOUND` | Requested resource does not exist |
| 409 | `INVALID_STATE` | Operation conflicts with upload state |
| 413 | `FILE_TOO_LARGE` | Recording exceeds configured limit |
| 429 | `RATE_LIMITED` | Client should retry with backoff |
| 500 | `INTERNAL_ERROR` | Unexpected server failure |

## Enumerations

```text
direction: incoming | outgoing | unknown
matchStatus: filename | media_metadata | call_log | unmatched
uploadStatus: pending | complete | failed | deleted
```

`call_log` is reserved for a later enhanced-permission mode. Android MVP requests use `filename`, `media_metadata`, or `unmatched`.

## Register device

`POST /v1/device/register`

No device authorization; invitation code is the credential.

Request:

```json
{
  "invitationCode": "join_7V4K9P",
  "device": {
    "model": "SM-S921B",
    "manufacturer": "samsung",
    "androidVersion": "16",
    "oneUiVersion": "8.0",
    "appVersion": "0.1.0"
  }
}
```

Response `201`:

```json
{
  "requestId": "req_01...",
  "deviceId": "dev_01...",
  "employee": {
    "id": "emp_01...",
    "name": "Asha"
  },
  "deviceToken": "ctd_live_secret_shown_once"
}
```

The server returns the device token only once and stores only its hash.

## Heartbeat

`POST /v1/device/heartbeat`

Request:

```json
{
  "appVersion": "0.1.0",
  "pendingUploads": 2,
  "lastSuccessfulUploadAt": "2026-09-23T05:12:00Z"
}
```

Response `200`:

```json
{
  "requestId": "req_01...",
  "serverTime": "2026-09-23T05:20:00Z"
}
```

## Prepare recording upload

`POST /v1/device/uploads/prepare`

Request:

```json
{
  "fingerprint": "64-lowercase-hex-characters",
  "file": {
    "displayName": "Call recording 20260923_103000.m4a",
    "contentType": "audio/mp4",
    "expectedBytes": 1234567,
    "durationSeconds": 182,
    "recordedAt": "2026-09-23T05:00:00Z"
  },
  "call": {
    "remoteNumber": "+919999999999",
    "direction": "outgoing",
    "matchStatus": "filename"
  }
}
```

Only `fingerprint`, `file.displayName`, `file.contentType`, `file.expectedBytes`, and `call.matchStatus` are required. `durationSeconds`, `recordedAt`, `remoteNumber`, and `direction` may be omitted when unavailable.

New/pending response `200`:

```json
{
  "requestId": "req_01...",
  "callId": "call_01...",
  "status": "pending",
  "upload": {
    "method": "PUT",
    "url": "https://signed-r2-url.example",
    "expiresAt": "2026-09-23T05:35:00Z",
    "headers": {
      "Content-Type": "audio/mp4"
    }
  }
}
```

Already-complete response `200`:

```json
{
  "requestId": "req_01...",
  "callId": "call_01...",
  "status": "complete"
}
```

Idempotency key: `(authenticated deviceId, fingerprint)`.

## Upload recording bytes

Use the exact method, URL, and headers returned by prepare. The signed URL authorizes one R2 object key and expires quickly. The APK never receives an R2 access key or secret.

The client records the returned ETag when present. An expired URL is resolved by calling prepare again with the same fingerprint.

## Complete recording upload

`POST /v1/device/uploads/{callId}/complete`

Request:

```json
{
  "actualBytes": 1234567,
  "etag": "abc123"
}
```

`etag` may be omitted when the upload response does not expose it.

Response `200`:

```json
{
  "requestId": "req_01...",
  "callId": "call_01...",
  "status": "complete",
  "uploadedAt": "2026-09-23T05:22:00Z"
}
```

The server verifies object existence and size before returning complete. Completion is idempotent.

## List calls for admin

`GET /v1/admin/calls?employeeId=&direction=&number=&from=&to=&status=&cursor=&limit=50`

`limit` is between 1 and 100. Results are newest first.

Response `200`:

```json
{
  "requestId": "req_01...",
  "items": [
    {
      "id": "call_01...",
      "employee": {
        "id": "emp_01...",
        "name": "Asha"
      },
      "deviceId": "dev_01...",
      "displayName": "Call recording 20260923_103000.m4a",
      "remoteNumber": "+919999999999",
      "direction": "outgoing",
      "recordedAt": "2026-09-23T05:00:00Z",
      "durationSeconds": 182,
      "matchStatus": "filename",
      "uploadStatus": "complete",
      "actualBytes": 1234567,
      "uploadedAt": "2026-09-23T05:22:00Z"
    }
  ],
  "nextCursor": null
}
```

## Create playback URL

`POST /v1/admin/calls/{callId}/playback`

Response `200`:

```json
{
  "requestId": "req_01...",
  "url": "https://short-lived-read-url.example",
  "expiresAt": "2026-09-23T05:30:00Z",
  "contentType": "audio/mp4"
}
```

## Delete call

`DELETE /v1/admin/calls/{callId}`

Response `200`:

```json
{
  "requestId": "req_01...",
  "callId": "call_01...",
  "status": "deleted"
}
```

Repeated deletion returns the same successful representation.

## Admin bootstrap endpoints

These endpoints are required for the pilot and protected as admin routes.

### Create employee

`POST /v1/admin/employees`

```json
{
  "name": "Asha",
  "phoneNumber": "+919999999999"
}
```

### Create invitation

`POST /v1/admin/employees/{employeeId}/invitations`

Response includes a single-use invitation code and expiry. Do not persist the plaintext code after redemption or expiry.

