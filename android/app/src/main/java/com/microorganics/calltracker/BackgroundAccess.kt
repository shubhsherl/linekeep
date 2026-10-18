package com.microorganics.calltracker

import android.app.ActivityManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * Whether Android lets this app run scheduled work while it is closed. Samsung's "Sleeping apps"
 * list has no public API; it surfaces as a battery-optimized app or a restricted standby bucket.
 */
internal data class BackgroundStatus(
    val ignoringOptimizations: Boolean = false,
    val backgroundRestricted: Boolean = false,
    val standbyRestricted: Boolean = false,
) {
    val unrestricted get() = ignoringOptimizations && !backgroundRestricted && !standbyRestricted

    val problem get() = when {
        backgroundRestricted -> "Background activity is restricted for this app."
        standbyRestricted -> "Android has placed this app in its most restricted standby bucket."
        !ignoringOptimizations -> "Battery optimization is on, so Android may delay or skip syncing while the app is closed."
        else -> null
    }
}

internal object BackgroundAccess {
    /** UsageStatsManager.STANDBY_BUCKET_RESTRICTED, available from API 31 but reported from 28. */
    private const val RESTRICTED_BUCKET = 45

    fun evaluate(ignoring: Boolean, restricted: Boolean, bucket: Int?) =
        BackgroundStatus(ignoring, restricted, bucket != null && bucket >= RESTRICTED_BUCKET)

    fun read(context: Context): BackgroundStatus {
        val power = context.getSystemService(PowerManager::class.java)
        val activity = context.getSystemService(ActivityManager::class.java)
        val bucket = if (Build.VERSION.SDK_INT >= 28)
            context.getSystemService(UsageStatsManager::class.java)?.appStandbyBucket else null
        return evaluate(
            ignoring = power?.isIgnoringBatteryOptimizations(context.packageName) == true,
            restricted = Build.VERSION.SDK_INT >= 28 && activity?.isBackgroundRestricted == true,
            bucket = bucket,
        )
    }

    /** The direct allow dialog cannot lift a user-chosen "Restricted" setting; that needs app battery settings. */
    fun requestIntent(context: Context, status: BackgroundStatus): Intent =
        if (status.backgroundRestricted) appSettingsIntent(context)
        else Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))

    fun appSettingsIntent(context: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
}
