package com.microorganics.calltracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundAccessTest {
    @Test fun requiresBatteryExemptionAndNoRestriction() {
        assertTrue(BackgroundAccess.evaluate(ignoring = true, restricted = false, bucket = 10).unrestricted)
        assertFalse(BackgroundAccess.evaluate(ignoring = false, restricted = false, bucket = 10).unrestricted)
        assertFalse(BackgroundAccess.evaluate(ignoring = true, restricted = true, bucket = 10).unrestricted)
    }

    @Test fun restrictedStandbyBucketBlocksEvenAnExemptApp() {
        assertFalse(BackgroundAccess.evaluate(ignoring = true, restricted = false, bucket = 45).unrestricted)
        assertTrue(BackgroundAccess.evaluate(ignoring = true, restricted = false, bucket = 40).unrestricted)
        assertTrue(BackgroundAccess.evaluate(ignoring = true, restricted = false, bucket = null).unrestricted)
    }

    @Test fun reportsTheMostSpecificProblem() {
        assertEquals("Background activity is restricted for this app.",
            BackgroundAccess.evaluate(ignoring = false, restricted = true, bucket = 45).problem)
        assertNull(BackgroundAccess.evaluate(ignoring = true, restricted = false, bucket = 10).problem)
    }
}
