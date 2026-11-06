package com.microorganics.calltracker

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.Locale

private const val CALL_SEARCH_DELAY_MS = 400L
private const val MAX_SEARCH_CHARS = 32

private fun callTimeFormat(): DateTimeFormatter = DateTimeFormatter.ofPattern("d MMM, h:mm a", Locale.getDefault()).withZone(ANALYTICS_ZONE)

private fun iconFor(type: String): Int = when (type) {
    "incoming" -> R.drawable.ic_call_in
    "outgoing" -> R.drawable.ic_call_out
    "missed", "rejected", "blocked" -> R.drawable.ic_call_missed
    else -> R.drawable.ic_call_other
}

/** The signed-in employee's own call history: filter by type, search by number, newest first, loaded page by page. */
@Composable
internal fun CallLogsTab(repository: AnalyticsRepository, scope: CoroutineScope) {
    var query by rememberSaveable { mutableStateOf("") }
    val state by repository.callLogs.state.collectAsStateWithLifecycle()
    val filter by repository.filter.collectAsStateWithLifecycle()
    LaunchedEffect(query) {
        if (query.isNotEmpty()) delay(CALL_SEARCH_DELAY_MS)
        scope.launch { repository.openCallLogs(query) }
    }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.padding(start = 16.dp, end = 4.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it.take(MAX_SEARCH_CHARS) },
                modifier = Modifier.weight(1f),
                label = { Text("Search by phone number") },
                singleLine = true,
                leadingIcon = { Icon(painterResource(R.drawable.ic_search), contentDescription = null, modifier = Modifier.size(20.dp)) },
                trailingIcon = if (query.isNotEmpty()) ({
                    ShellIconButton(R.drawable.ic_close, "Clear search", { query = "" })
                }) else null,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
            )
            ShellIconButton(R.drawable.ic_refresh, "Refresh call logs", { scope.launch { repository.callLogs.refresh() } }, enabled = !state.refreshing)
        }
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CallTypeFilter.entries.forEach { option ->
                FilterChip(
                    selected = filter == option,
                    onClick = { scope.launch { repository.setFilter(option) } },
                    label = { Text(option.label) },
                    modifier = Modifier.heightIn(min = 48.dp),
                )
            }
        }
        when {
            state.items.isEmpty() && state.error != null -> CallLogsMessage {
                Text(state.error.orEmpty(), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                OutlinedButton(onClick = { scope.launch { repository.callLogs.refresh() } }, Modifier.heightIn(min = 48.dp)) { Text("Try again") }
            }
            state.items.isEmpty() && !state.loaded -> CallLogsMessage { CircularProgressIndicator() }
            state.items.isEmpty() -> CallLogsMessage {
                Text(
                    if (query.isNotBlank() || filter != CallTypeFilter.ALL) "No calls match." else "No calls yet.",
                    style = MaterialTheme.typography.titleMedium,
                )
                SupportingText("Calls synced from this phone appear here.")
            }
            else -> LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (state.refreshing) item("progress") { LinearProgress() }
                items(state.items, key = { it.id }) { CallLogRow(it) }
                state.error?.let { message ->
                    item("error") {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(message, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                            TextButton(onClick = { scope.launch { repository.callLogs.loadMore() } }) { Text("Try again") }
                        }
                    }
                }
                if (state.nextCursor != null && state.error == null) {
                    item("more") {
                        // Composed only when the list is scrolled to its end, which is what asks for the next page.
                        LaunchedEffect(state.nextCursor) { scope.launch { repository.callLogs.loadMore() } }
                        Row(Modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.Center) {
                            CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun LinearProgress() {
    LinearProgressIndicator(Modifier.fillMaxWidth())
}

@Composable
private fun CallLogsMessage(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 40.dp, horizontal = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) { content() }
}

@Composable
private fun CallLogRow(item: CallLogItem) {
    val problem = item.callType == "missed" || item.callType == "rejected" || item.callType == "blocked"
    val tint = if (problem) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    val title = item.title()
    val time = callTimeFormat().format(Instant.ofEpochMilli(item.startedAt))
    val duration = if (item.durationSeconds > 0) formatDuration(item.durationSeconds) else "Not connected"
    val detail = buildList {
        item.remoteNumber?.takeIf { it != title }?.let { add(it) }
        add(callTypeLabel(item.callType))
        if (item.hasRecording) add("Recording")
    }.joinToString(" · ")
    Surface(
        modifier = Modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Surface(shape = CircleShape, color = tint.copy(alpha = 0.12f), modifier = Modifier.size(36.dp)) {
                Icon(painterResource(iconFor(item.callType)), contentDescription = null, tint = tint, modifier = Modifier.padding(8.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(time, style = MaterialTheme.typography.labelMedium)
                Text(duration, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
