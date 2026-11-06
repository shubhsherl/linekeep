package com.microorganics.calltracker

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import kotlin.math.abs
import kotlin.math.roundToInt

/** The server buckets analytics by Asia/Kolkata calendar days, so every range the app builds is an IST date. */
internal val ANALYTICS_ZONE: ZoneId = ZoneId.of("Asia/Kolkata")
internal const val MAX_RANGE_DAYS = 366L

internal fun istToday(now: Instant): LocalDate = now.atZone(ANALYTICS_ZONE).toLocalDate()

internal enum class RangePreset(val label: String) {
    TODAY("Today"),
    YESTERDAY("Yesterday"),
    LAST_7("Last 7 days"),
    LAST_30("Last 30 days"),
    THIS_MONTH("This month"),
    CUSTOM("Custom"),
}

/** Inclusive IST dates. */
internal data class DateRange(val from: LocalDate, val to: LocalDate) {
    val days: Long get() = ChronoUnit.DAYS.between(from, to) + 1
}

/** The preset's range as of [today]. [RangePreset.CUSTOM] has no fixed range and must be resolved by [RangeSelection]. */
internal fun presetRange(preset: RangePreset, today: LocalDate): DateRange = when (preset) {
    RangePreset.TODAY -> DateRange(today, today)
    RangePreset.YESTERDAY -> today.minusDays(1).let { DateRange(it, it) }
    RangePreset.LAST_7 -> DateRange(today.minusDays(6), today)
    RangePreset.LAST_30 -> DateRange(today.minusDays(29), today)
    RangePreset.THIS_MONTH -> DateRange(today.withDayOfMonth(1), today)
    RangePreset.CUSTOM -> throw IllegalArgumentException("A custom range carries its own dates")
}

/** Null when the custom range is usable, otherwise a short explanation for the person picking it. */
internal fun customRangeProblem(from: LocalDate, to: LocalDate, today: LocalDate): String? = when {
    from.isAfter(to) -> "The start date must not be after the end date."
    to.isAfter(today) -> "The end date cannot be in the future."
    ChronoUnit.DAYS.between(from, to) + 1 > MAX_RANGE_DAYS -> "Pick a range of at most $MAX_RANGE_DAYS days."
    else -> null
}

internal data class RangeSelection(val preset: RangePreset = RangePreset.LAST_7, val custom: DateRange? = null) {
    fun resolve(today: LocalDate): DateRange =
        if (preset == RangePreset.CUSTOM) custom ?: presetRange(RangePreset.LAST_7, today) else presetRange(preset, today)
}

internal data class CallMetrics(
    val total: Int = 0,
    val connected: Int = 0,
    val notConnected: Int = 0,
    val uniqueContacts: Int = 0,
    val talkSeconds: Long = 0,
    val avgConnectedSeconds: Long = 0,
    val incoming: Int = 0,
    val outgoing: Int = 0,
    val missed: Int = 0,
    val rejected: Int = 0,
) {
    /** Connected share of all calls in 0..1; 0 when there were no calls. */
    val connectRate: Double get() = if (total > 0) connected.toDouble() / total else 0.0
}

internal data class DayBucket(val date: LocalDate, val total: Int, val connected: Int)
internal data class TypeCount(val type: String, val count: Int)

internal data class CallAnalytics(
    val range: DateRange,
    val totals: CallMetrics,
    /** Null when the server did not send the comparison period. */
    val previous: CallMetrics?,
    val byType: List<TypeCount>,
    val byDay: List<DayBucket>,
    /** Calls per hour of the day (index 0..23), all days of the range together. */
    val byHour: List<Int>,
)

private fun JSONObject.count(name: String): Int = (opt(name) as? Number)?.toInt()?.coerceAtLeast(0) ?: 0
private fun JSONObject.seconds(name: String): Long = (opt(name) as? Number)?.toLong()?.coerceAtLeast(0) ?: 0

private fun parseMetrics(json: JSONObject?): CallMetrics? {
    json ?: return null
    val total = json.count("total")
    val connected = json.count("connected")
    return CallMetrics(
        total = total, connected = connected,
        notConnected = if (json.has("notConnected")) json.count("notConnected") else (total - connected).coerceAtLeast(0),
        uniqueContacts = json.count("uniqueContacts"), talkSeconds = json.seconds("talkSeconds"),
        avgConnectedSeconds = json.seconds("avgConnectedSeconds"),
        incoming = json.count("incoming"), outgoing = json.count("outgoing"),
        missed = json.count("missed"), rejected = json.count("rejected"),
    )
}

private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

private fun parseDate(value: String?): LocalDate? = try { value?.let(LocalDate::parse) } catch (_: Exception) { null }

/** The `GET /v1/device/analytics` body; null when it lacks the totals or the range. Malformed chart rows are skipped. */
internal fun parseAnalytics(json: JSONObject): CallAnalytics? {
    val range = json.optJSONObject("range") ?: return null
    val from = parseDate(range.optString("from")) ?: return null
    val to = parseDate(range.optString("to")) ?: return null
    val totals = parseMetrics(json.optJSONObject("totals")) ?: return null
    val byDay = json.optJSONArray("byDay").objects().mapNotNull { row ->
        parseDate(row.optString("date"))?.let { DayBucket(it, row.count("total"), row.count("connected")) }
    }.sortedBy { it.date }
    val byType = json.optJSONArray("byType").objects().mapNotNull { row ->
        row.optString("type").takeIf { it.isNotBlank() }?.let { TypeCount(it, row.count("count")) }
    }
    val hours = IntArray(24)
    json.optJSONArray("byHourWeekday").objects().forEach { row ->
        val hour = row.optInt("hour", -1)
        if (hour in 0..23) hours[hour] += row.count("count")
    }
    return CallAnalytics(DateRange(from, to), totals, parseMetrics(json.optJSONObject("previous")), byType, byDay, hours.toList())
}

internal enum class Movement { UP, DOWN, FLAT }

/** [good] is null when the direction carries no judgement (for example more incoming calls). */
internal data class KpiChange(val movement: Movement, val text: String, val good: Boolean?)

internal data class Kpi(val key: String, val label: String, val value: String, val change: KpiChange?)

internal fun formatDuration(seconds: Long): String {
    val total = seconds.coerceAtLeast(0)
    val hours = total / 3600
    val minutes = total % 3600 / 60
    val rest = total % 60
    return when {
        hours > 0 -> "${hours}h ${minutes}m"
        minutes > 0 -> "${minutes}m ${rest}s"
        else -> "${rest}s"
    }
}

internal fun formatRate(rate: Double): String = "${(rate * 100).roundToInt()}%"

private fun movement(delta: Double) = when {
    delta > 0 -> Movement.UP
    delta < 0 -> Movement.DOWN
    else -> Movement.FLAT
}

/** Change of a count or duration against the previous period; null when neither period had anything to compare. */
internal fun relativeChange(current: Long, previous: Long?, lowerIsBetter: Boolean? = false): KpiChange? {
    previous ?: return null
    if (current == 0L && previous == 0L) return null
    if (previous == 0L) return KpiChange(Movement.UP, "New", lowerIsBetter?.not())
    val percent = ((current - previous) * 100.0 / previous).roundToInt()
    if (percent == 0) return KpiChange(Movement.FLAT, "No change", null)
    val move = movement((current - previous).toDouble())
    return KpiChange(move, "${abs(percent)}%", lowerIsBetter?.let { lower -> (move == Movement.DOWN) == lower })
}

/** Change of the connect rate in percentage points. */
internal fun rateChange(current: Double, previous: Double?, previousTotal: Int): KpiChange? {
    previous ?: return null
    if (previousTotal == 0) return null
    val points = ((current - previous) * 100).roundToInt()
    if (points == 0) return KpiChange(Movement.FLAT, "No change", null)
    return KpiChange(movement(points.toDouble()), "${abs(points)} pts", points > 0)
}

/** The summary cards, in display order, with the change against [CallAnalytics.previous] when there is one. */
internal fun kpis(totals: CallMetrics, previous: CallMetrics?): List<Kpi> {
    fun count(key: String, label: String, current: Int, before: Int?, lowerIsBetter: Boolean? = false) =
        Kpi(key, label, current.toString(), relativeChange(current.toLong(), before?.toLong(), lowerIsBetter))
    return listOf(
        count("total", "Total calls", totals.total, previous?.total, null),
        count("connected", "Connected", totals.connected, previous?.connected),
        count("notConnected", "Not connected", totals.notConnected, previous?.notConnected, true),
        count("uniqueContacts", "Unique contacts", totals.uniqueContacts, previous?.uniqueContacts),
        count("incoming", "Incoming", totals.incoming, previous?.incoming, null),
        count("outgoing", "Outgoing", totals.outgoing, previous?.outgoing, null),
        count("missed", "Missed", totals.missed, previous?.missed, true),
        count("rejected", "Rejected", totals.rejected, previous?.rejected, true),
        Kpi("connectRate", "Connect rate", formatRate(totals.connectRate), rateChange(totals.connectRate, previous?.connectRate, previous?.total ?: 0)),
        Kpi("avgLength", "Avg call length", formatDuration(totals.avgConnectedSeconds),
            relativeChange(totals.avgConnectedSeconds, previous?.avgConnectedSeconds, null)),
        Kpi("talkTime", "Talk time", formatDuration(totals.talkSeconds), relativeChange(totals.talkSeconds, previous?.talkSeconds, null)),
    )
}

internal data class ChartBar(val start: LocalDate, val total: Int, val connected: Int)

/** Merges consecutive days so a long range still fits [maxBars] bars; a short range keeps one bar per day. */
internal fun bucketDays(days: List<DayBucket>, maxBars: Int = 31): List<ChartBar> {
    require(maxBars > 0)
    val size = (days.size + maxBars - 1) / maxBars
    if (size <= 1) return days.map { ChartBar(it.date, it.total, it.connected) }
    return days.chunked(size).map { group -> ChartBar(group.first().date, group.sumOf { it.total }, group.sumOf { it.connected }) }
}

/** Types with calls, most frequent first; ties keep the server order. */
internal fun typeBreakdown(byType: List<TypeCount>): List<TypeCount> = byType.filter { it.count > 0 }.sortedByDescending { it.count }

internal fun callTypeLabel(type: String): String = when (type) {
    "incoming" -> "Incoming"
    "outgoing" -> "Outgoing"
    "missed" -> "Missed"
    "rejected" -> "Rejected"
    "blocked" -> "Blocked"
    "voicemail" -> "Voicemail"
    "answered_externally" -> "Answered elsewhere"
    else -> "Other"
}

internal data class CallLogItem(
    val id: String,
    val startedAt: Long,
    val durationSeconds: Long,
    val callType: String,
    val remoteNumber: String?,
    val callerName: String?,
    val customerId: String?,
    val customerName: String?,
    val hasRecording: Boolean,
)

/** Recordings that no call claims have no call type or number, so they are not call-log rows. */
internal fun parseCallLog(json: JSONObject): CallLogItem? {
    if (json.optString("kind", "call") != "call") return null
    val id = json.optionalString("id") ?: return null
    val startedAt = json.optionalTime("startedAt") ?: return null
    val customer = json.optJSONObject("customer")
    val recordings = json.optJSONArray("recordings")
    return CallLogItem(
        id = id, startedAt = startedAt, durationSeconds = json.seconds("durationSeconds"),
        callType = json.optionalString("callType") ?: "unknown",
        remoteNumber = json.optionalString("remoteNumber"), callerName = json.optionalString("callerName"),
        customerId = customer?.optionalString("id"), customerName = customer?.optionalString("name"),
        hasRecording = json.optBoolean("hasRecording", false) || (recordings != null && recordings.length() > 0),
    )
}

internal fun CallLogItem.title(): String = customerName ?: callerName ?: remoteNumber ?: "Unknown number"

internal enum class CallTypeFilter(val label: String, val apiValue: String?) {
    ALL("All", null),
    INCOMING("Incoming", "incoming"),
    OUTGOING("Outgoing", "outgoing"),
    MISSED("Missed", "missed"),
    REJECTED("Rejected", "rejected"),
}

/** The number search sent to the server: digits and a leading plus only; null when nothing searchable remains. */
internal fun phoneSearchTerm(raw: String): String? {
    val digits = raw.filter { it.isDigit() }
    val term = if (raw.trim().startsWith("+")) "+$digits" else digits
    return term.takeIf { digits.isNotEmpty() }
}

internal data class AnalyticsState(
    val selection: RangeSelection = RangeSelection(),
    val loading: Boolean = false,
    val data: CallAnalytics? = null,
    val error: String? = null,
)
