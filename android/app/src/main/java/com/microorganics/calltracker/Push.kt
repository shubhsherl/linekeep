@file:Suppress("DEPRECATION") // FirebaseMessaging.getToken/deleteToken are flagged deprecated but remain the supported token API.

package com.microorganics.calltracker

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume

internal const val EXTRA_PUSH_TYPE = "type"
internal const val EXTRA_PUSH_CUSTOMER_ID = "customerId"
internal const val EXTRA_PUSH_CUSTOMER_NAME = "customerName"

/** Firebase options the server handed out, kept in plain app preferences (public client identifiers, not secrets). */
internal class PushConfigStore(context: Context) {
    private val prefs = context.getSharedPreferences("push-config", Context.MODE_PRIVATE)

    fun load(): FirebaseConfig? = FirebaseConfig(
        prefs.getString(API_KEY, null).orEmpty(), prefs.getString(APP_ID, null).orEmpty(),
        prefs.getString(PROJECT_ID, null).orEmpty(), prefs.getString(SENDER_ID, null).orEmpty(),
    ).takeIf { it.complete }

    fun save(config: FirebaseConfig) {
        prefs.edit().putString(API_KEY, config.apiKey).putString(APP_ID, config.appId)
            .putString(PROJECT_ID, config.projectId).putString(SENDER_ID, config.senderId).apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    private companion object {
        const val API_KEY = "apiKey"
        const val APP_ID = "appId"
        const val PROJECT_ID = "projectId"
        const val SENDER_ID = "senderId"
    }
}

/** The one-time manual FirebaseApp initialization from server-supplied options, falling back to the build's values. */
internal object PushConfig {
    private val build = FirebaseConfig(
        BuildConfig.FIREBASE_API_KEY, BuildConfig.FIREBASE_APP_ID, BuildConfig.FIREBASE_PROJECT_ID, BuildConfig.FIREBASE_SENDER_ID,
    )

    /** True only when FirebaseApp was initialized; push stays off otherwise and never throws. */
    @Volatile var enabled: Boolean = false
        private set

    /** The options FirebaseApp runs with in this process, or null when it is not initialized. */
    @Volatile var applied: FirebaseConfig? = null
        private set

    /** Application start: stored options first, then the build fallback, else push stays off. */
    fun initialize(context: Context) {
        resolveFirebaseOptions(PushConfigStore(context).load(), build)?.let { apply(context, it) }
    }

    /** Initializes FirebaseApp with [config] unless it is already initialized (it cannot be re-initialized). */
    fun apply(context: Context, config: FirebaseConfig) {
        try {
            val existing = FirebaseApp.getApps(context).firstOrNull()
            if (existing == null) FirebaseApp.initializeApp(context, config.toOptions())
            val running = existing?.options
            applied = if (running == null) config else FirebaseConfig(
                running.apiKey, running.applicationId, running.projectId.orEmpty(), running.gcmSenderId.orEmpty(),
            )
            enabled = true
        } catch (_: Exception) {
            enabled = false
        }
    }

    /** Push is off for the rest of this process, e.g. after the server withdrew its configuration. */
    fun disable() {
        enabled = false
    }

    private fun FirebaseConfig.toOptions(): FirebaseOptions = FirebaseOptions.Builder()
        .setApiKey(apiKey).setApplicationId(appId).setProjectId(projectId).setGcmSenderId(senderId).build()
}

/** True while the main activity is started; the messaging service uses it to skip a push for the visible chat. */
internal object AppVisibility {
    @Volatile var foreground: Boolean = false
}

private suspend fun <T> Task<T>.await(): T? = suspendCancellableCoroutine { continuation ->
    addOnCompleteListener { task -> continuation.resume(if (task.isSuccessful) task.result else null) }
}

/**
 * Keeps the server's copy of this phone's FCM token current. Registration needs an enrolled, authorized device and is
 * idempotent; a failure is silent and retried on the next app start or token refresh.
 */
internal class PushRegistrar(context: Context, private val repository: EnrollmentRepository) {
    private val appContext = context.applicationContext
    private val prefs = context.getSharedPreferences("push-token", Context.MODE_PRIVATE)
    private val configStore = PushConfigStore(context)
    private val api = DeviceApi(repository::serverUrl)
    private val mutex = Mutex()

    /** Registers [known] (a refreshed token) or the current FCM token with the server. */
    suspend fun register(known: String? = null) = withContext(Dispatchers.IO) {
        if (!PushConfig.enabled) return@withContext
        mutex.withLock {
            if (known != null) prefs.edit().putString(TOKEN, known).apply()
            if (repository.status.value.deviceId == null) return@withLock
            val token = known
                ?: FirebaseMessaging.getInstance().token.await()?.takeIf { it.isNotBlank() }
                ?: prefs.getString(TOKEN, null)
                ?: return@withLock
            prefs.edit().putString(TOKEN, token).apply()
            try {
                repository.authorized { enrollment ->
                    val registered = "${enrollment.deviceId}|$token"
                    if (prefs.getString(REGISTERED, null) != registered) {
                        api.putPushToken(enrollment, token)
                        prefs.edit().putString(REGISTERED, registered).apply()
                    }
                    Unit
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
            }
        }
    }

    /**
     * Asks the server which Firebase project to use. New or changed options are stored; FirebaseApp is initialized now only
     * if this process has none yet, otherwise the change applies at the next start. A failed call changes nothing; a null
     * answer after options were stored turns push off and drops the local token.
     */
    suspend fun refreshConfig() = withContext(Dispatchers.IO) {
        mutex.withLock {
            if (repository.status.value.deviceId == null) return@withLock
            val fromServer = try {
                repository.authorized { enrollment -> api.pushConfig(enrollment) }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                return@withLock
            }
            when (val decision = decidePushConfig(configStore.load(), fromServer, PushConfig.applied)) {
                PushConfigDecision.Keep -> Unit
                is PushConfigDecision.Save -> {
                    configStore.save(decision.config)
                    if (decision.initializeNow) PushConfig.apply(appContext, decision.config)
                }
                PushConfigDecision.Remove -> {
                    forgetLocked()
                    PushConfig.disable()
                }
            }
        }
    }

    /** Drops the local copy and invalidates the FCM token after the connection was removed. */
    suspend fun forget() = withContext(Dispatchers.IO) {
        mutex.withLock { forgetLocked() }
    }

    private suspend fun forgetLocked() {
        val wasRegistered = prefs.contains(REGISTERED)
        prefs.edit().clear().apply()
        configStore.clear()
        if (wasRegistered && PushConfig.enabled) {
            try { FirebaseMessaging.getInstance().deleteToken().await() } catch (error: Exception) {
                if (error is CancellationException) throw error
            }
        }
    }

    private companion object {
        const val TOKEN = "token"
        const val REGISTERED = "registered"
    }
}

internal object PushNotifications {
    const val CHANNEL_ID = "chats"

    /** Runtime permission, the app-wide switch and the chats channel must all allow notifications. */
    fun enabled(context: Context): Boolean {
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        val channel = context.getSystemService(NotificationManager::class.java)?.getNotificationChannel(CHANNEL_ID)
        return channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
    }

    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, context.getString(R.string.chats_channel_name), NotificationManager.IMPORTANCE_HIGH).apply {
                description = context.getString(R.string.chats_channel_description)
            },
        )
    }

    fun openIntent(context: Context, type: String, customerId: String, customerName: String): PendingIntent {
        val intent = Intent(context, SettingsActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            // Extras do not distinguish PendingIntents; a distinct data URI keeps each chat's tap target separate.
            .setData(Uri.Builder().scheme("linekeep").authority("open").appendPath(type).appendPath(customerId).build())
            .putExtra(EXTRA_PUSH_TYPE, type)
            .putExtra(EXTRA_PUSH_CUSTOMER_ID, customerId)
            .putExtra(EXTRA_PUSH_CUSTOMER_NAME, customerName)
        return PendingIntent.getActivity(
            context, "$type:$customerId".hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    fun post(context: Context, push: PushNotification) {
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        ensureChannel(context)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_linekeep_mark)
            .setContentTitle(push.title)
            .setContentText(push.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(push.body))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(openIntent(context, push.type, push.customerId, push.customerName))
            .build()
        try {
            manager.notify(push.tag, push.notificationId, notification)
        } catch (_: SecurityException) {
            // Permission can be revoked between the check and notify.
        }
    }
}

/** Receives the server's data-only FCM messages. The notification is built here from the payload, never auto-displayed. */
class CalltrackerMessagingService : FirebaseMessagingService() {
    private val app get() = application as CalltrackerApplication

    override fun onNewToken(token: String) {
        if (!PushConfig.enabled) return
        app.scope.launch { app.push.register(token) }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val push = parsePushPayload(message.data) ?: return
        // The foreground poller may be backed off; a push means something changed, so it checks right away.
        if (AppVisibility.foreground) app.customers.nudgeLiveUpdates()
        if (!shouldPostPush(push, AppVisibility.foreground, app.customers.openConversationId)) return
        PushNotifications.post(this, push)
    }
}
