package com.microorganics.calltracker

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ObserverSignalsTest {
    @Test fun callLogSignalsRunAtOnce() {
        assertTrue(signalsCallLog(listOf("content://call_log/calls")))
        assertTrue(signalsCallLog(listOf("content://call_log/calls/42")))
        assertTrue(signalsCallLog(listOf("content://media/external/images/media/9", "content://call_log/calls")))
    }

    @Test fun signalsThatSayNothingRunAtOnce() {
        assertTrue(signalsCallLog(emptyList()))
        assertTrue(signalsCallLog(listOf(null)))
    }

    @Test fun mediaAndFolderSignalsAreCoalesced() {
        assertFalse(signalsCallLog(listOf("content://media/external/images/media/9")))
        assertFalse(signalsCallLog(listOf("content://media/external_primary/audio/media/7", "content://com.android.externalstorage.documents/tree/primary%3ARecordings")))
    }
}
