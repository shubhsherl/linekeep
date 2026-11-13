package com.microorganics.calltracker

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withPermit
import java.io.IOException
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

/** Thrown when this installation has no usable credentials; [revoked] is true after a 401. */
internal class NotConnected(val revoked: Boolean) : Exception("Device is not connected")

internal data class PagedState<T>(
    val items: List<T> = emptyList(),
    val nextCursor: String? = null,
    val query: String = "",
    /** True once a page has arrived, or access was lost; a first-load failure leaves it false so opening the tab retries. */
    val loaded: Boolean = false,
    val refreshing: Boolean = false,
    val loadingMore: Boolean = false,
    val error: String? = null,
)

internal enum class SendAvailability { CHECKING, UNAVAILABLE, AVAILABLE, UNREACHABLE }

internal sealed interface SendOutcome {
    data object Sent : SendOutcome
    data object NotConfigured : SendOutcome
    /** The customer's 24-hour window is closed: only a template may be sent. */
    data object WindowClosed : SendOutcome
    data class Failed(val message: String) : SendOutcome
}

/** How long a loaded profile (role, team) is trusted before the app comes back to the foreground and asks again. */
internal const val PROFILE_MAX_AGE_MS = 10 * 60_000L

internal fun isAccessLost(error: Exception) = error is NotConnected || (error is ApiFailure && error.status == 401)

/** Short, data-free text for the UI. Server bodies and customer values never appear in it. */
internal fun customersFailureMessage(error: Exception): String = when {
    error is NotConnected && error.revoked -> "Access for this phone was revoked. Contact your manager."
    error is ServerNotSet -> "No server is set. Add one in Settings > Advanced."
    error is NotConnected -> "Open Settings > Setup first."
    error is ApiFailure && error.status == 401 -> "Access for this phone was revoked. Contact your manager."
    hasCode(error, WINDOW_CLOSED_CODE) -> "The 24-hour reply window is closed. Send a template to start the conversation again."
    hasCode(error, HEADER_IMAGE_REQUIRED_CODE) -> "Choose a header image for this template."
    hasCode(error, "unsupported_media_type") -> "This file type can't be sent on WhatsApp."
    hasCode(error, "file_too_large") || (error is ApiFailure && error.status == 413) -> "This file is larger than ${formatSize(MAX_ATTACHMENT_BYTES)}."
    hasCode(error, PHONE_NOT_EDITABLE_CODE) -> "The phone number can't be changed."
    hasCode(error, CUSTOMER_EXISTS_CODE) -> OTHER_HANDLER_MESSAGE
    hasCode(error, HANDLER_REQUIRED_CODE) -> "A customer needs at least one person. Keep someone ticked."
    hasCode(error, EMPLOYEE_OUT_OF_SCOPE_CODE) -> "That person is not on your team any more. Refresh and try again."
    hasCode(error, NOT_A_MANAGER_CODE) -> "Only managers can do this."
    error is ApiFailure && error.status == 502 -> "WhatsApp could not complete this. Try again in a moment."
    error is ApiFailure && error.status == 404 -> "This customer is not assigned to you any more."
    error is ApiFailure && (error.status == 429 || error.status >= 500) -> "Linekeep is busy right now. Try again in a moment."
    error is ApiFailure -> "Linekeep could not complete this (HTTP ${error.status})."
    error is IOException -> "Can't reach Linekeep. Check your connection and try again."
    else -> "Something went wrong. Try again."
}

internal fun <T> mergeNewestPage(known: List<T>, newest: List<T>, id: (T) -> String): List<T> {
    val fresh = newest.distinctBy(id)
    val freshIds = fresh.mapTo(HashSet(), id)
    if (known.isNotEmpty() && fresh.isNotEmpty() && known.none { id(it) in freshIds }) return fresh
    return fresh + known.filter { id(it) !in freshIds }
}

/** One memory-only, cursor-paged list. Results that arrive after a newer refresh, search or clear are dropped. */
internal class PagedList<T>(
    private val id: (T) -> String,
    private val fetch: suspend (query: String?, cursor: String?) -> Page<T>,
) {
    private val mutable = MutableStateFlow(PagedState<T>())
    val state: StateFlow<PagedState<T>> = mutable.asStateFlow()
    private val generation = AtomicInteger()

    fun clear() {
        generation.incrementAndGet()
        mutable.value = PagedState()
    }

    suspend fun ensureLoaded() {
        val current = mutable.value
        if (!current.loaded && !current.refreshing) refresh()
    }

    suspend fun search(query: String) {
        val trimmed = query.trim()
        val current = mutable.value
        if (trimmed == current.query && (current.loaded || current.refreshing)) return
        mutable.update { it.copy(query = trimmed) }
        refresh()
    }

    suspend fun refresh() {
        val mine = generation.incrementAndGet()
        val query = mutable.value.query
        mutable.update { it.copy(refreshing = true, loadingMore = false, error = null) }
        try {
            val page = fetch(query.ifEmpty { null }, null)
            if (mine != generation.get()) return
            mutable.value = PagedState(page.items.distinctBy(id), page.nextCursor, query, loaded = true)
        } catch (error: Exception) {
            settle(mine, error)
        }
    }

    suspend fun loadMore() {
        var cursor: String? = null
        var query = ""
        mutable.update {
            cursor = it.nextCursor.takeIf { _ -> !it.refreshing && !it.loadingMore }
            query = it.query
            if (cursor == null) it else it.copy(loadingMore = true, error = null)
        }
        val next = cursor ?: return
        val mine = generation.get()
        try {
            val page = fetch(query.ifEmpty { null }, next)
            if (mine != generation.get()) return
            mutable.update { current ->
                val known = current.items.mapTo(HashSet(), id)
                current.copy(items = current.items + page.items.filter { known.add(id(it)) },
                    nextCursor = page.nextCursor, loadingMore = false)
            }
        } catch (error: Exception) {
            settle(mine, error)
        }
    }

    /**
     * Fetches the newest page and merges it by id: fetched copies replace known ones and win their position,
     * older loaded items stay. Without any overlap the loaded list could have a gap, so it is replaced instead.
     * Silent: no loading or error state is touched, failures propagate to the caller. Results are dropped if a
     * refresh, search or clear ran meanwhile.
     */
    suspend fun mergeNewest() {
        val before = generation.get()
        val current = mutable.value
        if (!current.loaded || current.refreshing) return
        val page = fetch(current.query.ifEmpty { null }, null)
        if (before != generation.get()) return
        mutable.update { latest ->
            if (!latest.loaded) latest
            else {
                val merged = mergeNewestPage(latest.items, page.items, id)
                // Older pages stay loaded only when something beyond the fetched page survived the merge.
                latest.copy(items = merged, nextCursor = if (merged.size > page.items.distinctBy(id).size) latest.nextCursor else page.nextCursor)
            }
        }
    }

    /** Adds a just-sent item at the newest end, replacing any copy with the same id. */
    fun prepend(item: T) {
        mutable.update { current -> current.copy(items = listOf(item) + current.items.filter { id(it) != id(item) }) }
    }

    /** Rewrites one loaded item in place, without refetching. */
    fun update(itemId: String, transform: (T) -> T) {
        mutable.update { current ->
            if (current.items.none { id(it) == itemId }) current
            else current.copy(items = current.items.map { if (id(it) == itemId) transform(it) else it })
        }
    }

    private fun settle(mine: Int, error: Exception) {
        if (mine != generation.get()) {
            if (error is CancellationException) throw error
            return
        }
        if (error is CancellationException) {
            mutable.update { it.copy(refreshing = false, loadingMore = false) }
            throw error
        }
        val message = customersFailureMessage(error)
        mutable.update {
            if (isAccessLost(error)) PagedState(loaded = true, error = message)
            else it.copy(refreshing = false, loadingMore = false, error = message)
        }
    }
}

/**
 * Customers, chats and the open conversation, held in memory only: nothing here is written to disk and
 * everything is dropped with the process, on revocation, and when a conversation is closed.
 */
internal class CustomersRepository(private val enrollments: EnrollmentRepository) {
    private val api = DeviceApi(enrollments::serverUrl)

    @Volatile private var selectedId: String? = null
    @Volatile private var ownerId: String? = null
    @Volatile private var pending: Triple<String, String, String>? = null

    /** The conversation currently open on screen, or null. */
    val openConversationId: String? get() = selectedId

    private val mutableCustomersScope = MutableStateFlow<ScopeFilter>(ScopeFilter.All)
    private val mutableChatsScope = MutableStateFlow<ScopeFilter>(ScopeFilter.All)
    /** A manager's filter of the Customers list; always [ScopeFilter.All] for anyone else. */
    val customersScope: StateFlow<ScopeFilter> = mutableCustomersScope.asStateFlow()
    /** A manager's filter of the WhatsApp chat list; always [ScopeFilter.All] for anyone else. */
    val chatsScope: StateFlow<ScopeFilter> = mutableChatsScope.asStateFlow()

    val customers = PagedList<Customer>({ it.id }) { query, cursor ->
        val employee = scopeParam(mutableCustomersScope.value, mutableProfile.value)
        enrollments.authorized { api.customers(it, query, cursor, employee) }
    }
    val chats = PagedList<ChatSummary>({ it.customerId }) { query, cursor ->
        val employee = scopeParam(mutableChatsScope.value, mutableProfile.value)
        enrollments.authorized { api.chats(it, query, cursor, employee) }
    }
    val messages = PagedList<WhatsAppMessage>({ it.id }) { _, cursor ->
        val customerId = selectedId ?: throw CancellationException("No conversation is open")
        enrollments.authorized { api.customerMessages(it, customerId, cursor) }
    }

    private val mutableCustomer = MutableStateFlow<Customer?>(null)
    /** Facts for the open conversation; null until loaded. */
    val selectedCustomer: StateFlow<Customer?> = mutableCustomer.asStateFlow()

    private val mutableUnreadChats = MutableStateFlow(0)
    /** Chats with unread customer messages for this employee; 0 until fetched. */
    val unreadChats: StateFlow<Int> = mutableUnreadChats.asStateFlow()
    private val unreadRequest = AtomicInteger()

    @Volatile private var lastVersion: Long? = null
    @Volatile private var chatsStale = false
    private val mediaGate = kotlinx.coroutines.sync.Semaphore(3)

    private val mutableAvailability = MutableStateFlow(SendAvailability.CHECKING)
    val availability: StateFlow<SendAvailability> = mutableAvailability.asStateFlow()
    private val mutableSending = MutableStateFlow(false)
    val sending: StateFlow<Boolean> = mutableSending.asStateFlow()

    /** A different employee on this device must never see the previous one's data. */
    private fun resetIfOwnerChanged() {
        val current = enrollments.status.value.employeeId.ifEmpty { null }
        if (ownerId != current) {
            if (ownerId != null) closeAll()
            ownerId = current
        }
    }

    private fun closeAll() {
        customers.clear()
        chats.clear()
        unreadRequest.incrementAndGet()
        mutableUnreadChats.value = 0
        lastVersion = null
        chatsStale = false
        mutableProfile.value = null
        profileLoadedAt = 0L
        mutableCustomersScope.value = ScopeFilter.All
        mutableChatsScope.value = ScopeFilter.All
        quickCache.clear()
        templateCache.clear()
        closeConversation()
    }

    /** Loads lazily: a tab first opened (or re-queried) fetches; revisiting with the same query reuses memory. */
    suspend fun openCustomers(query: String) {
        resetIfOwnerChanged()
        if (query.trim() != customers.state.value.query) customers.search(query) else customers.ensureLoaded()
    }

    suspend fun setCustomersScope(filter: ScopeFilter) {
        resetIfOwnerChanged()
        val next = normalizeFilter(filter, mutableProfile.value)
        if (mutableCustomersScope.value == next) return
        mutableCustomersScope.value = next
        customers.refresh()
    }

    suspend fun setChatsScope(filter: ScopeFilter) {
        resetIfOwnerChanged()
        val next = normalizeFilter(filter, mutableProfile.value)
        if (mutableChatsScope.value == next) return
        mutableChatsScope.value = next
        chats.refresh()
    }

    suspend fun openChats(query: String) {
        resetIfOwnerChanged()
        if (query.trim() != chats.state.value.query) chats.search(query)
        else if (chatsStale && chats.state.value.loaded) { chatsStale = false; chats.mergeNewest() }
        else chats.ensureLoaded()
    }

    /** Downloads one message's media with the device token; at most three transfers run at once. */
    suspend fun mediaBytes(url: String): ByteArray = mediaGate.withPermit {
        enrollments.authorized { api.mediaBytes(it, url) }
    }

    /**
     * Polls the tiny version endpoint until cancelled (callers run it only while the app is started). On a
     * change it refreshes just what is on screen: the open conversation's newest page, or the chat list when
     * [chatsVisible]; unread totals always. Other loaded chat lists are refreshed when next shown. While nothing
     * changes the interval stretches per [policy]; a change, [nudgeLiveUpdates] or a restart of this loop (a new
     * screen, the app coming to the foreground) brings it back to the base. Errors double the interval up to 60 s;
     * a successful answer resets that. The first successful poll only records the version.
     */
    suspend fun runLiveUpdates(policy: PollPolicy, chatsVisible: Boolean) {
        var unchanged = 0
        var failures = 0
        nudges.tryReceive()
        while (true) {
            try {
                val changed = pollVersion(chatsVisible)
                failures = 0
                unchanged = if (changed) 0 else unchanged + 1
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                failures++
            }
            if (kotlinx.coroutines.withTimeoutOrNull(nextPollDelay(policy, unchanged, failures)) { nudges.receive() } != null) unchanged = 0
        }
    }

    private val nudges = kotlinx.coroutines.channels.Channel<Unit>(kotlinx.coroutines.channels.Channel.CONFLATED)

    /** Something the employee did or a push says a message may have changed: poll now and restart the back-off. */
    fun nudgeLiveUpdates() {
        nudges.trySend(Unit)
    }

    /** True when the server's version moved since the last poll (or this is the first one). */
    private suspend fun pollVersion(chatsVisible: Boolean): Boolean {
        resetIfOwnerChanged()
        val version = enrollments.authorized { api.whatsAppVersion(it) }
        val previous = lastVersion
        if (previous == null) {
            lastVersion = version
            return true
        }
        if (previous == version) return false
        coroutineScope {
            if (selectedId != null) launch { messages.mergeNewest() }
            if (chatsVisible && selectedId == null) launch { chats.mergeNewest() } else chatsStale = true
            launch { refreshUnreadOrThrow() }
        }
        lastVersion = version
        return true
    }

    private suspend fun refreshUnreadOrThrow() {
        val mine = unreadRequest.incrementAndGet()
        val totals = enrollments.authorized { api.unread(it) }
        if (mine == unreadRequest.get()) mutableUnreadChats.value = totals.chats
    }

    suspend fun openConversation(customerId: String, known: Customer?) {
        resetIfOwnerChanged()
        if (selectedId == customerId && messages.state.value.loaded) return
        if (selectedId != customerId) {
            selectedId = customerId
            pending = null
            clearComposer()
            messages.clear()
            mutableCustomer.value = known ?: customers.state.value.items.firstOrNull { it.id == customerId }
            mutableAvailability.value = SendAvailability.CHECKING
        }
        coroutineScope {
            launch { messages.refresh() }
            launch { loadCustomer(customerId) }
            launch { checkAvailability() }
        }
    }

    /** Fetches this employee's unread totals; failures keep the last value and the next trigger retries. */
    suspend fun refreshUnread() {
        resetIfOwnerChanged()
        val mine = unreadRequest.incrementAndGet()
        try {
            val totals = enrollments.authorized { api.unread(it) }
            if (mine == unreadRequest.get()) mutableUnreadChats.value = totals.chats
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (isAccessLost(error) && mine == unreadRequest.get()) mutableUnreadChats.value = 0
        }
    }

    /**
     * Marks the open, loaded conversation read for this employee and clears its badge in memory.
     * Ignored for any chat not on screen; failures are ignored so the next call retries.
     */
    suspend fun markConversationRead(customerId: String) {
        if (selectedId != customerId || !messages.state.value.loaded) return
        try {
            enrollments.authorized { api.markChatRead(it, customerId) }
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            return
        }
        chats.update(customerId) { it.copy(unreadCount = 0) }
        refreshUnread()
    }

    fun closeConversation() {
        selectedId = null
        pending = null
        clearComposer()
        messages.clear()
        mutableCustomer.value = null
        mutableAvailability.value = SendAvailability.CHECKING
    }

    suspend fun refreshConversation() {
        nudgeLiveUpdates()
        val customerId = selectedId ?: return
        coroutineScope {
            launch { messages.refresh() }
            launch { loadCustomer(customerId) }
            launch { checkAvailability() }
        }
    }

    private suspend fun loadCustomer(customerId: String) {
        try {
            val loaded = enrollments.authorized { api.customer(it, customerId) }
            if (loaded != null && selectedId == customerId) mutableCustomer.value = loaded
        } catch (error: Exception) {
            // Facts are optional; the message request reports access or assignment problems.
            if (error is CancellationException) throw error
        }
    }

    suspend fun checkAvailability() {
        try {
            val can = enrollments.authorized { api.whatsAppCanSend(it) }
            mutableAvailability.value = if (can) SendAvailability.AVAILABLE else SendAvailability.UNAVAILABLE
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            mutableAvailability.value = SendAvailability.UNREACHABLE
        }
    }

    /**
     * Composer state that must survive a configuration change (rotation, keyboard, night mode): the file waiting to be
     * sent and the last send problem of the open conversation. Memory only; dropped when the conversation is closed.
     */
    var composerAttachment by androidx.compose.runtime.mutableStateOf<AttachmentDraft?>(null)
    var composerNotice by androidx.compose.runtime.mutableStateOf<String?>(null)

    private fun clearComposer() {
        composerAttachment = null
        composerNotice = null
    }

    /** Emits this phone's device id once it is enrolled and not revoked, otherwise null. */
    val connection: kotlinx.coroutines.flow.Flow<String?> = enrollments.status
        .map { if (it.unauthorized) null else it.deviceId }
        .distinctUntilChanged()

    /** Reloads lists that failed only because the phone was not connected yet, once it is. */
    suspend fun onConnected() {
        resetIfOwnerChanged()
        if (customers.state.value.let { it.items.isEmpty() && it.error != null }) customers.refresh()
        if (chats.state.value.let { it.items.isEmpty() && it.error != null }) chats.refresh()
        refreshProfileIfStale()
    }

    private val mutableProfile = MutableStateFlow<EmployeeProfile?>(null)
    /** This employee's profile, fetched once per process and kept in memory only; null until loaded. */
    val profile: StateFlow<EmployeeProfile?> = mutableProfile.asStateFlow()

    @Volatile private var profileLoadedAt = 0L

    /** Loads the profile if it isn't known yet. A failure is ignored: the SIM number and enrolled name are the fallback. */
    suspend fun ensureProfile() {
        if (mutableProfile.value != null) return
        loadProfile()
    }

    /**
     * Refetches the profile when it is older than [PROFILE_MAX_AGE_MS], so a role or team change made by the administrator
     * reaches the app without a restart. Called when the app comes to the foreground; it is not polled.
     */
    suspend fun refreshProfileIfStale() {
        resetIfOwnerChanged()
        if (mutableProfile.value != null && System.currentTimeMillis() - profileLoadedAt < PROFILE_MAX_AGE_MS) return
        loadProfile()
    }

    private suspend fun loadProfile() {
        try {
            val loaded = enrollments.authorized { api.profile(it) }
            val before = mutableProfile.value
            mutableProfile.value = loaded
            profileLoadedAt = System.currentTimeMillis()
            if (before != null && scopeSignature(before) != scopeSignature(loaded)) onScopeChanged(loaded)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
        }
    }

    /** The manager's role or team changed: filters that no longer apply are dropped and loaded lists are fetched again. */
    private suspend fun onScopeChanged(profile: EmployeeProfile) {
        mutableCustomersScope.value = normalizeFilter(mutableCustomersScope.value, profile)
        mutableChatsScope.value = normalizeFilter(mutableChatsScope.value, profile)
        coroutineScope {
            if (customers.state.value.loaded) launch { customers.refresh() }
            if (chats.state.value.loaded) launch { chats.refresh() }
        }
    }

    /**
     * Name and number for {{handler_*}} placeholders and template variables: this employee, or, for a manager, the first
     * in-scope handler of [customer] (the open conversation's customer by default).
     */
    fun handlerContext(customerName: String, customer: Customer? = mutableCustomer.value): FillContext {
        val status = enrollments.status.value
        val (name, phone) = resolveHandlerIdentity(mutableProfile.value, status.employeeName, status.sim.numbers, customer?.employees.orEmpty())
        return FillContext(customerName = customerName, handlerName = name, handlerPhone = phone)
    }

    private val quickCache = Cached<List<QuickMessage>> { enrollments.authorized { api.quickMessages(it) } }
    private val templateCache = Cached<List<MessageTemplate>> { enrollments.authorized { api.templates(it) } }

    /** Shared quick replies; refetched when older than a minute or when [force]d. */
    suspend fun quickMessages(force: Boolean = false): List<QuickMessage> = quickCache.get(force).sortedBy { it.title.lowercase() }

    /** Approved templates; refetched when older than five minutes or when [force]d. */
    suspend fun templates(force: Boolean = false): List<MessageTemplate> = templateCache.get(force, maxAgeMs = 300_000L)

    /**
     * Sends one text message. The same text to the same customer reuses its client id after a failure, so a retry
     * cannot create a duplicate. The caller keeps the typed text unless [SendOutcome.Sent].
     */
    suspend fun send(text: String): SendOutcome {
        val body = text.trim()
        if (body.isEmpty()) return SendOutcome.Failed("Type a message first.")
        if (body.length > MAX_MESSAGE_CHARACTERS) return SendOutcome.Failed("Messages can be up to $MAX_MESSAGE_CHARACTERS characters.")
        return deliver("text:$body", requiresOpenWindow = true) { textMessageBody(it, body) }
    }

    /** Sends an uploaded attachment, with an optional caption. */
    suspend fun sendMedia(attachmentId: String, caption: String): SendOutcome {
        if (caption.length > MAX_MESSAGE_CHARACTERS) return SendOutcome.Failed("Captions can be up to $MAX_MESSAGE_CHARACTERS characters.")
        return deliver("media:$attachmentId:${caption.trim()}", requiresOpenWindow = true) { mediaMessageBody(it, attachmentId, caption) }
    }

    /** Sends an approved template; allowed at any time, including when the 24-hour window is closed. */
    suspend fun sendTemplate(template: MessageTemplate, values: List<String>, headerAttachmentId: String?): SendOutcome {
        val problem = templateProblem(template, values, headerAttachmentId != null)
        if (problem != null) return SendOutcome.Failed(problem)
        return deliver("template:${template.key}:${values.joinToString("\u0000")}:$headerAttachmentId", requiresOpenWindow = false) {
            templateMessageBody(it, template, values, headerAttachmentId)
        }
    }

    private suspend fun deliver(fingerprint: String, requiresOpenWindow: Boolean, build: (clientMessageId: String) -> org.json.JSONObject): SendOutcome {
        val customerId = selectedId ?: return SendOutcome.Failed("Open a conversation first.")
        when (mutableAvailability.value) {
            SendAvailability.AVAILABLE -> Unit
            SendAvailability.UNAVAILABLE -> return SendOutcome.NotConfigured
            SendAvailability.CHECKING -> return SendOutcome.Failed("Checking whether sending is available. Try again shortly.")
            SendAvailability.UNREACHABLE -> return SendOutcome.Failed("Could not check whether sending is available. Check your connection and try again.")
        }
        if (requiresOpenWindow && !isReplyWindowOpen(mutableCustomer.value?.whatsappWindow, System.currentTimeMillis())) return SendOutcome.WindowClosed
        if (!mutableSending.compareAndSet(false, true)) return SendOutcome.Failed("A message is already being sent.")
        val clientId = pending?.takeIf { it.first == customerId && it.second == fingerprint }?.third ?: UUID.randomUUID().toString()
        pending = Triple(customerId, fingerprint, clientId)
        try {
            val sent = enrollments.authorized { api.sendMessage(it, customerId, build(clientId)) }
            pending = null
            if (selectedId == customerId) {
                if (sent != null) messages.prepend(sent) else messages.refresh()
            }
            nudgeLiveUpdates()
            return SendOutcome.Sent
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (error is ApiFailure && error.status == 503 && error.code == WHATSAPP_NOT_CONFIGURED) {
                mutableAvailability.value = SendAvailability.UNAVAILABLE
                return SendOutcome.NotConfigured
            }
            if (hasCode(error, WINDOW_CLOSED_CODE)) {
                pending = null
                if (selectedId == customerId) mutableCustomer.update { it?.copy(whatsappWindow = WhatsAppWindow(open = false, expiresAt = null)) }
                return SendOutcome.WindowClosed
            }
            return SendOutcome.Failed(customersFailureMessage(error))
        } finally {
            mutableSending.value = false
        }
    }

    /** Uploads one picked file for a later [sendMedia] or template header; [onProgress] gets 0f..1f. */
    suspend fun uploadAttachment(file: PickedAttachment, onProgress: (Float) -> Unit): UploadedAttachment {
        val job = kotlin.coroutines.coroutineContext[kotlinx.coroutines.Job]
        return enrollments.authorized {
            api.uploadAttachment(it, file.fileName, file.mimeType, file.bytes, { job?.ensureActive() }) { sent -> onProgress(sent.toFloat() / file.bytes.size.coerceAtLeast(1)) }
        }
    }

    /**
     * Checks the number first, then creates the customer. A number that is already the caller's opens that customer;
     * one that belongs to someone else reveals nothing about it. A manager may pick [assignTo] from the team; it is ignored
     * (never sent) for anyone else and for oneself.
     */
    suspend fun addCustomer(name: String, phone: String, notes: String, assignTo: String? = null): AddCustomerOutcome {
        validateNewCustomer(name, phone, notes)?.let { return AddCustomerOutcome.Failed(it) }
        val normalized = requireNotNull(normalizePhone(phone))
        resetIfOwnerChanged()
        try {
            val lookup = enrollments.authorized { api.lookupCustomer(it, normalized) }
            when (val decision = decideAfterLookup(lookup)) {
                DuplicateDecision.BelongsToOther -> return AddCustomerOutcome.OtherHandler
                is DuplicateDecision.OpenExisting -> return AddCustomerOutcome.Existing(decision.customerId, decision.name, normalized, lookup.handlers)
                DuplicateDecision.Create -> Unit
            }
            val created = enrollments.authorized {
                api.createCustomer(it, createCustomerBody(name, phone, notes, assigneeToSend(assignTo, mutableProfile.value)))
            }
            if (customers.state.value.query.isEmpty() && mutableCustomersScope.value == ScopeFilter.All) customers.prepend(created)
            return AddCustomerOutcome.Created(created)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            // Someone created it between the check and the create: the server tells whose it is.
            if (hasCode(error, CUSTOMER_EXISTS_CODE)) {
                val id = (error as ApiFailure).customerId
                return if (id != null) AddCustomerOutcome.Existing(id, name.trim(), normalized) else AddCustomerOutcome.OtherHandler
            }
            return AddCustomerOutcome.Failed(customersFailureMessage(error))
        }
    }

    /**
     * Manager only: makes [employeeIds] (members of the manager's scope) the in-scope handlers of [original]. Handlers outside
     * the scope stay. The stored customer replaces the loaded copies; a customer that left the manager's scope is fetched away.
     */
    suspend fun handOver(original: Customer, employeeIds: List<String>): Result<Customer> {
        return try {
            val saved = enrollments.authorized { api.setHandlers(it, original.id, employeeIds) }
            val profile = mutableProfile.value
            val merged = original.copy(
                employees = saved.employees,
                scope = saved.scope ?: scopeAfterHandlersChanged(saved.employees, profile),
                whatsappWindow = saved.whatsappWindow ?: original.whatsappWindow,
            )
            customers.update(merged.id) { merged }
            chats.update(merged.id) { it.copy(employees = merged.employees) }
            if (selectedId == merged.id) mutableCustomer.value = merged
            if (scopeAfterHandlersChanged(merged.employees, profile) == null) {
                coroutineScope {
                    if (customers.state.value.loaded) launch { customers.refresh() }
                    if (chats.state.value.loaded) launch { chats.refresh() }
                }
            }
            Result.success(merged)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            Result.failure(IllegalStateException(customersFailureMessage(error)))
        }
    }

    /** Saves a changed name and/or notes of one of this employee's customers; returns the stored customer. */
    suspend fun updateCustomer(original: Customer, name: String, notes: String): Result<Customer> {
        if (name.isBlank()) return Result.failure(IllegalArgumentException("The name can't be empty."))
        val body = patchCustomerBody(original, name, notes) ?: return Result.success(original)
        return try {
            val saved = enrollments.authorized { api.updateCustomer(it, original.id, body) }
            val merged = original.copy(name = saved.name, notes = saved.notes, whatsappWindow = saved.whatsappWindow ?: original.whatsappWindow)
            customers.update(merged.id) { merged }
            chats.update(merged.id) { it.copy(customerName = merged.name) }
            if (selectedId == merged.id) mutableCustomer.value = merged
            Result.success(merged)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            Result.failure(IllegalStateException(customersFailureMessage(error)))
        }
    }
}

internal sealed interface AddCustomerOutcome {
    data class Created(val customer: Customer) : AddCustomerOutcome
    /** The number is already one of this employee's customers. */
    data class Existing(val customerId: String, val name: String, val phone: String, val handlers: List<EmployeeRef> = emptyList()) : AddCustomerOutcome
    data object OtherHandler : AddCustomerOutcome
    data class Failed(val message: String) : AddCustomerOutcome
}

/** A value fetched on demand and reused until it is older than [maxAgeMs]; concurrent callers see the last fetched value. */
internal class Cached<T>(private val load: suspend () -> T) {
    @Volatile private var value: T? = null
    @Volatile private var loadedAt = 0L

    suspend fun get(force: Boolean = false, maxAgeMs: Long = 60_000L): T {
        val known = value
        if (!force && known != null && System.currentTimeMillis() - loadedAt < maxAgeMs) return known
        return load().also { value = it; loadedAt = System.currentTimeMillis() }
    }

    fun clear() { value = null }
}
