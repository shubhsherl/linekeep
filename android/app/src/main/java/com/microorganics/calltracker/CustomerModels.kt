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
)

internal enum class MessageDirection { IN, OUT }

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
    )
}

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
    )
}

/** Malformed items are skipped rather than failing the whole page. */
internal fun <T> parsePage(json: JSONObject, parse: (JSONObject) -> T?): Page<T> =
    Page(json.optJSONArray("items")?.objects()?.mapNotNull(parse).orEmpty(), json.optionalString("nextCursor"))

internal fun parseCanSend(json: JSONObject): Boolean = json.optBoolean("canSend", false)

/** The stable machine code from `{error:{code}}`, or null when the body is empty or not that shape. */
internal fun parseApiErrorCode(body: String?): String? {
    if (body.isNullOrBlank()) return null
    return try { JSONObject(body).optJSONObject("error")?.optionalString("code") } catch (_: Exception) { null }
}
