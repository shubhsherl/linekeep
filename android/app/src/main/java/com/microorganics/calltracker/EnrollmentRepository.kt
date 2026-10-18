package com.microorganics.calltracker

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.IOException

internal data class DeviceStatus(
    val loaded: Boolean = false,
    val deviceId: String? = null,
    val employeeName: String = "",
    val employeeId: String = "",
    val lastSync: String = "",
    val unauthorized: Boolean = false,
    val storageUnavailable: Boolean = false,
    val busy: Boolean = false,
    val message: String = "Loading encrypted enrollment…",
    val sim: SimSnapshot = SimSnapshot(emptyList(), "Checking phone permission…"),
    val pendingUploads: Int = 0,
    val invitationId: String? = null,
    val lastInvitationId: String? = null,
    val lastSuccessfulUploadAt: String? = null,
    val pendingCallLogs: Int = 0,
    val recordingWaitMessage: String? = null,
    val heartbeatMessage: String? = null,
    val credentialHint: String = "",
)

/** Enough to tell installations apart without exposing a usable bearer token. */
internal fun maskCredential(secret: String): String =
    if (secret.length < 24) "•".repeat(12) else secret.take(4) + "••••••••••••" + secret.takeLast(4)

internal enum class SyncOutcome { SUCCESS, MORE, SETTLING, RETRY, FAILED }

internal class EnrollmentRepository(private val context: Context) {
    private val store = EnrollmentStore(context)
    private val api = DeviceApi { serverUrl() }
    private val contentSync = ContentSync(context, api)
    val contentStatus = contentSync.status
    private val simReader = SimReader(context)
    private val mutex = Mutex()
    private val contentTransferMutex = Mutex()
    private val heartbeatMutex = Mutex()
    private var loaded = false
    private var enrollment: Enrollment? = null
    private val mutableStatus = MutableStateFlow(DeviceStatus())
    val status = mutableStatus.asStateFlow()

    /** The server that device requests go to right now, or null when none is configured. */
    fun serverUrl(): String? = ServerConfig.current(context)

    private fun publish(value: DeviceStatus) {
        mutableStatus.value = value
        updateContentNotification()
    }

    fun updateContentNotification() {
        val content = contentStatus.value
        StatusNotification.show(context, mutableStatus.value.copy(
            pendingUploads = content.pendingUploads,
            lastSuccessfulUploadAt = content.lastSuccessfulUploadAt,
            pendingCallLogs = content.pendingCallLogs,
            recordingWaitMessage = content.recordingWaitMessage,
        ))
    }

    private fun enrollmentStatus(message: String, busy: Boolean = false): DeviceStatus {
        val current = enrollment
        return mutableStatus.value.copy(
            loaded = true, deviceId = current?.deviceId, employeeId = current?.employeeId.orEmpty(),
            employeeName = current?.employeeName.orEmpty(), lastSync = current?.lastSync.orEmpty(),
            invitationId = current?.invitationId, lastInvitationId = current?.lastInvitationId,
            credentialHint = current?.token?.let(::maskCredential).orEmpty(),
            unauthorized = current?.unauthorized == true, message = message, busy = busy,
        )
    }

    private fun load() {
        if (loaded) return
        loaded = true
        try {
            enrollment = store.load()
            publish(enrollmentStatus(when {
                enrollment?.unauthorized == true -> "Enrollment unauthorized or revoked. Contact your manager; no replacement enrollment was attempted."
                enrollment != null -> "Enrolled. Sync to refresh the current assignment."
                else -> "Not enrolled. Scan the setup QR code or enter a one-time code from your manager."
            }).copy(sim = simReader.read()))
            if (enrollment != null && enrollment?.unauthorized != true) SyncScheduler.schedule(context)
        } catch (_: Exception) {
            publish(mutableStatus.value.copy(loaded = true, storageUnavailable = true,
                message = "Encrypted enrollment cannot be opened. Contact your manager; existing credentials were not replaced."))
        }
    }

    suspend fun restore() = withContext(Dispatchers.IO) {
        mutex.withLock { load() }
        refreshContent()
    }

    suspend fun refreshContent() = withContext(Dispatchers.IO) {
        val before = contentStatus.value
        try {
            contentSync.restore()
            mutex.withLock {
                refreshScheduling()
                val after = contentStatus.value
                if (canSync() && (before.setupAccepted != after.setupAccepted ||
                        before.callLogPermissionGranted != after.callLogPermissionGranted ||
                        before.folderAccessible != after.folderAccessible)) {
                    SyncScheduler.enqueueHeartbeat(context)
                }
            }
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            mutex.withLock {
                if (!mutableStatus.value.unauthorized && !mutableStatus.value.storageUnavailable) {
                    publish(mutableStatus.value.copy(message = "Sync storage or folder access could not be opened. Existing uploads remain queued."))
                }
            }
        }
        updateContentNotification()
    }

    suspend fun selectRecordingFolder(uri: Uri) = contentAction { contentSync.selectFolder(uri) }

    suspend fun inspectRecordingFolder() = contentAction(enqueueContent = false) { contentSync.inspectFolder() }

    suspend fun acceptSetup() = contentAction { contentSync.acceptSetup() }

    private fun refreshScheduling() {
        val current = contentStatus.value
        SyncScheduler.refresh(context, canSync() && current.setupAccepted,
            current.callLogPermissionGranted, contentSync.recordingTree().takeIf { current.folderAccessible })
    }

    private suspend fun contentAction(enqueueContent: Boolean = true, action: suspend () -> Unit) = withContext(Dispatchers.IO) {
        try {
            action()
            mutex.withLock {
                load()
                refreshScheduling()
                if (canSync()) {
                    SyncScheduler.enqueueHeartbeat(context)
                    if (enqueueContent && contentStatus.value.setupAccepted) SyncScheduler.enqueue(context)
                }
            }
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            mutex.withLock {
                if (!mutableStatus.value.unauthorized && !mutableStatus.value.storageUnavailable) {
                    publish(mutableStatus.value.copy(message = "The sync setting or folder could not be saved. Check access and try again."))
                }
            }
        } finally {
            updateContentNotification()
        }
    }

    suspend fun refreshSim(syncIfChanged: Boolean = true) = withContext(Dispatchers.IO) {
        mutex.withLock {
            load()
            val snapshot = simReader.read()
            val changed = snapshot != mutableStatus.value.sim
            publish(mutableStatus.value.copy(sim = snapshot))
            refreshScheduling()
            if (changed && syncIfChanged && canSync()) SyncScheduler.enqueueHeartbeat(context)
        }
    }

    /** Saves the server before enrollment only; the server receives bearer tokens, so it never changes while enrolled. */
    suspend fun setServer(origin: String) = withContext(Dispatchers.IO) {
        mutex.withLock {
            load()
            if (enrollment != null || mutableStatus.value.storageUnavailable) {
                publish(mutableStatus.value.copy(message = "The server cannot be changed while this phone is connected."))
                return@withLock
            }
            try {
                ServerConfig.save(context, origin)
                publish(enrollmentStatus("Server saved. Enter a setup code to connect."))
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                publish(enrollmentStatus("The server could not be saved. Try again."))
            }
        }
    }

    /** [server], when given, is a validated origin from a confirmed QR code or the Advanced form; it is saved first. */
    suspend fun enroll(invitation: String, server: String? = null) = withContext(Dispatchers.IO) {
        mutex.withLock {
            load()
            if (enrollment != null || mutableStatus.value.storageUnavailable || invitation.isBlank()) return@withLock
            if (server != null) {
                try {
                    ServerConfig.save(context, server)
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    publish(enrollmentStatus("The server could not be saved. Try again."))
                    return@withLock
                }
            }
            if (serverUrl() == null) {
                publish(enrollmentStatus("No server is set. Scan a setup QR code or set the server URL in Advanced."))
                return@withLock
            }
            val snapshot = simReader.read()
            publish(enrollmentStatus("Enrolling this installation…", busy = true).copy(sim = snapshot))
            try {
                enrollment = api.register(invitation.trim(), snapshot.numbers)
                store.save(checkNotNull(enrollment))
                publish(enrollmentStatus("Enrollment saved securely. Granted resources queued for sync.")
                    .copy(heartbeatMessage = "Metadata heartbeat queued."))
                SyncScheduler.schedule(context)
                refreshScheduling()
                SyncScheduler.enqueue(context)
                SyncScheduler.enqueueHeartbeat(context)
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                val message = when {
                    enrollment != null -> "Server enrollment succeeded but encrypted storage failed. Keep this app installed and contact your manager."
                    error is ApiFailure && error.status in listOf(400, 401, 403, 404, 409, 410) -> "Invitation rejected (HTTP ${error.status}). Ask your manager for a valid unused invitation."
                    error is ApiFailure -> "Enrollment failed (HTTP ${error.status}). No automatic retry; check with your manager before retrying."
                    error is ServerNotSet -> "No server is set. Scan a setup QR code or set the server URL in Advanced."
                    else -> "Enrollment did not finish. Check your connection. If the invitation was consumed, ask your manager to inspect the device before issuing another."
                }
                publish(enrollmentStatus(message).copy(storageUnavailable = enrollment != null))
            }
        }
    }

    private fun canSync(): Boolean = enrollment != null && enrollment?.unauthorized != true && !mutableStatus.value.storageUnavailable

    /**
     * Runs one authenticated request for the Customers and Chats tabs with the current credentials.
     * A 401 revokes the enrollment exactly as a content sync would; the caller still receives the failure.
     */
    suspend fun <T> authorized(call: (Enrollment) -> T): T = withContext(Dispatchers.IO) {
        val current = mutex.withLock {
            load()
            if (canSync()) enrollment else null
        } ?: throw NotConnected(revoked = mutableStatus.value.unauthorized)
        try {
            call(current)
        } catch (error: ApiFailure) {
            if (error.status == 401) mutex.withLock { handleFailure(current, error, heartbeat = false) }
            throw error
        }
    }

    suspend fun requestSync() = withContext(Dispatchers.IO) {
        mutex.withLock {
            load()
            if (canSync()) {
                if (!mutableStatus.value.busy) publish(enrollmentStatus("Local discovery queued; uploads wait for network and Android scheduling."))
                SyncScheduler.enqueue(context, manual = true)
                SyncScheduler.enqueueHeartbeat(context)
            }
        }
    }

    suspend fun discover(callEndedAt: Long? = null): Long? = withContext(Dispatchers.IO) {
        val current = mutex.withLock {
            load()
            enrollment.takeIf { canSync() }
        } ?: return@withContext null
        try {
            // Local capture must not wait for a heartbeat or a large recording transfer.
            contentSync.discover(current, callEndedAt)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            mutex.withLock {
                if (isCurrent(current)) publish(enrollmentStatus(
                    "Local call history or recording discovery could not finish. Saved items remain queued.",
                    busy = mutableStatus.value.busy,
                ))
            }
            throw error
        } finally {
            withContext(NonCancellable) {
                mutex.withLock { refreshScheduling() }
                updateContentNotification()
            }
        }
    }

    suspend fun sync(): SyncOutcome = withContext(Dispatchers.IO) {
        contentTransferMutex.withLock {
            val current = mutex.withLock {
                load()
                if (!canSync()) null else checkNotNull(enrollment).also {
                    publish(enrollmentStatus("Synchronizing granted call history and recording resources…", busy = true))
                }
            } ?: return@withLock SyncOutcome.FAILED
            try {
                val result = contentSync.synchronize(current)
                mutex.withLock {
                    if (!isCurrent(current)) return@withLock SyncOutcome.FAILED
                    val after = contentStatus.value
                    publish(enrollmentStatus(if (!after.setupAccepted)
                        "Accept sharing setup to synchronize granted resources." else after.detail))
                    when {
                        result.retry -> SyncOutcome.RETRY
                        result.more -> SyncOutcome.MORE
                        result.settling -> SyncOutcome.SETTLING
                        else -> SyncOutcome.SUCCESS
                    }
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                mutex.withLock { handleFailure(current, error, heartbeat = false) }
            } finally {
                withContext(NonCancellable) {
                    mutex.withLock {
                        refreshScheduling()
                        if (mutableStatus.value.busy) publish(mutableStatus.value.copy(busy = false))
                    }
                }
            }
        }
    }

    suspend fun heartbeat(): SyncOutcome = withContext(Dispatchers.IO) {
        heartbeatMutex.withLock {
            val current = mutex.withLock {
                load()
                if (!canSync()) null else checkNotNull(enrollment).also {
                    publish(enrollmentStatus(mutableStatus.value.message, mutableStatus.value.busy).copy(
                        sim = simReader.read(), heartbeatMessage = "Refreshing device status and assignment…",
                    ))
                }
            } ?: return@withLock SyncOutcome.FAILED
            try {
                contentSync.restore()
                val content = contentStatus.value
                val refreshed = api.heartbeat(current, simReader.read().numbers,
                    content.pendingUploads, content.lastSuccessfulUploadAt)
                mutex.withLock {
                    // A content request may have revoked this token while the heartbeat was in flight.
                    if (!isCurrent(current)) return@withLock SyncOutcome.FAILED
                    store.save(refreshed)
                    enrollment = refreshed
                    publish(enrollmentStatus(mutableStatus.value.message, mutableStatus.value.busy).copy(
                        heartbeatMessage = "Device status and assignment refreshed. Content uploads are tracked separately.",
                    ))
                    SyncOutcome.SUCCESS
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                mutex.withLock { handleFailure(current, error, heartbeat = true) }
            } finally {
                withContext(NonCancellable) {
                    mutex.withLock {
                        refreshScheduling()
                        if (mutableStatus.value.heartbeatMessage == "Refreshing device status and assignment…") {
                            publish(mutableStatus.value.copy(heartbeatMessage = "Device heartbeat interrupted; last confirmed heartbeat is shown."))
                        }
                    }
                }
            }
        }
    }

    /**
     * Forgets a credential the server has already rejected (revoked, or replaced by a recovery) so the phone can be set
     * up again with a new code. Allowed only after a 401: a working connection is never dropped from here.
     */
    suspend fun resetRejectedConnection() = withContext(Dispatchers.IO) {
        mutex.withLock {
            load()
            if (enrollment?.unauthorized != true || mutableStatus.value.storageUnavailable) return@withLock
            try {
                store.clear()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                publish(mutableStatus.value.copy(message = "The old connection could not be removed. Try again."))
                return@withLock
            }
            enrollment = null
            val work = androidx.work.WorkManager.getInstance(context)
            work.cancelUniqueWork("device-metadata-periodic")
            work.cancelUniqueWork("device-heartbeat")
            refreshScheduling()
            publish(enrollmentStatus("Old connection removed. Scan a new setup or recovery code from your manager.")
                .copy(heartbeatMessage = null))
        }
    }

    /** Called under mutex: only the current, non-revoked credentials may publish a successful result. */
    private fun isCurrent(snapshot: Enrollment): Boolean =
        canSync() && enrollment?.deviceId == snapshot.deviceId && enrollment?.token == snapshot.token

    private fun handleFailure(current: Enrollment, error: Exception, heartbeat: Boolean): SyncOutcome {
        if (!isCurrent(current)) return SyncOutcome.FAILED
        if (error is ApiFailure && error.status == 401) {
            enrollment = checkNotNull(enrollment).copy(unauthorized = true)
            val stored = runCatching { store.save(checkNotNull(enrollment)) }.isSuccess
            publish(enrollmentStatus("Enrollment unauthorized or revoked. Contact your manager; this installation will not re-enroll automatically.")
                .copy(storageUnavailable = !stored, heartbeatMessage = null))
            return SyncOutcome.FAILED
        }
        val retry = error is IOException && (error !is ApiFailure || error.status == 429 || error.status >= 500)
        if (heartbeat) {
            publish(mutableStatus.value.copy(heartbeatMessage = if (retry)
                "Device heartbeat failed; Android will retry independently of content uploads. Assignment shown is the last known value."
                else "Device heartbeat could not be completed or saved. Contact your manager. Assignment shown may be out of date."))
        } else {
            publish(enrollmentStatus(if (retry)
                "Content sync failed; Android will retry with network access. Saved items remain queued."
                else "Content sync could not be completed. Check resource status or contact your manager."))
        }
        return if (retry) SyncOutcome.RETRY else SyncOutcome.FAILED
    }
}
