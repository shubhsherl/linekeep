package com.microorganics.calltracker

import android.content.Context
import java.io.IOException

/** Raised when a request is attempted before any server is configured. */
internal class ServerNotSet : IOException("Server not set")

/**
 * The HTTPS origin that receives device requests: the user-saved value, else the optional build-time default,
 * else none. Callers must read it per request. Changing it is only allowed before enrollment.
 */
internal object ServerConfig {
    private const val FILE = "server-config"
    private const val KEY = "serverUrl"

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** The build-time default, or null for the generic build. */
    fun buildDefault(): String? = validateServerUrl(BuildConfig.API_BASE_URL)

    fun saved(context: Context): String? = prefs(context).getString(KEY, null)?.let(::validateServerUrl)

    fun current(context: Context): String? = saved(context) ?: buildDefault()

    /** Stores an already validated origin. */
    fun save(context: Context, origin: String) {
        val normalized = checkNotNull(validateServerUrl(origin)) { "Not a valid server origin" }
        check(prefs(context).edit().putString(KEY, normalized).commit()) { "Server could not be saved" }
    }
}

internal fun serverHost(origin: String): String = origin.removePrefix("https://")
