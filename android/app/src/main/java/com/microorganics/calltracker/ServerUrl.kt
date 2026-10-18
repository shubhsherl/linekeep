package com.microorganics.calltracker

import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.URISyntaxException

/** Longest scanned payload or typed server URL considered at all. */
private const val MAX_INPUT_CHARS = 2048
/** Same bound the manual setup-code field enforces. */
internal const val MAX_SETUP_CODE_CHARS = 512

/** A parsed setup QR. [server] is a validated HTTPS origin, or null to keep the configured server. */
internal data class EnrollmentQr(val server: String?, val code: String)

/**
 * Returns the normalized HTTPS origin (no trailing slash) or null. The server receives bearer tokens, so only
 * `https://host[:port]` is accepted: no credentials, query, fragment or path other than an optional "/".
 */
internal fun validateServerUrl(input: String): String? {
    val value = input.trim()
    if (value.isEmpty() || value.length > MAX_INPUT_CHARS) return null
    val uri = try { URI(value) } catch (_: URISyntaxException) { return null }
    val host = uri.host
    if (!uri.scheme.equals("https", ignoreCase = true) || host.isNullOrBlank()) return null
    if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
    if (!uri.rawPath.isNullOrEmpty() && uri.rawPath != "/") return null
    val port = if (uri.port == -1) "" else ":${uri.port}"
    return "https://${host.lowercase()}$port"
}

/**
 * Parses `linekeep://enroll?server=<origin>&code=<code>`. Anything else, including an unusable `server`,
 * returns null. Unknown parameters are ignored and the first occurrence of a parameter wins.
 */
internal fun parseEnrollmentQr(raw: String): EnrollmentQr? {
    val value = raw.trim()
    if (value.isEmpty() || value.length > MAX_INPUT_CHARS) return null
    val uri = try { URI(value) } catch (_: URISyntaxException) { return null }
    if (!uri.scheme.equals("linekeep", ignoreCase = true) || !uri.host.equals("enroll", ignoreCase = true)) return null
    if (uri.rawUserInfo != null || uri.port != -1) return null
    if (!uri.rawPath.isNullOrEmpty() && uri.rawPath != "/") return null
    val parameters = LinkedHashMap<String, String>()
    for (pair in uri.rawQuery.orEmpty().split('&')) {
        if (pair.isEmpty()) continue
        val separator = pair.indexOf('=')
        val name = percentDecode(if (separator < 0) pair else pair.substring(0, separator)) ?: return null
        val parameterValue = percentDecode(if (separator < 0) "" else pair.substring(separator + 1)) ?: return null
        parameters.putIfAbsent(name, parameterValue)
    }
    val code = parameters["code"]?.trim()
    if (code.isNullOrEmpty() || code.length > MAX_SETUP_CODE_CHARS) return null
    val server = parameters["server"]?.let { validateServerUrl(it) ?: return null }
    return EnrollmentQr(server, code)
}

/** Percent-decodes UTF-8; "+" stays literal because setup codes may contain it. Null for malformed input. */
private fun percentDecode(value: String): String? {
    if (value.indexOf('%') < 0) return value
    val bytes = ByteArrayOutputStream(value.length)
    var index = 0
    while (index < value.length) {
        val character = value[index]
        if (character == '%') {
            if (index + 2 >= value.length) return null
            val high = hexValue(value[index + 1])
            val low = hexValue(value[index + 2])
            if (high < 0 || low < 0) return null
            bytes.write(high * 16 + low)
            index += 3
        } else {
            val codePoint = value.codePointAt(index)
            bytes.write(String(Character.toChars(codePoint)).toByteArray(Charsets.UTF_8))
            index += Character.charCount(codePoint)
        }
    }
    val decoder = Charsets.UTF_8.newDecoder()
    return try {
        decoder.decode(java.nio.ByteBuffer.wrap(bytes.toByteArray())).toString()
    } catch (_: java.nio.charset.CharacterCodingException) {
        null
    }
}

private fun hexValue(character: Char): Int = when (character) {
    in '0'..'9' -> character - '0'
    in 'a'..'f' -> character - 'a' + 10
    in 'A'..'F' -> character - 'A' + 10
    else -> -1
}
