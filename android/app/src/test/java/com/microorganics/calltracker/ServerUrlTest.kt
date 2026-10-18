package com.microorganics.calltracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerUrlTest {
    @Test
    fun acceptsHttpsOriginAndStripsTrailingSlash() {
        assertEquals("https://api.example.com", validateServerUrl("https://api.example.com"))
        assertEquals("https://api.example.com", validateServerUrl("https://api.example.com/"))
        assertEquals("https://api.example.com", validateServerUrl("  https://API.Example.com/  "))
        assertEquals("https://api.example.com:8443", validateServerUrl("https://api.example.com:8443/"))
    }

    @Test
    fun rejectsEverythingElse() {
        listOf(
            "", "   ", "api.example.com", "http://api.example.com", "ftp://api.example.com", "https://",
            "https:///path", "https://user@api.example.com", "https://user:pw@api.example.com",
            "https://api.example.com/v1", "https://api.example.com//", "https://api.example.com?x=1",
            "https://api.example.com/?x=1", "https://api.example.com?", "https://api.example.com#frag",
            "https://api.example.com#", "https://api example.com", "https://api_example.com",
        ).forEach { assertNull(it, validateServerUrl(it)) }
    }
}

class EnrollmentQrTest {
    @Test
    fun parsesCodeWithServer() {
        val parsed = parseEnrollmentQr("linekeep://enroll?server=https%3A%2F%2Fapi.example.com&code=abc123")
        assertEquals(EnrollmentQr("https://api.example.com", "abc123"), parsed)
    }

    @Test
    fun parsesCodeWithoutServer() {
        assertEquals(EnrollmentQr(null, "abc123"), parseEnrollmentQr("linekeep://enroll?code=abc123"))
    }

    @Test
    fun roundTripsSymbolsAndUnicodeInCode() {
        val code = "a+b/c=d&e%f g?#é✓-_.~"
        val encoded = java.net.URLEncoder.encode(code, "UTF-8").replace("+", "%20")
        assertEquals(code, parseEnrollmentQr("linekeep://enroll?code=$encoded")?.code)
        val server = java.net.URLEncoder.encode("https://api.example.com/", "UTF-8")
        assertEquals(EnrollmentQr("https://api.example.com", code), parseEnrollmentQr("linekeep://enroll?server=$server&code=$encoded"))
    }

    @Test
    fun literalPlusStaysPlus() {
        assertEquals("a+b", parseEnrollmentQr("linekeep://enroll?code=a+b")?.code)
    }

    @Test
    fun ignoresUnknownParametersAndOrder() {
        assertEquals(
            EnrollmentQr("https://api.example.com", "c1"),
            parseEnrollmentQr("linekeep://enroll?v=2&code=c1&extra=ignored&server=https%3A%2F%2Fapi.example.com"),
        )
    }

    @Test
    fun rejectsWrongSchemeHostAndPath() {
        listOf(
            "https://enroll?code=abc", "linekeep://other?code=abc", "linekeep://enroll/extra?code=abc",
            "otherapp://enroll?code=abc", "linekeep:enroll?code=abc", "", "not a uri", "abc123",
            "linekeep://user@enroll?code=abc", "linekeep://enroll:99?code=abc",
        ).forEach { assertNull(it, parseEnrollmentQr(it)) }
    }

    @Test
    fun rejectsMissingOrBlankCode() {
        listOf(
            "linekeep://enroll", "linekeep://enroll?server=https%3A%2F%2Fapi.example.com", "linekeep://enroll?code=",
            "linekeep://enroll?code=%20%20", "linekeep://enroll?Code=abc",
        ).forEach { assertNull(it, parseEnrollmentQr(it)) }
        assertNull(parseEnrollmentQr("linekeep://enroll?code=" + "a".repeat(MAX_SETUP_CODE_CHARS + 1)))
    }

    @Test
    fun rejectsBadServerAndBadEncoding() {
        listOf(
            "linekeep://enroll?server=http%3A%2F%2Fapi.example.com&code=abc",
            "linekeep://enroll?server=https%3A%2F%2Fapi.example.com%2Fv1&code=abc",
            "linekeep://enroll?server=https%3A%2F%2Fuser%40api.example.com&code=abc",
            "linekeep://enroll?server=https%3A%2F%2Fapi.example.com%3Fx%3D1&code=abc",
            "linekeep://enroll?server=&code=abc", "linekeep://enroll?server=nonsense&code=abc",
            "linekeep://enroll?code=%E0%A4%A", "linekeep://enroll?code=%ff%fe",
        ).forEach { assertNull(it, parseEnrollmentQr(it)) }
    }
}
