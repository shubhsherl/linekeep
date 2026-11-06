package com.microorganics.calltracker

import android.content.ActivityNotFoundException
import android.content.Intent
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.withStarted
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

private const val SEARCH_DELAY_MS = 350L

private val listTimeFormat = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withZone(ZoneId.systemDefault())

internal fun formatTime(format: DateTimeFormatter, millis: Long?): String? = millis?.let { format.format(Instant.ofEpochMilli(it)) }

internal fun statusLabel(status: String): String = when (status) {
    "queued" -> "Queued"
    "sent" -> "Sent"
    "delivered" -> "Delivered"
    "read" -> "Read"
    "failed" -> "Failed"
    else -> status.replaceFirstChar { it.uppercase() }
}

/** Describes what a message is when it has no text, for list previews and bubbles without attachments. */
internal fun typeLabel(type: String, templateName: String? = null): String? = when (type) {
    "text" -> null
    "image" -> "Photo"
    "document" -> "Document"
    "video" -> "Video"
    "audio" -> "Audio"
    "sticker" -> "Sticker"
    "template" -> if (templateName != null) "Template: $templateName" else "Template message"
    else -> "${type.replaceFirstChar { it.uppercase() }} message"
}

@Composable
private fun ListSurface(onClick: () -> Unit, content: @Composable () -> Unit) {
    Surface(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { content() }
    }
}

@Composable
private fun SearchField(value: String, label: String, modifier: Modifier = Modifier, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = { onChange(it.take(100)) },
        modifier = modifier.fillMaxWidth(),
        label = { Text(label) },
        singleLine = true,
        leadingIcon = { Icon(painterResource(R.drawable.ic_search), contentDescription = null, modifier = Modifier.size(20.dp)) },
        trailingIcon = if (value.isNotEmpty()) ({ IconAction(R.drawable.ic_close, "Clear search", { onChange("") }) }) else null,
    )
}

@Composable
internal fun Centered(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 48.dp, horizontal = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) { content() }
}

@Composable
internal fun ErrorNotice(message: String, retry: () -> Unit) {
    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(message, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onErrorContainer)
            TextButton(onClick = retry) { Text("Try again") }
        }
    }
}

/** Shared list body: loading, error, empty and paged states around caller-supplied rows. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun <T> PagedColumn(
    state: PagedState<T>,
    emptyText: String,
    rowKey: (T) -> String,
    refresh: () -> Unit,
    loadMore: () -> Unit,
    row: @Composable (T) -> Unit,
) {
    PullToRefreshBox(isRefreshing = state.refreshing && state.loaded, onRefresh = refresh, modifier = Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (state.error != null && state.items.isNotEmpty()) item("error") { ErrorNotice(state.error, refresh) }
            if (state.items.isEmpty()) {
                item("empty") {
                    Centered {
                        when {
                            !state.loaded && state.error == null -> CircularProgressIndicator()
                            state.error != null -> {
                                Text(state.error, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                                OutlinedButton(onClick = refresh) { Text("Try again") }
                            }
                            else -> SupportingText(emptyText)
                        }
                    }
                }
            }
            items(state.items, key = rowKey) { row(it) }
            if (state.nextCursor != null) {
                item("more") {
                    // Reaching the footer requests the next page; the button is the manual retry after a failure.
                    LaunchedEffect(state.nextCursor, state.items.size) { loadMore() }
                    Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
                        if (state.loadingMore) CircularProgressIndicator() else OutlinedButton(onClick = loadMore) { Text("Load more") }
                    }
                }
            }
        }
    }
}

@Composable
internal fun CustomersTab(customers: CustomersRepository, scope: CoroutineScope, open: (id: String, name: String, phone: String) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var detailsId by rememberSaveable { mutableStateOf<String?>(null) }
    var adding by rememberSaveable { mutableStateOf(false) }
    val context = LocalContext.current
    val state by customers.customers.state.collectAsStateWithLifecycle()
    // A list that failed because the phone was not enrolled yet reloads as soon as it is.
    val connected by customers.connection.collectAsStateWithLifecycle(initialValue = null)
    LaunchedEffect(connected) { if (connected != null) customers.onConnected() }
    // Loads on first open and re-queries after typing pauses; later visits reuse what is in memory.
    LaunchedEffect(query) {
        if (query.isNotEmpty()) delay(SEARCH_DELAY_MS)
        scope.launch { customers.openCustomers(query) }
    }
    if (adding) {
        BackHandler { adding = false }
        AddCustomerScreen(customers, scope, onBack = { adding = false }) { id, name, phone, message ->
            // The form reports from the repository's IO scope; toasts and navigation need the main thread.
            scope.launch(Dispatchers.Main) {
                adding = false
                Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
                open(id, name, phone)
            }
        }
        return
    }
    detailsId?.let { id ->
        BackHandler { detailsId = null }
        val customer = state.items.firstOrNull { it.id == id }
        CustomerDetailsScreen(
            customers, scope, customer, customer?.phone.orEmpty(), onBack = { detailsId = null },
            reload = { scope.launch { customers.customers.refresh() } },
            openBusinessWhatsApp = { customer?.let { open(it.id, it.name, it.phone) } },
        )
        return
    }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(start = 16.dp, end = 8.dp, top = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            SearchField(query, "Search customer", Modifier.weight(1f)) { query = it }
            FilledTonalIconButton(onClick = { adding = true }, modifier = Modifier.size(48.dp)) {
                Icon(painterResource(R.drawable.ic_chat_add), contentDescription = "Add customer", modifier = Modifier.size(24.dp))
            }
        }
        Box(Modifier.weight(1f)) {
            PagedColumn(
                state = state,
                emptyText = if (state.query.isEmpty()) "No customers are assigned to you yet. Use + to add one." else "No customers match this search.",
                rowKey = { it.id },
                refresh = { scope.launch { customers.customers.refresh() } },
                loadMore = { scope.launch { customers.customers.loadMore() } },
            ) { customer ->
                CustomerRow(customer) { detailsId = customer.id }
            }
        }
    }
}

@Composable
private fun CustomerRow(customer: Customer, onClick: () -> Unit) {
    ListSurface(onClick) {
        Text(customer.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(customer.phone, style = MaterialTheme.typography.bodyMedium)
        val place = listOfNotNull(customer.district, customer.state).joinToString(", ")
        if (place.isNotEmpty()) SupportingText(place)
        customer.source?.let { SupportingText("Source: $it") }
        SupportingText(formatTime(listTimeFormat, customer.lastMessageAt)?.let { "Last message $it" } ?: "No messages yet")
    }
}

@Composable
internal fun ChatsTab(customers: CustomersRepository, scope: CoroutineScope, open: (id: String, name: String, phone: String) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val state by customers.chats.state.collectAsStateWithLifecycle()
    val connected by customers.connection.collectAsStateWithLifecycle(initialValue = null)
    LaunchedEffect(connected) { if (connected != null) customers.onConnected() }
    LaunchedEffect(query) {
        if (query.isNotEmpty()) delay(SEARCH_DELAY_MS)
        scope.launch { customers.openChats(query) }
    }
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp)) { SearchField(query, "Search chats") { query = it } }
        Box(Modifier.weight(1f)) {
            PagedColumn(
                state = state,
                emptyText = if (state.query.isEmpty()) "No WhatsApp conversations yet." else "No conversations match this search.",
                rowKey = { it.customerId },
                refresh = { scope.launch { customers.chats.refresh() } },
                loadMore = { scope.launch { customers.chats.loadMore() } },
            ) { chat ->
                ChatRow(chat) { open(chat.customerId, chat.customerName, chat.customerPhone) }
            }
        }
    }
}

/** Filled circular count; capped at 99+. The description replaces the visible digits for screen readers. */
@Composable
internal fun UnreadBadge(count: Int, description: String, modifier: Modifier = Modifier) {
    val label = if (count > 99) "99+" else count.toString()
    Box(
        modifier.defaultMinSize(minWidth = 24.dp, minHeight = 24.dp)
            .background(MaterialTheme.colorScheme.primary, CircleShape)
            .clearAndSetSemantics { contentDescription = description }
            .padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onPrimary, maxLines = 1)
    }
}

@Composable
private fun ChatRow(chat: ChatSummary, onClick: () -> Unit) {
    val unread = chat.unreadCount > 0
    ListSurface(onClick) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(chat.customerName, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = if (unread) FontWeight.Bold else FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            formatTime(listTimeFormat, chat.lastSentAt)?.let { SupportingText(it) }
        }
        val preview = chat.lastText.ifBlank { typeLabel(chat.lastMessageType).orEmpty() }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                (if (chat.lastDirection == MessageDirection.OUT) "You: " else "") + preview,
                Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium, fontWeight = if (unread) FontWeight.Bold else null,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
            if (unread) UnreadBadge(chat.unreadCount, "${chat.unreadCount} unread messages")
        }
        SupportingText(chat.customerPhone)
    }
}
