package com.microorganics.calltracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class CredentialMaskTest {
    @Test fun keepsOnlyTheEndsOfALongCredential() {
        val secret = "abcd" + "S".repeat(30) + "wxyz"
        val masked = maskCredential(secret)
        assertEquals("abcd••••••••••••wxyz", masked)
        assertFalse(masked.contains("SSSS"))
    }

    @Test fun hidesShortValuesCompletely() {
        val masked = maskCredential("shorttoken123456789")
        assertEquals("••••••••••••", masked)
    }
}
