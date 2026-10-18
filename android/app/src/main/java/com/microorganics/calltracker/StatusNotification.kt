package com.microorganics.calltracker

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.ForegroundInfo

internal object StatusNotification {
    private const val channelId = "device-metadata-status"

    fun settingsIntent(context: Context): PendingIntent = PendingIntent.getActivity(
        context, 0, Intent(context, SettingsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    fun enabled(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        val manager = context.getSystemService(NotificationManager::class.java) ?: return false
        return NotificationManagerCompat.from(context).areNotificationsEnabled() &&
            manager.getNotificationChannel(channelId)?.importance != NotificationManager.IMPORTANCE_NONE
    }

    /** WorkManager's expedited compatibility service on API 26–30 has a named, visible identity. */
    fun foreground(context: Context): ForegroundInfo {
        context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(
            NotificationChannel(channelId, context.getString(R.string.status_channel_name), NotificationManager.IMPORTANCE_LOW))
        val settings = settingsIntent(context)
        val sync = PendingIntent.getBroadcast(context, 1,
            Intent(context, SyncReceiver::class.java).setAction("com.microorganics.calltracker.SYNC"),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_linekeep_mark).setContentTitle(context.getString(R.string.notification_syncing))
            .setContentText("Sharing granted call history and recording resources.")
            .setContentIntent(settings).setOngoing(true).setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .addAction(0, "Settings", settings).addAction(0, "Sync now", sync).build()
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(2, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else ForegroundInfo(2, notification)
    }

    fun show(context: Context, status: DeviceStatus) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(NotificationChannel(channelId, context.getString(R.string.status_channel_name), NotificationManager.IMPORTANCE_LOW))
        if (!status.loaded || !enabled(context)) return
        val settings = settingsIntent(context)
        val detail = buildString {
            append(status.message)
            status.heartbeatMessage?.let { append("\n").append(it) }
            status.recordingWaitMessage?.let { append("\n").append(it) }
            append("\nLast heartbeat: ").append(status.lastSync.ifEmpty { "Never" })
            append("\nPending call logs: ").append(status.pendingCallLogs)
            append("\nPending recordings: ").append(status.pendingUploads)
            append("\nLast upload: ").append(status.lastSuccessfulUploadAt ?: "Never")
        }
        val builder = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_linekeep_mark)
            .setContentTitle(context.getString(R.string.notification_status))
            .setContentText(if (status.unauthorized || status.storageUnavailable) status.message
                else status.recordingWaitMessage ?: status.message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(detail))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setContentIntent(settings)
            .addAction(0, "Settings", settings)
        if (status.deviceId != null && !status.unauthorized && !status.storageUnavailable) {
            val sync = PendingIntent.getBroadcast(context, 1,
                Intent(context, SyncReceiver::class.java).setAction("com.microorganics.calltracker.SYNC"),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            builder.addAction(0, "Sync now", sync)
        }
        try { manager.notify(1, builder.build()) } catch (_: SecurityException) {
            // Permission can be revoked between the check and notify; the launcher stays available.
        }
    }
}

class CalltrackerTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        qsTile?.apply {
            label = getString(R.string.tile_label)
            state = Tile.STATE_INACTIVE
            updateTile()
        }
    }

    @Suppress("DEPRECATION")
    override fun onClick() {
        super.onClick()
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(StatusNotification.settingsIntent(this))
        else startActivityAndCollapse(Intent(this, SettingsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
