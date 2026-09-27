package com.microorganics.calltracker

import android.Manifest
import android.app.Application
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.CallLog
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

class CalltrackerApplication : Application() {
    internal val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    internal lateinit var repository: EnrollmentRepository
        private set

    override fun onCreate() {
        super.onCreate()
        repository = EnrollmentRepository(this)
        scope.launch { repository.restore() }
        scope.launch { repository.contentStatus.collect { repository.updateContentNotification() } }
    }
}

internal object SyncScheduler {
    private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
    private val handler = Handler(Looper.getMainLooper())
    private var observer: ContentObserver? = null
    private var observed = emptySet<String>()
    private var debounce: Runnable? = null
    private var firstChange = 0L
    private var subscriptionListener: SubscriptionManager.OnSubscriptionsChangedListener? = null
    private val callCompletionReceiver = ComponentName(BuildConfig.APPLICATION_ID, CallCompletionReceiver::class.java.name)
    private fun prefs(context: Context) = context.getSharedPreferences("sync-scheduler-v3", Context.MODE_PRIVATE)

    fun schedule(context: Context) {
        val work = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(network).setInputData(workDataOf("kind" to "recovery"))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        // Keep the existing identity so an upgrade does not duplicate periodic work.
        WorkManager.getInstance(context).enqueueUniquePeriodicWork("device-metadata-periodic", ExistingPeriodicWorkPolicy.UPDATE, work)
    }

    /** Only replace dormant URI listeners when actual access changes; never cancel a transfer. */
    @Synchronized
    fun refresh(context: Context, accepted: Boolean, callLog: Boolean, tree: Uri?) {
        val app = context.applicationContext as CalltrackerApplication
        observeSubscriptions(app)
        val completionEnabled = accepted && tree != null &&
            ContextCompat.checkSelfPermission(app, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED
        val componentState = if (completionEnabled) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
            else PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
        if (app.packageManager.getComponentEnabledSetting(callCompletionReceiver) != componentState) {
            app.packageManager.setComponentEnabledSetting(callCompletionReceiver, componentState, PackageManager.DONT_KILL_APP)
        }
        val desired = buildSet {
            if (accepted && callLog) add(CallLog.Calls.CONTENT_URI.toString())
            if (accepted && tree != null) {
                add(tree.toString())
                val root = DocumentsContract.getTreeDocumentId(tree)
                add(DocumentsContract.buildDocumentUriUsingTree(tree, root).toString())
                add(DocumentsContract.buildChildDocumentsUriUsingTree(tree, root).toString())
                // Some DocumentsProviders notify canonical children rather than the tree URI.
                add(DocumentsContract.buildChildDocumentsUri(tree.authority!!, root).toString())
                add(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI.toString())
                add("content://${MediaStore.AUTHORITY}/")
            }
        }
        if (desired != observed || observer == null) {
            observer?.let { app.contentResolver.unregisterContentObserver(it) }
            val listener = object : ContentObserver(handler) {
                override fun onChange(selfChange: Boolean) = changed(app)
                override fun onChange(selfChange: Boolean, uri: Uri?) = changed(app)
                override fun onChange(selfChange: Boolean, uri: Uri?, flags: Int) = changed(app)
                override fun onChange(selfChange: Boolean, uris: MutableCollection<Uri>, flags: Int) = changed(app)
            }
            val allowed = desired.filterTo(sortedSetOf()) { uri ->
                runCatching { app.contentResolver.registerContentObserver(Uri.parse(uri), true, listener) }.isSuccess
            }
            observer = listener
            observed = desired
            val signature = allowed.joinToString("\n")
            val state = prefs(app)
            if (state.getString("uris", "") != signature) {
                val manager = WorkManager.getInstance(app)
                manager.cancelUniqueWork("content-trigger-0")
                manager.cancelUniqueWork("content-trigger-1")
                check(state.edit().putString("uris", signature).putInt("triggerSlot", 0).commit())
                if (signature.isNotEmpty()) enqueue(app)
            }
        }
        armTrigger(app)
    }

    private fun observeSubscriptions(app: CalltrackerApplication) {
        handler.post {
            val manager = app.getSystemService(SubscriptionManager::class.java) ?: return@post
            val granted = ContextCompat.checkSelfPermission(app, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                subscriptionListener?.let { runCatching { manager.removeOnSubscriptionsChangedListener(it) } }
                subscriptionListener = null
            } else if (subscriptionListener == null) {
                val listener = object : SubscriptionManager.OnSubscriptionsChangedListener() {
                    override fun onSubscriptionsChanged() { app.scope.launch { app.repository.refreshSim() } }
                }
                subscriptionListener = listener
                @Suppress("DEPRECATION")
                try { manager.addOnSubscriptionsChangedListener(listener) }
                catch (_: SecurityException) { subscriptionListener = null }
                catch (_: UnsupportedOperationException) { subscriptionListener = null }
            }
        }
    }

    private fun changed(app: CalltrackerApplication) {
        // Called on the main handler. A continuous provider stream cannot postpone this indefinitely.
        val now = SystemClock.elapsedRealtime()
        if (firstChange == 0L) firstChange = now
        debounce?.let(handler::removeCallbacks)
        val task = Runnable {
            firstChange = 0L
            debounce = null
            app.scope.launch { enqueue(app) }
        }
        debounce = task
        handler.postDelayed(task, minOf(1_000L, maxOf(0L, 5_000L - (now - firstChange))))
    }

    private fun armTrigger(context: Context, replaceConsumed: Boolean = false) {
        val state = prefs(context)
        val signature = state.getString("uris", "").orEmpty()
        if (signature.isEmpty()) return
        val slot = state.getInt("triggerSlot", 0)
        val constraints = Constraints.Builder().setTriggerContentUpdateDelay(1, TimeUnit.SECONDS)
            .setTriggerContentMaxDelay(5, TimeUnit.SECONDS)
        signature.lines().forEach { constraints.addContentUriTrigger(Uri.parse(it), true) }
        val work = OneTimeWorkRequestBuilder<ContentTriggerWorker>().setConstraints(constraints.build())
            .setInputData(workDataOf("slot" to slot, "signature" to signature)).build()
        WorkManager.getInstance(context).enqueueUniqueWork("content-trigger-$slot",
            if (replaceConsumed) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, work).result.get()
    }

    @Synchronized
    fun consumeTrigger(context: Context, slot: Int, signature: String) {
        val state = prefs(context)
        if (state.getString("uris", "") != signature || state.getInt("triggerSlot", 0) != slot) return
        // A distinct successor can be registered while this short dispatcher is still running.
        // There are at most two dispatcher slots, not an ever-growing APPEND chain.
        check(state.edit().putInt("triggerSlot", 1 - slot).commit())
        // An older dispatcher in that slot may still be returning success. It has already
        // handed off its work under this lock, so replacing it cannot cancel a transfer.
        armTrigger(context, replaceConsumed = true)
        enqueue(context)
    }

    @Synchronized
    fun enqueue(context: Context, manual: Boolean = false) {
        if (manual) queue(context, "manual", expedited = true)
        else queue(context, "event-${prefs(context).getInt("eventSlot", 0)}")
        finalizationChecks(context)
    }

    @Synchronized
    fun started(context: Context, kind: String) {
        if (kind.startsWith("event-")) {
            val slot = kind.substringAfter('-').toInt()
            check(prefs(context).edit().putInt("eventSlot", 1 - slot).commit())
        }
    }

    @Synchronized
    fun continueBacklog(context: Context, kind: String) {
        val next = if (kind == "backlog-0") 1 else 0
        queue(context, "backlog-$next", delaySeconds = 5)
    }

    fun retry(context: Context) = queue(context, "retry", delaySeconds = 30)

    fun finalizationChecks(context: Context) {
        // Only these two near-term attempts; an unfinished/zero-length file falls back to periodic recovery.
        queue(context, "settle-35", delaySeconds = 35)
        queue(context, "settle-120", delaySeconds = 120)
    }

    private fun queue(context: Context, kind: String, delaySeconds: Long = 0, expedited: Boolean = false) {
        val builder = OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(network)
            .setInputData(workDataOf("kind" to kind))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        if (delaySeconds > 0) builder.setInitialDelay(delaySeconds, TimeUnit.SECONDS)
        if (expedited) builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        WorkManager.getInstance(context).enqueueUniqueWork("content-sync-$kind", ExistingWorkPolicy.KEEP, builder.build()).result.get()
    }
}

/** System-scheduled content URI work wakes a dead process without holding a foreground service open. */
class ContentTriggerWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        SyncScheduler.consumeTrigger(applicationContext, inputData.getInt("slot", 0), inputData.getString("signature").orEmpty())
        return Result.success()
    }
}

class SyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun getForegroundInfo(): ForegroundInfo = StatusNotification.foreground(applicationContext)

    override suspend fun doWork(): Result {
        val kind = inputData.getString("kind") ?: "recovery"
        SyncScheduler.started(applicationContext, kind)
        return when ((applicationContext as CalltrackerApplication).repository.sync()) {
            SyncOutcome.SUCCESS -> Result.success()
            SyncOutcome.MORE -> {
                SyncScheduler.continueBacklog(applicationContext, kind)
                if (!kind.startsWith("settle-")) SyncScheduler.finalizationChecks(applicationContext)
                Result.success()
            }
            SyncOutcome.SETTLING -> {
                if (!kind.startsWith("settle-")) SyncScheduler.finalizationChecks(applicationContext)
                Result.success()
            }
            SyncOutcome.RETRY -> {
                // Event and user work never remain stuck in retry backoff. One independent lane retries failures.
                if (kind == "retry") Result.retry()
                else { SyncScheduler.retry(applicationContext); Result.success() }
            }
            SyncOutcome.FAILED -> Result.failure()
        }
    }
}

class SyncReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != "com.microorganics.calltracker.SYNC") return
        val pending = goAsync()
        val app = context.applicationContext as CalltrackerApplication
        app.scope.launch {
            try { app.repository.restore(); app.repository.requestSync() }
            finally { pending.finish() }
        }
    }
}

/** A call-end scheduling signal, not an alternative source of permission-denied call history. */
class CallCompletionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED ||
            intent.getStringExtra(TelephonyManager.EXTRA_STATE) != TelephonyManager.EXTRA_STATE_IDLE ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) return
        val pending = goAsync()
        val app = context.applicationContext as CalltrackerApplication
        app.scope.launch {
            // The opt-in component gate and worker's fresh access checks remain authoritative.
            // Do not wait for repository/network locks inside the broadcast lifetime.
            try { SyncScheduler.enqueue(app) }
            finally { pending.finish() }
        }
    }
}
