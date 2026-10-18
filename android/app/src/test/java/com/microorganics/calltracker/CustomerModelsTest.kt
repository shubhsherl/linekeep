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
}
