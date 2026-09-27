package com.microorganics.calltracker

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat

internal data class SimSnapshot(val numbers: List<String>, val explanation: String)
internal data class CallLine(val number: String? = null, val label: String? = null)

internal class SimReader(private val context: Context) {
    fun hasPermissions(): Boolean = arrayOf(Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_PHONE_NUMBERS)
        .all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }

    /** Resolve only the handle written on this call, never an account ID interpreted as a subscription ID. */
    @Suppress("DEPRECATION")
    fun readCallLine(component: String?, accountId: String?): CallLine {
        val name = component?.let(ComponentName::unflattenFromString) ?: return CallLine()
        if (accountId.isNullOrBlank()) return CallLine()
        val handle = PhoneAccountHandle(name, accountId)
        val account = runCatching { context.getSystemService(TelecomManager::class.java)?.getPhoneAccount(handle) }.getOrNull()
        val label = account?.label?.toString()?.trim()?.take(120)?.takeIf { it.isNotEmpty() }
        if (!hasPermissions()) return CallLine(label = label)
        val number = runCatching {
            val scoped = context.getSystemService(TelephonyManager::class.java)?.createForPhoneAccountHandle(handle)
            val provisioned = if (Build.VERSION.SDK_INT >= 33 && scoped != null && SubscriptionManager.isValidSubscriptionId(scoped.subscriptionId)) {
                context.getSystemService(SubscriptionManager::class.java)?.getPhoneNumber(scoped.subscriptionId)
            } else scoped?.line1Number
            provisioned?.trim()?.takeIf { it.length in 1..80 && it.any(Char::isDigit) }
                ?: account?.subscriptionAddress?.takeIf { it.scheme == "tel" }?.schemeSpecificPart
                    ?.trim()?.takeIf { it.length in 1..80 && it.any(Char::isDigit) }
        }.getOrNull()
        return CallLine(number, label)
    }

    @Suppress("DEPRECATION")
    fun read(): SimSnapshot {
        if (!hasPermissions()) return SimSnapshot(emptyList(), "Phone permission not granted. Reporting an empty list; enrollment still works.")
        return try {
            val subscriptions = context.getSystemService(SubscriptionManager::class.java)
                ?: return SimSnapshot(emptyList(), "No SIM service available. Reporting an empty list.")
            val telephony = context.getSystemService(TelephonyManager::class.java)
            val numbers = subscriptions.activeSubscriptionInfoList.orEmpty().mapNotNull { subscription ->
                val number = if (Build.VERSION.SDK_INT >= 33) {
                    subscriptions.getPhoneNumber(subscription.subscriptionId)
                } else {
                    telephony?.createForSubscriptionId(subscription.subscriptionId)?.line1Number
                }
                number?.trim()?.takeIf { it.isNotEmpty() && it.length <= 64 }
            }.distinct().take(8)
            SimSnapshot(numbers, if (numbers.isEmpty()) "No readable SIM number. Reporting an empty list; carrier provisioning may omit numbers." else "SIM-reported numbers are unverified metadata, not device identity.")
        } catch (_: SecurityException) {
            SimSnapshot(emptyList(), "Phone access denied by Android. Reporting an empty list.")
        } catch (_: UnsupportedOperationException) {
            SimSnapshot(emptyList(), "This device has no supported SIM number service. Reporting an empty list.")
        } catch (_: IllegalStateException) {
            SimSnapshot(emptyList(), "SIM information is temporarily unavailable. Reporting an empty list.")
        }
    }
}
