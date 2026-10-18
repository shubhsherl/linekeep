package com.microorganics.calltracker

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordingDiscoveryTest {
    private val policy = RecordingDiscoveryPolicy
    private val start = Instant.parse("2026-09-27T09:10:25.312Z").toEpochMilli()
    private val end = start + 96_000
    private val history = HistoryEntry("history-a", "synthetic-device", 1, Instant.ofEpochMilli(start).toString(),
        96, "incoming", "+15550123456", callerName = "Casey#")
    private val filename = "Call Casey#_260927_144033.m4a"
    private val media = SourceMetadata(96, "2026-09-27T09:12:09Z")

    @Test
    fun `repeat observations retain the same identity and true deadline regardless of upload state`() {
        val first = requireNotNull(policy.watch(history, end))
        val later = requireNotNull(policy.watch(history.copy(synced = true), end + 240_000))
        assertEquals(first, later)
        assertEquals(end + 300_000, first.deadline)
        val expired = policy.checked(first, first.deadline, found = false, deferred = false)
        assertEquals("timed_out", expired.state)
        assertEquals(first.deadline, policy.checked(expired, first.deadline + 60_000, false, false).deadline)
        assertNull(policy.watch(history, first.deadline))
    }

    @Test
    fun `old imports uncompleted calls and unanswered call types create no wait`() {
        assertNull(policy.watch(history, end + 300_000))
        assertNull(policy.watch(history, end - 1))
        assertNull(policy.watch(history.copy(durationSeconds = 0), end))
        assertNull(policy.watch(history.copy(callType = "missed"), end))
        assertNull(policy.watch(history.copy(callType = "rejected"), end))
        assertNull(policy.watch(history.copy(error = "invalid source"), end))
        assertNotNull(policy.watch(history.copy(callType = "outgoing"), end))
    }

    @Test
    fun `simultaneous calls keep independent deadlines and finding one does not stop another`() {
        val first = requireNotNull(policy.watch(history, end))
        val secondHistory = history.copy(fingerprint = "history-b", startedAt = Instant.ofEpochMilli(start + 200_000).toString())
        val second = requireNotNull(policy.watch(secondHistory, end + 200_000))
        val now = first.deadline - 1_000
        val checked = policy.checked(first, now, false, false)
        assertEquals(first.deadline, policy.status(listOf(checked, second), now).nextCheckAt)
        val found = policy.checked(first, now, true, false)
        assertEquals(now + 15_000, policy.status(listOf(found, second), now).nextCheckAt)
        assertEquals("waiting", second.state)
    }

    @Test
    fun `deadline stops polling even when scan is deferred and status refreshes do not postpone checks`() {
        val watch = requireNotNull(policy.watch(history, end))
        val checked = policy.checked(watch, end, false, true)
        assertEquals(end + 15_000, policy.status(listOf(checked), end + 10_000).nextCheckAt)
        val timeout = policy.expire(checked, watch.deadline)
        assertEquals("timed_out", timeout.state)
        assertTrue(timeout.deferred)
        assertNull(policy.status(listOf(timeout), watch.deadline).nextCheckAt)
        assertNotNull(policy.status(listOf(timeout), watch.deadline).message)
    }

    @Test
    fun `late confidently matched audio resolves timeout without waiting for upload`() {
        val watch = requireNotNull(policy.watch(history, end))
        val timedOut = policy.checked(watch, watch.deadline, false, false)
        val match = policy.confirmedHistory(listOf(history), filename, media)
        val found = policy.checked(timedOut, watch.deadline + 60_000, match == history.fingerprint, false)
        assertEquals("found", found.state)
        assertNull(policy.status(listOf(found), found.checkedAt).message)
        assertNull(policy.status(listOf(found), found.checkedAt).nextCheckAt)
        assertEquals(found, policy.checked(found, found.checkedAt + 1_000, false, true))
    }

    @Test
    fun `incomplete source evidence stays unconfirmed and can be resolved by later evidence`() {
        val watch = requireNotNull(policy.watch(history, end))
        assertNull(policy.confirmedHistory(listOf(history), filename, media.copy(recordedAt = null)))
        assertNull(policy.confirmedHistory(listOf(history), filename, media.copy(durationSeconds = null)))
        val deferred = policy.checked(watch, end, false, true)
        assertEquals("waiting", deferred.state)
        assertTrue(deferred.deferred)
        assertNotNull(policy.status(listOf(deferred), end).nextCheckAt)
        assertEquals(history.fingerprint, policy.confirmedHistory(listOf(history), filename, media))
    }

    @Test
    fun `matching corroborates embedded start or end without guessing timezone or country code`() {
        assertTrue(policy.matches(history, filename, media))
        assertTrue(policy.matches(history, filename, media.copy(recordedAt = "2026-09-27T09:10:33Z")))
        val numbered = "Call +1 (555) 012-3456_260927_144033.m4a"
        assertTrue(policy.matches(history.copy(callerName = null, durationSeconds = 98), numbered, media))
        assertFalse(policy.matches(history.copy(callerName = null), "Call 5550123456_260927_144033.m4a", media))
        assertFalse(policy.matches(history, "Call Someone else_260927_144033.m4a", media))
        assertFalse(policy.matches(history.copy(durationSeconds = 99), filename, media))
        assertFalse(policy.matches(history, "Call Casey#_260230_144033.m4a", media))
        assertFalse(policy.matches(history, "Call Casey#_260927_144133.m4a", media))
        assertFalse(policy.matches(history, "Call Casey#_260927_144056.m4a", media.copy(recordedAt = "2026-09-27T09:12:32Z")))
    }

    @Test
    fun `multiple matching histories remain ambiguous rather than choosing the closest`() {
        val nearby = history.copy(fingerprint = "history-b", startedAt = "2026-09-27T09:10:26Z")
        assertTrue(policy.matches(nearby, filename, media))
        assertNull(policy.confirmedHistory(listOf(history, nearby), filename, media))
        assertNull(policy.confirmedHistory(listOf(nearby, history), filename, media))
        val truncated = List(201) { history.copy(fingerprint = "history-$it") }
        assertNull(policy.confirmedHistory(truncated, filename, media))
    }

    @Test
    fun `offset and ringing boundaries reject uncorroborated filename timestamps`() {
        val exactStart = history.copy(startedAt = "2026-09-27T09:10:25Z")
        assertTrue(policy.matches(exactStart, "Call Casey#_260927_144055.m4a", media.copy(recordedAt = "2026-09-27T09:10:55Z")))
        assertFalse(policy.matches(exactStart, "Call Casey#_260927_144056.m4a", media.copy(recordedAt = "2026-09-27T09:10:56Z")))
        assertTrue(policy.matches(history, "Call Casey#_260927_231033.m4a", media))
        assertFalse(policy.matches(history, "Call Casey#_260927_232533.m4a", media))
        assertTrue(policy.matches(history, "Call Casey#_260927_144035.m4a", media))
        assertFalse(policy.matches(history, "Call Casey#_260927_144036.m4a", media))
    }

    @Test
    fun `a persisted call end delayed past deadline reports uncertainty without restarting polling`() {
        val observedEnd = end + 8_000
        val resumedAt = observedEnd + 360_000
        assertNull(policy.watch(history, resumedAt))
        val deferred = requireNotNull(policy.watch(history, resumedAt, observedEnd))
        assertEquals(observedEnd + 300_000, deferred.deadline)
        assertNull(policy.status(listOf(deferred), resumedAt).nextCheckAt)
        assertNotNull(policy.status(listOf(deferred), resumedAt).message)
        assertTrue(deferred.deferred)
        assertNull(policy.watch(history.copy(callType = "missed"), resumedAt, observedEnd))
    }

    @Test
    fun `permission denied call end deduplicates and audio activity never claims call association`() {
        val watch = requireNotNull(policy.callEndWatch("synthetic-device", end, end))
        assertEquals(watch, policy.callEndWatch("synthetic-device", end, end + 250_000))
        val deferred = requireNotNull(policy.callEndWatch("synthetic-device", end, watch.deadline))
        assertNull(policy.status(listOf(deferred), watch.deadline).nextCheckAt)
        assertTrue(deferred.deferred)
        assertTrue(policy.audioActivity(media, end))
        assertFalse(policy.audioActivity(media.copy(recordedAt = null), end))
        assertFalse(policy.audioActivity(media, end + 60_000))
        val activity = policy.checked(watch, end + 10_000, true, false)
        assertEquals("activity", activity.state)
        assertNotNull(policy.status(listOf(activity), activity.checkedAt).message)
        assertNull(policy.status(listOf(activity), activity.checkedAt).nextCheckAt)
    }
}
