package com.microorganics.calltracker

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordingBatchTest {
    @Test
    fun `only two transfers start together and each recording is processed once`() = runBlocking {
        withTimeout(5_000) {
            val started = mutableListOf<Int>()
            val bothStarted = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val batch = async {
                syncRecordingBatch((0 until 12).toList(), Long.MAX_VALUE) { index ->
                    started.add(index)
                    if (started.size == 2) bothStarted.complete(Unit)
                    release.await()
                    ContentSyncResult()
                }
            }
            bothStarted.await()
            assertEquals(listOf(0, 1), started)
            release.complete(Unit)
            batch.await()
            assertEquals((0 until 12).toList(), started.sorted())
        }
    }

    @Test
    fun `one slow transfer does not strand the rest of the queue`() = runBlocking {
        withTimeout(5_000) {
            val completed = mutableListOf<Int>()
            val fastFilesFinished = CompletableDeferred<Unit>()
            syncRecordingBatch((0 until 12).toList(), Long.MAX_VALUE) { index ->
                if (index == 0) fastFilesFinished.await()
                completed.add(index)
                if (completed.size == 11) fastFilesFinished.complete(Unit)
                ContentSyncResult()
            }
            assertEquals((1 until 12).toList() + 0, completed)
        }
    }

    @Test
    fun `authorization failure cancels the sibling and starts no later recording`() = runBlocking {
        withTimeout(5_000) {
            supervisorScope {
                val siblingStarted = CompletableDeferred<Unit>()
                val siblingCancelled = CompletableDeferred<Unit>()
                val started = mutableListOf<Int>()
                val unauthorized = ApiFailure(401)
                val batch = async {
                    syncRecordingBatch((0 until 12).toList(), Long.MAX_VALUE) { index ->
                        started.add(index)
                        if (index == 0) {
                            siblingStarted.await()
                            throw unauthorized
                        }
                        try {
                            siblingStarted.complete(Unit)
                            awaitCancellation()
                        } finally {
                            siblingCancelled.complete(Unit)
                        }
                    }
                }
                val failure = runCatching { batch.await() }.exceptionOrNull()
                assertSame(unauthorized, failure)
                siblingCancelled.await()
                assertEquals(listOf(0, 1), started)
            }
        }
    }

    @Test
    fun `expired work budget leaves recordings available for the next batch`() = runBlocking {
        val transfers = AtomicInteger()
        val entries = (0 until 12).toList()
        val deferred = syncRecordingBatch(entries, System.nanoTime() - 1) {
            transfers.incrementAndGet()
            ContentSyncResult()
        }
        assertTrue(deferred.more)
        assertEquals(0, transfers.get())
        syncRecordingBatch(entries, Long.MAX_VALUE) {
            transfers.incrementAndGet()
            ContentSyncResult()
        }
        assertEquals(entries.size, transfers.get())
    }
}
