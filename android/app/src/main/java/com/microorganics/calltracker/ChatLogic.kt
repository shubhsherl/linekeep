package com.microorganics.calltracker

import org.json.JSONArray
import org.json.JSONObject

// Pure logic and wire shapes for adding customers, the 24-hour window, quick replies, templates and attachments.

// ---- 24-hour window -------------------------------------------------------------------------------------------------

/** `whatsappWindow` of a customer: free-text and media replies are only accepted while [open]. */
internal data class WhatsAppWindow(val open: Boolean, val expiresAt: Long?)

internal fun parseWindow(json: JSONObject?): WhatsAppWindow? {
    json ?: return null
    if (!json.has("open") || json.isNull("open")) return null
    return WhatsAppWindow(json.optBoolean("open", false), json.optionalTime("expiresAt"))
}

/**
 * Whether a free-text or media reply may be sent now. An unknown window (older server, not loaded yet) counts as
 * open: the server still answers 409 `window_closed` and the screen then switches to the closed state.
 */
internal fun isReplyWindowOpen(window: WhatsAppWindow?, now: Long): Boolean =
    window == null || (window.open && (window.expiresAt == null || window.expiresAt > now))

internal const val WINDOW_CLOSED_CODE = "window_closed"
internal const val HEADER_IMAGE_REQUIRED_CODE = "template_header_image_required"
internal const val CUSTOMER_EXISTS_CODE = "customer_exists"
internal const val PHONE_NOT_EDITABLE_CODE = "phone_not_editable"

/** Server error codes are compared case-insensitively. */
internal fun hasCode(error: Exception, code: String): Boolean = error is ApiFailure && error.code.equals(code, ignoreCase = true)

// ---- Adding a customer ----------------------------------------------------------------------------------------------

/**
 * Mirrors the server's phone normaliser: ten digits and a leading-zero eleven digits are Indian numbers (+91),
 * anything else keeps its digits. Null when the result is not 8 to 15 digits.
 */
internal fun normalizePhone(raw: String): String? {
    val digits = raw.filter { it in '0'..'9' }
    val normalized = when {
        digits.length == 10 -> "91$digits"
        digits.length == 11 && digits.startsWith("0") -> "91${digits.substring(1)}"
        else -> digits
    }
    return if (normalized.length in 8..15) "+$normalized" else null
}

internal data class LookupResult(val phone: String, val exists: Boolean, val mine: Boolean, val customerId: String?, val customerName: String?)

internal fun parseLookup(json: JSONObject): LookupResult? {
    val phone = json.optionalString("phone") ?: return null
    if (!json.has("exists") || json.isNull("exists")) return null
    val exists = json.optBoolean("exists", false)
    val mine = exists && json.optBoolean("mine", false)
    val customer = if (mine) json.optJSONObject("customer") else null
    return LookupResult(phone, exists, mine, customer?.optionalString("id"), customer?.optionalString("name"))
}

internal sealed interface DuplicateDecision {
    /** Nobody has this number: it may be created. */
    data object Create : DuplicateDecision
    /** The caller already has this customer. */
    data class OpenExisting(val customerId: String, val name: String) : DuplicateDecision
    /** Someone else has it; nothing more is shown. */
    data object BelongsToOther : DuplicateDecision
}

internal fun decideAfterLookup(result: LookupResult): DuplicateDecision = when {
    !result.exists -> DuplicateDecision.Create
    result.mine && result.customerId != null -> DuplicateDecision.OpenExisting(result.customerId, result.customerName.orEmpty())
    else -> DuplicateDecision.BelongsToOther
}

internal const val OTHER_HANDLER_MESSAGE = "This number already belongs to another handler. Ask your manager."

/** First problem with the add-customer form, or null when it can be submitted. */
internal fun validateNewCustomer(name: String, phone: String, notes: String): String? = when {
    name.isBlank() -> "Enter the customer's name."
    name.trim().length > 200 -> "The name can be up to 200 characters."
    normalizePhone(phone) == null -> "Enter a valid phone number, with 8 to 15 digits."
    notes.length > 4000 -> "Notes can be up to 4000 characters."
    else -> null
}

internal fun createCustomerBody(name: String, phone: String, notes: String): JSONObject {
    val body = JSONObject().put("name", name.trim()).put("phone", requireNotNull(normalizePhone(phone)) { "Invalid phone" })
    notes.trim().takeIf { it.isNotEmpty() }?.let { body.put("notes", it) }
    return body
}

/** Only changed fields are sent; the phone number is never part of an edit. Null when nothing changed. */
internal fun patchCustomerBody(original: Customer, name: String, notes: String): JSONObject? {
    val body = JSONObject()
    if (name.trim() != original.name) body.put("name", name.trim())
    if (notes.trim() != original.notes.orEmpty()) body.put("notes", notes.trim())
    return if (body.length() == 0) null else body
}

// ---- Handler (this employee) ---------------------------------------------------------------------------------------------

/** `employee` of `GET /v1/device/profile`; [phoneNumber] is the number the manager configured, if any. */
internal data class EmployeeProfile(val id: String, val name: String, val phoneNumber: String?)

internal fun parseProfile(json: JSONObject): EmployeeProfile? {
    val employee = json.optJSONObject("employee") ?: return null
    val id = employee.optionalString("id") ?: return null
    return EmployeeProfile(id, employee.optionalString("name").orEmpty(), employee.optionalString("phoneNumber"))
}

/** The manager-configured number wins; the SIM-reported one is only a fallback; empty when neither is known. */
internal fun resolveHandlerPhone(profile: EmployeeProfile?, simNumbers: List<String>): String =
    profile?.phoneNumber?.trim()?.takeIf { it.isNotEmpty() } ?: simNumbers.firstOrNull { it.isNotBlank() }?.trim().orEmpty()

internal fun resolveHandlerName(profile: EmployeeProfile?, enrolledName: String): String =
    profile?.name?.trim()?.takeIf { it.isNotEmpty() } ?: enrolledName.trim()

// ---- Quick replies ---------------------------------------------------------------------------------------------------

internal data class QuickMessage(val id: String, val title: String, val text: String)

internal fun parseQuickMessage(json: JSONObject): QuickMessage? {
    val id = json.optionalString("id") ?: return null
    val title = json.optionalString("title") ?: return null
    val text = json.optionalString("text") ?: return null
    return QuickMessage(id, title, text)
}

internal data class QuickFill(val text: String, val missing: List<String>)

private val quickPlaceholder = Regex("""\{\{\s*(name|handler_name|handler_phone)\s*\}\}""")

/** Replaces {{name}}, {{handler_name}} and {{handler_phone}}; a placeholder without a value stays as typed and is reported. */
internal fun fillQuickPlaceholders(text: String, customerName: String, handlerName: String, handlerPhone: String): QuickFill {
    val missing = LinkedHashSet<String>()
    val filled = quickPlaceholder.replace(text) { match ->
        val key = match.groupValues[1]
        val value = when (key) {
            "name" -> customerName
            "handler_name" -> handlerName
            else -> handlerPhone
        }.trim()
        if (value.isEmpty()) { missing.add(key); match.value } else value
    }
    return QuickFill(filled, missing.toList())
}

// ---- Templates --------------------------------------------------------------------------------------------------------

internal data class TemplateVariable(val key: String, val example: String?)

internal data class MessageTemplate(
    val name: String,
    val language: String,
    val category: String,
    val header: String?,
    val body: String,
    val footer: String?,
    val buttons: List<String>,
    val variables: List<TemplateVariable>,
    val sendable: Boolean,
    val reason: String?,
    /** NONE, TEXT, IMAGE, VIDEO or DOCUMENT. */
    val headerFormat: String,
    val headerImageConfigured: Boolean,
) {
    val key: String get() = "$name/$language"
    val needsHeaderImage: Boolean get() = headerFormat == "IMAGE"
}

internal fun parseTemplate(json: JSONObject): MessageTemplate? {
    val name = json.optionalString("name") ?: return null
    val language = json.optionalString("language") ?: return null
    val variables = json.optJSONArray("variables").objects().mapNotNull { item ->
        item.optionalString("key")?.let { TemplateVariable(it, item.optionalString("example")) }
    }
    val buttons = json.optJSONArray("buttons").objects().mapNotNull { it.optionalString("text") }
    return MessageTemplate(
        name = name, language = language, category = json.optionalString("category").orEmpty(),
        header = json.optionalString("header"), body = json.optionalString("body").orEmpty(), footer = json.optionalString("footer"),
        buttons = buttons, variables = variables,
        sendable = json.optBoolean("sendable", false), reason = json.optionalString("reason"),
        headerFormat = json.optionalString("headerFormat")?.uppercase() ?: "NONE",
        headerImageConfigured = json.optBoolean("headerImageConfigured", false),
    )
}

private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

/** Where a template variable's value comes from; the employee can always overwrite it with custom text. */
internal enum class VariableSource(val label: String) {
    HANDLER_NAME("My name"),
    HANDLER_PHONE("My phone number"),
    CUSTOMER_NAME("Customer name"),
    CUSTOM("Custom text"),
}

/** Same defaults as the admin picker: variable {{2}} and the second one are the handler's phone, the first is the handler's name. */
internal fun defaultVariableSource(key: String, index: Int): VariableSource = when {
    key == "2" -> VariableSource.HANDLER_PHONE
    key == "1" || index == 0 -> VariableSource.HANDLER_NAME
    index == 1 -> VariableSource.HANDLER_PHONE
    else -> VariableSource.CUSTOM
}

internal data class FillContext(val customerName: String, val handlerName: String, val handlerPhone: String)

/** Meta rejects tabs and newlines inside a variable. */
internal fun cleanVariable(value: String): String = value.replace(Regex("""[\t\r\n]+"""), " ")

internal fun valueFor(source: VariableSource, context: FillContext): String = cleanVariable(
    when (source) {
        VariableSource.HANDLER_NAME -> context.handlerName
        VariableSource.HANDLER_PHONE -> context.handlerPhone
        VariableSource.CUSTOMER_NAME -> context.customerName
        VariableSource.CUSTOM -> ""
    }
).trim()

/** Initial values for every variable of [template], taken from the default sources. */
internal fun initialTemplateValues(template: MessageTemplate, context: FillContext): List<String> =
    template.variables.mapIndexed { index, variable -> valueFor(defaultVariableSource(variable.key, index), context) }

private val templatePlaceholder = Regex("""\{\{\s*([A-Za-z0-9_]+)\s*\}\}""")

/** The text the customer will see: header, body and footer with the values filled in; unfilled variables show as typed. */
internal fun renderTemplate(template: MessageTemplate, values: List<String>): String {
    val byKey = template.variables.mapIndexed { index, variable -> variable.key to values.getOrNull(index).orEmpty() }.toMap()
    fun fill(text: String) = templatePlaceholder.replace(text) { match -> byKey[match.groupValues[1]]?.takeIf { it.isNotBlank() } ?: match.value }
    return listOfNotNull(template.header, template.body.takeIf { it.isNotEmpty() }, template.footer).joinToString("\n") { fill(it) }
}

/** Why [template] cannot be sent yet with these values, or null when it can. */
internal fun templateProblem(template: MessageTemplate, values: List<String>, headerOverride: Boolean): String? = when {
    !template.sendable -> template.reason ?: "This template cannot be sent from the app yet."
    template.variables.indices.any { values.getOrNull(it).isNullOrBlank() } -> "Fill in every variable."
    values.any { it.length > 1024 } -> "A variable can be up to 1024 characters."
    template.needsHeaderImage && !template.headerImageConfigured && !headerOverride -> "Choose a header image."
    else -> null
}

// ---- Send bodies -------------------------------------------------------------------------------------------------------

internal fun textMessageBody(clientMessageId: String, text: String): JSONObject =
    JSONObject().put("clientMessageId", clientMessageId).put("text", text)

internal fun mediaMessageBody(clientMessageId: String, attachmentId: String, caption: String): JSONObject {
    val body = JSONObject().put("clientMessageId", clientMessageId).put("type", "media").put("attachmentId", attachmentId)
    caption.trim().takeIf { it.isNotEmpty() }?.let { body.put("caption", it) }
    return body
}

internal fun templateMessageBody(clientMessageId: String, template: MessageTemplate, values: List<String>, headerAttachmentId: String?): JSONObject {
    val params = JSONArray()
    values.take(template.variables.size).forEach { params.put(cleanVariable(it).trim()) }
    val inner = JSONObject().put("name", template.name).put("language", template.language).put("params", params)
    headerAttachmentId?.let { inner.put("headerAttachmentId", it) }
    return JSONObject().put("clientMessageId", clientMessageId).put("template", inner)
}

// ---- Attachments --------------------------------------------------------------------------------------------------------

internal const val MAX_ATTACHMENT_BYTES = 16L * 1024 * 1024
/** WhatsApp accepts images up to 5 MB; larger photos are re-encoded as JPEG before upload. */
internal const val IMAGE_SHRINK_ABOVE_BYTES = 4L * 1024 * 1024

internal val ALLOWED_ATTACHMENT_TYPES: Set<String> = setOf(
    "image/jpeg", "image/png", "image/webp", "video/mp4", "application/pdf",
    "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain", "text/csv",
)

internal val IMAGE_ATTACHMENT_TYPES: Set<String> = setOf("image/jpeg", "image/png", "image/webp")

/** MIME types offered to the document picker. */
internal val DOCUMENT_PICKER_TYPES: Array<String> = (ALLOWED_ATTACHMENT_TYPES - IMAGE_ATTACHMENT_TYPES - "video/mp4").toTypedArray()

internal fun cleanMimeType(raw: String?): String = raw?.substringBefore(';')?.trim()?.lowercase().orEmpty()

internal sealed interface AttachmentCheck {
    data object Ok : AttachmentCheck
    data class Rejected(val message: String) : AttachmentCheck
}

/** [size] is null when the provider does not report one; the read is then bounded by [MAX_ATTACHMENT_BYTES]. */
internal fun checkAttachment(mimeType: String?, size: Long?): AttachmentCheck {
    val mime = cleanMimeType(mimeType)
    return when {
        mime !in ALLOWED_ATTACHMENT_TYPES -> AttachmentCheck.Rejected("This file type can't be sent on WhatsApp. Send a photo, video (MP4), PDF, Office file, text or CSV.")
        size != null && size <= 0 -> AttachmentCheck.Rejected("This file is empty.")
        size != null && size > MAX_ATTACHMENT_BYTES && mime !in IMAGE_ATTACHMENT_TYPES -> AttachmentCheck.Rejected("Files can be up to ${formatSize(MAX_ATTACHMENT_BYTES)}.")
        else -> AttachmentCheck.Ok
    }
}

internal fun attachmentKind(mimeType: String?): String = when {
    cleanMimeType(mimeType) in IMAGE_ATTACHMENT_TYPES -> "image"
    cleanMimeType(mimeType) == "video/mp4" -> "video"
    else -> "document"
}

/** A photo is re-encoded when it is larger than WhatsApp accepts for images. */
internal fun shouldShrinkImage(mimeType: String?, size: Long?): Boolean =
    cleanMimeType(mimeType) in IMAGE_ATTACHMENT_TYPES && (size == null || size > IMAGE_SHRINK_ABOVE_BYTES)

internal fun withExtension(fileName: String, extension: String): String {
    val base = fileName.substringBeforeLast('.', fileName)
    return "${base.ifEmpty { "photo" }}.$extension"
}

/** What the server returns after `POST /v1/device/whatsapp/attachments`. */
internal data class UploadedAttachment(val id: String, val kind: String, val mimeType: String, val fileName: String, val size: Long)

internal fun parseUploadedAttachment(json: JSONObject): UploadedAttachment? {
    val id = json.optionalString("attachmentId") ?: return null
    return UploadedAttachment(id, json.optionalString("kind") ?: "document", json.optionalString("mimeType").orEmpty(), json.optionalString("fileName").orEmpty(), json.optLong("size", 0))
}

// ---- Conversation presentation -------------------------------------------------------------------------------------------

internal fun initialsOf(name: String): String {
    val parts = name.trim().split(Regex("""\s+""")).filter { it.isNotEmpty() }
    val letters = when {
        parts.isEmpty() -> ""
        parts.size == 1 -> parts[0].take(1)
        else -> parts[0].take(1) + parts.last().take(1)
    }.filter { it.isLetterOrDigit() }
    return letters.uppercase().ifEmpty { "#" }
}

/** Calendar day (days since epoch in [offsetMs] local time) used to place day separators. */
internal fun dayNumber(millis: Long, offsetMs: Long): Long = Math.floorDiv(millis + offsetMs, 86_400_000L)

/** The newest-first [items] index set where a day separator goes above the item: the oldest message of each day. */
internal fun dayStartIndexes(times: List<Long>, offsetFor: (Long) -> Long): Set<Int> {
    val result = HashSet<Int>()
    for (index in times.indices) {
        val day = dayNumber(times[index], offsetFor(times[index]))
        val older = times.getOrNull(index + 1)
        if (older == null || dayNumber(older, offsetFor(older)) != day) result.add(index)
    }
    return result
}
