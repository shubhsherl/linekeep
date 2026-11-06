package com.microorganics.calltracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.json.JSONObject
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.IOException

class PushMessageTest {
    private fun data(vararg pairs: Pair<String, String>) = mapOf(*pairs)

    @Test fun parsesMessagePayload() {
        val push = parsePushPayload(data(
            "type" to "message", "customerId" to "c1", "customerName" to "Asha Traders",
            "title" to "New WhatsApp message", "body" to "Asha Traders",
        ))
        assertEquals(PushNotification("message", "c1", "Asha Traders", "New WhatsApp message", "Asha Traders"), push)
        assertEquals("c1", push!!.tag)
        assertEquals(PushNotification.MESSAGE_NOTIFICATION_ID, push.notificationId)
    }

    @Test fun parsesAssignedPayloadWithItsOwnNotificationId() {
        val push = parsePushPayload(data("type" to "assigned", "customerId" to "c2", "customerName" to "Asha Traders",
            "title" to "New customer assigned", "body" to "Asha Traders"))!!
        assertEquals("assigned", push.type)
        assertEquals(PushNotification.ASSIGNED_NOTIFICATION_ID, push.notificationId)
    }

    @Test fun missingTextFallsBackToDefaults() {
        val message = parsePushPayload(data("type" to "message", "customerId" to "c1", "customerName" to "Asha"))!!
        assertEquals("New WhatsApp message", message.title)
        assertEquals("Asha", message.body)
        assertEquals("New customer assigned", parsePushPayload(data("type" to "assigned", "customerId" to "c1"))!!.title)
    }

    @Test fun rejectsUnknownTypesAndMissingCustomers() {
        assertNull(parsePushPayload(emptyMap()))
        assertNull(parsePushPayload(data("type" to "unassigned", "customerId" to "c1")))
        assertNull(parsePushPayload(data("type" to "message")))
        assertNull(parsePushPayload(data("type" to "message", "customerId" to "  ")))
        assertNull(parsePushPayload(data("type" to "message", "customerId" to "x".repeat(129))))
    }

    @Test fun boundsTextLengths() {
        val push = parsePushPayload(data("type" to "message", "customerId" to "c1", "customerName" to "n".repeat(500),
            "title" to "t".repeat(500), "body" to "b".repeat(2000)))!!
        assertEquals(200, push.customerName.length)
        assertEquals(200, push.title.length)
        assertEquals(500, push.body.length)
    }

    @Test fun skipsOnlyAMessageForTheConversationOnScreen() {
        val message = PushNotification("message", "c1", "A", "t", "b")
        assertFalse(shouldPostPush(message, appInForeground = true, openConversationId = "c1"))
        assertTrue(shouldPostPush(message, appInForeground = false, openConversationId = "c1"))
        assertTrue(shouldPostPush(message, appInForeground = true, openConversationId = "c2"))
        assertTrue(shouldPostPush(message, appInForeground = true, openConversationId = null))
        val assigned = PushNotification("assigned", "c1", "A", "t", "b")
        assertTrue(shouldPostPush(assigned, appInForeground = true, openConversationId = "c1"))
    }

    @Test fun openRequestChoosesTheTab() {
        assertEquals(3, parseOpenRequest("message", "c1", "Asha")!!.tab)
        assertEquals(2, parseOpenRequest("assigned", "c1", null)!!.tab)
        assertEquals("", parseOpenRequest("assigned", "c1", null)!!.customerName)
    }

    @Test fun openRequestRejectsIncompleteExtras() {
        assertNull(parseOpenRequest(null, "c1", "Asha"))
        assertNull(parseOpenRequest("message", null, "Asha"))
        assertNull(parseOpenRequest("other", "c1", "Asha"))
        assertNull(parseOpenRequest("message", " ", "Asha"))
    }

    @Test fun pushNeedsAllFourFirebaseValues() {
        assertTrue(pushConfigured("k", "a", "p", "s"))
        assertFalse(pushConfigured("", "a", "p", "s"))
        assertFalse(pushConfigured("k", " ", "p", "s"))
        assertFalse(pushConfigured("k", "a", "", "s"))
        assertFalse(pushConfigured("k", "a", "p", ""))
    }

    private val serverConfig = FirebaseConfig("key", "1:1:android:a", "proj", "123")
    private val otherConfig = FirebaseConfig("key2", "1:2:android:b", "proj2", "456")
    private val noConfig = FirebaseConfig("", "", "", "")

    @Test fun storedOptionsBeatTheBuildFallback() {
        assertEquals(serverConfig, resolveFirebaseOptions(serverConfig, otherConfig))
    }

    @Test fun buildFallbackIsUsedWithoutCompleteStoredOptions() {
        assertEquals(otherConfig, resolveFirebaseOptions(null, otherConfig))
        assertEquals(otherConfig, resolveFirebaseOptions(serverConfig.copy(senderId = ""), otherConfig))
    }

    @Test fun pushIsDisabledWithoutAnyCompleteOptions() {
        assertNull(resolveFirebaseOptions(null, noConfig))
        assertNull(resolveFirebaseOptions(null, otherConfig.copy(appId = " ")))
    }

    @Test fun newServerOptionsInitializeFirebaseWhenNoneRunsYet() {
        assertEquals(PushConfigDecision.Save(serverConfig, initializeNow = true), decidePushConfig(null, serverConfig, null))
        // Stored options that failed to initialize earlier are retried.
        assertEquals(PushConfigDecision.Save(serverConfig, initializeNow = true), decidePushConfig(serverConfig, serverConfig, null))
    }

    @Test fun differingOptionsAreStoredForTheNextStartWhenFirebaseAlreadyRuns() {
        assertEquals(PushConfigDecision.Save(serverConfig, initializeNow = false), decidePushConfig(otherConfig, serverConfig, otherConfig))
        // The build fallback is running and the server now supplies options.
        assertEquals(PushConfigDecision.Save(serverConfig, initializeNow = false), decidePushConfig(null, serverConfig, otherConfig))
    }

    @Test fun unchangedOptionsKeepEverything() {
        assertEquals(PushConfigDecision.Keep, decidePushConfig(serverConfig, serverConfig, serverConfig))
    }

    @Test fun nullFromServerRemovesOnlyStoredOptions() {
        assertEquals(PushConfigDecision.Remove, decidePushConfig(serverConfig, null, serverConfig))
        assertEquals(PushConfigDecision.Keep, decidePushConfig(null, null, otherConfig))
        assertEquals(PushConfigDecision.Keep, decidePushConfig(null, null, null))
    }

    @Test fun parsesPushConfigResponse() {
        val body = JSONObject("""{"requestId":"r1","push":{"apiKey":" key ","appId":"1:1:android:a","projectId":"proj","senderId":"123"}}""")
        assertEquals(serverConfig, parsePushConfigResponse(body))
    }

    @Test fun nullPushMeansTheServerHasPushDisabled() {
        assertNull(parsePushConfigResponse(JSONObject("""{"requestId":"r1","push":null}""")))
    }

    @Test fun malformedPushConfigResponseIsAFailure() {
        listOf(
            """{"requestId":"r1"}""",
            """{"push":"nope"}""",
            """{"push":{"apiKey":"k","appId":"a","projectId":"p"}}""",
            """{"push":{"apiKey":"k","appId":"a","projectId":"p","senderId":""}}""",
            """{"push":{"apiKey":"k","appId":"a","projectId":"p","senderId":123}}""",
        ).forEach { body -> assertThrows(body, IOException::class.java) { parsePushConfigResponse(JSONObject(body)) } }
    }
}
