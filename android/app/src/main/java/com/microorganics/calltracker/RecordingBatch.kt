package com.microorganics.calltracker

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive

internal data class ContentSyncResult(val retry: Boolean = false, val more: Boolean = false, val settling: Boolean = false)

/** Two workers share the queue so a large file does not strand small files behind it. */
internal suspend fun <T> syncRecordingBatch(
    entries: List<T>,
    deadlineNanos: Long,
    transfer: suspend (T) -> ContentSyncResult,
): ContentSyncResult = coroutineScope {
    val cursor = AtomicInteger()
    val results = List(minOf(2, entries.size)) {
        async {
            var retry = false
            var more = false
            var settling = false
            while (true) {
                ensureActive()
                // Let in-flight transfers finish; leave unstarted entries in the durable queue.
                if (System.nanoTime() >= deadlineNanos) break
                val index = cursor.getAndIncrement()
                if (index >= entries.size) break
                val result = transfer(entries[index])
                retry = retry || result.retry
                more = more || result.more
                settling = settling || result.settling
            }
            ContentSyncResult(retry, more, settling)
        }
    }.awaitAll()
    ContentSyncResult(
        retry = results.any { it.retry },
        more = cursor.get() < entries.size || results.any { it.more },
        settling = results.any { it.settling },
    )
}
