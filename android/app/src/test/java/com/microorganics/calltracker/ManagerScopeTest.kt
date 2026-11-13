package com.microorganics.calltracker

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class ManagerScopeTest {
    private val asha = TeamMember("emp_asha", "Asha Test", "+919000000011")
    private val ravi = TeamMember("emp_ravi", "Ravi Test", null)
    private val manager = EmployeeProfile("emp_mgr", "Maya Test", "+919000000010", role = "manager", team = listOf(asha, ravi))
    private val plain = EmployeeProfile("emp_plain", "Neel Test", null)

    private fun profileJson(employee: String) = JSONObject("""{"requestId":"r","employee":$employee}""")

    // ---- Role gating and profile parsing ---------------------------------------------------------------------------

    @Test fun missingRoleMeansEmployeeAndHidesTeam() {
        val profile = parseProfile(profileJson("""{"id":"emp_1","name":"Neel Test","phoneNumber":null,"team":[{"id":"emp_2","name":"Ignored"}]}"""))!!
        assertEquals("employee", profile.role)
        assertTrue(profile.team.isEmpty())
        assertFalse(profile.isManagerProfile())
        assertNull(profile.asManager())
    }

    @Test fun unknownRoleIsNotAManager() {
        val profile = parseProfile(profileJson("""{"id":"emp_1","name":"Neel Test","role":"supervisor-2"}"""))!!
        assertEquals("employee", profile.role)
        assertFalse(profile.isManagerProfile())
        assertFalse(null.isManagerProfile())
    }

    @Test fun managerProfileKeepsTeamAndSkipsMalformedMembers() {
        val profile = parseProfile(profileJson(
            """{"id":"emp_mgr","name":"Maya Test","phoneNumber":"+919000000010","role":"manager","managerId":null,"future":1,
               "team":[{"id":"emp_asha","name":"Asha Test","phoneNumber":"+919000000011"},{"name":"no id"},{"id":"emp_ravi","name":"Ravi Test","phoneNumber":null},
                       {"id":"emp_asha","name":"duplicate"},"junk"]}"""
        ))!!
        assertTrue(profile.isManagerProfile())
        assertEquals(listOf(asha, ravi), profile.team)
        assertNull(profile.managerId)
    }

    @Test fun reportKeepsItsManagerId() {
        val profile = parseProfile(profileJson("""{"id":"emp_asha","name":"Asha Test","role":"employee","managerId":"emp_mgr","team":[]}"""))!!
        assertEquals("emp_mgr", profile.managerId)
        assertFalse(profile.isManagerProfile())
    }

    @Test fun roleIsCaseInsensitiveOnTheWire() {
        assertTrue(parseProfile(profileJson("""{"id":"emp_m","name":"M","role":"Manager"}"""))!!.isManagerProfile())
    }

    @Test fun scopeMembersListManagerFirstAndNothingForOthers() {
        assertEquals(listOf("emp_mgr", "emp_asha", "emp_ravi"), scopeMembers(manager).map { it.id })
        assertTrue(scopeMembers(plain).isEmpty())
        assertTrue(scopeMembers(null).isEmpty())
    }

    @Test fun signatureChangesWithRoleAndTeam() {
        assertEquals("employee", scopeSignature(plain))
        assertEquals("employee", scopeSignature(null))
        assertEquals("manager:emp_asha,emp_ravi", scopeSignature(manager))
        assertEquals(scopeSignature(manager), scopeSignature(manager.copy(team = listOf(ravi, asha))))
        assertFalse(scopeSignature(manager) == scopeSignature(manager.copy(team = listOf(asha))))
    }

    // ---- Scope parameters ------------------------------------------------------------------------------------------

    @Test fun nonManagersNeverSendScopeParameters() {
        listOf(ScopeFilter.All, ScopeFilter.Mine, ScopeFilter.Team, ScopeFilter.Member("emp_asha")).forEach {
            assertNull(scopeParam(it, plain))
            assertNull(scopeParam(it, null))
        }
        assertNull(analyticsEmployeeIds(setOf("emp_asha"), plain))
        assertNull(analyticsEmployeeIds(setOf("emp_asha"), null))
    }

    @Test fun managerScopeParameters() {
        assertNull(scopeParam(ScopeFilter.All, manager))
        assertEquals("me", scopeParam(ScopeFilter.Mine, manager))
        assertEquals("team", scopeParam(ScopeFilter.Team, manager))
        assertEquals("emp_asha", scopeParam(ScopeFilter.Member("emp_asha"), manager))
        assertEquals("me", scopeParam(ScopeFilter.Member("emp_mgr"), manager))
    }

    @Test fun staleOrEmptyScopeIsNotSent() {
        assertNull(scopeParam(ScopeFilter.Member("emp_left"), manager))
        assertNull(scopeParam(ScopeFilter.Team, manager.copy(team = emptyList())))
        assertEquals(ScopeFilter.All, normalizeFilter(ScopeFilter.Member("emp_left"), manager))
        assertEquals(ScopeFilter.All, normalizeFilter(ScopeFilter.Team, manager.copy(team = emptyList())))
        assertEquals(ScopeFilter.All, normalizeFilter(ScopeFilter.Mine, plain))
        assertEquals(ScopeFilter.Member("emp_ravi"), normalizeFilter(ScopeFilter.Member("emp_ravi"), manager))
        assertEquals(ScopeFilter.Mine, normalizeFilter(ScopeFilter.Mine, manager))
    }

    @Test fun filterLabels() {
        assertEquals("All", scopeFilterLabel(ScopeFilter.All, manager))
        assertEquals("Team", scopeFilterLabel(ScopeFilter.Team, manager))
        assertEquals("Asha Test", scopeFilterLabel(ScopeFilter.Member("emp_asha"), manager))
        assertEquals("Employee", scopeFilterLabel(ScopeFilter.Member("emp_left"), manager))
    }

    @Test fun analyticsEmployeeIdsAreScopedSortedAndOmittedForTheWholeScope() {
        assertNull(analyticsEmployeeIds(emptySet(), manager))
        assertNull(analyticsEmployeeIds(setOf("emp_mgr", "emp_asha", "emp_ravi"), manager))
        assertEquals("emp_asha,emp_ravi", analyticsEmployeeIds(setOf("emp_ravi", "emp_asha"), manager))
        assertEquals("emp_mgr", analyticsEmployeeIds(setOf("emp_mgr"), manager))
        // Ids outside the scope are dropped, and nothing valid left means the whole scope.
        assertEquals("emp_asha", analyticsEmployeeIds(setOf("emp_asha", "emp_stranger"), manager))
        assertNull(analyticsEmployeeIds(setOf("emp_stranger"), manager))
    }

    @Test fun analyticsChipsRoundTrip() {
        assertEquals(AnalyticsChip.ALL, analyticsChip(emptySet(), manager))
        assertEquals(AnalyticsChip.MINE, analyticsChip(setOf("emp_mgr"), manager))
        assertEquals(AnalyticsChip.TEAM, analyticsChip(setOf("emp_asha", "emp_ravi"), manager))
        assertEquals(AnalyticsChip.CUSTOM, analyticsChip(setOf("emp_asha"), manager))
        assertEquals(AnalyticsChip.CUSTOM, analyticsChip(setOf("emp_mgr", "emp_ravi"), manager))
        assertEquals(emptySet<String>(), analyticsSelectionFor(AnalyticsChip.ALL, manager, setOf("emp_asha")))
        assertEquals(setOf("emp_mgr"), analyticsSelectionFor(AnalyticsChip.MINE, manager, emptySet()))
        assertEquals(setOf("emp_asha", "emp_ravi"), analyticsSelectionFor(AnalyticsChip.TEAM, manager, emptySet()))
        assertEquals(setOf("emp_asha"), analyticsSelectionFor(AnalyticsChip.CUSTOM, manager, setOf("emp_asha")))
    }

    // ---- Customer markers ------------------------------------------------------------------------------------------

    @Test fun teamMarkerUsesServerScopeFirstThenHandlers() {
        val others = listOf(EmployeeRef("emp_asha", "Asha Test"))
        assertTrue(isTeamCustomer("team", emptyList(), "emp_mgr"))
        assertFalse(isTeamCustomer("own", others, "emp_mgr"))
        assertTrue(isTeamCustomer(null, others, "emp_mgr"))
        assertFalse(isTeamCustomer(null, others + EmployeeRef("emp_mgr", "Maya Test"), "emp_mgr"))
        assertFalse(isTeamCustomer(null, emptyList(), "emp_mgr"))
        assertFalse(isTeamCustomer(null, others, null))
    }

    @Test fun handlerNamesMarkTheViewer() {
        val handlers = listOf(EmployeeRef("emp_mgr", "Maya Test"), EmployeeRef("emp_asha", "Asha Test"), EmployeeRef("emp_x", ""))
        assertEquals("You, Asha Test, Employee", handlerNames(handlers, "emp_mgr"))
        assertEquals("Maya Test, Asha Test, Employee", handlerNames(handlers, null))
    }

    @Test fun customerParsesScopeAndIgnoresUnknownValues() {
        val items = parsePage(
            JSONObject("""{"items":[{"id":"c1","name":"A Test","phone":"+919000000001","scope":"team","employees":[{"id":"emp_asha","name":"Asha Test"}]},
                {"id":"c2","name":"B Test","phone":"+919000000002","scope":"own"},{"id":"c3","name":"C Test","phone":"+919000000003","scope":"galaxy"},
                {"id":"c4","name":"D Test","phone":"+919000000004"}]}"""),
            ::parseCustomer,
        ).items
        assertEquals(listOf("team", "own", null, null), items.map { it.scope })
    }

    @Test fun scopeAfterAHandoverFollowsTheHandlers() {
        val me = EmployeeRef("emp_mgr", "Maya Test")
        val report = EmployeeRef("emp_asha", "Asha Test")
        val outsider = EmployeeRef("emp_out", "Out Test")
        assertEquals("own", scopeAfterHandlersChanged(listOf(me, outsider), manager))
        assertEquals("team", scopeAfterHandlersChanged(listOf(report, outsider), manager))
        assertNull(scopeAfterHandlersChanged(listOf(outsider), manager))
        assertNull(scopeAfterHandlersChanged(listOf(me), plain))
    }

    // ---- Hand over -------------------------------------------------------------------------------------------------

    private val candidates = handoverCandidates(manager)
    private val outsider = EmployeeRef("emp_out", "Out Test")

    @Test fun handoverCandidatesAreTheManagerThenTheTeam() {
        assertEquals(listOf("emp_mgr", "emp_asha", "emp_ravi"), candidates.map { it.id })
        assertTrue(handoverCandidates(plain).isEmpty())
    }

    @Test fun currentInScopeHandlersStartTicked() {
        val current = listOf(EmployeeRef("emp_asha", "Asha Test"), outsider)
        assertEquals(setOf("emp_asha"), initialHandoverSelection(current, candidates))
        assertEquals(listOf(outsider), outsideHandlers(current, candidates))
    }

    @Test fun requestNeverCarriesOutsideHandlersOrUnknownIds() {
        // Outside handlers stay on the customer because the server keeps them; the app must not send their ids.
        val ids = handoverRequestIds(setOf("emp_ravi", "emp_mgr", "emp_out", "emp_stranger"), candidates)
        assertEquals(listOf("emp_mgr", "emp_ravi"), ids)
        assertEquals("""{"employeeIds":["emp_mgr","emp_ravi"]}""", handoverBody(ids).toString())
    }

    @Test fun handingOverPreservesOutsideHandlersAndNeedsAHandlerOverall() {
        val onlyOutsider = listOf(outsider)
        val withReport = listOf(EmployeeRef("emp_asha", "Asha Test"), outsider)
        // Empty selection is fine only while an outside handler remains.
        assertNull(handoverProblem(emptySet(), withReport, candidates))
        assertNull(handoverProblem(emptySet(), onlyOutsider, candidates))
        assertEquals("Choose at least one person.", handoverProblem(emptySet(), listOf(EmployeeRef("emp_asha", "Asha Test")), candidates))
        assertEquals("Choose at least one person.", handoverProblem(setOf("emp_out"), emptyList(), candidates))
        assertNull(handoverProblem(setOf("emp_ravi"), emptyList(), candidates))
    }

    @Test fun handoverIsOnlyEnabledWhenSomethingChanged() {
        val current = listOf(EmployeeRef("emp_asha", "Asha Test"), outsider)
        assertFalse(handoverChanged(setOf("emp_asha"), current, candidates))
        assertTrue(handoverChanged(setOf("emp_ravi"), current, candidates))
        assertTrue(handoverChanged(setOf("emp_asha", "emp_ravi"), current, candidates))
        assertTrue(handoverChanged(emptySet(), current, candidates))
    }

    // ---- Add customer ----------------------------------------------------------------------------------------------

    @Test fun assigneeIsSentOnlyByManagersForTeamMembers() {
        assertEquals("emp_asha", assigneeToSend("emp_asha", manager))
        assertNull(assigneeToSend(null, manager))
        assertNull(assigneeToSend("emp_mgr", manager))
        assertNull(assigneeToSend("emp_stranger", manager))
        assertNull(assigneeToSend("emp_asha", plain))
        assertNull(assigneeToSend("emp_asha", null))
    }

    @Test fun createBodyCarriesEmployeeIdOnlyWhenGiven() {
        val without = createCustomerBody("Asha Test", "9000000001", "")
        assertFalse(without.has("employeeId"))
        val with = createCustomerBody("Asha Test", "9000000001", "", "emp_asha")
        assertEquals("emp_asha", with.getString("employeeId"))
        assertEquals("+919000000001", with.getString("phone"))
        assertFalse(createCustomerBody("Asha Test", "9000000001", "", " ").has("employeeId"))
    }

    @Test fun lookupReturnsHandlersOnlyWhenMine() {
        val mine = parseLookup(JSONObject("""{"phone":"+919000000001","exists":true,"mine":true,"customer":{"id":"c1","name":"A Test"},"handlers":[{"id":"emp_asha","name":"Asha Test"},{"x":1}]}"""))!!
        assertEquals(listOf(EmployeeRef("emp_asha", "Asha Test")), mine.handlers)
        val other = parseLookup(JSONObject("""{"phone":"+919000000001","exists":true,"mine":false,"handlers":[{"id":"emp_asha","name":"Asha Test"}]}"""))!!
        assertTrue(other.handlers.isEmpty())
        val older = parseLookup(JSONObject("""{"phone":"+919000000001","exists":true,"mine":true,"customer":{"id":"c1","name":"A Test"}}"""))!!
        assertTrue(older.handlers.isEmpty())
    }

    @Test fun existingCustomerMessageNamesOtherHandlers() {
        assertEquals("This number is already in your customers.", existingCustomerMessage(emptyList(), "emp_mgr"))
        assertEquals("This number is already in your customers.", existingCustomerMessage(listOf(EmployeeRef("emp_mgr", "Maya Test")), "emp_mgr"))
        assertEquals(
            "This number is already a customer of Asha Test.",
            existingCustomerMessage(listOf(EmployeeRef("emp_asha", "Asha Test")), "emp_mgr"),
        )
    }

    // ---- Placeholders ----------------------------------------------------------------------------------------------

    @Test fun managerUsesTheFirstInScopeHandlerForPlaceholders() {
        val sim = listOf("+919000000099")
        // A report who handles the customer: their name and the number from the team list.
        assertEquals("Asha Test" to "+919000000011", resolveHandlerIdentity(manager, "Enrolled", sim, listOf(outsider, EmployeeRef("emp_asha", "Asha Test"))))
        // A report without a configured number: empty, never the manager's own number.
        assertEquals("Ravi Test" to "", resolveHandlerIdentity(manager, "Enrolled", sim, listOf(EmployeeRef("emp_ravi", "Ravi Test"))))
        // The first in-scope handler wins, in the customer's order.
        assertEquals("Asha Test" to "+919000000011", resolveHandlerIdentity(manager, "Enrolled", sim, listOf(EmployeeRef("emp_asha", "A"), EmployeeRef("emp_mgr", "M"))))
        // The manager themself handles it: today's resolution.
        assertEquals("Maya Test" to "+919000000010", resolveHandlerIdentity(manager, "Enrolled", sim, listOf(EmployeeRef("emp_mgr", "Maya Test"))))
    }

    @Test fun placeholdersFallBackToTheOwnProfile() {
        val sim = listOf("+919000000099")
        assertEquals("Maya Test" to "+919000000010", resolveHandlerIdentity(manager, "Enrolled", sim, emptyList()))
        assertEquals("Maya Test" to "+919000000010", resolveHandlerIdentity(manager, "Enrolled", sim, listOf(outsider)))
        // Non-managers never switch handler, whatever the customer lists.
        assertEquals("Neel Test" to "+919000000099", resolveHandlerIdentity(plain, "Enrolled", sim, listOf(EmployeeRef("emp_asha", "Asha Test"))))
        assertEquals("Enrolled" to "+919000000099", resolveHandlerIdentity(null, "Enrolled", sim, emptyList()))
    }

    // ---- Analytics and call history --------------------------------------------------------------------------------

    private val analyticsBody = """
        {"range":{"from":"2026-11-01","to":"2026-11-07"},"totals":{"total":9,"connected":6,"talkSeconds":600},
         "employees":[{"id":"emp_mgr","name":"Maya Test","total":3},{"id":"emp_asha","name":"Asha Test","total":6},{"name":"no id"}],
         "byEmployee":[{"id":"emp_mgr","name":"Maya Test","total":3,"connected":2,"talkSeconds":120},
                       {"id":"emp_asha","name":"Asha Test","total":6,"connected":4,"talkSeconds":480,"future":true},
                       {"name":"no id","total":99},"junk"]}
    """

    @Test fun analyticsParsesWhoIsIncludedAndTheBreakdownBiggestFirst() {
        val data = parseAnalytics(JSONObject(analyticsBody))!!
        assertEquals(listOf(EmployeeRef("emp_mgr", "Maya Test"), EmployeeRef("emp_asha", "Asha Test")), data.employees)
        assertEquals(listOf("emp_asha", "emp_mgr"), data.byEmployee.map { it.id })
        assertEquals(EmployeeCalls("emp_asha", "Asha Test", 6, 4, 480), data.byEmployee.first())
        assertEquals(DateRange(LocalDate.of(2026, 11, 1), LocalDate.of(2026, 11, 7)), data.range)
    }

    @Test fun analyticsWithoutManagerFieldsStillParses() {
        val data = parseAnalytics(JSONObject("""{"range":{"from":"2026-11-01","to":"2026-11-07"},"totals":{"total":2,"connected":1}}"""))!!
        assertTrue(data.employees.isEmpty())
        assertTrue(data.byEmployee.isEmpty())
        assertNotNull(data.totals)
    }

    @Test fun callLogCarriesTheEmployeeWhenPresent() {
        val page = parsePage(
            JSONObject("""{"items":[{"id":"call_1","kind":"call","startedAt":"2026-11-06T10:00:00.000Z","durationSeconds":42,"callType":"outgoing","employee":{"id":"emp_asha","name":"Asha Test"},"hasRecording":true},
                {"id":"call_2","kind":"call","startedAt":"2026-11-06T11:00:00.000Z","durationSeconds":0,"callType":"missed"},
                {"id":"call_3","kind":"call","startedAt":"2026-11-06T12:00:00.000Z","callType":"incoming","employee":"not-an-object","futureField":[1]}]}"""),
            ::parseCallLog,
        ).items
        assertEquals(EmployeeRef("emp_asha", "Asha Test"), page[0].employee)
        assertNull(page[1].employee)
        assertNull(page[2].employee)
        assertTrue(page[0].hasRecording)
    }
}
