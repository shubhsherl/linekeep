package com.microorganics.calltracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MainNavigationTest {
    @Test fun bottomDestinationsAreInTheRequestedOrder() {
        assertEquals(
            listOf(MainDestination.CUSTOMERS, MainDestination.CHATS, MainDestination.ANALYTICS, MainDestination.SETTINGS),
            MainDestination.entries,
        )
        assertEquals(listOf("Customers", "WhatsApp", "Call analytics", "Settings"), MainDestination.entries.map { it.label })
    }

    @Test fun topTabsAreInTheRequestedOrder() {
        assertEquals(listOf("Setup", "Advanced"), SettingsSection.entries.map { it.label })
        assertEquals(listOf("Analytics", "Call logs"), AnalyticsSection.entries.map { it.label })
    }

    @Test fun savedIndexesFallBackToTheFirstEntry() {
        assertEquals(MainDestination.ANALYTICS, MainDestination.fromIndex(2))
        assertEquals(MainDestination.CUSTOMERS, MainDestination.fromIndex(9))
        assertEquals(MainDestination.CUSTOMERS, MainDestination.fromIndex(-1))
        assertEquals(SettingsSection.ADVANCED, SettingsSection.fromIndex(1))
        assertEquals(SettingsSection.SETUP, SettingsSection.fromIndex(5))
        assertEquals(AnalyticsSection.CALL_LOGS, AnalyticsSection.fromIndex(1))
        assertEquals(AnalyticsSection.ANALYTICS, AnalyticsSection.fromIndex(5))
    }

    @Test fun notificationTapsOpenCustomersOrWhatsApp() {
        assertEquals(MainDestination.CHATS, parseOpenRequest("message", "c1", "Asha")!!.destination())
        assertEquals(MainDestination.CUSTOMERS, parseOpenRequest("assigned", "c1", null)!!.destination())
    }

    @Test fun conversationsHideTheBottomBar() {
        assertTrue(showsBottomBar(null))
        assertFalse(showsBottomBar("c1"))
    }

    @Test fun liveChatUpdatesRunOnlyOnTheWhatsAppDestination() {
        assertTrue(chatsVisible(MainDestination.CHATS))
        assertFalse(chatsVisible(MainDestination.CUSTOMERS))
        assertFalse(chatsVisible(MainDestination.ANALYTICS))
        assertFalse(chatsVisible(MainDestination.SETTINGS))
    }
}
