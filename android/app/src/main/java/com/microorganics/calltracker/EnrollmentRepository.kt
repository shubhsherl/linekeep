package com.microorganics.calltracker

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
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
)

internal enum class SyncOutcome { SUCCESS, MORE, SETTLING, RETRY, FAILED }

internal class EnrollmentRepository(private val context: Context) {
    private val store = EnrollmentStore(context)
    private val api = DeviceApi()
    private val contentSync = ContentSync(context, api)
    val contentStatus = contentSync.status
    private val simReader = SimReader(context)
    private val mutex = Mutex()
    private var loaded = false
    private var enrollment: Enrollment? = null
    private val mutableStatus = MutableStateFlow(DeviceStatus())
    val status = mutableStatus.asStateFlow()

    private fun publish(value: DeviceStatus) {
        mutableStatus.value = value
        updateContentNotification()
    }

    fun updateContentNotification() {
        val content = contentStatus.value
        StatusNotification.show(context, mutableStatus.value.copy(
            pendingUploads = content.pendingUploads,
            lastSuccessfulUploadAt = content.lastSuccessfulUploadAt,
        ))
    }

    private fun enrollmentStatus(message: String, busy: Boolean = false): DeviceStatus {
        val current = enrollment
        return mutableStatus.value.copy(
            loaded = true, deviceId = current?.deviceId, employeeId = current?.employeeId.orEmpty(),
            employeeName = current?.employeeName.orEmpty(), lastSync = current?.lastSync.orEmpty(),
            invitationId = current?.invitationId, lastInvitationId = current?.lastInvitationId,
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
                else -> "Not enrolled. Enter a one-time invitation from your manager."
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
        try {
            contentSync.restore()
            refreshScheduling()
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            publish(mutableStatus.value.copy(message = "Sync storage or folder access could not be opened. No content was uploaded."))
        }
        updateContentNotification()
    }

    suspend fun selectRecordingFolder(uri: Uri) = contentAction { contentSync.selectFolder(uri) }

    suspend fun inspectRecordingFolder() = contentAction { contentSync.inspectFolder() }

    suspend fun acceptSetup() = contentAction { contentSync.acceptSetup() }

    private fun refreshScheduling() {
        val current = contentStatus.value
        SyncScheduler.refresh(context, canSync() && current.setupAccepted,
            current.callLogPermissionGranted, contentSync.recordingTree().takeIf { current.folderAccessible })
    }

    private suspend fun contentAction(action: suspend () -> Unit) = withContext(Dispatchers.IO) {
        try {
            action()
            refreshScheduling()
            if (canSync() && contentStatus.value.setupAccepted) SyncScheduler.enqueue(context)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            publish(mutableStatus.value.copy(message = "The sync setting or folder could not be saved. Check access and try again."))
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
            if (changed && syncIfChanged && canSync()) SyncScheduler.enqueue(context)
        }
    }

    suspend fun enroll(invitation: String) = withContext(Dispatchers.IO) {
        mutex.withLock {
            load()
            if (enrollment != null || mutableStatus.value.storageUnavailable || invitation.isBlank()) return@withLock
            val snapshot = simReader.read()
            publish(enrollmentStatus("Enrolling this installation…", busy = true).copy(sim = snapshot))
            try {
                enrollment = api.register(invitation.trim(), snapshot.numbers)
                store.save(checkNotNull(enrollment))
                publish(enrollmentStatus("Enrollment saved securely. Metadata heartbeat queued."))
                SyncScheduler.schedule(context)
                refreshScheduling()
                SyncScheduler.enqueue(context)
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                val message = when {
                    enrollment != null -> "Server enrollment succeeded but encrypted storage failed. Keep this app installed and contact your manager."
                    error is ApiFailure && error.status in listOf(400, 401, 403, 404, 409, 410) -> "Invitation rejected (HTTP ${error.status}). Ask your manager for a valid unused invitation."
                    error is ApiFailure -> "Enrollment failed (HTTP ${error.status}). No automatic retry; check with your manager before retrying."
                    else -> "Enrollment did not finish. Check your connection. If the invitation was consumed, ask your manager to inspect the device before issuing another."
                }
                publish(enrollmentStatus(message).copy(storageUnavailable = enrollment != null))
            }
        }
    }

    private fun canSync(): Boolean = enrollment != null && enrollment?.unauthorized != true && !mutableStatus.value.storageUnavailable

    suspend fun requestSync() = withContext(Dispatchers.IO) {
        val state = mutableStatus.value
        if (state.deviceId != null && !state.unauthorized && !state.storageUnavailable) {
            if (!state.busy) publish(state.copy(message = "Sync queued; waiting for network and Android scheduling."))
            SyncScheduler.enqueue(context, manual = true)
        }
    }

    suspend fun sync(): SyncOutcome = withContext(Dispatchers.IO) {
        mutex.withLock {
            load()
            if (!canSync()) return@withLock SyncOutcome.FAILED
            val current = checkNotNull(enrollment)
            val snapshot = simReader.read()
            publish(enrollmentStatus("Authenticating and refreshing device assignment…", busy = true).copy(sim = snapshot))
            try {
                contentSync.restore()
                refreshScheduling()
                val before = contentStatus.value
                enrollment = api.heartbeat(current, snapshot.numbers, before.pendingUploads, before.lastSuccessfulUploadAt)
                store.save(checkNotNull(enrollment))
                publish(enrollmentStatus("Synchronizing granted call history and recording resources…", busy = true))
                val result = contentSync.synchronize(checkNotNull(enrollment))
                val after = contentStatus.value
                if (after.pendingUploads != before.pendingUploads || after.lastSuccessfulUploadAt != before.lastSuccessfulUploadAt) {
                    enrollment = api.heartbeat(checkNotNull(enrollment), simReader.read().numbers, after.pendingUploads, after.lastSuccessfulUploadAt)
                    store.save(checkNotNull(enrollment))
                }
                publish(enrollmentStatus(when {
                    !after.setupAccepted -> "Device status synced. Accept sharing setup to synchronize granted resources."
                    else -> after.detail
                }))
                when {
                    result.retry -> SyncOutcome.RETRY
                    result.more -> SyncOutcome.MORE
                    result.settling -> SyncOutcome.SETTLING
                    else -> SyncOutcome.SUCCESS
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (error is ApiFailure && error.status == 401) {
                    enrollment = checkNotNull(enrollment).copy(unauthorized = true)
                    val stored = runCatching { store.save(checkNotNull(enrollment)) }.isSuccess
                    publish(enrollmentStatus("Enrollment unauthorized or revoked. Contact your manager; this installation will not re-enroll automatically.")
                        .copy(storageUnavailable = !stored))
                    SyncOutcome.FAILED
                } else {
                    val retry = error is IOException && (error !is ApiFailure || error.status == 429 || error.status >= 500)
                    publish(enrollmentStatus(if (retry) "Sync failed; Android will retry with network access. Assignment shown is the last known value."
                        else "Sync could not be completed or saved. Contact your manager. Assignment shown may be out of date."))
                    if (retry) SyncOutcome.RETRY else SyncOutcome.FAILED
                }
            } finally {
                refreshScheduling()
                if (mutableStatus.value.busy) publish(mutableStatus.value.copy(busy = false))
            }
        }
    }
}
