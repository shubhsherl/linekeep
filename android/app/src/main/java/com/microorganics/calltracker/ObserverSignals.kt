package com.microorganics.calltracker

/** Content-observer signals that are not about the call log wait this long, so a burst becomes one discovery run. */
internal const val COALESCE_SECONDS = 8L

private const val CALL_LOG_URI_PREFIX = "content://call_log"

/**
 * True when a content-change signal may be about the call log or says nothing about what changed. Those run at once;
 * only signals that all name other providers (MediaStore, the recording folder) are coalesced.
 */
internal fun signalsCallLog(uris: Collection<String?>): Boolean =
    uris.isEmpty() || uris.any { it == null || it.startsWith(CALL_LOG_URI_PREFIX) }
