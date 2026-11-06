package com.microorganics.calltracker

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatLogicTest {
    // ---- phone normalisation and the duplicate check ----

    @Test fun phoneNormalisationMirrorsTheServer() {
        assertEquals("+919000000001", normalizePhone("90000 00001"))
        assertEquals("+919000000001", normalizePhone("09000000001"))
        assertEquals("+919000000001", normalizePhone("+91 (900) 000-0001"))
        assertEquals("+14155550123", normalizePhone("+1 415 555 0123"))
        assertNull(normalizePhone("1234567"))
        assertNull(normalizePhone("1234567890123456"))
        assertNull(normalizePhone("call me"))
    }

    @Test fun lookupDecidesWhatToDo() {
        assertEquals(DuplicateDecision.Create, decideAfterLookup(parseLookup(JSONObject("""{"phone":"+919000000001","exists":false,"mine":false}"""))!!))
        assertEquals(
            DuplicateDecision.OpenExisting("cus_1", "Asha Test"),
            decideAfterLookup(parseLookup(JSONObject("""{"phone":"+919000000001","exists":true,"mine":true,"customer":{"id":"cus_1","name":"Asha Test"}}"""))!!),
        )
        assertEquals(DuplicateDecision.BelongsToOther, decideAfterLookup(parseLookup(JSONObject("""{"phone":"+919000000001","exists":true,"mine":false}"""))!!))
        // A mine:true answer without a customer id cannot be opened, so nothing is revealed or created.
        assertEquals(DuplicateDecision.BelongsToOther, decideAfterLookup(parseLookup(JSONObject("""{"phone":"+919000000001","exists":true,"mine":true}"""))!!))
        assertNull(parseLookup(JSONObject("""{"phone":"+919000000001"}""")))
    }

    @Test fun newCustomerFormIsValidated() {
        assertNull(validateNewCustomer("Asha Test", "90000 00001", ""))
        assertEquals("Enter the customer's name.", validateNewCustomer("  ", "9000000001", ""))
        assertTrue(validateNewCustomer("Asha", "12", "")!!.contains("phone"))
    }

    @Test fun requestBodiesCarryOnlyWhatIsAllowed() {
        val create = createCustomerBody(" Asha Test ", "90000 00001", " ")
        assertEquals("Asha Test", create.getString("name"))
        assertEquals("+919000000001", create.getString("phone"))
        assertFalse(create.has("notes"))
        assertEquals("Call back", createCustomerBody("A", "9000000001", " Call back ").getString("notes"))

        val customer = Customer("cus_1", "Asha Test", "+919000000001", notes = "Old")
        assertNull(patchCustomerBody(customer, "Asha Test", "Old"))
        val patch = patchCustomerBody(customer, "Asha T", "Old")!!
        assertEquals("Asha T", patch.getString("name"))
        assertFalse(patch.has("notes"))
        assertFalse(patch.has("phone"))
        assertEquals("", patchCustomerBody(customer, "Asha Test", "")!!.getString("notes"))
    }

    // ---- 24-hour window ----

    @Test fun replyWindowState() {
        assertTrue(isReplyWindowOpen(null, 1_000))
        assertTrue(isReplyWindowOpen(WhatsAppWindow(true, 2_000), 1_000))
        assertFalse(isReplyWindowOpen(WhatsAppWindow(true, 2_000), 2_000))
        assertFalse(isReplyWindowOpen(WhatsAppWindow(false, null), 1_000))
        assertFalse(isReplyWindowOpen(WhatsAppWindow(false, 9_000), 1_000))
        assertTrue(isReplyWindowOpen(WhatsAppWindow(true, null), 1_000))
    }

    @Test fun customerCarriesItsWindow() {
        val customer = parseCustomer(JSONObject("""{"id":"cus_1","name":"Asha Test","phone":"+919000000001","notes":"n","whatsappWindow":{"open":true,"expiresAt":"2026-10-06T10:00:00.000Z"}}"""))!!
        assertEquals("n", customer.notes)
        assertEquals(WhatsAppWindow(true, 1_791_280_800_000L), customer.whatsappWindow)
        assertNull(parseCustomer(JSONObject("""{"id":"cus_1","name":"Asha Test","phone":"+919000000001"}"""))!!.whatsappWindow)
    }

    @Test fun errorCodesMatchRegardlessOfCase() {
        assertTrue(hasCode(ApiFailure(409, "window_closed"), WINDOW_CLOSED_CODE))
        assertTrue(hasCode(ApiFailure(409, "WINDOW_CLOSED"), WINDOW_CLOSED_CODE))
        assertFalse(hasCode(ApiFailure(409, null), WINDOW_CLOSED_CODE))
        assertEquals("cus_9", parseApiErrorCustomerId("""{"error":{"code":"customer_exists","customerId":"cus_9"}}"""))
        assertEquals("cus_9", parseApiErrorCustomerId("""{"customerId":"cus_9"}"""))
        assertNull(parseApiErrorCustomerId("""{"error":{"code":"customer_exists"}}"""))
    }

    // ---- quick replies ----

    @Test fun quickReplyPlaceholdersAreSubstituted() {
        val filled = fillQuickPlaceholders("Hi {{name}}, this is {{ handler_name }} ({{handler_phone}}).", "Asha", "Maya", "+919000000002")
        assertEquals("Hi Asha, this is Maya (+919000000002).", filled.text)
        assertTrue(filled.missing.isEmpty())
        val partial = fillQuickPlaceholders("{{handler_phone}} {{handler_phone}} {{unknown}}", "Asha", "Maya", " ")
        assertEquals("{{handler_phone}} {{handler_phone}} {{unknown}}", partial.text)
        assertEquals(listOf("handler_phone"), partial.missing)
    }

    @Test fun quickMessagesNeedIdTitleAndText() {
        assertEquals(QuickMessage("q1", "Hello", "Hi {{name}}"), parseQuickMessage(JSONObject("""{"id":"q1","title":"Hello","text":"Hi {{name}}","createdAt":"x"}""")))
        assertNull(parseQuickMessage(JSONObject("""{"id":"q1","title":"Hello"}""")))
    }

    // ---- templates ----

    private fun template(extra: String = "") = parseTemplate(JSONObject(
        """{"name":"welcome","language":"en_US","category":"UTILITY","header":"Hello","body":"Hi {{1}}, call {{2}} or visit {{3}}","footer":"Bye","variables":[{"key":"1"},{"key":"2","example":"+1"},{"key":"3"}],"sendable":true,"headerFormat":"NONE","headerImageConfigured":false$extra}"""
    ))!!

    @Test fun templateVariablesAreFilledFromTheEmployeeAndCustomer() {
        val context = FillContext("Asha", "Maya", "+919000000002")
        val template = template()
        assertEquals(listOf("Maya", "+919000000002", ""), initialTemplateValues(template, context))
        assertEquals("Asha", valueFor(VariableSource.CUSTOMER_NAME, context))
        assertEquals("a b", cleanVariable("a\n\tb"))
        assertEquals(VariableSource.HANDLER_PHONE, defaultVariableSource("2", 0))
        assertEquals(VariableSource.CUSTOM, defaultVariableSource("name", 2))
    }

    @Test fun templatePreviewShowsFilledAndUnfilledVariables() {
        val template = template()
        assertEquals("Hello\nHi Maya, call {{2}} or visit {{3}}\nBye", renderTemplate(template, listOf("Maya", "", "")))
    }

    @Test fun templateReadinessNamesTheProblem() {
        val template = template()
        assertEquals("Fill in every variable.", templateProblem(template, listOf("Maya", "+1", ""), false))
        assertNull(templateProblem(template, listOf("Maya", "+1", "x"), false))
        val unsendable = template.copy(sendable = false, reason = "Carousel templates are not supported yet")
        assertEquals("Carousel templates are not supported yet", templateProblem(unsendable, listOf("a", "b", "c"), false))
        val image = template.copy(headerFormat = "IMAGE", headerImageConfigured = false)
        assertEquals("Choose a header image.", templateProblem(image, listOf("a", "b", "c"), false))
        assertNull(templateProblem(image, listOf("a", "b", "c"), true))
        assertNull(templateProblem(image.copy(headerImageConfigured = true), listOf("a", "b", "c"), false))
    }

    @Test fun templateItemsParseWithDefaults() {
        val parsed = parseTemplate(JSONObject("""{"name":"hello","language":"en","body":"Hi","variables":[],"sendable":true}"""))!!
        assertEquals("NONE", parsed.headerFormat)
        assertFalse(parsed.headerImageConfigured)
        assertEquals("IMAGE", parseTemplate(JSONObject("""{"name":"x","language":"en","body":"b","headerFormat":"image","headerImageConfigured":true,"sendable":true}"""))!!.headerFormat)
        assertNull(parseTemplate(JSONObject("""{"language":"en"}""")))
    }

    // ---- send bodies ----

    @Test fun sendBodiesFollowTheApiShapes() {
        val text = textMessageBody("c1", "Hi")
        assertEquals(setOf("clientMessageId", "text"), text.keys().asSequence().toSet())
        assertEquals("Hi", text.getString("text"))
        val media = mediaMessageBody("c1", "att_1", " Look ")
        assertEquals("media", media.getString("type"))
        assertEquals("att_1", media.getString("attachmentId"))
        assertEquals("Look", media.getString("caption"))
        assertFalse(mediaMessageBody("c1", "att_1", "  ").has("caption"))

        val body = templateMessageBody("c2", template(), listOf("Maya", "+1", "x\ny"), "att_2")
        val inner = body.getJSONObject("template")
        assertEquals("welcome", inner.getString("name"))
        assertEquals("en_US", inner.getString("language"))
        assertEquals("""["Maya","+1","x y"]""", inner.getJSONArray("params").toString())
        assertEquals("att_2", inner.getString("headerAttachmentId"))
        assertFalse(templateMessageBody("c2", template(), listOf("a", "b", "c"), null).getJSONObject("template").has("headerAttachmentId"))
    }

    // ---- attachments ----

    @Test fun attachmentValidation() {
        assertEquals(AttachmentCheck.Ok, checkAttachment("image/jpeg", 1_000))
        assertEquals(AttachmentCheck.Ok, checkAttachment("application/pdf; charset=binary", MAX_ATTACHMENT_BYTES))
        assertEquals(AttachmentCheck.Ok, checkAttachment("text/csv", null))
        assertTrue(checkAttachment("application/pdf", MAX_ATTACHMENT_BYTES + 1) is AttachmentCheck.Rejected)
        assertTrue(checkAttachment("application/zip", 10) is AttachmentCheck.Rejected)
        assertTrue(checkAttachment(null, 10) is AttachmentCheck.Rejected)
        assertTrue(checkAttachment("image/png", 0) is AttachmentCheck.Rejected)
        // Large photos are shrunk before upload instead of rejected.
        assertEquals(AttachmentCheck.Ok, checkAttachment("image/jpeg", MAX_ATTACHMENT_BYTES + 1))
        assertTrue(shouldShrinkImage("image/jpeg", IMAGE_SHRINK_ABOVE_BYTES + 1))
        assertFalse(shouldShrinkImage("image/jpeg", 1_000))
        assertFalse(shouldShrinkImage("application/pdf", IMAGE_SHRINK_ABOVE_BYTES + 1))
        assertEquals("image", attachmentKind("image/webp"))
        assertEquals("video", attachmentKind("video/mp4"))
        assertEquals("document", attachmentKind("text/plain"))
        assertEquals("IMG_1.jpg", withExtension("IMG_1.heic", "jpg"))
    }

    @Test fun uploadedAttachmentParses() {
        val uploaded = parseUploadedAttachment(JSONObject("""{"requestId":"r","attachmentId":"att_1","kind":"image","mimeType":"image/jpeg","fileName":"a.jpg","size":12}"""))!!
        assertEquals(UploadedAttachment("att_1", "image", "image/jpeg", "a.jpg", 12), uploaded)
        assertNull(parseUploadedAttachment(JSONObject("""{"kind":"image"}""")))
    }

    // ---- presentation ----

    @Test fun initialsAndDaySeparators() {
        assertEquals("AT", initialsOf("Asha Test"))
        assertEquals("A", initialsOf("asha"))
        assertEquals("#", initialsOf("  "))
        val day = 86_400_000L
        // Newest first: two on day 3, one on day 2, one on day 2, one on day 1.
        val times = listOf(3 * day + 5, 3 * day + 1, 2 * day + 9, 2 * day + 2, day + 1)
        assertEquals(setOf(1, 3, 4), dayStartIndexes(times) { 0L })
        // A local offset moves the day boundary.
        assertEquals(setOf(0), dayStartIndexes(listOf(day + 1)) { 3_600_000L })
    }

    // ---- handler profile ----

    @Test fun handlerPhonePrefersTheConfiguredNumberThenTheSim() {
        val configured = parseProfile(JSONObject("""{"requestId":"r","employee":{"id":"emp_1","name":"Maya Test","phoneNumber":" +919000000002 "}}"""))!!
        val without = parseProfile(JSONObject("""{"employee":{"id":"emp_1","name":"Maya Test","phoneNumber":null}}"""))!!
        assertEquals("+919000000002", resolveHandlerPhone(configured, listOf("+919000000003")))
        assertEquals("+919000000003", resolveHandlerPhone(without, listOf(" ", "+919000000003")))
        assertEquals("+919000000003", resolveHandlerPhone(null, listOf("+919000000003")))
        assertEquals("", resolveHandlerPhone(without, emptyList()))
        // Still unknown: the placeholder stays and is flagged.
        val filled = fillQuickPlaceholders("Call {{handler_phone}}", "Asha", "Maya", resolveHandlerPhone(without, emptyList()))
        assertEquals("Call {{handler_phone}}", filled.text)
        assertEquals(listOf("handler_phone"), filled.missing)
        assertEquals("Maya Test", resolveHandlerName(configured, "Enrolled"))
        assertEquals("Enrolled", resolveHandlerName(null, " Enrolled "))
        assertNull(parseProfile(JSONObject("""{"requestId":"r"}""")))
    }
}

class CustomerActionsLogicTest {
    @Test fun waMeUrlUsesDigitsOnly() {
        assertEquals("https://wa.me/919000000001", waMeUrl("+919000000001"))
        assertEquals("https://wa.me/14155550123", waMeUrl("+1 415 555 0123"))
        assertNull(waMeUrl(""))
        assertNull(waMeUrl("+123"))
    }

    @Test fun personalWhatsAppTriesAppThenBrowser() {
        assertEquals(PersonalWhatsAppStep.WHATSAPP_APP, nextPersonalWhatsAppStep(null))
        assertEquals(PersonalWhatsAppStep.BROWSER, nextPersonalWhatsAppStep(PersonalWhatsAppStep.WHATSAPP_APP))
        assertNull(nextPersonalWhatsAppStep(PersonalWhatsAppStep.BROWSER))
        assertEquals("com.whatsapp", WHATSAPP_PACKAGE)
    }

    @Test fun onlyTextMessagesCanBeCopied() {
        assertEquals("hello", copyableText("hello"))
        assertNull(copyableText(null))
        assertNull(copyableText("  "))
    }
}
