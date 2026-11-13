package com.microorganics.calltracker

import org.json.JSONObject
import java.io.IOException
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/**
 * Read-only calls for the signed-in employee's own analytics and call history. Called only from an IO dispatcher.
 * Same transport rules as [DeviceApi]: HTTPS only, no redirects, no logging; error bodies are reduced to their code.
 */
internal class AnalyticsApi(private val server: () -> String?) {

    /** Managers pass [employeeIds] (comma-separated, null = the whole scope) and [byEmployee] to get the per-employee breakdown. */
    fun analytics(enrollment: Enrollment, range: DateRange, employeeIds: String? = null, byEmployee: Boolean = false): CallAnalytics {
        val body = get("/v1/device/analytics", enrollment.token, "from" to range.from.toString(), "to" to range.to.toString(),
            "employeeIds" to employeeIds, "groupBy" to if (byEmployee) "employee" else null)
        return parseAnalytics(body) ?: throw IOException("Malformed analytics response")
    }

    fun callHistory(enrollment: Enrollment, numberTerm: String?, callType: String?, cursor: String?, employeeId: String? = null, limit: Int = PAGE_SIZE): Page<CallLogItem> =
        parsePage(
            get("/v1/device/call-history", enrollment.token,
                "number" to numberTerm, "callType" to callType, "cursor" to cursor, "limit" to limit.toString(), "employeeId" to employeeId),
            ::parseCallLog,
        )

    private fun get(path: String, token: String, vararg parameters: Pair<String, String?>): JSONObject {
        val pairs = parameters.filter { !it.second.isNullOrEmpty() }
        val query = if (pairs.isEmpty()) "" else pairs.joinToString("&", prefix = "?") { "${it.first}=${android.net.Uri.encode(it.second)}" }
        val url = URL((server() ?: throw ServerNotSet()) + path + query)
        require(url.protocol == "https" && url.userInfo == null && url.host.isNotBlank()) { "HTTPS is required" }
        val connection = (url.openConnection() as HttpsURLConnection).apply {
            instanceFollowRedirects = false
            connectTimeout = 15_000
            readTimeout = 20_000
            requestMethod = "GET"
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Authorization", "Bearer $token")
        }
        try {
            val status = connection.responseCode
            if (status !in 200..299) throw ApiFailure(status, errorCode(connection))
            return connection.inputStream.bufferedReader().use { reader -> reader.readText().ifBlank { "{}" }.let(::JSONObject) }
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
