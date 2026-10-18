package com.microorganics.calltracker

import android.net.Uri
import androidx.room.withTransaction
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle
import kotlin.math.abs
import kotlin.math.round
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

internal data class RecordingDiscoveryStatus(val message: String? = null, val nextCheckAt: Long? = null)

/** Informational only: no upload state is read as proof of association or changed here. */
internal class RecordingDiscovery(private val database: ContentLedger, private val source: RecordingSource) {
    private val dao = database.entries()

    suspend fun observeHistory(deviceId: String, now: Long, callEndedAt: Long? = null) {
        if (callEndedAt != null && callEndedAt in 1..now) {
            // An explicitly observed end may arrive late after Doze; unlike old imports it still deserves a notice.
            val candidates = dao.discoveryHistory(deviceId, callEndedAt - 60_000, callEndedAt + 1_000)
            if (candidates.size == 1) {
                RecordingDiscoveryPolicy.watch(candidates.single(), now, callEndedAt)?.let { dao.addRecordingWatch(it) }
            }
        }
        dao.discoveryHistory(deviceId, now - RecordingDiscoveryPolicy.window - 1_000, now + 1_000).forEach { history ->
            RecordingDiscoveryPolicy.watch(history, now)?.let { dao.addRecordingWatch(it) }
        }
    }

    suspend fun observeCallEnd(deviceId: String, endedAt: Long) {
        RecordingDiscoveryPolicy.callEndWatch(deviceId, endedAt, System.currentTimeMillis())?.let { dao.addRecordingWatch(it) }
    }

    suspend fun check(deviceId: String, tree: String, now: Long, scanComplete: Boolean): RecordingDiscoveryStatus {
        val watches = dao.recordingWatches(deviceId).filter { it.state != "found" && it.state != "activity" }
            .sortedBy { if (it.deadline > now) 0 else 1 }
        // Reuse metadata and ambiguity decisions across simultaneous windows. Failed reads count too.
        val inspected = mutableMapOf<String, Inspection>()
        val updates = ArrayList<RecordingWatch>(watches.size)
        for (watch in watches) {
            currentCoroutineContext().ensureActive()
            val history = watch.historyFingerprint?.let { dao.history(it) }
            val page = dao.discoveryRecordings(deviceId, tree, watch.cursor)
            var cursor = watch.cursor
            var deferred = !scanComplete || page.size == 128
            var found = false
            var consumed = true
            for (entry in page) {
                currentCoroutineContext().ensureActive()
                val filename = RecordingDiscoveryPolicy.filename(entry.name)
                // Unknown names remain unconfirmed; do not spend source reads on unrelated identities.
                if (history != null && (filename == null || !RecordingDiscoveryPolicy.sameIdentity(filename.identity, history))) {
                    cursor = entry.key
                    continue
                }
                if (!inspected.containsKey(entry.uri) && inspected.size >= 16) {
                    consumed = false
                    deferred = true
                    break
                }
                val evidence = inspected[entry.uri] ?: inspect(entry, deviceId).also { inspected[entry.uri] = it }
                cursor = entry.key
                if (evidence.metadata == null || evidence.ambiguous) deferred = true
                found = if (watch.historyFingerprint != null) evidence.historyFingerprint == watch.historyFingerprint
                    else evidence.metadata?.let { RecordingDiscoveryPolicy.audioActivity(it, watch.endedAt) } == true
                if (found) break
            }
            if (consumed && page.size < 128) cursor = ""
            updates.add(RecordingDiscoveryPolicy.checked(watch, now, found, deferred).copy(cursor = cursor))
        }
        persist(updates)
        return status(deviceId, now)
    }

    private suspend fun inspect(entry: RecordingEntry, deviceId: String): Inspection {
        val metadata = try {
            source.metadata(Uri.parse(entry.uri))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return Inspection(null)
        }
        val duration = metadata.durationSeconds ?: return Inspection(metadata, ambiguous = true)
        val media = metadata.recordedAt?.let { runCatching { Instant.parse(it).epochSecond }.getOrNull() }
            ?: return Inspection(metadata, ambiguous = true)
        val histories = dao.recordingMatchHistory(deviceId, (duration - 2).coerceAtLeast(1), duration + 2, media, duration)
        val matched = RecordingDiscoveryPolicy.confirmedHistory(histories, entry.name, metadata)
        return Inspection(metadata, matched, matched == null)
    }

    private suspend fun persist(updates: List<RecordingWatch>) {
        if (updates.isEmpty()) return
        database.withTransaction {
            val current = dao.recordingWatches(updates.first().deviceId).associateBy { it.watchId }
            updates.forEach { update ->
                val existing = current[update.watchId]
                // A concurrent status refresh or older check must never undo confirmed discovery.
                if (existing != null && existing.state != "found" && existing.state != "activity" && existing.checkedAt <= update.checkedAt) {
                    dao.saveRecordingWatch(update)
                }
            }
        }
    }

    suspend fun status(deviceId: String, now: Long): RecordingDiscoveryStatus {
        val watches = database.withTransaction {
            dao.recordingWatches(deviceId).map { watch ->
                RecordingDiscoveryPolicy.expire(watch, now).also { if (it != watch) dao.saveRecordingWatch(it) }
            }
        }
        return RecordingDiscoveryPolicy.status(watches, now)
    }

    private data class Inspection(val metadata: SourceMetadata?, val historyFingerprint: String? = null, val ambiguous: Boolean = false)
}

/** Pure policy shared by discovery and JVM regressions; timestamps are never provider modification times. */
internal object RecordingDiscoveryPolicy {
    const val window = 300_000L
    private const val poll = 15_000L
    private val samsung = Regex("^Call (.+)_([0-9]{6})_([0-9]{6})\\.m4a$")
    private val filenameFormat = DateTimeFormatter.ofPattern("uuuuMMdd_HHmmss").withResolverStyle(ResolverStyle.STRICT)
    internal data class Filename(val identity: String, val wallSeconds: Long)

    fun watch(history: HistoryEntry, now: Long, observedEnd: Long? = null): RecordingWatch? {
        if (history.error != null || (history.callType != "incoming" && history.callType != "outgoing") || history.durationSeconds !in 1..604800) return null
        val start = instant(history.startedAt) ?: return null
        if (start <= 0 || start > Long.MAX_VALUE - history.durationSeconds * 1_000 - window) return null
        val estimatedEnd = start + history.durationSeconds * 1_000
        if (observedEnd != null && (observedEnd !in 1..now || abs(observedEnd - estimatedEnd) > 60_000)) return null
        val endedAt = observedEnd ?: estimatedEnd
        if (endedAt > Long.MAX_VALUE - window || endedAt > now || observedEnd == null && endedAt <= now - window) return null
        return expire(RecordingWatch(history.deviceId, "history:${history.fingerprint}", history.fingerprint,
            endedAt, endedAt + window, deferred = now >= endedAt + window), now)
    }

    fun callEndWatch(deviceId: String, endedAt: Long, now: Long): RecordingWatch? {
        if (endedAt <= 0 || endedAt > now || endedAt > Long.MAX_VALUE - window) return null
        return expire(RecordingWatch(deviceId, "call_end:$endedAt", null, endedAt, endedAt + window,
            deferred = now >= endedAt + window), now)
    }

    fun expire(watch: RecordingWatch, now: Long): RecordingWatch =
        if (watch.state == "waiting" && now >= watch.deadline) watch.copy(state = "timed_out") else watch

    fun checked(watch: RecordingWatch, now: Long, found: Boolean, deferred: Boolean): RecordingWatch {
        if (watch.state == "found" || watch.state == "activity") return watch
        val state = when {
            found -> if (watch.historyFingerprint == null) "activity" else "found"
            now >= watch.deadline -> "timed_out"
            else -> "waiting"
        }
        return watch.copy(state = state, checkedAt = now, deferred = deferred)
    }

    fun status(watches: List<RecordingWatch>, now: Long): RecordingDiscoveryStatus {
        val unresolved = watches.filter { it.state != "found" && it.state != "activity" }
        val waiting = unresolved.filter { now < it.deadline }
        val expired = unresolved.size - waiting.size
        val messages = mutableListOf<String>()
        if (waiting.isNotEmpty()) messages.add("Checking for recordings for ${waiting.size} recent call(s), for up to 5 minutes after each call.")
        if (expired > 0) messages.add("No recording confirmed within 5 minutes for $expired call(s). Late recordings can still sync.")
        if (unresolved.any { it.deferred }) messages.add("Local checking is delayed or the available audio could not be matched confidently.")
        if (unresolved.any { it.historyFingerprint == null }) messages.add("A call was observed without call history permission; its recording association is unconfirmed.")
        if (watches.any { it.state == "activity" }) messages.add("Audio activity observed for a call-end window without call history access; association with that call is unconfirmed.")
        val next = waiting.minOfOrNull { minOf(it.deadline, if (it.checkedAt == 0L) now + poll else maxOf(now, it.checkedAt + poll)) }
        return RecordingDiscoveryStatus(messages.takeIf { it.isNotEmpty() }?.joinToString(" "), next)
    }

    fun filename(name: String): Filename? {
        val match = samsung.matchEntire(name) ?: return null
        val wall = runCatching {
            LocalDateTime.parse("20${match.groupValues[2]}_${match.groupValues[3]}", filenameFormat).toEpochSecond(ZoneOffset.UTC)
        }.getOrNull() ?: return null
        return Filename(match.groupValues[1].trim(), wall)
    }

    fun sameIdentity(identity: String, history: HistoryEntry): Boolean {
        val caller = history.callerName?.trim()
        if (caller != null && asciiEqual(identity, caller)) return true
        val key = number(identity) ?: return false
        return key == number(history.remoteNumber)
    }

    fun confirmedHistory(histories: List<HistoryEntry>, name: String, metadata: SourceMetadata): String? {
        // A truncated candidate set can never establish uniqueness.
        if (histories.size > 200) return null
        var matched: String? = null
        for (history in histories) {
            if (matches(history, name, metadata)) {
                if (matched != null) return null
                matched = history.fingerprint
            }
        }
        return matched
    }

    fun matches(history: HistoryEntry, name: String, metadata: SourceMetadata): Boolean {
        if (history.error != null || (history.callType != "incoming" && history.callType != "outgoing") || history.durationSeconds <= 0) return false
        val duration = metadata.durationSeconds?.takeIf { it in 1..604800 } ?: return false
        if (abs(history.durationSeconds - duration) > 2) return false
        val filename = filename(name) ?: return false
        if (!sameIdentity(filename.identity, history)) return false
        val started = instant(history.startedAt)?.div(1_000) ?: return false
        val media = metadata.recordedAt?.let(::instant)?.div(1_000) ?: return false
        return plausibleStart(filename.wallSeconds, media, started) || plausibleStart(filename.wallSeconds, media - duration, started)
    }

    private fun plausibleStart(wall: Long, mediaStart: Long, historyStart: Long): Boolean {
        if (mediaStart - historyStart !in 0..30) return false
        val offset = wall - mediaStart
        return offset in -43_202..50_402 && abs(offset - round(offset / 900.0) * 900) <= 2
    }

    fun audioActivity(metadata: SourceMetadata, endedAt: Long): Boolean {
        val media = metadata.recordedAt?.let(::instant) ?: return false
        val duration = metadata.durationSeconds?.takeIf { it in 1..604800 } ?: return false
        // This is deliberately only activity, not a claim that this recording belongs to this call.
        return abs(media - endedAt) <= 30_000 || abs(media + duration * 1_000 - endedAt) <= 30_000
    }

    private fun instant(value: String): Long? = runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
    private fun asciiEqual(first: String, second: String): Boolean {
        if (first.length != second.length) return false
        return first.indices.all { index ->
            val a = first[index].let { if (it in 'A'..'Z') it.lowercaseChar() else it }
            val b = second[index].let { if (it in 'A'..'Z') it.lowercaseChar() else it }
            a == b
        }
    }
    private fun number(value: String?): String? {
        if (value == null || value.any { it !in '0'..'9' && it !in "+ -()." }) return null
        return value.filter { it in '0'..'9' }.takeIf { it.length in 7..15 }
    }
}
