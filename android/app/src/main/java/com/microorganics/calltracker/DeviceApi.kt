package com.microorganics.calltracker

import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.URL
import java.security.MessageDigest
import javax.net.ssl.HttpsURLConnection

/** [code] is the server's stable error code when the response carried the standard error body. */
internal class ApiFailure(val status: Int, val code: String? = null) : IOException("HTTP $status")
internal class UploadFailure(val status: Int) : IOException("Audio transfer HTTP $status")
internal class SourceChanged : IOException("Recording changed while being read; not completed")
internal data class UploadedAudio(val bytes: Long, val etag: String?)
internal const val MAX_AUDIO_BYTES = 100L * 1024 * 1024
internal const val PAGE_SIZE = 50
internal fun sha256(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).hex()
internal fun ByteArray.hex(): String {
    val digits = "0123456789abcdef"
    val characters = CharArray(size * 2)
    for (index in indices) {
        val value = this[index].toInt() and 255
        characters[index * 2] = digits[value ushr 4]
        characters[index * 2 + 1] = digits[value and 15]
    }
    return characters.concatToString()
}

/** Called only from an IO dispatcher. No HTTP logging, redirects, or shared upload credentials. [server] is read per request. */
internal class DeviceApi(private val server: () -> String?) {

    fun register(invitation: String, numbers: List<String>): Enrollment {
        val device = JSONObject().put("model", Build.MODEL).put("manufacturer", Build.MANUFACTURER)
            .put("androidVersion", Build.VERSION.RELEASE).put("appVersion", BuildConfig.VERSION_NAME)
            .put("phoneNumbers", JSONArray(numbers))
        val response = post("/v1/device/register", JSONObject().put("invitationCode", invitation).put("device", device))
        val employee = response.getJSONObject("employee")
        return Enrollment(response.getString("deviceId"), response.getString("deviceToken"), employee.getString("id"), employee.getString("name"),
            invitationId = response.optionalString("invitationId"), lastInvitationId = response.optionalString("lastInvitationId"))
    }

    fun heartbeat(enrollment: Enrollment, numbers: List<String>, pendingUploads: Int, lastSuccessfulUploadAt: String?): Enrollment {
        val payload = JSONObject().put("deviceId", enrollment.deviceId).put("phoneNumbers", JSONArray(numbers))
            .put("appVersion", BuildConfig.VERSION_NAME).put("pendingUploads", pendingUploads)
        lastSuccessfulUploadAt?.let { payload.put("lastSuccessfulUploadAt", it) }
        val response = post("/v1/device/heartbeat", payload, enrollment.token)
        check(response.getString("deviceId") == enrollment.deviceId) { "Enrollment response mismatch" }
        val employee = response.getJSONObject("employee")
        return enrollment.copy(employeeId = employee.getString("id"), employeeName = employee.getString("name"), lastSync = response.getString("serverTime"),
            invitationId = response.optionalString("invitationId") ?: enrollment.invitationId,
            lastInvitationId = response.optionalString("lastInvitationId") ?: enrollment.lastInvitationId)
    }

    fun prepare(enrollment: Enrollment, entry: RecordingEntry): JSONObject {
        val file = JSONObject().put("displayName", entry.name).put("contentType", entry.mime).put("expectedBytes", entry.size)
        entry.durationSeconds?.let { file.put("durationSeconds", it) }
        entry.recordedAt?.let { file.put("recordedAt", it) }
        return post("/v1/device/uploads/prepare", JSONObject().put("fingerprint", requireNotNull(entry.fingerprint))
            .put("file", file).put("call", JSONObject().put("matchStatus", if (entry.recordedAt != null || entry.durationSeconds != null) "media_metadata" else "unmatched")), enrollment.token)
    }

    fun complete(enrollment: Enrollment, entry: RecordingEntry): String {
        val payload = JSONObject().put("actualBytes", requireNotNull(entry.uploadedBytes))
        entry.etag?.let { payload.put("etag", it) }
        val id = requireNotNull(entry.callId)
        val response = post("/v1/device/uploads/${android.net.Uri.encode(id)}/complete", payload, enrollment.token)
        check(response.getString("callId") == id && response.getString("status") == "complete") { "Unexpected completion response" }
        return response.getString("uploadedAt")
    }

    fun history(enrollment: Enrollment, entries: List<HistoryEntry>): Set<String> {
        require(entries.size in 1..50)
        val items = JSONArray()
        entries.forEach { entry ->
            val item = JSONObject().put("fingerprint", entry.fingerprint).put("startedAt", entry.startedAt)
                .put("durationSeconds", entry.durationSeconds).put("callType", entry.callType)
            entry.remoteNumber?.let { item.put("remoteNumber", it) }
            entry.callerName?.let { item.put("callerName", it) }
            entry.localNumber?.let { item.put("localNumber", it) }
            entry.simLabel?.let { item.put("simLabel", it) }
            entry.phoneAccountId?.let { item.put("phoneAccountId", it) }
            items.put(item)
        }
        val response = post("/v1/device/call-logs/batch", JSONObject().put("deviceId", enrollment.deviceId).put("entries", items), enrollment.token)
        val accepted = response.getJSONArray("accepted")
        val submitted = entries.map { it.fingerprint }.toSet()
        return buildSet {
            for (index in 0 until accepted.length()) {
                val item = accepted.getJSONObject(index)
                val fingerprint = item.getString("fingerprint")
                if (fingerprint in submitted && item.getString("id").isNotBlank()) add(fingerprint)
            }
        }
    }

    fun upload(upload: JSONObject, expectedBytes: Long, expectedHash: String, open: () -> InputStream, checkActive: () -> Unit): UploadedAudio {
        require(expectedBytes in 1..MAX_AUDIO_BYTES)
        val method = upload.getString("method")
        require(method == "PUT") { "Unsupported signed upload method" }
        val connection = secureConnection(upload.getString("url"))
        try {
            connection.requestMethod = method
            connection.doOutput = true
            val headers = upload.getJSONObject("headers")
            for (name in headers.keys()) {
                require(!name.equals("Authorization", true) && !name.equals("Cookie", true) && !name.equals("Proxy-Authorization", true)) { "Credential header forbidden on signed upload" }
                val value = headers.getString(name)
                if (name.equals("Content-Length", true)) require(value.toLong() == expectedBytes)
                connection.setRequestProperty(name, value)
            }
            connection.setFixedLengthStreamingMode(expectedBytes)
            val digest = MessageDigest.getInstance("SHA-256")
            var count = 0L
            open().use { input ->
                connection.outputStream.use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        checkActive()
                        val read = input.read(buffer)
                        if (read < 0) break
                        count += read
                        if (count > expectedBytes || count > MAX_AUDIO_BYTES) throw SourceChanged()
                        digest.update(buffer, 0, read)
                        output.write(buffer, 0, read)
                    }
                    if (count != expectedBytes || digest.digest().hex() != expectedHash) throw SourceChanged()
                }
            }
            val status = connection.responseCode
            if (status !in 200..299) throw UploadFailure(status)
            return UploadedAudio(count, connection.getHeaderField("ETag"))
        } finally {
            connection.disconnect()
        }
    }

    private fun secureConnection(address: String): HttpsURLConnection {
        val url = URL(address)
        require(url.protocol == "https" && url.userInfo == null && url.host.isNotBlank()) { "HTTPS is required" }
        return (url.openConnection() as HttpsURLConnection).apply {
            instanceFollowRedirects = false
            connectTimeout = 15_000
            readTimeout = 20_000
        }
    }

    fun customers(enrollment: Enrollment, query: String?, cursor: String?, limit: Int = PAGE_SIZE): Page<Customer> =
        parsePage(get("/v1/device/customers" + queryString("q" to query, "cursor" to cursor, "limit" to limit.toString()), enrollment.token), ::parseCustomer)

    fun customer(enrollment: Enrollment, customerId: String): Customer? =
        get("/v1/device/customers/${android.net.Uri.encode(customerId)}", enrollment.token).optJSONObject("customer")?.let(::parseCustomer)

    fun customerMessages(enrollment: Enrollment, customerId: String, cursor: String?, limit: Int = PAGE_SIZE): Page<WhatsAppMessage> =
        parsePage(get("/v1/device/customers/${android.net.Uri.encode(customerId)}/messages" + queryString("cursor" to cursor, "limit" to limit.toString()), enrollment.token), ::parseMessage)

    fun chats(enrollment: Enrollment, query: String?, cursor: String?, limit: Int = PAGE_SIZE): Page<ChatSummary> =
        parsePage(get("/v1/device/whatsapp/chats" + queryString("q" to query, "cursor" to cursor, "limit" to limit.toString()), enrollment.token), ::parseChat)

    fun whatsAppCanSend(enrollment: Enrollment): Boolean =
        parseCanSend(get("/v1/device/whatsapp/status", enrollment.token))

    /** Throws [ApiFailure] with code [WHATSAPP_NOT_CONFIGURED] (HTTP 503) until the server has a transport; nothing is stored then. */
    fun sendMessage(enrollment: Enrollment, customerId: String, clientMessageId: String, text: String): WhatsAppMessage? {
        val response = post("/v1/device/customers/${android.net.Uri.encode(customerId)}/messages",
            JSONObject().put("clientMessageId", clientMessageId).put("text", text), enrollment.token)
        return response.optJSONObject("message")?.let(::parseMessage)
    }

    private fun queryString(vararg parameters: Pair<String, String?>): String {
        val pairs = parameters.filter { !it.second.isNullOrEmpty() }
        return if (pairs.isEmpty()) "" else pairs.joinToString("&", prefix = "?") { "${it.first}=${android.net.Uri.encode(it.second)}" }
    }

    private fun get(path: String, token: String): JSONObject = request("GET", path, null, token)

    private fun post(path: String, payload: JSONObject, token: String? = null): JSONObject = request("POST", path, payload, token)

    private fun request(method: String, path: String, payload: JSONObject?, token: String?): JSONObject {
        val connection = secureConnection((server() ?: throw ServerNotSet()) + path)
        try {
            connection.requestMethod = method
            connection.setRequestProperty("Accept", "application/json")
            token?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
            if (payload != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                val bytes = payload.toString().toByteArray(Charsets.UTF_8)
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val status = connection.responseCode
            if (status !in 200..299) throw ApiFailure(status, errorCode(connection))
            return connection.inputStream.bufferedReader().use { JSONObject(it.readText()) }
        } finally {
            connection.disconnect()
        }
    }

    /** Reads at most 4 KiB of the error body for its code; the body itself is never kept or logged. */
    private fun errorCode(connection: HttpsURLConnection): String? = try {
        connection.errorStream?.bufferedReader()?.use { reader ->
            val buffer = CharArray(4096)
            val count = reader.read(buffer)
            parseApiErrorCode(if (count > 0) String(buffer, 0, count) else null)
        }
    } catch (_: Exception) {
        null
    }
}
