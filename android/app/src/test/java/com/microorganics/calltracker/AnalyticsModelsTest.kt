package com.microorganics.calltracker

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

class AnalyticsModelsTest {
    private val today = LocalDate.of(2026, 11, 6)

    @Test fun presetsResolveAgainstTheIstDay() {
        assertEquals(DateRange(today, today), presetRange(RangePreset.TODAY, today))
        assertEquals(DateRange(LocalDate.of(2026, 11, 5), LocalDate.of(2026, 11, 5)), presetRange(RangePreset.YESTERDAY, today))
        assertEquals(DateRange(LocalDate.of(2026, 10, 31), today), presetRange(RangePreset.LAST_7, today))
        assertEquals(7, presetRange(RangePreset.LAST_7, today).days)
        assertEquals(DateRange(LocalDate.of(2026, 10, 8), today), presetRange(RangePreset.LAST_30, today))
        assertEquals(30, presetRange(RangePreset.LAST_30, today).days)
        assertEquals(DateRange(LocalDate.of(2026, 11, 1), today), presetRange(RangePreset.THIS_MONTH, today))
    }

    @Test fun presetsHandleMonthAndYearBoundaries() {
        val first = LocalDate.of(2027, 1, 1)
        assertEquals(DateRange(LocalDate.of(2026, 12, 31), LocalDate.of(2026, 12, 31)), presetRange(RangePreset.YESTERDAY, first))
        assertEquals(DateRange(first, first), presetRange(RangePreset.THIS_MONTH, first))
        assertEquals(LocalDate.of(2026, 12, 26), presetRange(RangePreset.LAST_7, first).from)
    }

    @Test fun istTodayCrossesMidnightBeforeUtcDoes() {
        // 20:00 UTC on 5 Nov is 01:30 IST on 6 Nov.
        assertEquals(LocalDate.of(2026, 11, 6), istToday(Instant.parse("2026-11-05T20:00:00Z")))
        assertEquals(LocalDate.of(2026, 11, 5), istToday(Instant.parse("2026-11-05T18:29:59Z")))
    }

    @Test fun customRangesAreValidated() {
        assertNull(customRangeProblem(LocalDate.of(2026, 11, 1), today, today))
        assertNotNull(customRangeProblem(today, LocalDate.of(2026, 11, 1), today))
        assertNotNull(customRangeProblem(today, today.plusDays(1), today))
        assertNotNull(customRangeProblem(today.minusDays(366), today, today))
        assertNull(customRangeProblem(today.minusDays(365), today, today))
    }

    @Test fun selectionResolvesPresetsAndCustomRanges() {
        assertEquals(presetRange(RangePreset.LAST_7, today), RangeSelection().resolve(today))
        val custom = DateRange(LocalDate.of(2026, 9, 1), LocalDate.of(2026, 9, 9))
        assertEquals(custom, RangeSelection(RangePreset.CUSTOM, custom).resolve(today))
        assertEquals(presetRange(RangePreset.TODAY, today), RangeSelection(RangePreset.TODAY, custom).resolve(today))
    }

    private val body = JSONObject("""{
        "requestId":"r",
        "range":{"from":"2026-11-01","to":"2026-11-03","days":3,"timezone":"Asia/Kolkata"},
        "totals":{"total":10,"connected":6,"notConnected":4,"uniqueContacts":7,"talkSeconds":600,"avgConnectedSeconds":100,"incoming":3,"outgoing":5,"missed":1,"rejected":1,"other":0,"withRecording":2},
        "previous":{"total":5,"connected":5,"notConnected":0,"uniqueContacts":7,"talkSeconds":300,"avgConnectedSeconds":60,"incoming":1,"outgoing":4,"missed":0,"rejected":0,"other":0,"withRecording":0},
        "employees":[{"id":"emp_1","name":"Maya Test","total":10}],
        "byType":[{"type":"incoming","count":3,"seconds":10},{"type":"outgoing","count":5,"seconds":20},{"type":"missed","count":1,"seconds":0},{"type":"rejected","count":1,"seconds":0},{"type":"blocked","count":0,"seconds":0}],
        "byDay":[{"date":"2026-11-02","total":4,"connected":3},{"date":"2026-11-01","total":6,"connected":3},{"date":"2026-11-03","total":0,"connected":0},{"date":"bad","total":1,"connected":1}],
        "byHourWeekday":[{"weekday":1,"hour":10,"count":4},{"weekday":2,"hour":10,"count":2},{"weekday":2,"hour":15,"count":1},{"weekday":2,"hour":99,"count":9}],
        "durationBuckets":[]
    }""")

    @Test fun analyticsResponseIsMapped() {
        val analytics = parseAnalytics(body)!!
        assertEquals(DateRange(LocalDate.of(2026, 11, 1), LocalDate.of(2026, 11, 3)), analytics.range)
        assertEquals(10, analytics.totals.total)
        assertEquals(6, analytics.totals.connected)
        assertEquals(4, analytics.totals.notConnected)
        assertEquals(600L, analytics.totals.talkSeconds)
        assertEquals(5, analytics.previous!!.total)
        assertEquals(listOf(LocalDate.of(2026, 11, 1), LocalDate.of(2026, 11, 2), LocalDate.of(2026, 11, 3)), analytics.byDay.map { it.date })
        assertEquals(24, analytics.byHour.size)
        assertEquals(6, analytics.byHour[10])
        assertEquals(1, analytics.byHour[15])
        assertEquals(7, analytics.byHour.sum())
        assertEquals(listOf("incoming", "outgoing", "missed", "rejected", "blocked"), analytics.byType.map { it.type })
    }

    @Test fun analyticsWithoutTotalsOrRangeIsRejected() {
        assertNull(parseAnalytics(JSONObject("""{"range":{"from":"2026-11-01","to":"2026-11-01"}}""")))
        assertNull(parseAnalytics(JSONObject("""{"totals":{"total":1}}""")))
        assertNull(parseAnalytics(JSONObject("""{"range":{"from":"x","to":"y"},"totals":{"total":1}}""")))
    }

    @Test fun missingPreviousPeriodHasNoChanges() {
        val analytics = parseAnalytics(JSONObject("""{"range":{"from":"2026-11-01","to":"2026-11-01"},"totals":{"total":2,"connected":1}}"""))!!
        assertNull(analytics.previous)
        assertEquals(1, analytics.totals.notConnected)
        assertTrue(kpis(analytics.totals, analytics.previous).all { it.change == null })
    }

    @Test fun kpisCoverEveryRequestedMetricInOrder() {
        val analytics = parseAnalytics(body)!!
        val cards = kpis(analytics.totals, analytics.previous)
        assertEquals(
            listOf("Total calls", "Connected", "Not connected", "Unique contacts", "Incoming", "Outgoing", "Missed", "Rejected", "Connect rate", "Avg call length", "Talk time"),
            cards.map { it.label },
        )
        val byKey = cards.associateBy { it.key }
        assertEquals("10", byKey.getValue("total").value)
        assertEquals("60%", byKey.getValue("connectRate").value)
        assertEquals("1m 40s", byKey.getValue("avgLength").value)
        assertEquals("10m 0s", byKey.getValue("talkTime").value)
    }

    @Test fun changesAreRelativeAndJudgedByDirection() {
        val cards = kpis(parseAnalytics(body)!!.totals, parseAnalytics(body)!!.previous).associateBy { it.key }
        // total 5 -> 10: +100%, no judgement; connected 5 -> 6: +20% good.
        assertEquals(KpiChange(Movement.UP, "100%", null), cards.getValue("total").change)
        assertEquals(KpiChange(Movement.UP, "20%", true), cards.getValue("connected").change)
        // not connected 0 -> 4 is new and bad; missed 0 -> 1 is new and bad.
        assertEquals(KpiChange(Movement.UP, "New", false), cards.getValue("notConnected").change)
        assertEquals(KpiChange(Movement.UP, "New", false), cards.getValue("missed").change)
        // unique contacts 7 -> 7.
        assertEquals(KpiChange(Movement.FLAT, "No change", null), cards.getValue("uniqueContacts").change)
        // rate 100% -> 60%: down 40 points, bad.
        assertEquals(KpiChange(Movement.DOWN, "40 pts", false), cards.getValue("connectRate").change)
    }

    @Test fun nothingToCompareGivesNoChange() {
        assertNull(relativeChange(0, 0))
        assertNull(relativeChange(3, null))
        assertNull(rateChange(0.5, 0.0, previousTotal = 0))
        assertEquals(KpiChange(Movement.DOWN, "50%", true), relativeChange(2, 4, lowerIsBetter = true))
    }

    @Test fun durationsAreReadable() {
        assertEquals("0s", formatDuration(0))
        assertEquals("45s", formatDuration(45))
        assertEquals("3m 20s", formatDuration(200))
        assertEquals("1h 5m", formatDuration(3900))
        assertEquals("0s", formatDuration(-5))
        assertEquals("0%", formatRate(0.0))
        assertEquals("67%", formatRate(2.0 / 3))
    }

    @Test fun shortRangesKeepOneBarPerDayAndLongOnesAreGrouped() {
        val start = LocalDate.of(2026, 1, 1)
        val week = (0 until 7).map { DayBucket(start.plusDays(it.toLong()), it + 1, 1) }
        assertEquals(7, bucketDays(week).size)
        val year = (0 until 90).map { DayBucket(start.plusDays(it.toLong()), 2, 1) }
        val grouped = bucketDays(year, maxBars = 31)
        assertTrue(grouped.size <= 31)
        assertEquals(year.sumOf { it.total }, grouped.sumOf { it.total })
        assertEquals(year.sumOf { it.connected }, grouped.sumOf { it.connected })
        assertEquals(start, grouped.first().start)
        assertTrue(bucketDays(emptyList()).isEmpty())
    }

    @Test fun typeBreakdownDropsEmptyTypesAndSortsDescending() {
        val rows = typeBreakdown(listOf(TypeCount("missed", 1), TypeCount("blocked", 0), TypeCount("outgoing", 5), TypeCount("incoming", 3)))
        assertEquals(listOf("outgoing", "incoming", "missed"), rows.map { it.type })
        assertEquals("Answered elsewhere", callTypeLabel("answered_externally"))
        assertEquals("Other", callTypeLabel("something_new"))
    }

    @Test fun callLogRowsMapAndRecordingsAreSkipped() {
        val page = parsePage(JSONObject("""{"items":[
            {"kind":"call","id":"cl_1","startedAt":"2026-11-05T10:00:00.000Z","durationSeconds":75,"callType":"incoming","remoteNumber":"+919000000001","callerName":"Cached","hasRecording":true,"customer":{"id":"cus_1","name":"Asha Test"}},
            {"kind":"call","id":"cl_2","startedAt":"2026-11-05T09:00:00.000Z","durationSeconds":0,"callType":"missed","remoteNumber":"+919000000002"},
            {"kind":"recording","id":"rec_1","createdAt":"2026-11-05T08:00:00.000Z"},
            {"id":"cl_3","durationSeconds":1},
            {"id":"cl_4","startedAt":"2026-11-05T07:00:00.000Z","callType":"voicemail","recordings":[{"id":"r"}]}
        ],"nextCursor":"next"}"""), ::parseCallLog)
        assertEquals(listOf("cl_1", "cl_2", "cl_4"), page.items.map { it.id })
        assertEquals("next", page.nextCursor)
        val first = page.items[0]
        assertEquals("Asha Test", first.title())
        assertEquals("cus_1", first.customerId)
        assertTrue(first.hasRecording)
        assertEquals(75L, first.durationSeconds)
        val second = page.items[1]
        assertEquals("+919000000002", second.title())
        assertFalse(second.hasRecording)
        assertTrue(page.items[2].hasRecording)
        assertEquals("Unknown number", CallLogItem("x", 0, 0, "unknown", null, null, null, null, false).title())
    }

    @Test fun phoneSearchKeepsDigitsAndLeadingPlus() {
        assertEquals("919000000001", phoneSearchTerm("91 9000-000001"))
        assertEquals("+919000", phoneSearchTerm(" +91 9000"))
        assertNull(phoneSearchTerm("abc"))
        assertNull(phoneSearchTerm("  "))
        assertEquals(null, CallTypeFilter.ALL.apiValue)
        assertEquals("missed", CallTypeFilter.MISSED.apiValue)
    }
}
