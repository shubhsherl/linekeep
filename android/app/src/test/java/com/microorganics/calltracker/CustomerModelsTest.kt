package com.microorganics.calltracker

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CustomerModelsTest {
    @Test fun customerWithOnlyRequiredFieldsParses() {
        val page = parsePage(JSONObject("""{"requestId":"r","items":[{"id":"cus_1","name":"Asha Test","phone":"+919000000001"}],"nextCursor":null}"""), ::parseCustomer)
        val customer = page.items.single()
        assertEquals("Asha Test", customer.name)
        assertNull(customer.email)
        assertNull(customer.lastMessageAt)
        assertTrue(customer.employees.isEmpty())
        assertNull(page.nextCursor)
    }

    @Test fun malformedItemsAreSkippedAndUnknownFieldsIgnored() {
        val json = JSONObject("""{"items":[{"id":"cus_1","name":"Ravi Test","phone":"+919000000002","future":{"x":1},"lastMessageAt":"2026-10-06T10:00:00.000Z","employees":[{"id":"emp_1","name":"Maya Test"},{"name":"no id"}]},{"id":"cus_2","name":""}],"nextCursor":"abc"}""")
        val page = parsePage(json, ::parseCustomer)
        assertEquals(listOf("cus_1"), page.items.map { it.id })
        assertEquals(1_791_280_800_000L, page.items.single().lastMessageAt)
        assertEquals(listOf(EmployeeRef("emp_1", "Maya Test")), page.items.single().employees)
        assertEquals("abc", page.nextCursor)
    }

    @Test fun mediaMessageWithoutBodyKeepsUnknownStatus() {
        val message = parseMessage(JSONObject("""{"id":"wam_1","customerId":"cus_1","direction":"in","messageType":"image","status":"archived","sentAt":1791280800000}"""))!!
        assertEquals(MessageDirection.IN, message.direction)
        assertNull(message.body)
        assertEquals("archived", message.status)
    }

    @Test fun errorCodeComesFromTheStandardErrorBodyOnly() {
        assertEquals(WHATSAPP_NOT_CONFIGURED, parseApiErrorCode("""{"requestId":"r","error":{"code":"WHATSAPP_NOT_CONFIGURED","message":"Not set up"}}"""))
        assertNull(parseApiErrorCode("<html>503</html>"))
        assertNull(parseApiErrorCode(null))
        assertFalse(parseCanSend(JSONObject("""{"requestId":"r"}""")))
    }

    private fun chatJson(extra: String) = JSONObject("""{"customer":{"id":"cus_1","name":"Asha Test","phone":"+919000000001"},"lastMessage":{"direction":"in","messageType":"text","text":"Hi","sentAt":1791280800000},"messageCount":3$extra}""")

    @Test fun chatUnreadCountIsParsedAndDefaultsToZero() {
        assertEquals(4, parseChat(chatJson(""","unreadCount":4"""))!!.unreadCount)
        assertEquals(0, parseChat(chatJson(""))!!.unreadCount)
        assertEquals(0, parseChat(chatJson(""","unreadCount":-2"""))!!.unreadCount)
    }

    @Test fun unreadTotalsParse() {
        assertEquals(UnreadTotals(2, 7), parseUnread(JSONObject("""{"requestId":"r","chats":2,"messages":7}""")))
        assertEquals(UnreadTotals(0, 0), parseUnread(JSONObject("""{"requestId":"r"}""")))
    }

    @Test fun mediaIsParsedWhenPresentAndAbsentOtherwise() {
        val with = parseMessage(JSONObject("""{"id":"m1","sentAt":1791280800000,"messageType":"image","media":{"kind":"image","mimeType":"image/jpeg","fileName":"a.jpg","size":1234,"url":"/v1/device/whatsapp/messages/m1/media"}}"""))!!
        assertEquals(MessageMedia(MediaKind.IMAGE, "/v1/device/whatsapp/messages/m1/media", "image/jpeg", "a.jpg", 1234L), with.media)
        assertNull(parseMessage(JSONObject("""{"id":"m2","sentAt":1791280800000}"""))!!.media)
        assertNull(parseMessage(JSONObject("""{"id":"m3","sentAt":1791280800000,"media":{"kind":"image"}}"""))!!.media)
    }

    @Test fun unknownMediaKindBecomesDocument() {
        val message = parseMessage(JSONObject("""{"id":"m4","sentAt":1791280800000,"media":{"kind":"hologram","url":"/v1/device/whatsapp/messages/m4/media"}}"""))!!
        assertEquals(MediaKind.DOCUMENT, message.media!!.kind)
        assertNull(message.media!!.size)
    }

    @Test fun versionParses() {
        assertEquals(42L, parseVersion(JSONObject("""{"requestId":"r","version":42}""")))
        assertNull(parseVersion(JSONObject("""{"version":"x"}""")))
    }
}
