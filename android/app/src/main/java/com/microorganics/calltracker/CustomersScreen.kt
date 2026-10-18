package com.microorganics.calltracker

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

private const val NOT_SET_UP = "Sending WhatsApp messages from this app is not set up yet. Ask your manager."
private const val SEARCH_DELAY_MS = 350L

private val listTimeFormat = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withZone(ZoneId.systemDefault())
private val bubbleTimeFormat = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT, FormatStyle.SHORT).withZone(ZoneId.systemDefault())

private fun formatTime(format: DateTimeFormatter, millis: Long?): String? = millis?.let { format.format(Instant.ofEpochMilli(it)) }

private fun statusLabel(status: String): String = when (status) {
    "queued" -> "Queued"
    "sent" -> "Sent"
    "delivered" -> "Delivered"
    "read" -> "Read"
    "failed" -> "Failed"
    else -> status.replaceFirstChar { it.uppercase() }
}

/** Media is never downloaded in this app; say what the message is instead of leaving a blank bubble. */
private fun typeLabel(type: String, templateName: String? = null): String? = when (type) {
    "text" -> null
    "image" -> "Photo (not shown in this app)"
    "document" -> "Document (not shown in this app)"
    "template" -> if (templateName != null) "Template: $templateName" else "Template message"
    else -> "${type.replaceFirstChar { it.uppercase() }} message (not shown in this app)"
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
private fun SearchField(value: String, label: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = { onChange(it.take(100)) },
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        label = { Text(label) },
        singleLine = true,
        trailingIcon = if (value.isNotEmpty()) ({ TextButton(onClick = { onChange("") }) { Text("Clear") } }) else null,
    )
}

@Composable
private fun Centered(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 48.dp, horizontal = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) { content() }
}

@Composable
private fun ErrorNotice(message: String, retry: () -> Unit) {
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
    val state by customers.customers.state.collectAsStateWithLifecycle()
    // Loads on first open and re-queries after typing pauses; later visits reuse what is in memory.
    LaunchedEffect(query) {
        if (query.isNotEmpty()) delay(SEARCH_DELAY_MS)
        scope.launch { customers.openCustomers(query) }
    }
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.padding(top = 12.dp)) { SearchField(query, "Search name, phone or email") { query = it } }
        Box(Modifier.weight(1f)) {
            PagedColumn(
                state = state,
                emptyText = if (state.query.isEmpty()) "No customers are assigned to you yet." else "No customers match this search.",
                rowKey = { it.id },
                refresh = { scope.launch { customers.customers.refresh() } },
                loadMore = { scope.launch { customers.customers.loadMore() } },
            ) { customer ->
                CustomerRow(customer) { open(customer.id, customer.name, customer.phone) }
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
    LaunchedEffect(query) {
        if (query.isNotEmpty()) delay(SEARCH_DELAY_MS)
        scope.launch { customers.openChats(query) }
    }
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.padding(top = 12.dp)) { SearchField(query, "Search chats") { query = it } }
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

@Composable
private fun ChatRow(chat: ChatSummary, onClick: () -> Unit) {
    ListSurface(onClick) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(chat.customerName, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            formatTime(listTimeFormat, chat.lastSentAt)?.let { SupportingText(it) }
        }
        val preview = chat.lastText.ifBlank { typeLabel(chat.lastMessageType).orEmpty() }
        Text(
            (if (chat.lastDirection == MessageDirection.OUT) "You: " else "") + preview,
            style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
        SupportingText(chat.customerPhone)
    }
}

@Composable
internal fun ConversationScreen(
    customers: CustomersRepository,
    scope: CoroutineScope,
    customerId: String,
    hintName: String,
    hintPhone: String,
    close: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val thread by customers.messages.state.collectAsStateWithLifecycle()
    val customer by customers.selectedCustomer.collectAsStateWithLifecycle()
    val availability by customers.availability.collectAsStateWithLifecycle()
    val sending by customers.sending.collectAsStateWithLifecycle()
    var detailsOpen by rememberSaveable { mutableStateOf(false) }
    var draft by rememberSaveable(customerId) { mutableStateOf("") }
    var sendNotice by remember(customerId) { mutableStateOf<String?>(null) }
    BackHandler(onBack = close)
    LaunchedEffect(customerId) { scope.launch { customers.openConversation(customerId, null) } }
    val name = customer?.name ?: hintName.ifEmpty { "Conversation" }
    val phone = customer?.phone ?: hintPhone

    Column(modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = close) { Text("Back") }
            Column(Modifier.weight(1f)) {
                Text(name, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (phone.isNotEmpty()) SupportingText(phone)
            }
            TextButton(onClick = { detailsOpen = !detailsOpen }) { Text(if (detailsOpen) "Hide details" else "Details") }
            TextButton(onClick = { scope.launch { customers.refreshConversation() } }) { Text("Refresh") }
        }
        if (detailsOpen) {
            Column(
                Modifier.fillMaxWidth().heightIn(max = 260.dp).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                CustomerFacts(customer, phone) {
                    try {
                        context.startActivity(Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", phone, null)))
                    } catch (_: ActivityNotFoundException) {
                        sendNotice = "No phone app is available to dial."
                    }
                }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            MessageThread(thread, { scope.launch { customers.refreshConversation() } }, { scope.launch { customers.messages.loadMore() } })
        }
        Composer(
            availability = availability,
            sending = sending,
            draft = draft,
            notice = sendNotice,
            onDraft = { draft = it.take(MAX_MESSAGE_CHARACTERS); sendNotice = null },
            recheck = { scope.launch { customers.checkAvailability() } },
            send = {
                sendNotice = null
                val text = draft
                scope.launch {
                    when (val outcome = customers.send(text)) {
                        SendOutcome.Sent -> { if (draft == text) draft = "" }
                        SendOutcome.NotConfigured -> sendNotice = NOT_SET_UP
                        is SendOutcome.Failed -> sendNotice = outcome.message
                    }
                }
            },
        )
    }
}

@Composable
private fun CustomerFacts(customer: Customer?, phone: String, dial: () -> Unit) {
    if (customer == null) {
        SupportingText("Loading customer details…")
        return
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) { DetailField("Phone", phone) }
        OutlinedButton(onClick = dial) { Text("Dial") }
    }
    customer.email?.let { DetailField("Email", it) }
    customer.notes?.let { DetailField("Notes", it) }
    customer.source?.let { DetailField("Source", it) }
    customer.district?.let { DetailField("District", it) }
    customer.state?.let { DetailField("State", it) }
    customer.country?.let { DetailField("Country", it) }
    if (customer.employees.isNotEmpty()) {
        DetailField("Handled by", customer.employees.joinToString(", ") { it.name.ifEmpty { "Employee" } })
    }
}

@Composable
private fun MessageThread(thread: PagedState<WhatsAppMessage>, refresh: () -> Unit, loadEarlier: () -> Unit) {
    when {
        thread.items.isEmpty() -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            Centered {
                when {
                    thread.error != null -> {
                        Text(thread.error, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                        OutlinedButton(onClick = refresh) { Text("Try again") }
                    }
                    !thread.loaded -> CircularProgressIndicator()
                    else -> SupportingText("No WhatsApp messages with this customer yet.")
                }
            }
        }
        // Newest first with a reversed layout: the latest message sits at the bottom and older ones are above.
        else -> LazyColumn(
            Modifier.fillMaxSize(),
            reverseLayout = true,
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (thread.error != null) item("error") { ErrorNotice(thread.error, refresh) }
            items(thread.items, key = { it.id }) { MessageBubble(it) }
            if (thread.nextCursor != null) {
                item("earlier") {
                    LaunchedEffect(thread.nextCursor, thread.items.size) { loadEarlier() }
                    Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
                        if (thread.loadingMore) CircularProgressIndicator() else OutlinedButton(onClick = loadEarlier) { Text("Load earlier messages") }
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(message: WhatsAppMessage) {
    val outgoing = message.direction == MessageDirection.OUT
    val label = typeLabel(message.messageType, message.templateName)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (outgoing) Arrangement.End else Arrangement.Start) {
        Surface(
            modifier = Modifier.widthIn(max = 420.dp),
            shape = RoundedCornerShape(16.dp),
            color = if (outgoing) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
            contentColor = if (outgoing) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
        ) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                label?.let { Text(it, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold) }
                message.body?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                if (label == null && message.body == null) Text("(empty message)", style = MaterialTheme.typography.bodySmall)
                val meta = buildList {
                    formatTime(bubbleTimeFormat, message.sentAt)?.let { add(it) }
                    if (outgoing) {
                        add(statusLabel(message.status))
                        message.sentBy?.name?.takeIf { it.isNotEmpty() }?.let { add(it) }
                    }
                }.joinToString(" · ")
                Text(
                    meta, style = MaterialTheme.typography.labelSmall,
                    color = if (outgoing && message.status == "failed") MaterialTheme.colorScheme.error else LocalContentColor.current.copy(alpha = 0.7f),
                )
            }
        }
    }
}

@Composable
private fun Composer(
    availability: SendAvailability,
    sending: Boolean,
    draft: String,
    notice: String?,
    onDraft: (String) -> Unit,
    recheck: () -> Unit,
    send: () -> Unit,
) {
    val enabled = availability == SendAvailability.AVAILABLE
    Surface(color = MaterialTheme.colorScheme.background, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = onDraft,
                    modifier = Modifier.weight(1f),
                    enabled = enabled && !sending,
                    label = { Text("Message") },
                    maxLines = 4,
                )
                Button(onClick = send, enabled = enabled && !sending && draft.isNotBlank()) { Text(if (sending) "Sending…" else "Send") }
            }
            when (availability) {
                SendAvailability.UNAVAILABLE -> SupportingText(NOT_SET_UP)
                SendAvailability.CHECKING -> SupportingText("Checking whether sending is available…")
                SendAvailability.UNREACHABLE -> Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) { SupportingText("Could not check whether sending is available.") }
                    TextButton(onClick = recheck) { Text("Try again") }
                }
                SendAvailability.AVAILABLE -> Unit
            }
            notice?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        }
    }
}
