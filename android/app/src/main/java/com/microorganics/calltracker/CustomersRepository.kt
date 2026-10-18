package com.microorganics.calltracker

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
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
    data class Failed(val message: String) : SendOutcome
}

internal fun isAccessLost(error: Exception) = error is NotConnected || (error is ApiFailure && error.status == 401)

/** Short, data-free text for the UI. Server bodies and customer values never appear in it. */
internal fun customersFailureMessage(error: Exception): String = when {
    error is NotConnected && error.revoked -> "Access for this phone was revoked. Contact your manager."
    error is ServerNotSet -> "No server is set. Add one in Advanced."
    error is NotConnected -> "Set up this phone on the Home tab first."
    error is ApiFailure && error.status == 401 -> "Access for this phone was revoked. Contact your manager."
    error is ApiFailure && error.status == 404 -> "This customer is not assigned to you any more."
    error is ApiFailure && (error.status == 429 || error.status >= 500) -> "Linekeep is busy right now. Try again in a moment."
    error is ApiFailure -> "Linekeep could not complete this (HTTP ${error.status})."
    error is IOException -> "Can't reach Linekeep. Check your connection and try again."
    else -> "Something went wrong. Try again."
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

    /** Adds a just-sent item at the newest end, replacing any copy with the same id. */
    fun prepend(item: T) {
        mutable.update { current -> current.copy(items = listOf(item) + current.items.filter { id(it) != id(item) }) }
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

    val customers = PagedList<Customer>({ it.id }) { query, cursor ->
        enrollments.authorized { api.customers(it, query, cursor) }
    }
    val chats = PagedList<ChatSummary>({ it.customerId }) { query, cursor ->
        enrollments.authorized { api.chats(it, query, cursor) }
    }
    val messages = PagedList<WhatsAppMessage>({ it.id }) { _, cursor ->
        val customerId = selectedId ?: throw CancellationException("No conversation is open")
        enrollments.authorized { api.customerMessages(it, customerId, cursor) }
    }

    private val mutableCustomer = MutableStateFlow<Customer?>(null)
    /** Facts for the open conversation; null until loaded. */
    val selectedCustomer: StateFlow<Customer?> = mutableCustomer.asStateFlow()

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
        closeConversation()
    }

    /** Loads lazily: a tab first opened (or re-queried) fetches; revisiting with the same query reuses memory. */
    suspend fun openCustomers(query: String) {
        resetIfOwnerChanged()
        if (query.trim() != customers.state.value.query) customers.search(query) else customers.ensureLoaded()
    }

    suspend fun openChats(query: String) {
        resetIfOwnerChanged()
        if (query.trim() != chats.state.value.query) chats.search(query) else chats.ensureLoaded()
    }

    suspend fun openConversation(customerId: String, known: Customer?) {
        resetIfOwnerChanged()
        if (selectedId == customerId && messages.state.value.loaded) return
        if (selectedId != customerId) {
            selectedId = customerId
            pending = null
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

    fun closeConversation() {
        selectedId = null
        pending = null
        messages.clear()
        mutableCustomer.value = null
        mutableAvailability.value = SendAvailability.CHECKING
    }

    suspend fun refreshConversation() {
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
     * Sends one message. The same text to the same customer reuses its client id after a failure, so a retry
     * cannot create a duplicate once a transport exists. The caller keeps the typed text unless [SendOutcome.Sent].
     */
    suspend fun send(text: String): SendOutcome {
        val customerId = selectedId ?: return SendOutcome.Failed("Open a conversation first.")
        val body = text.trim()
        if (body.isEmpty()) return SendOutcome.Failed("Type a message first.")
        if (body.length > MAX_MESSAGE_CHARACTERS) return SendOutcome.Failed("Messages can be up to $MAX_MESSAGE_CHARACTERS characters.")
        when (mutableAvailability.value) {
            SendAvailability.AVAILABLE -> Unit
            SendAvailability.UNAVAILABLE -> return SendOutcome.NotConfigured
            SendAvailability.CHECKING -> return SendOutcome.Failed("Checking whether sending is available. Try again shortly.")
            SendAvailability.UNREACHABLE -> return SendOutcome.Failed("Could not check whether sending is available. Check your connection and try again.")
        }
        if (!mutableSending.compareAndSet(false, true)) return SendOutcome.Failed("A message is already being sent.")
        val clientId = pending?.takeIf { it.first == customerId && it.second == body }?.third ?: UUID.randomUUID().toString()
        pending = Triple(customerId, body, clientId)
        try {
            val sent = enrollments.authorized { api.sendMessage(it, customerId, clientId, body) }
            pending = null
            if (selectedId == customerId) {
                if (sent != null) messages.prepend(sent) else messages.refresh()
            }
            return SendOutcome.Sent
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (error is ApiFailure && error.status == 503 && error.code == WHATSAPP_NOT_CONFIGURED) {
                mutableAvailability.value = SendAvailability.UNAVAILABLE
                return SendOutcome.NotConfigured
            }
            return SendOutcome.Failed(customersFailureMessage(error))
        } finally {
            mutableSending.value = false
        }
    }
}
