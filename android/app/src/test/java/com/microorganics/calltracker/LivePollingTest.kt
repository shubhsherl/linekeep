package com.microorganics.calltracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LivePollingTest {
    private val browsing = PollPolicy.BROWSING
    private val conversation = PollPolicy.CONVERSATION

    @Test fun staysAtBaseWhileChangesKeepComing() {
        assertEquals(15_000L, nextPollDelay(browsing, unchangedStreak = 0, failureStreak = 0))
        assertEquals(5_000L, nextPollDelay(conversation, unchangedStreak = 0, failureStreak = 0))
    }

    @Test fun staysAtBaseThroughTheGraceWindow() {
        assertEquals(15_000L, nextPollDelay(browsing, 2, 0))
        assertEquals(5_000L, nextPollDelay(conversation, 6, 0))
    }

    @Test fun stretchesTowardTheCeilingWhenNothingChanges() {
        assertEquals(30_000L, nextPollDelay(browsing, 3, 0))
        assertEquals(60_000L, nextPollDelay(browsing, 4, 0))
        assertEquals(60_000L, nextPollDelay(browsing, 400, 0))
        assertEquals(10_000L, nextPollDelay(conversation, 7, 0))
        assertEquals(20_000L, nextPollDelay(conversation, 8, 0))
        assertEquals(20_000L, nextPollDelay(conversation, 400, 0))
    }

    @Test fun anOpenConversationNeverWaitsLongerThanItsCeiling() {
        assertTrue((0..1000).all { nextPollDelay(conversation, it, 0) <= conversation.idleMaxMs })
    }

    @Test fun failuresDoubleFromTheBaseUpToSixtySeconds() {
        assertEquals(30_000L, nextPollDelay(browsing, 0, 1))
        assertEquals(60_000L, nextPollDelay(browsing, 0, 2))
        assertEquals(60_000L, nextPollDelay(browsing, 0, 50))
        assertEquals(10_000L, nextPollDelay(conversation, 0, 1))
        assertEquals(40_000L, nextPollDelay(conversation, 0, 3))
        assertEquals(60_000L, nextPollDelay(conversation, 0, 4))
    }

    @Test fun failuresDominateAnIdleBackOff() {
        assertEquals(30_000L, nextPollDelay(browsing, 10, 1))
    }

    @Test fun aCeilingBelowTheBaseNeverShortensThePoll() {
        assertEquals(10_000L, nextPollDelay(PollPolicy(10_000L, 1_000L, 0), 5, 0))
    }
}
