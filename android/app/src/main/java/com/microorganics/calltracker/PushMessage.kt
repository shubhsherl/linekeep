package com.microorganics.calltracker

import org.json.JSONObject
import java.io.IOException

internal const val PUSH_TYPE_MESSAGE = "message"
internal const val PUSH_TYPE_ASSIGNED = "assigned"

private const val MAX_ID_CHARS = 128
private const val MAX_NAME_CHARS = 200
private const val MAX_TITLE_CHARS = 200
private const val MAX_BODY_CHARS = 500

/** The four public Firebase client identifiers that let the app receive FCM data messages. */
internal data class FirebaseConfig(val apiKey: String, val appId: String, val projectId: String, val senderId: String) {
    /** A push is only possible when all four values are present. */
    val complete: Boolean get() = pushConfigured(apiKey, appId, projectId, senderId)
}

internal fun pushConfigured(apiKey: String, appId: String, projectId: String, senderId: String): Boolean =
    apiKey.isNotBlank() && appId.isNotBlank() && projectId.isNotBlank() && senderId.isNotBlank()

/** Options saved from the server win; the Gradle-supplied build values are the fallback; otherwise push is disabled (null). */
internal fun resolveFirebaseOptions(stored: FirebaseConfig?, build: FirebaseConfig): FirebaseConfig? =
    stored?.takeIf { it.complete } ?: build.takeIf { it.complete }

/**
 * Reads `GET /v1/device/push-config`: `push` is an object with the four values, or JSON null while the server has push
 * disabled (returned as null). A missing or malformed `push` throws so the caller treats it as a failed call and keeps
 * whatever is stored.
 */
internal fun parsePushConfigResponse(response: JSONObject): FirebaseConfig? {
    if (!response.has("push")) throw IOException("Malformed push config response")
    if (response.isNull("push")) return null
    val push = response.optJSONObject("push") ?: throw IOException("Malformed push config response")
    fun value(name: String) = (push.opt(name) as? String)?.trim().orEmpty()
    return FirebaseConfig(value("apiKey"), value("appId"), value("projectId"), value("senderId"))
        .takeIf { it.complete } ?: throw IOException("Malformed push config response")
}

/** What to do with a successful `push-config` answer. A failed call never reaches this: stored options stay as they are. */
internal sealed interface PushConfigDecision {
    /** Nothing to change. */
    data object Keep : PushConfigDecision

    /**
     * Store [config]. [initializeNow] is true only when FirebaseApp is not initialized in this process; when it already
     * runs with different options, FirebaseApp cannot be re-initialized, so the new options apply at the next start.
     */
    data class Save(val config: FirebaseConfig, val initializeNow: Boolean) : PushConfigDecision

    /** The server turned push off after options were stored: drop them and the registered token. */
    data object Remove : PushConfigDecision
}

/** [applied] is what FirebaseApp runs with in this process, or null when it is not initialized. */
internal fun decidePushConfig(stored: FirebaseConfig?, fromServer: FirebaseConfig?, applied: FirebaseConfig?): PushConfigDecision = when {
    fromServer == null -> if (stored != null) PushConfigDecision.Remove else PushConfigDecision.Keep
    fromServer == stored && applied != null -> PushConfigDecision.Keep
    else -> PushConfigDecision.Save(fromServer, initializeNow = applied == null)
}

/** What the server's data-only FCM message asks the phone to show. */
internal data class PushNotification(
    val type: String,
    val customerId: String,
    val customerName: String,
    val title: String,
    val body: String,
) {
    /** A newer notification with the same tag and id replaces the older one, so one chat never stacks. */
    val tag: String get() = customerId
    val notificationId: Int get() = if (type == PUSH_TYPE_MESSAGE) MESSAGE_NOTIFICATION_ID else ASSIGNED_NOTIFICATION_ID

    companion object {
        const val MESSAGE_NOTIFICATION_ID = 1001
        const val ASSIGNED_NOTIFICATION_ID = 1002
    }
}

/** Returns null for anything that is not a well-formed `message` or `assigned` push; missing text falls back to a default. */
internal fun parsePushPayload(data: Map<String, String>): PushNotification? {
    val type = data["type"]?.trim()
    if (type != PUSH_TYPE_MESSAGE && type != PUSH_TYPE_ASSIGNED) return null
    val customerId = data["customerId"]?.trim().orEmpty()
    if (customerId.isEmpty() || customerId.length > MAX_ID_CHARS) return null
    val name = data["customerName"]?.trim().orEmpty().take(MAX_NAME_CHARS)
    val title = data["title"]?.trim().orEmpty().ifEmpty {
        if (type == PUSH_TYPE_MESSAGE) "New WhatsApp message" else "New customer assigned"
    }.take(MAX_TITLE_CHARS)
    val body = data["body"]?.trim().orEmpty().ifEmpty { name }.take(MAX_BODY_CHARS)
    return PushNotification(type, customerId, name, title, body)
}

/** The live polling already shows a new message when that exact conversation is on screen. */
internal fun shouldPostPush(push: PushNotification, appInForeground: Boolean, openConversationId: String?): Boolean =
    !(push.type == PUSH_TYPE_MESSAGE && appInForeground && openConversationId == push.customerId)

/** A request to show one customer's conversation, carried by a notification tap. */
internal data class OpenRequest(val type: String, val customerId: String, val customerName: String)

internal fun parseOpenRequest(type: String?, customerId: String?, customerName: String?): OpenRequest? {
    if (type != PUSH_TYPE_MESSAGE && type != PUSH_TYPE_ASSIGNED) return null
    val id = customerId?.trim().orEmpty()
    if (id.isEmpty() || id.length > MAX_ID_CHARS) return null
    return OpenRequest(type, id, customerName?.trim().orEmpty().take(MAX_NAME_CHARS))
}
