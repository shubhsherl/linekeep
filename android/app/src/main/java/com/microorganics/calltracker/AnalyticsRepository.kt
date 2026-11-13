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
 * employee from the device credential, so nothing here names an employee unless the profile says this is a manager, who
 * may narrow to people in their scope (never anything else: [profile] gates every parameter). Dropped when a different
 * employee signs in.
 */
internal class AnalyticsRepository(
    private val enrollments: EnrollmentRepository,
    private val profile: () -> EmployeeProfile? = { null },
    private val clock: () -> Instant = Instant::now,
) {
    private val api = AnalyticsApi(enrollments::serverUrl)

    @Volatile private var ownerId: String? = null
    private val generation = AtomicInteger()
    @Volatile private var loadedRange: DateRange? = null
    @Volatile private var loadedSignature: String? = null
    @Volatile private var seenSignature: String? = null

    private val mutableEmployees = MutableStateFlow<Set<String>>(emptySet())
    /** A manager's chosen employees for analytics; empty means the whole scope. */
    val employees: StateFlow<Set<String>> = mutableEmployees.asStateFlow()

    private val mutableCallsScope = MutableStateFlow<ScopeFilter>(ScopeFilter.All)
    /** A manager's filter of the call log; [ScopeFilter.All] for anyone else. */
    val callLogsScope: StateFlow<ScopeFilter> = mutableCallsScope.asStateFlow()

    private val mutableAnalytics = MutableStateFlow(AnalyticsState())
    val analytics: StateFlow<AnalyticsState> = mutableAnalytics.asStateFlow()

    private val mutableFilter = MutableStateFlow(CallTypeFilter.ALL)
    val filter: StateFlow<CallTypeFilter> = mutableFilter.asStateFlow()

    val callLogs = PagedList<CallLogItem>({ it.id }) { query, cursor ->
        val type = mutableFilter.value.apiValue
        val term = query?.let(::phoneSearchTerm)
        val employee = scopeParam(mutableCallsScope.value, profile())
        enrollments.authorized { api.callHistory(it, term, type, cursor, employee) }
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
                mutableEmployees.value = emptySet()
                mutableCallsScope.value = ScopeFilter.All
                loadedSignature = null
                seenSignature = null
                callLogs.clear()
            }
            ownerId = current
        }
    }

    /**
     * Notices a changed role or team (an administrator's change reaches the app through the profile): choices that no longer
     * apply are dropped, and a call log that was a manager's is fetched again. Analytics reload through [loadedSignature].
     */
    private fun syncScope() {
        val current = profile()
        val signature = scopeSignature(current)
        val previous = seenSignature
        if (signature == previous) return
        seenSignature = signature
        mutableEmployees.value = if (current.isManagerProfile()) {
            val members = scopeMembers(current).mapTo(HashSet()) { it.id }
            mutableEmployees.value.filterTo(LinkedHashSet()) { it in members }
        } else emptySet()
        mutableCallsScope.value = normalizeFilter(mutableCallsScope.value, current)
        if (previous != null && previous != "employee") callLogs.clear()
    }

    /** Loads on first use, and again when the selection now means a different range (a new day for "Today"). */
    suspend fun openAnalytics() {
        resetIfOwnerChanged()
        syncScope()
        val state = mutableAnalytics.value
        if (state.loading) return
        if (state.data == null || loadedRange != state.selection.resolve(today()) || loadedSignature != seenSignature) refreshAnalytics()
    }

    /** Manager only: which employees the analytics cover; an empty set is the whole scope. */
    suspend fun selectEmployees(ids: Set<String>) {
        resetIfOwnerChanged()
        syncScope()
        val valid = analyticsEmployeeIds(ids, profile())?.split(',')?.toSet().orEmpty()
        if (valid == mutableEmployees.value) return
        mutableEmployees.value = valid
        refreshAnalytics()
    }

    suspend fun select(selection: RangeSelection) {
        resetIfOwnerChanged()
        mutableAnalytics.update { it.copy(selection = selection) }
        refreshAnalytics()
    }

    suspend fun refreshAnalytics() {
        resetIfOwnerChanged()
        syncScope()
        val mine = generation.incrementAndGet()
        val range = mutableAnalytics.value.selection.resolve(today())
        val viewer = profile()
        val signature = seenSignature
        val employeeIds = analyticsEmployeeIds(mutableEmployees.value, viewer)
        mutableAnalytics.update { it.copy(loading = true, error = null) }
        try {
            val result = enrollments.authorized { api.analytics(it, range, employeeIds, byEmployee = viewer.isManagerProfile()) }
            if (mine != generation.get()) return
            loadedRange = range
            loadedSignature = signature
            mutableAnalytics.update { it.copy(loading = false, data = result, error = null) }
            // The profile (role, team) arrived or changed while this was loading: fetch again with the right parameters.
            if (scopeSignature(profile()) != signature) refreshAnalytics()
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
        syncScope()
        if (query.trim() != callLogs.state.value.query) callLogs.search(query) else callLogs.ensureLoaded()
    }

    suspend fun setCallLogsScope(filter: ScopeFilter) {
        resetIfOwnerChanged()
        syncScope()
        val next = normalizeFilter(filter, profile())
        if (mutableCallsScope.value == next) return
        mutableCallsScope.value = next
        callLogs.refresh()
    }

    suspend fun setFilter(filter: CallTypeFilter) {
        resetIfOwnerChanged()
        if (mutableFilter.value == filter) return
        mutableFilter.value = filter
        callLogs.refresh()
    }
}
