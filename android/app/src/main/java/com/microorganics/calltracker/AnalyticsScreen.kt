package com.microorganics.calltracker

import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

private fun shortDate(): DateTimeFormatter = DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())
private fun longDate(): DateTimeFormatter = DateTimeFormatter.ofPattern("d MMM yyyy", Locale.getDefault())

/** A 48dp icon-only button; [description] is what screen readers announce. */
@Composable
internal fun ShellIconButton(@DrawableRes icon: Int, description: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    IconButton(onClick = onClick, modifier = modifier.size(48.dp), enabled = enabled) {
        Icon(painterResource(icon), contentDescription = description, modifier = Modifier.size(24.dp))
    }
}

@Composable
private fun goodColor() = if (isSystemInDarkTheme()) Color(0xFF9CDEB5) else Color(0xFF20623B)

@Composable
private fun changeColor(change: KpiChange): Color = when (change.good) {
    true -> goodColor()
    false -> MaterialTheme.colorScheme.error
    null -> MaterialTheme.colorScheme.onSurfaceVariant
}

private fun changeSpeech(change: KpiChange): String = when (change.movement) {
    Movement.UP -> if (change.text == "New") "new compared with the previous period" else "up ${change.text} compared with the previous period"
    Movement.DOWN -> "down ${change.text} compared with the previous period"
    Movement.FLAT -> "no change compared with the previous period"
}

private fun changeLabel(change: KpiChange): String = when (change.movement) {
    Movement.UP -> if (change.text == "New") "New" else "▲ ${change.text}"
    Movement.DOWN -> "▼ ${change.text}"
    Movement.FLAT -> "No change"
}

/** The employee's own call analytics: range chips, summary cards and two simple charts. */
@Composable
internal fun AnalyticsTab(repository: AnalyticsRepository, scope: CoroutineScope, profile: EmployeeProfile? = null) {
    val state by repository.analytics.collectAsStateWithLifecycle()
    val selectedEmployees by repository.employees.collectAsStateWithLifecycle()
    val manager = profile.asManager()
    var pickingCustom by remember { mutableStateOf(false) }
    // Runs again when the profile (role, team) arrives or changes: a manager's numbers cover the whole scope.
    LaunchedEffect(scopeSignature(profile)) { scope.launch { repository.openAnalytics() } }
    if (pickingCustom) {
        CustomRangeDialog(
            today = repository.today(),
            initial = state.selection.custom ?: presetRange(RangePreset.LAST_7, repository.today()),
            dismiss = { pickingCustom = false },
            apply = { range ->
                pickingCustom = false
                scope.launch { repository.select(RangeSelection(RangePreset.CUSTOM, range)) }
            },
        )
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(if (manager != null) "Calls" else "Your calls", Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                val range = state.data?.range ?: state.selection.resolve(repository.today())
                SupportingText(rangeText(range) + " · IST")
            }
            ShellIconButton(R.drawable.ic_refresh, "Refresh analytics", { scope.launch { repository.refreshAnalytics() } }, enabled = !state.loading)
        }
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RangePreset.entries.forEach { preset ->
                FilterChip(
                    selected = state.selection.preset == preset,
                    onClick = {
                        if (preset == RangePreset.CUSTOM) pickingCustom = true
                        else scope.launch { repository.select(RangeSelection(preset)) }
                    },
                    label = { Text(if (preset == RangePreset.CUSTOM && state.selection.custom != null && state.selection.preset == preset) rangeText(state.selection.custom!!) else preset.label) },
                    modifier = Modifier.heightIn(min = 48.dp),
                )
            }
        }
        AnalyticsScopeBar(manager, selectedEmployees) { ids -> scope.launch { repository.selectEmployees(ids) } }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = 16.dp))
        state.error?.let { message ->
            Surface(Modifier.padding(horizontal = 16.dp).fillMaxWidth(), shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.errorContainer) {
                Row(Modifier.padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(message, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onErrorContainer)
                    TextButton(onClick = { scope.launch { repository.refreshAnalytics() } }, enabled = !state.loading) { Text("Try again") }
                }
            }
        }
        val data = state.data
        when {
            data == null -> Unit
            data.totals.total == 0 -> Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 40.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("No calls in this range", style = MaterialTheme.typography.titleMedium)
                SupportingText("Calls synced from this phone appear here. Pick another range or sync from Settings.")
            }
            else -> AnalyticsContent(data, manager?.id)
        }
    }
}

private fun rangeText(range: DateRange): String =
    if (range.from == range.to) longDate().format(range.from) else "${shortDate().format(range.from)} – ${longDate().format(range.to)}"

@Composable
private fun AnalyticsContent(data: CallAnalytics, viewerId: String?) {
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        kpis(data.totals, data.previous).chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                pair.forEach { KpiCard(it, Modifier.weight(1f)) }
                if (pair.size == 1) Box(Modifier.weight(1f))
            }
        }
        if (data.previous != null) SupportingText("Changes compare with the previous ${data.range.days} day${if (data.range.days == 1L) "" else "s"}.")
        if (viewerId != null && data.byEmployee.isNotEmpty()) ChartCard("By employee") { EmployeeRows(data.byEmployee, viewerId) }
        val breakdown = typeBreakdown(data.byType)
        if (breakdown.isNotEmpty()) ChartCard("Calls by type") { TypeBars(breakdown) }
        if (data.range.days > 1 && data.byDay.isNotEmpty()) {
            val bars = bucketDays(data.byDay)
            val grouped = bars.size < data.byDay.size
            ChartCard(if (grouped) "Calls per period" else "Calls per day") {
                val peak = bars.maxBy { it.total }
                BarChart(
                    totals = bars.map { it.total }, highlights = bars.map { it.connected },
                    description = "${if (grouped) "Calls per period" else "Calls per day"}. Busiest ${if (grouped) "period from" else "day"} ${shortDate().format(peak.start)} with ${peak.total} calls.",
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    SupportingText(shortDate().format(bars.first().start))
                    SupportingText(shortDate().format(bars.last().start))
                }
                SupportingText("Darker part: connected calls.")
            }
        }
        if (data.byHour.any { it > 0 }) {
            ChartCard("Calls by hour of day") {
                val peakHour = data.byHour.indices.maxBy { data.byHour[it] }
                BarChart(
                    totals = data.byHour, highlights = null,
                    description = "Calls by hour of day. Busiest hour starts at ${hourLabel(peakHour)} with ${data.byHour[peakHour]} calls.",
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    listOf(0, 6, 12, 18, 23).forEach { SupportingText(hourLabel(it)) }
                }
            }
        }
    }
}

internal fun hourLabel(hour: Int): String = when {
    hour == 0 -> "12 am"
    hour < 12 -> "$hour am"
    hour == 12 -> "12 pm"
    else -> "${hour - 12} pm"
}

@Composable
private fun KpiCard(kpi: Kpi, modifier: Modifier) {
    val speech = buildString {
        append(kpi.label).append(' ').append(kpi.value)
        kpi.change?.let { append(", ").append(changeSpeech(it)) }
    }
    Surface(
        modifier = modifier.clearAndSetSemantics { contentDescription = speech },
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.fillMaxWidth().heightIn(min = 88.dp).padding(14.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(kpi.label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(kpi.value, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            kpi.change?.let { Text(changeLabel(it), style = MaterialTheme.typography.labelMedium, color = changeColor(it)) }
        }
    }
}

@Composable
private fun ChartCard(title: String, content: @Composable () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            content()
        }
    }
}

/** Compact manager list: who made how many calls, how many connected, and the talk time. */
@Composable
private fun EmployeeRows(rows: List<EmployeeCalls>, viewerId: String) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        rows.forEach { row ->
            val name = if (row.id == viewerId) "You" else row.name.ifEmpty { "Employee" }
            val summary = "${row.total} calls · ${row.connected} connected · ${formatDuration(row.talkSeconds)}"
            Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
                Text(name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1)
                Text(summary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun TypeBars(rows: List<TypeCount>) {
    val most = rows.maxOf { it.count }.coerceAtLeast(1)
    val bar = MaterialTheme.colorScheme.primary
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        rows.forEach { row ->
            Row(
                Modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(callTypeLabel(row.type), Modifier.width(104.dp), style = MaterialTheme.typography.bodySmall, maxLines = 1)
                Box(Modifier.weight(1f).height(10.dp)) {
                    Box(Modifier.fillMaxWidth(row.count.toFloat() / most).height(10.dp).background(bar, RoundedCornerShape(5.dp)))
                }
                Text(row.count.toString(), Modifier.width(40.dp), style = MaterialTheme.typography.labelLarge, maxLines = 1)
            }
        }
    }
}

/** Plain Compose Canvas bars. [highlights] (if any) are drawn in the darker colour from the bottom of each bar. */
@Composable
private fun BarChart(totals: List<Int>, highlights: List<Int>?, description: String) {
    val light = MaterialTheme.colorScheme.primary.copy(alpha = if (highlights != null) 0.3f else 0.85f)
    val dark = MaterialTheme.colorScheme.primary
    val baseline = MaterialTheme.colorScheme.outlineVariant
    val most = totals.max().coerceAtLeast(1)
    Canvas(Modifier.fillMaxWidth().height(120.dp).semantics { contentDescription = description }) {
        val slot = size.width / totals.size
        val gap = if (slot > 6f) slot * 0.25f else slot * 0.1f
        val barWidth = (slot - gap).coerceAtLeast(1f)
        val usable = size.height - 2f
        totals.forEachIndexed { index, total ->
            val left = index * slot + gap / 2
            val height = if (total > 0) (total.toFloat() / most * usable).coerceAtLeast(2f) else 0f
            if (height > 0f) {
                drawRoundRect(light, Offset(left, usable - height + 2f), Size(barWidth, height), CornerRadius(minOf(3f, barWidth / 2)))
                val connected = highlights?.getOrNull(index) ?: 0
                if (connected > 0) {
                    val inner = (connected.toFloat() / most * usable).coerceIn(2f, height)
                    drawRoundRect(dark, Offset(left, usable - inner + 2f), Size(barWidth, inner), CornerRadius(minOf(3f, barWidth / 2)))
                }
            }
        }
        drawLine(baseline, Offset(0f, size.height - 1f), Offset(size.width, size.height - 1f), strokeWidth = 2f)
    }
}

private fun LocalDate.toPickerMillis(): Long = atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
private fun Long.toPickerDate(): LocalDate = Instant.ofEpochMilli(this).atZone(ZoneOffset.UTC).toLocalDate()

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CustomRangeDialog(today: LocalDate, initial: DateRange, dismiss: () -> Unit, apply: (DateRange) -> Unit) {
    var from by remember { mutableStateOf(initial.from) }
    var to by remember { mutableStateOf(initial.to) }
    var editing by remember { mutableStateOf<String?>(null) }
    val problem = customRangeProblem(from, to, today)
    editing?.let { which ->
        val picker = rememberDatePickerState(
            initialSelectedDateMillis = (if (which == "from") from else to).toPickerMillis(),
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long) = !utcTimeMillis.toPickerDate().isAfter(today)
            },
        )
        DatePickerDialog(
            onDismissRequest = { editing = null },
            confirmButton = {
                TextButton(onClick = {
                    picker.selectedDateMillis?.toPickerDate()?.let { if (which == "from") from = it else to = it }
                    editing = null
                }) { Text("OK") }
            },
            dismissButton = { TextButton(onClick = { editing = null }) { Text("Cancel") } },
        ) { DatePicker(state = picker) }
    }
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text("Custom range") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = { editing = "from" }, Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("From · ${longDate().format(from)}") }
                OutlinedButton(onClick = { editing = "to" }, Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("To · ${longDate().format(to)}") }
                if (problem != null) Text(problem, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                else SupportingText("Days are counted in IST, up to $MAX_RANGE_DAYS days.")
            }
        },
        confirmButton = { TextButton(onClick = { apply(DateRange(from, to)) }, enabled = problem == null) { Text("Show") } },
        dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } },
    )
}
