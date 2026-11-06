package com.microorganics.calltracker

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

internal const val WHATSAPP_NOT_CONFIGURED = "WHATSAPP_NOT_CONFIGURED"
internal const val MAX_MESSAGE_CHARACTERS = 4096

internal data class EmployeeRef(val id: String, val name: String)

internal data class Customer(
    val id: String,
    val name: String,
    val phone: String,
    val email: String? = null,
    val notes: String? = null,
    val source: String? = null,
    val district: String? = null,
    val state: String? = null,
    val country: String? = null,
    val employees: List<EmployeeRef> = emptyList(),
    val messageCount: Int = 0,
    val lastMessageAt: Long? = null,
    val lastCallAt: Long? = null,
    /** Null when the server did not say; see [isReplyWindowOpen]. */
    val whatsappWindow: WhatsAppWindow? = null,
)

internal enum class MessageDirection { IN, OUT }

internal enum class MediaKind { IMAGE, VIDEO, AUDIO, DOCUMENT, STICKER }

/** [url] is a server path (`/v1/device/whatsapp/messages/{id}/media`) fetched with the device bearer token. */
internal data class MessageMedia(
    val kind: MediaKind,
    val url: String,
    val mimeType: String? = null,
    val fileName: String? = null,
    val size: Long? = null,
)

internal data class WhatsAppMessage(
    val id: String,
    val customerId: String,
    val direction: MessageDirection,
    val messageType: String,
    val body: String?,
    val mediaUrl: String?,
    val templateName: String?,
    /** queued, sent, delivered, read or failed; unknown future values are kept verbatim. */
    val status: String,
    val sentAt: Long,
    val deliveredAt: Long? = null,
    val readAt: Long? = null,
    val sentBy: EmployeeRef? = null,
    val media: MessageMedia? = null,
)

internal data class ChatSummary(
    val customerId: String,
    val customerName: String,
    val customerPhone: String,
    val employees: List<EmployeeRef>,
    val lastDirection: MessageDirection,
    val lastMessageType: String,
    val lastText: String,
    val lastSentAt: Long,
    val messageCount: Int,
    /** Customer messages newer than this viewer's read marker; 0 when all are read. */
    val unreadCount: Int = 0,
)

internal data class Page<T>(val items: List<T>, val nextCursor: String?)

/** Server timestamps are ISO-8601 instants; epoch milliseconds are also accepted. Anything else is absent. */
internal fun JSONObject.optionalTime(name: String): Long? {
    if (!has(name) || isNull(name)) return null
    return when (val value = opt(name)) {
        is Number -> value.toLong()
        is String -> try { Instant.parse(value).toEpochMilli() } catch (_: Exception) { value.toLongOrNull() }
        else -> null
    }
}

private fun JSONObject.employees(name: String): List<EmployeeRef> {
    val array = optJSONArray(name) ?: return emptyList()
    return array.objects().mapNotNull { it.employee() }
}

private fun JSONObject.employee(): EmployeeRef? {
    val id = optionalString("id") ?: return null
    return EmployeeRef(id, optionalString("name").orEmpty())
}

private fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }

internal fun parseCustomer(json: JSONObject): Customer? {
    val id = json.optionalString("id") ?: return null
    val name = json.optionalString("name") ?: return null
    val phone = json.optionalString("phone") ?: return null
    return Customer(
        id = id, name = name, phone = phone,
        email = json.optionalString("email"), notes = json.optionalString("notes"),
        source = json.optionalString("source"), district = json.optionalString("district"),
        state = json.optionalString("state"), country = json.optionalString("country"),
        employees = json.employees("employees"),
        messageCount = json.optInt("messageCount", 0),
        lastMessageAt = json.optionalTime("lastMessageAt"), lastCallAt = json.optionalTime("lastCallAt"),
        whatsappWindow = parseWindow(json.optJSONObject("whatsappWindow")),
    )
}

/** Absent without a usable url; an unrecognised future kind is offered as a downloadable document. */
internal fun parseMedia(json: JSONObject?): MessageMedia? {
    json ?: return null
    val url = json.optionalString("url") ?: return null
    val kind = when (json.optionalString("kind")) {
        "image" -> MediaKind.IMAGE
        "video" -> MediaKind.VIDEO
        "audio" -> MediaKind.AUDIO
        "sticker" -> MediaKind.STICKER
        else -> MediaKind.DOCUMENT
    }
    val size = if (json.has("size") && !json.isNull("size")) (json.opt("size") as? Number)?.toLong()?.takeIf { it >= 0 } else null
    return MessageMedia(kind, url, json.optionalString("mimeType"), json.optionalString("fileName"), size)
}

/** The `version` of `GET /v1/device/whatsapp/version`, or null when absent or not a number. */
internal fun parseVersion(json: JSONObject): Long? = (json.opt("version") as? Number)?.toLong()

private fun direction(value: String?) = if (value == "out") MessageDirection.OUT else MessageDirection.IN

internal fun parseMessage(json: JSONObject): WhatsAppMessage? {
    val id = json.optionalString("id") ?: return null
    val sentAt = json.optionalTime("sentAt") ?: return null
    return WhatsAppMessage(
        id = id, customerId = json.optionalString("customerId").orEmpty(),
        direction = direction(json.optionalString("direction")),
        messageType = json.optionalString("messageType") ?: "text",
        body = json.optionalString("body"), mediaUrl = json.optionalString("mediaUrl"),
        templateName = json.optionalString("templateName"),
        status = json.optionalString("status") ?: "sent",
        sentAt = sentAt, deliveredAt = json.optionalTime("deliveredAt"), readAt = json.optionalTime("readAt"),
        sentBy = json.optJSONObject("sentBy")?.employee(),
        media = parseMedia(json.optJSONObject("media")),
    )
}

internal fun parseChat(json: JSONObject): ChatSummary? {
    val customer = json.optJSONObject("customer") ?: return null
    val last = json.optJSONObject("lastMessage") ?: return null
    val id = customer.optionalString("id") ?: return null
    return ChatSummary(
        customerId = id, customerName = customer.optionalString("name") ?: return null,
        customerPhone = customer.optionalString("phone").orEmpty(),
        employees = json.employees("employees"),
        lastDirection = direction(last.optionalString("direction")),
        lastMessageType = last.optionalString("messageType") ?: "text",
        // A media-only message legitimately has empty text.
        lastText = last.optionalString("text").orEmpty(),
        lastSentAt = last.optionalTime("sentAt") ?: return null,
        messageCount = json.optInt("messageCount", 0),
        unreadCount = json.optInt("unreadCount", 0).coerceAtLeast(0),
    )
}

/** Chat and message totals unread by this phone's employee. */
internal data class UnreadTotals(val chats: Int, val messages: Int)

internal fun parseUnread(json: JSONObject) = UnreadTotals(json.optInt("chats", 0).coerceAtLeast(0), json.optInt("messages", 0).coerceAtLeast(0))

/** Malformed items are skipped rather than failing the whole page. */
internal fun <T> parsePage(json: JSONObject, parse: (JSONObject) -> T?): Page<T> =
    Page(json.optJSONArray("items")?.objects()?.mapNotNull(parse).orEmpty(), json.optionalString("nextCursor"))

internal fun parseCanSend(json: JSONObject): Boolean = json.optBoolean("canSend", false)

/** The stable machine code from `{error:{code}}`, or null when the body is empty or not that shape. */
internal fun parseApiErrorCode(body: String?): String? {
    if (body.isNullOrBlank()) return null
    return try { JSONObject(body).optJSONObject("error")?.optionalString("code") } catch (_: Exception) { null }
}

/** The `customerId` an error body may carry (inside `error` or at the top level), e.g. for a duplicate of the caller's own customer. */
internal fun parseApiErrorCustomerId(body: String?): String? {
    if (body.isNullOrBlank()) return null
    return try {
        val json = JSONObject(body)
        json.optJSONObject("error")?.optionalString("customerId") ?: json.optionalString("customerId")
    } catch (_: Exception) { null }
}
