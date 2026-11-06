package com.microorganics.calltracker

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.withStarted
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

private operator fun <T> kotlin.reflect.KMutableProperty0<T>.getValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>): T = get()
private operator fun <T> kotlin.reflect.KMutableProperty0<T>.setValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>, value: T) = set(value)

private val timeOnlyFormat = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault())
private val dayFormat = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withZone(ZoneId.systemDefault())

private fun offsetMillis(at: Long): Long = ZoneId.systemDefault().rules.getOffset(Instant.ofEpochMilli(at)).totalSeconds * 1000L

private fun dayLabel(millis: Long): String {
    val zone = ZoneId.systemDefault()
    val day = Instant.ofEpochMilli(millis).atZone(zone).toLocalDate()
    val today = LocalDate.now(zone)
    return when (day) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> dayFormat.format(Instant.ofEpochMilli(millis))
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
    var detailsOpen by rememberSaveable(customerId) { mutableStateOf(false) }
    var templatesOpen by rememberSaveable(customerId) { mutableStateOf(false) }
    var attachOpen by remember(customerId) { mutableStateOf(false) }
    var quickOpen by remember(customerId) { mutableStateOf(false) }
    var draft by rememberSaveable(customerId) { mutableStateOf("") }
    // Held by the repository so a rotation does not lose the picked file or the last error.
    var notice by customers::composerNotice
    var attachment by customers::composerAttachment
    BackHandler(onBack = close)
    BackHandler(enabled = detailsOpen || templatesOpen) { detailsOpen = false; templatesOpen = false }
    LaunchedEffect(customerId) { scope.launch { customers.openConversation(customerId, null) } }
    val profile by customers.profile.collectAsStateWithLifecycle()
    LaunchedEffect(customerId) { customers.ensureProfile() }
    // Once per open after the messages load, and again when a newer incoming message arrives while the screen is shown.
    val media = rememberMediaController(customers, scope)
    MediaDialogs(media, customers)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val newestIncomingId = thread.items.firstOrNull { it.direction == MessageDirection.IN }?.id
    LaunchedEffect(customerId, thread.loaded, newestIncomingId) {
        if (thread.loaded && newestIncomingId != null) {
            lifecycle.withStarted { }
            customers.markConversationRead(customerId)
        }
    }
    val name = customer?.name ?: hintName.ifEmpty { "Conversation" }
    val phone = customer?.phone ?: hintPhone

    // The reply window closes by itself while the screen is open.
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val expiresAt = customer?.whatsappWindow?.expiresAt
    LaunchedEffect(expiresAt, customer?.whatsappWindow?.open) {
        now = System.currentTimeMillis()
        if (expiresAt != null && expiresAt > now) {
            delay((expiresAt - now + 500).coerceAtMost(Int.MAX_VALUE.toLong()))
            now = System.currentTimeMillis()
        }
    }
    val windowOpen = isReplyWindowOpen(customer?.whatsappWindow, now)

    fun pick(uri: Uri?) {
        if (uri == null) return
        scope.launch {
            when (val result = readPickedAttachment(context, uri)) {
                is PickResult.Picked -> { attachment = AttachmentDraft(result.file); notice = null }
                is PickResult.Rejected -> notice = result.message
            }
        }
    }
    // The system pickers grant access to the chosen file only, so the app needs no storage permission.
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { pick(it) }
    val documentPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { pick(it) }

    fun submit() {
        notice = null
        val pending = attachment
        val text = draft
        scope.launch {
            if (pending == null) {
                when (val outcome = customers.send(text)) {
                    SendOutcome.Sent -> { if (draft == text) draft = "" }
                    SendOutcome.NotConfigured -> notice = NOT_SET_UP
                    SendOutcome.WindowClosed -> notice = null
                    is SendOutcome.Failed -> notice = outcome.message
                }
                return@launch
            }
            try {
                val uploaded = pending.uploaded ?: run {
                    pending.progress = 0f
                    customers.uploadAttachment(pending.file) { pending.progress = it }.also { pending.uploaded = it }
                }
                pending.progress = null
                when (val outcome = customers.sendMedia(uploaded.id, text)) {
                    SendOutcome.Sent -> {
                        if (attachment === pending) attachment = null
                        if (draft == text) draft = ""
                    }
                    SendOutcome.NotConfigured -> notice = NOT_SET_UP
                    SendOutcome.WindowClosed -> notice = null
                    is SendOutcome.Failed -> notice = outcome.message
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                notice = customersFailureMessage(error)
            } finally {
                pending.progress = null
            }
        }
    }

    val colors = chatColors()
    when {
        templatesOpen -> Box(modifier.fillMaxSize()) {
            TemplatePickerScreen(
                customers, scope, name, onBack = { templatesOpen = false },
                onSent = { templatesOpen = false; notice = null },
            )
        }
        detailsOpen -> Box(modifier.fillMaxSize()) {
            CustomerDetailsScreen(
                customers, scope, customer, phone, onBack = { detailsOpen = false },
                reload = { scope.launch { customers.refreshConversation() } },
                openBusinessWhatsApp = { detailsOpen = false },
            )
        }
        else -> Column(modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                IconAction(R.drawable.ic_back, "Back", close)
                Row(
                    Modifier.weight(1f).clickable(onClickLabel = "Show customer details") { detailsOpen = true }.padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Avatar(name)
                    Column(Modifier.weight(1f)) {
                        Text(name, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (phone.isNotEmpty()) Text(phone, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                    }
                }
                IconAction(R.drawable.ic_refresh, "Refresh", { scope.launch { customers.refreshConversation() } })
                IconAction(R.drawable.ic_chat_info, "Customer details", { detailsOpen = true })
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                MessageThread(thread, customers, media, colors, { scope.launch { customers.refreshConversation() } }, { scope.launch { customers.messages.loadMore() } })
            }
            Column(Modifier.fillMaxWidth().background(colors.background)) {
                notice?.let { Text(it, Modifier.padding(horizontal = 16.dp, vertical = 4.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                when (availability) {
                    SendAvailability.UNAVAILABLE -> Box(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) { SupportingText(NOT_SET_UP) }
                    SendAvailability.CHECKING -> Box(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) { SupportingText("Checking whether sending is available…") }
                    SendAvailability.UNREACHABLE -> Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.weight(1f)) { SupportingText("Could not check whether sending is available.") }
                        TextButton(onClick = { scope.launch { customers.checkAvailability() } }) { Text("Try again") }
                    }
                    SendAvailability.AVAILABLE -> Unit
                }
                val canSend = availability == SendAvailability.AVAILABLE
                if (windowOpen) {
                    ChatComposer(
                        colors = colors, draft = draft, onDraft = { draft = it.take(MAX_MESSAGE_CHARACTERS); notice = null },
                        enabled = canSend, busy = sending || attachment?.progress != null,
                        attachment = attachment, onRemoveAttachment = { attachment = null },
                        onQuickReplies = { quickOpen = true }, onAttach = { attachOpen = true },
                        onTemplate = { templatesOpen = true }, onSend = ::submit,
                    )
                } else {
                    ClosedWindowBanner(colors, enabled = canSend) { templatesOpen = true }
                }
            }
        }
    }
    if (attachOpen) {
        AttachSheet(
            onDismiss = { attachOpen = false },
            onPhoto = { attachOpen = false; photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
            onDocument = { attachOpen = false; documentPicker.launch(DOCUMENT_PICKER_TYPES) },
        )
    }
    if (quickOpen) {
        QuickReplySheet(
            customers, remember(name, profile) { customers.handlerContext(name) }, onDismiss = { quickOpen = false },
            onPick = { filled ->
                quickOpen = false
                draft = (if (draft.isBlank()) filled.text else draft.trimEnd() + "\n" + filled.text).take(MAX_MESSAGE_CHARACTERS)
                notice = null
                if (filled.missing.isNotEmpty()) {
                    notice = "Fill in " + filled.missing.joinToString(", ") { "{{$it}}" } + " before sending."
                }
            },
        )
    }
}

internal const val NOT_SET_UP = "Sending WhatsApp messages from this app is not set up yet. Ask your manager."

@Composable
private fun MessageThread(
    thread: PagedState<WhatsAppMessage>,
    customers: CustomersRepository,
    media: MediaController,
    colors: ChatColors,
    refresh: () -> Unit,
    loadEarlier: () -> Unit,
) {
    Box(Modifier.fillMaxSize().background(colors.background)) {
        when {
            thread.items.isEmpty() -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                Centered {
                    when {
                        thread.error != null -> {
                            Text(thread.error, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                            OutlinedButton(onClick = refresh) { Text("Try again") }
                        }
                        !thread.loaded -> CircularProgressIndicator()
                        else -> Text("No WhatsApp messages with this customer yet.", style = MaterialTheme.typography.bodySmall, color = colors.meta)
                    }
                }
            }
            else -> {
                val dayStarts = remember(thread.items) { dayStartIndexes(thread.items.map { it.sentAt }, ::offsetMillis) }
                // Newest first with a reversed layout: the latest message sits at the bottom and older ones are above.
                LazyColumn(Modifier.fillMaxSize(), reverseLayout = true, contentPadding = PaddingValues(vertical = 8.dp)) {
                    if (thread.error != null) item("error") { Box(Modifier.padding(horizontal = 12.dp)) { ErrorNotice(thread.error, refresh) } }
                    thread.items.forEachIndexed { index, message ->
                        val older = thread.items.getOrNull(index + 1)
                        val groupStart = older == null || older.direction != message.direction || index in dayStarts
                        item(key = message.id) { MessageBubble(message, groupStart, customers, media, colors) }
                        if (index in dayStarts) item(key = "day-${message.id}") { DayChip(message.sentAt, colors) }
                    }
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
    }
}

@Composable
private fun DayChip(millis: Long, colors: ChatColors) {
    Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
        Surface(shape = RoundedCornerShape(8.dp), color = colors.chip, shadowElevation = 0.5.dp) {
            Text(dayLabel(millis), Modifier.padding(horizontal = 10.dp, vertical = 4.dp), style = MaterialTheme.typography.labelMedium, color = colors.meta)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageBubble(message: WhatsAppMessage, tail: Boolean, customers: CustomersRepository, controller: MediaController, colors: ChatColors) {
    val outgoing = message.direction == MessageDirection.OUT
    val attachment = message.media
    val label = if (attachment != null) null else typeLabel(message.messageType, message.templateName)
    val bubbleColor = if (outgoing) colors.outgoing else colors.incoming
    val copyText = copyableText(message.body)
    var menuOpen by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val radius = 10.dp
    val shape = RoundedCornerShape(
        topStart = if (tail && !outgoing) 0.dp else radius, topEnd = if (tail && outgoing) 0.dp else radius,
        bottomStart = radius, bottomEnd = radius,
    )
    Row(
        Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = if (tail) 6.dp else 1.dp),
        horizontalArrangement = if (outgoing) Arrangement.End else Arrangement.Start,
    ) {
        Box(
            Modifier.widthIn(max = 340.dp).drawBehind {
                if (!tail) return@drawBehind
                val w = 8.dp.toPx()
                val h = 10.dp.toPx()
                val path = Path().apply {
                    if (outgoing) {
                        moveTo(size.width, 0f); lineTo(size.width + w, 0f); lineTo(size.width, h)
                    } else {
                        moveTo(0f, 0f); lineTo(-w, 0f); lineTo(0f, h)
                    }
                    close()
                }
                drawPath(path, bubbleColor)
            },
        ) {
            Surface(shape = shape, color = bubbleColor, contentColor = colors.text) {
                Column(
                    Modifier.then(if (copyText != null) Modifier.combinedClickable(onClick = {}, onLongClickLabel = "Copy message text", onLongClick = { menuOpen = true }) else Modifier)
                        .padding(start = 9.dp, end = 9.dp, top = 6.dp, bottom = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    if (outgoing) message.sentBy?.name?.takeIf { it.isNotEmpty() }?.let {
                        Text(it, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = colors.meta)
                    }
                    label?.let { Text(it, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold) }
                    if (attachment != null) MediaBlock(message, attachment, customers, controller)
                    message.body?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    if (label == null && attachment == null && message.body == null) Text("(empty message)", style = MaterialTheme.typography.bodySmall)
                    Row(Modifier.align(Alignment.End), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                        if (outgoing && message.status == "failed") Text("Failed", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                        Text(timeOnlyFormat.format(Instant.ofEpochMilli(message.sentAt)), style = MaterialTheme.typography.labelSmall, color = colors.meta)
                        if (outgoing) StatusTick(message.status, colors)
                    }
                    if (copyText != null) DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("Copy") }, onClick = {
                            menuOpen = false
                            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            clipboard.setPrimaryClip(ClipData.newPlainText("Message", copyText))
                            Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
                        })
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusTick(status: String, colors: ChatColors) {
    val (icon, tint) = when (status) {
        "queued" -> R.drawable.ic_chat_clock to colors.meta
        "delivered" -> R.drawable.ic_chat_done_all to colors.meta
        "read" -> R.drawable.ic_chat_done_all to colors.readTick
        "failed" -> R.drawable.ic_chat_error to MaterialTheme.colorScheme.error
        else -> R.drawable.ic_chat_check to colors.meta
    }
    Icon(painterResource(icon), contentDescription = statusLabel(status), tint = tint, modifier = Modifier.size(14.dp))
}
