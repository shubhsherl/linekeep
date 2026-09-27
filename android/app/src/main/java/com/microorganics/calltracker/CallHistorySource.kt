package com.microorganics.calltracker

import android.content.ContentResolver
import android.provider.CallLog
import androidx.room.withTransaction
import java.io.IOException
import java.time.Instant

internal class CallHistorySource(private val resolver: ContentResolver, private val database: ContentLedger, private val simReader: SimReader) {
    private val dao = database.entries()
    private val projection = arrayOf(CallLog.Calls._ID, CallLog.Calls.DATE, CallLog.Calls.DURATION,
        CallLog.Calls.TYPE, CallLog.Calls.NUMBER, CallLog.Calls.NUMBER_PRESENTATION, CallLog.Calls.CACHED_NAME,
        CallLog.Calls.PHONE_ACCOUNT_COMPONENT_NAME, CallLog.Calls.PHONE_ACCOUNT_ID)

    /** Each bounded page and its watermark commit together before any HTTP request. Full rescans also reconcile older edits. */
    suspend fun collect(deviceId: String, checkActive: () -> Unit): Boolean {
        val after = dao.historyProgress(deviceId)?.lastId ?: 0L
        val page = read(deviceId, after, false, 200, checkActive)
        database.withTransaction {
            page.forEach { saveChanged(it) }
            dao.saveHistoryProgress(HistoryProgress(deviceId, if (page.size == 200) page.last().providerId else 0L))
        }
        // Revisit recent rows on every run so final durations/types are not delayed behind a large historical import.
        val recent = read(deviceId, 0, true, 50, checkActive)
        database.withTransaction { recent.forEach { saveChanged(it) } }
        return page.size == 200
    }

    private suspend fun saveChanged(entry: HistoryEntry) {
        val existing = dao.history(entry.fingerprint)
        // The first known line belongs to this historical call even after the current SIM changes.
        val sameAccount = existing?.phoneAccountId == null ||
            existing.phoneAccountId == entry.phoneAccountId && existing.phoneAccountComponent == entry.phoneAccountComponent
        val merged = entry.copy(
            callerName = existing?.callerName ?: entry.callerName,
            localNumber = existing?.localNumber ?: entry.localNumber.takeIf { sameAccount },
            simLabel = existing?.simLabel ?: entry.simLabel.takeIf { sameAccount },
            phoneAccountId = existing?.phoneAccountId ?: entry.phoneAccountId,
            phoneAccountComponent = existing?.phoneAccountComponent ?: entry.phoneAccountComponent,
        )
        if (existing == null || existing.copy(synced = false, error = merged.error) != merged) dao.saveHistory(merged)
    }

    private fun read(device: String, after: Long, recent: Boolean, limit: Int, checkActive: () -> Unit): List<HistoryEntry> {
        checkActive()
        val uri = CallLog.Calls.CONTENT_URI.buildUpon().appendQueryParameter("limit", limit.toString()).build()
        return resolver.query(uri, projection, if (recent) null else "${CallLog.Calls._ID} > ?",
            if (recent) null else arrayOf(after.toString()), if (recent) "${CallLog.Calls.DATE} DESC, ${CallLog.Calls._ID} DESC" else "${CallLog.Calls._ID} ASC")?.use { cursor ->
            val entries = ArrayList<HistoryEntry>(limit)
            val lines = mutableMapOf<Pair<String?, String?>, CallLine>()
            while (entries.size < limit && cursor.moveToNext()) {
                checkActive()
                val id = cursor.getLong(0)
                val started = cursor.getLong(1)
                val duration = cursor.getLong(2)
                val number = if (cursor.getInt(5) == CallLog.Calls.PRESENTATION_ALLOWED) {
                    cursor.getString(4)?.trim()?.takeIf { value ->
                        value.length in 1..80 && value !in setOf("-1", "-2", "-3") && value.any(Char::isDigit)
                    }
                } else null
                val type = when (cursor.getInt(3)) {
                    CallLog.Calls.INCOMING_TYPE -> "incoming"
                    CallLog.Calls.OUTGOING_TYPE -> "outgoing"
                    CallLog.Calls.MISSED_TYPE -> "missed"
                    CallLog.Calls.REJECTED_TYPE -> "rejected"
                    CallLog.Calls.BLOCKED_TYPE -> "blocked"
                    CallLog.Calls.VOICEMAIL_TYPE -> "voicemail"
                    CallLog.Calls.ANSWERED_EXTERNALLY_TYPE -> "answered_externally"
                    else -> "unknown"
                }
                val component = cursor.getString(7)?.trim()?.takeIf { it.isNotEmpty() }
                val accountId = cursor.getString(8)?.trim()?.takeIf { it.length in 1..256 }
                val line = lines.getOrPut(component to accountId) { simReader.readCallLine(component, accountId) }
                entries.add(HistoryEntry(sha256("history\u0000$device\u0000$id\u0000$started"), device, id,
                    Instant.ofEpochMilli(started).toString(), duration, type, number,
                    error = if (started <= 0 || duration !in 0..604800) "Call history row has an invalid start time or duration" else null,
                    callerName = cursor.getString(6)?.trim()?.take(256)?.takeIf { it.isNotEmpty() },
                    localNumber = line.number, simLabel = line.label, phoneAccountId = accountId, phoneAccountComponent = component))
            }
            entries
        } ?: throw IOException("Phone call history provider unavailable")
    }
}
