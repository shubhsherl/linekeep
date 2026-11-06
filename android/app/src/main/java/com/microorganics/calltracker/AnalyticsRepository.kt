package com.microorganics.calltracker

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.time.Instant
import java.time.LocalDate
import java.util.concurrent.atomic.AtomicInteger

/** Short, data-free text for the analytics UI. */
internal fun analyticsFailureMessage(error: Exception): String = when {
    error is ApiFailure && error.status == 404 -> "Call analytics are not available on this server yet."
    else -> customersFailureMessage(error)
}

/**
 * The signed-in employee's own call analytics and call history, held in memory only. The server forces the
 * employee from the device credential, so nothing here names an employee. Dropped when a different employee signs in.
 */
internal class AnalyticsRepository(
    private val enrollments: EnrollmentRepository,
    private val clock: () -> Instant = Instant::now,
) {
    private val api = AnalyticsApi(enrollments::serverUrl)

    @Volatile private var ownerId: String? = null
    private val generation = AtomicInteger()
    @Volatile private var loadedRange: DateRange? = null

    private val mutableAnalytics = MutableStateFlow(AnalyticsState())
    val analytics: StateFlow<AnalyticsState> = mutableAnalytics.asStateFlow()

    private val mutableFilter = MutableStateFlow(CallTypeFilter.ALL)
    val filter: StateFlow<CallTypeFilter> = mutableFilter.asStateFlow()

    val callLogs = PagedList<CallLogItem>({ it.id }) { query, cursor ->
        val type = mutableFilter.value.apiValue
        val term = query?.let(::phoneSearchTerm)
        enrollments.authorized { api.callHistory(it, term, type, cursor) }
    }

    fun today(): LocalDate = istToday(clock())

    private fun resetIfOwnerChanged() {
        val current = enrollments.status.value.employeeId.ifEmpty { null }
        if (ownerId != current) {
            if (ownerId != null) {
                generation.incrementAndGet()
                mutableAnalytics.value = AnalyticsState()
                loadedRange = null
                mutableFilter.value = CallTypeFilter.ALL
                callLogs.clear()
            }
            ownerId = current
        }
    }

    /** Loads on first use, and again when the selection now means a different range (a new day for "Today"). */
    suspend fun openAnalytics() {
        resetIfOwnerChanged()
        val state = mutableAnalytics.value
        if (state.loading) return
        if (state.data == null || loadedRange != state.selection.resolve(today())) refreshAnalytics()
    }

    suspend fun select(selection: RangeSelection) {
        resetIfOwnerChanged()
        mutableAnalytics.update { it.copy(selection = selection) }
        refreshAnalytics()
    }

    suspend fun refreshAnalytics() {
        resetIfOwnerChanged()
        val mine = generation.incrementAndGet()
        val range = mutableAnalytics.value.selection.resolve(today())
        mutableAnalytics.update { it.copy(loading = true, error = null) }
        try {
            val result = enrollments.authorized { api.analytics(it, range) }
            if (mine != generation.get()) return
            loadedRange = range
            mutableAnalytics.update { it.copy(loading = false, data = result, error = null) }
        } catch (error: Exception) {
            if (mine != generation.get()) {
                if (error is CancellationException) throw error
                return
            }
            if (error is CancellationException) {
                mutableAnalytics.update { it.copy(loading = false) }
                throw error
            }
            mutableAnalytics.update {
                it.copy(loading = false, error = analyticsFailureMessage(error), data = if (isAccessLost(error)) null else it.data)
            }
        }
    }

    suspend fun openCallLogs(query: String) {
        resetIfOwnerChanged()
        if (query.trim() != callLogs.state.value.query) callLogs.search(query) else callLogs.ensureLoaded()
    }

    suspend fun setFilter(filter: CallTypeFilter) {
        resetIfOwnerChanged()
        if (mutableFilter.value == filter) return
        mutableFilter.value = filter
        callLogs.refresh()
    }
}
