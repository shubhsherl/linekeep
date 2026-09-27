package com.microorganics.calltracker

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.DocumentsContract
import androidx.core.content.ContextCompat
import androidx.room.withTransaction
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.io.FileNotFoundException
import java.io.IOException
import java.time.Instant

internal data class ContentSyncStatus(
    val folderLabel: String? = null,
    val folderAccessible: Boolean = false,
    val setupAccepted: Boolean = false,
    val callLogPermissionGranted: Boolean = false,
    val pendingUploads: Int = 0,
    val pendingCallLogs: Int = 0,
    val uploadedRecordings: Int = 0,
    val syncedCallLogs: Int = 0,
    val lastSuccessfulUploadAt: String? = null,
    val lastScanAt: String? = null,
    val detail: String = "Accept sharing setup, then grant access to the resources you want to sync.",
    val recent: List<String> = emptyList(),
)

private class ContentStopped : IOException("Sharing setup or selected access changed")

internal class ContentSync(context: Context, private val api: DeviceApi) {
    private val app = context.applicationContext
    private val prefs = app.getSharedPreferences("content-sync", Context.MODE_PRIVATE)
    private val database = ContentLedger.get(app)
    private val dao = database.entries()
    private val source = RecordingSource(app.contentResolver)
    private val history = CallHistorySource(app.contentResolver, database, SimReader(app))
    private val mutableStatus = MutableStateFlow(ContentSyncStatus())
    val status: StateFlow<ContentSyncStatus> = mutableStatus.asStateFlow()
    private fun tree(): String? = prefs.getString("tree", null)
    private fun accepted() = prefs.getBoolean("setupAcceptedV3", false)
    private fun callPermission() = ContextCompat.checkSelfPermission(app, Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED

    suspend fun restore() = withContext(Dispatchers.IO) {
        refreshAccess()
        val recent = runCatching { JSONArray(prefs.getString("recent", "[]")) }.getOrElse { JSONArray() }
        mutableStatus.update { it.copy(lastScanAt = prefs.getString("lastScanAt", null), recent = (0 until recent.length()).map { index -> recent.getString(index) }) }
        prefs.getString("device", null)?.let { refreshCounts(it) }
    }

    suspend fun selectFolder(uri: Uri) = withContext(Dispatchers.IO) {
        require(DocumentsContract.isTreeUri(uri)) { "Select a folder, not a single recording" }
        app.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val folder = source.document(uri, DocumentsContract.getTreeDocumentId(uri))
        require(folder.directory) { "Selection is not a folder" }
        val previous = tree()
        check(prefs.edit().putString("tree", uri.toString()).putString("folderLabel", folder.name).commit()) { "Could not save folder selection" }
        if (previous != null && previous != uri.toString()) {
            runCatching { app.contentResolver.releasePersistableUriPermission(Uri.parse(previous), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        }
        refreshAccess()
        note("Selected ${folder.name}. Readable recordings synchronize after sharing setup is accepted.")
    }

    suspend fun acceptSetup() = withContext(Dispatchers.IO) {
        // A new consent key deliberately does not inherit any previous feature preference.
        check(prefs.edit().putBoolean("setupAcceptedV3", true).commit()) { "Could not save sharing acceptance" }
        refreshAccess()
        note("Sharing setup accepted. Each resource synchronizes only while its Android access is granted.")
    }

    fun recordingTree(): Uri? = tree()?.let(Uri::parse)

    suspend fun inspectFolder() = withContext(Dispatchers.IO) {
        operationMutex.withLock {
            val selected = tree() ?: run { note("Choose a recording folder first."); return@withLock }
            try {
                val uri = Uri.parse(selected)
                checkFolder(selected)
                val queue = ArrayDeque<String>().apply { add(DocumentsContract.getTreeDocumentId(uri)) }
                val seen = mutableSetOf<String>()
                var inspected = 0
                var visited = 0
                while (queue.isNotEmpty() && visited < 200 && inspected < 5) {
                    val id = queue.removeFirst()
                    if (!seen.add(id)) continue
                    var offset = 0
                    do {
                        checkFolder(selected)
                        val page = source.children(uri, id, offset, minOf(50, 200 - visited))
                        for (document in page.documents) {
                            visited++
                            if (document.directory) queue.add(document.id)
                            else if (document.audioType != null && inspected < 5) {
                                try {
                                    source.hash(document.uri, document.size) { checkFolder(selected) }
                                    val metadata = source.metadata(document.uri)
                                    inspected++
                                    note("Readable: ${document.name} (${document.size} bytes, ${metadata.durationSeconds}s). No upload performed.")
                                } catch (error: Exception) {
                                    rethrowCancellation(error)
                                    note("Cannot inspect ${document.name}: ${safeError(error)}")
                                }
                            }
                        }
                        offset = page.nextOffset
                    } while (!page.finished && visited < 200 && inspected < 5)
                }
                note("Inspection: $inspected readable audio files in $visited entries checked; no files uploaded. Large folders are sampled.")
            } catch (error: Exception) {
                rethrowCancellation(error)
                note("Folder inspection: ${safeError(error)}")
            }
            refreshAccess()
        }
    }

    suspend fun synchronize(enrollment: Enrollment): ContentSyncResult = withContext(Dispatchers.IO) {
        operationMutex.withLock {
            check(prefs.edit().putString("device", enrollment.deviceId).commit())
            refreshAccess()
            if (!accepted()) { refreshCounts(enrollment.deviceId); return@withLock ContentSyncResult() }
            var retry = false
            var more = false
            var settling = false
            val coroutine = currentCoroutineContext()
            val selected = tree()
            if (callPermission()) {
                val active = { coroutine.ensureActive(); checkHistoryActive() }
                var acknowledgedCount = 0
                try {
                    more = history.collect(enrollment.deviceId, active) || more
                    repeat(4) {
                        active()
                        val batch = (dao.recentPendingHistory(enrollment.deviceId) +
                            dao.oldestPendingHistory(enrollment.deviceId)).distinctBy { it.fingerprint }
                        if (batch.isNotEmpty()) {
                            try {
                                val acknowledged = api.history(enrollment, batch)
                                database.withTransaction {
                                    batch.filter { it.fingerprint in acknowledged }.forEach { dao.saveHistory(it.copy(synced = true)) }
                                }
                                acknowledgedCount += acknowledged.size
                                if (acknowledged.size != batch.size) retry = true
                            } catch (error: ApiFailure) {
                                if (error.status != 400) throw error
                                // Isolate a rejected row; do not strand the other valid rows behind a poison batch.
                                val first = batch.first()
                                try {
                                    if (first.fingerprint in api.history(enrollment, listOf(first))) {
                                        dao.saveHistory(first.copy(synced = true))
                                        acknowledgedCount++
                                    }
                                } catch (single: ApiFailure) {
                                    if (single.status != 400) throw single
                                    dao.saveHistory(first.copy(error = "Server rejected this history row (HTTP 400)"))
                                    note("One call history entry was rejected; other entries remain queued.")
                                }
                                retry = true
                            }
                        }
                    }
                    if (acknowledgedCount > 0) note("Synced $acknowledgedCount call history entries.")
                } catch (error: Exception) {
                    rethrowAuthorization(error)
                    if (error !is ContentStopped) {
                        note("Call history: ${safeError(error)}")
                        retry = retry || error !is SecurityException && !(error is ApiFailure && error.status in setOf(403, 404))
                    }
                }
                val invalid = dao.failedHistoryCount(enrollment.deviceId)
                if (invalid > 0) note("$invalid call history entries could not sync; invalid provider data or server rejection.")
            }
            if (selected != null && status.value.folderAccessible) {
                val active = { coroutine.ensureActive(); checkRecordingActive(selected) }
                try {
                    more = scan(enrollment.deviceId, selected, active) || more
                    refreshCounts(enrollment.deviceId)
                    val queue = (dao.recentPendingRecording(enrollment.deviceId, selected) +
                        dao.pendingRecordings(enrollment.deviceId, selected, 12)).distinctBy { it.key }.take(12)
                    val result = syncRecordingBatch(queue, System.nanoTime() + 90_000_000_000L) { entry ->
                        val worker = currentCoroutineContext()
                        val transferActive = { worker.ensureActive(); checkRecordingActive(selected) }
                        transferActive()
                        try {
                            ContentSyncResult(settling = transfer(enrollment, entry, transferActive))
                        } catch (error: Exception) {
                            rethrowAuthorization(error)
                            if (error is ContentStopped) throw error
                            val latest = dao.recording(entry.key) ?: entry
                            val permanent = error is SourceChanged && latest.fingerprint != null || error is FileNotFoundException ||
                                error is IllegalArgumentException || error is ApiFailure && error.status in setOf(400, 403, 404, 409, 413) ||
                                error is UploadFailure && error.status in setOf(400, 404, 409, 413)
                            dao.saveRecording(latest.copy(state = if (permanent) "failed" else latest.state, error = safeError(error)))
                            note("${entry.name}: ${safeError(error)}${if (permanent) "; stopped for this source" else "; will retry"}")
                            ContentSyncResult(retry = !permanent && error !is SecurityException)
                        }
                    }
                    retry = retry || result.retry
                    more = more || result.more
                    settling = settling || result.settling
                } catch (error: Exception) {
                    rethrowAuthorization(error)
                    if (error !is ContentStopped) {
                        note("Recording folder: ${safeError(error)}")
                        retry = retry || error !is SecurityException && error !is FileNotFoundException
                    }
                }
            }
            check(prefs.edit().putString("lastScanAt", Instant.now().toString()).commit())
            refreshAccess()
            refreshCounts(enrollment.deviceId)
            mutableStatus.update { it.copy(lastScanAt = prefs.getString("lastScanAt", null)) }
            val recordingBacklog = status.value.folderAccessible && selected != null && dao.actionableRecordingCount(enrollment.deviceId, selected) > 0
            val historyBacklog = callPermission() && dao.pendingHistoryCount(enrollment.deviceId) > 0
            ContentSyncResult(retry, more || recordingBacklog || historyBacklog, settling)
        }
    }

    private suspend fun scan(device: String, selected: String, active: () -> Unit): Boolean {
        val uri = Uri.parse(selected)
        if (dao.nextDirectory(selected) == null) {
            dao.clearDirectories(selected)
            dao.addDirectory(DirectoryEntry(selected, DocumentsContract.getTreeDocumentId(uri)))
        }
        var remaining = 200
        var directories = 0
        while (remaining > 0 && directories++ < 40) {
            active()
            val directory = dao.nextDirectory(selected) ?: break
            val page = try {
                source.children(uri, directory.documentId, directory.offset, minOf(50, remaining))
            } catch (error: FileNotFoundException) {
                dao.saveDirectory(directory.copy(done = true))
                note("A recording subfolder was removed; continuing with the remaining folders.")
                continue
            }
            database.withTransaction {
                for (document in page.documents) {
                    active()
                    if (document.directory) dao.addDirectory(DirectoryEntry(selected, document.id))
                    else document.audioType?.let { mime ->
                        val key = sha256("recording\u0000$device\u0000${uri.authority}\u0000${document.id}")
                        val old = dao.recording(key)
                        if (old == null || old.fingerprint == null && (old.size != document.size || old.modified != document.modified)) {
                            dao.saveRecording(RecordingEntry(key, device, selected, document.id, document.uri.toString(), document.name,
                                mime, document.size, document.modified, System.currentTimeMillis()))
                        } else if (old.tree != selected || old.uri != document.uri.toString()) {
                            dao.saveRecording(old.copy(tree = selected, uri = document.uri.toString()))
                        }
                    }
                }
                dao.saveDirectory(directory.copy(offset = page.nextOffset, done = page.finished))
            }
            remaining -= page.documents.size
        }
        return dao.nextDirectory(selected) != null
    }

    private suspend fun transfer(enrollment: Enrollment, original: RecordingEntry, active: () -> Unit): Boolean {
        var entry = original.copy(lastAttemptAt = System.currentTimeMillis())
        dao.saveRecording(entry)
        active()
        val tree = Uri.parse(entry.tree)
        val document = source.document(tree, entry.documentId)
        if (document.size != entry.size || document.modified != entry.modified) {
            if (entry.fingerprint != null) throw SourceChanged()
            dao.saveRecording(entry.copy(size = document.size, modified = document.modified, contentHash = null, stableSince = System.currentTimeMillis(), state = "observing"))
            return true
        }
        if (entry.size <= 0) {
            note("${entry.name}: waiting for a non-empty recording with a known size.")
            return true
        }
        require(entry.size <= MAX_AUDIO_BYTES) { "Recording exceeds 100 MiB upload limit" }
        val uri = Uri.parse(entry.uri)
        val hash = source.hash(uri, entry.size, active)
        if (entry.fingerprint == null) {
            if (entry.contentHash != hash) {
                dao.saveRecording(entry.copy(contentHash = hash, stableSince = System.currentTimeMillis()))
                note("Waiting for ${entry.name} to remain unchanged for 30 seconds.")
                return true
            }
            if (System.currentTimeMillis() - entry.stableSince < 30_000) return true
            val metadata = source.metadata(uri)
            entry = entry.copy(fingerprint = sha256("${entry.key}\u0000$hash"), durationSeconds = metadata.durationSeconds,
                recordedAt = metadata.recordedAt, state = "ready", error = null)
            dao.saveRecording(entry)
        } else if (entry.contentHash != hash) throw SourceChanged()
        active()
        if (entry.uploadedBytes == null) {
            val response = api.prepare(enrollment, entry)
            val id = response.getString("callId")
            if (entry.callId != null && entry.callId != id) throw IOException("Prepared call identity changed")
            entry = entry.copy(callId = id)
            dao.saveRecording(entry)
            when (response.getString("status")) {
                "complete" -> {
                    dao.saveRecording(entry.copy(state = "complete", uploadedAt = Instant.now().toString(), error = null))
                    note("Already uploaded: ${entry.name}")
                    return false
                }
                "pending" -> Unit
                else -> throw IllegalArgumentException("Server recording is deleted or cannot be uploaded")
            }
            active()
            note("Uploading: ${entry.name} (${entry.size} bytes)")
            val uploaded = api.upload(response.getJSONObject("upload"), entry.size, hash, { source.open(uri) }, active)
            // Persist the successful PUT before any follow-up read/network operation. Process restart completes first.
            entry = entry.copy(uploadedBytes = uploaded.bytes, etag = uploaded.etag, state = "completing")
            dao.saveRecording(entry)
        }
        active()
        val current = source.document(tree, entry.documentId)
        if (current.size != entry.size || current.modified != entry.modified || source.hash(uri, entry.size, active) != entry.contentHash) throw SourceChanged()
        active()
        note("Confirming upload: ${entry.name}")
        val uploadedAt = api.complete(enrollment, entry)
        dao.saveRecording(entry.copy(state = "complete", uploadedAt = uploadedAt, error = null))
        note("Uploaded: ${entry.name}")
        return false
    }

    private fun checkFolder(selected: String) {
        if (tree() != selected) throw ContentStopped()
        if (!source.hasGrant(Uri.parse(selected))) throw SecurityException("Selected folder read grant is missing; choose the folder again")
    }

    private fun checkRecordingActive(selected: String) {
        if (!accepted()) throw ContentStopped()
        checkFolder(selected)
    }

    private fun checkHistoryActive() {
        if (!accepted()) throw ContentStopped()
        if (!callPermission()) throw SecurityException("READ_CALL_LOG is denied or restricted by the installer; call history cannot sync")
    }

    private fun refreshAccess() {
        val selected = tree()
        var accessible = false
        if (selected != null) {
            accessible = runCatching {
                val uri = Uri.parse(selected)
                source.hasGrant(uri) && source.document(uri, DocumentsContract.getTreeDocumentId(uri)).directory
            }.getOrDefault(false)
        }
        val permission = callPermission()
        mutableStatus.update { current ->
            current.copy(folderLabel = prefs.getString("folderLabel", null), folderAccessible = accessible,
                setupAccepted = accepted(),
                callLogPermissionGranted = permission,
                detail = when {
                    !accepted() -> "Sharing setup has not been accepted. No call history or recordings will upload."
                    !permission && !accessible -> "Grant call history permission or select a recording folder to start sharing."
                    !permission -> "Recordings can sync. Call history permission is denied or installer-restricted."
                    !accessible -> "Call history can sync. Select an accessible recording folder to share audio."
                    else -> current.detail
                })
        }
    }

    private suspend fun refreshCounts(device: String) {
        val selected = tree()
        val recordings = if (selected != null) dao.pendingRecordingCount(device, selected) else 0
        val pendingHistory = dao.pendingHistoryCount(device)
        val uploaded = dao.uploadedCount(device)
        val synced = dao.syncedHistoryCount(device)
        val last = dao.lastUpload(device)
        mutableStatus.update { it.copy(pendingUploads = recordings, pendingCallLogs = pendingHistory, uploadedRecordings = uploaded, syncedCallLogs = synced, lastSuccessfulUploadAt = last) }
    }

    @Synchronized
    private fun note(message: String) {
        mutableStatus.update { it.copy(detail = message, recent = (listOf(message) + it.recent).take(8)) }
        prefs.edit().putString("recent", JSONArray(status.value.recent).toString()).commit()
    }

    private fun safeError(error: Exception): String = when (error) {
        is ApiFailure -> "Server HTTP ${error.status}"
        is UploadFailure -> "Audio upload HTTP ${error.status}"
        is SecurityException -> "Read permission is missing or restricted"
        is FileNotFoundException -> "Source no longer exists or cannot be opened"
        is SourceChanged -> "Source changed; upload not completed"
        is IllegalArgumentException -> error.message ?: "Unsupported or incomplete audio"
        else -> "${error.javaClass.simpleName}; operation did not complete"
    }

    private fun rethrowCancellation(error: Exception) { if (error is CancellationException) throw error }
    private fun rethrowAuthorization(error: Exception) {
        rethrowCancellation(error)
        if (error is ApiFailure && error.status == 401) throw error
    }

    companion object { private val operationMutex = Mutex() }
}
