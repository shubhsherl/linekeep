package com.microorganics.calltracker

import org.json.JSONArray
import org.json.JSONObject

// Pure logic for the manager level: role gating, the scope filter sent to the server, hand-over sets and wire shapes.
// A manager sees themselves plus the employees who report to them; the server enforces that scope, this file only
// decides which parameters to send and what to show. A missing or unknown role means "employee".

internal const val ROLE_MANAGER = "manager"

/** An active report of a manager, as listed in the profile. */
internal data class TeamMember(val id: String, val name: String, val phoneNumber: String?)

internal fun parseTeam(array: JSONArray?): List<TeamMember> {
    array ?: return emptyList()
    val seen = HashSet<String>()
    return (0 until array.length()).mapNotNull { index ->
        val item = array.optJSONObject(index) ?: return@mapNotNull null
        val id = item.optionalString("id") ?: return@mapNotNull null
        if (!seen.add(id)) return@mapNotNull null
        TeamMember(id, item.optionalString("name").orEmpty(), item.optionalString("phoneNumber"))
    }
}

/** True only for a loaded profile whose role is exactly `manager`; anything else behaves as before. */
internal fun EmployeeProfile?.isManagerProfile(): Boolean = this != null && role == ROLE_MANAGER

/** The profile when it belongs to a manager, otherwise null; the UI shows manager features only for a non-null result. */
internal fun EmployeeProfile?.asManager(): EmployeeProfile? = this?.takeIf { it.role == ROLE_MANAGER }

/** Changes whenever what the manager may see changes (role or team members); used to drop stale lists and filters. */
internal fun scopeSignature(profile: EmployeeProfile?): String =
    profile.asManager()?.let { "manager:" + it.team.map { member -> member.id }.sorted().joinToString(",") } ?: "employee"

/** The manager and the active reports, the manager first. Empty for anyone else. */
internal fun scopeMembers(profile: EmployeeProfile?): List<TeamMember> {
    val manager = profile.asManager() ?: return emptyList()
    return listOf(TeamMember(manager.id, manager.name, manager.phoneNumber)) + manager.team.filter { it.id != manager.id }
}

/** The list filter of a manager. [Member] narrows to one person of the scope. */
internal sealed interface ScopeFilter {
    data object All : ScopeFilter
    data object Mine : ScopeFilter
    data object Team : ScopeFilter
    data class Member(val id: String) : ScopeFilter
}

/**
 * The `employeeId` query value for customers, chats and call history: absent for everyone but a manager, and absent for
 * [ScopeFilter.All] and for a member who is no longer in the scope (the server would refuse the id).
 */
internal fun scopeParam(filter: ScopeFilter, profile: EmployeeProfile?): String? {
    val manager = profile.asManager() ?: return null
    return when (filter) {
        ScopeFilter.All -> null
        ScopeFilter.Mine -> "me"
        ScopeFilter.Team -> if (manager.team.isEmpty()) null else "team"
        is ScopeFilter.Member -> when {
            filter.id == manager.id -> "me"
            manager.team.any { it.id == filter.id } -> filter.id
            else -> null
        }
    }
}

/** A filter that still means something for [profile]; otherwise [ScopeFilter.All]. */
internal fun normalizeFilter(filter: ScopeFilter, profile: EmployeeProfile?): ScopeFilter {
    val manager = profile.asManager() ?: return ScopeFilter.All
    return when {
        filter is ScopeFilter.Member && filter.id != manager.id && manager.team.none { it.id == filter.id } -> ScopeFilter.All
        filter == ScopeFilter.Team && manager.team.isEmpty() -> ScopeFilter.All
        else -> filter
    }
}

/** Short label of the filter for the member chip and screen readers. */
internal fun scopeFilterLabel(filter: ScopeFilter, profile: EmployeeProfile?): String = when (filter) {
    ScopeFilter.All -> "All"
    ScopeFilter.Mine -> "Mine"
    ScopeFilter.Team -> "Team"
    is ScopeFilter.Member -> profile?.team?.firstOrNull { it.id == filter.id }?.name?.ifEmpty { null } ?: "Employee"
}

/**
 * The `employeeIds` query value of analytics: the chosen ids that are in the scope, sorted; null (the whole scope) when
 * nothing valid is chosen, the whole scope is chosen, or [profile] is not a manager.
 */
internal fun analyticsEmployeeIds(selected: Set<String>, profile: EmployeeProfile?): String? {
    if (profile.asManager() == null) return null
    val members = scopeMembers(profile).map { it.id }.toSet()
    val valid = selected.filter { it in members }.toSet()
    if (valid.isEmpty() || valid == members) return null
    return valid.sorted().joinToString(",")
}

/** What the analytics chips show for a selection. [CUSTOM] is any other combination. */
internal enum class AnalyticsChip { ALL, MINE, TEAM, CUSTOM }

internal fun analyticsChip(selected: Set<String>, profile: EmployeeProfile?): AnalyticsChip {
    val ids = analyticsEmployeeIds(selected, profile) ?: return AnalyticsChip.ALL
    val chosen = ids.split(',').toSet()
    val own = profile?.id
    return when {
        chosen == setOf(own) -> AnalyticsChip.MINE
        profile != null && profile.team.isNotEmpty() && chosen == profile.team.map { it.id }.toSet() -> AnalyticsChip.TEAM
        else -> AnalyticsChip.CUSTOM
    }
}

/** Selection set for a chip. [AnalyticsChip.CUSTOM] keeps whatever [current] is. */
internal fun analyticsSelectionFor(chip: AnalyticsChip, profile: EmployeeProfile?, current: Set<String>): Set<String> = when (chip) {
    AnalyticsChip.ALL -> emptySet()
    AnalyticsChip.MINE -> profile?.id?.let { setOf(it) } ?: emptySet()
    AnalyticsChip.TEAM -> profile?.team?.map { it.id }?.toSet().orEmpty()
    AnalyticsChip.CUSTOM -> current
}

// ---- Customers: scope marker and handler names --------------------------------------------------------------------------

/** "Team" when the manager is not a handler. Uses the server's `scope` when present, else the handlers; unknown stays false. */
internal fun isTeamCustomer(scope: String?, employees: List<EmployeeRef>, viewerId: String?): Boolean = when (scope) {
    "team" -> true
    "own" -> false
    else -> viewerId != null && employees.isNotEmpty() && employees.none { it.id == viewerId }
}

internal fun handlerNames(employees: List<EmployeeRef>, viewerId: String?): String =
    employees.joinToString(", ") { if (it.id == viewerId) "You" else it.name.ifEmpty { "Employee" } }

/** The `scope` of a customer after its handlers changed locally: own when the viewer handles it, team otherwise. */
internal fun scopeAfterHandlersChanged(employees: List<EmployeeRef>, profile: EmployeeProfile?): String? {
    val manager = profile.asManager() ?: return null
    val members = scopeMembers(manager).map { it.id }.toSet()
    return when {
        employees.any { it.id == manager.id } -> "own"
        employees.any { it.id in members } -> "team"
        else -> null
    }
}

/** The `employeeId` a manager's add-customer form sends: a team member other than oneself; null for everyone else. */
internal fun assigneeToSend(selected: String?, profile: EmployeeProfile?): String? {
    val manager = profile.asManager() ?: return null
    return selected?.takeIf { it != manager.id && manager.team.any { member -> member.id == it } }
}

/** What the form says when the number already belongs to someone in the manager's scope (or to the employee). */
internal fun existingCustomerMessage(handlers: List<EmployeeRef>, viewerId: String?): String =
    if (handlers.isEmpty() || (handlers.size == 1 && handlers[0].id == viewerId)) "This number is already in your customers."
    else "This number is already a customer of ${handlerNames(handlers, viewerId)}."

// ---- Hand over -----------------------------------------------------------------------------------------------------------

/** Who can be ticked in the hand-over dialog: the manager first, then the team. Empty for non-managers. */
internal fun handoverCandidates(profile: EmployeeProfile?): List<TeamMember> = scopeMembers(profile)

/** Current handlers who are not in the manager's scope; the server keeps them whatever is sent. */
internal fun outsideHandlers(current: List<EmployeeRef>, candidates: List<TeamMember>): List<EmployeeRef> {
    val ids = candidates.mapTo(HashSet()) { it.id }
    return current.filter { it.id !in ids }
}

/** Candidates who handle the customer now: the dialog's starting ticks. */
internal fun initialHandoverSelection(current: List<EmployeeRef>, candidates: List<TeamMember>): Set<String> {
    val handlers = current.mapTo(HashSet()) { it.id }
    return candidates.filter { it.id in handlers }.mapTo(LinkedHashSet()) { it.id }
}

/**
 * The `employeeIds` sent to `PUT .../handlers`: only in-scope ids, in candidate order. Handlers outside the scope are
 * never sent; the server preserves them.
 */
internal fun handoverRequestIds(selected: Set<String>, candidates: List<TeamMember>): List<String> =
    candidates.map { it.id }.filter { it in selected }

/** Null when the selection may be saved; otherwise a short explanation. An empty selection is fine only if outside handlers remain. */
internal fun handoverProblem(selected: Set<String>, current: List<EmployeeRef>, candidates: List<TeamMember>): String? {
    val ids = handoverRequestIds(selected, candidates)
    if (ids.isEmpty() && outsideHandlers(current, candidates).isEmpty()) return "Choose at least one person."
    return null
}

internal fun handoverChanged(selected: Set<String>, current: List<EmployeeRef>, candidates: List<TeamMember>): Boolean =
    handoverRequestIds(selected, candidates).toSet() != initialHandoverSelection(current, candidates)

internal fun handoverBody(employeeIds: List<String>): JSONObject = JSONObject().put("employeeIds", JSONArray(employeeIds))

// ---- Placeholders for a team customer ------------------------------------------------------------------------------------

/**
 * Name and phone for {{handler_*}}. A manager looking at a customer uses that customer's first in-scope handler: the manager
 * with their usual number resolution, or a report with the number from the team list (empty if none is configured).
 * Everyone else, and a customer whose handlers are unknown or outside the scope, resolves to this employee as before.
 */
internal fun resolveHandlerIdentity(
    profile: EmployeeProfile?,
    enrolledName: String,
    simNumbers: List<String>,
    customerEmployees: List<EmployeeRef>,
): Pair<String, String> {
    val own = resolveHandlerName(profile, enrolledName) to resolveHandlerPhone(profile, simNumbers)
    val manager = profile.asManager() ?: return own
    val members = scopeMembers(manager).associateBy { it.id }
    val handler = customerEmployees.firstNotNullOfOrNull { members[it.id] } ?: return own
    if (handler.id == manager.id) return own
    return handler.name.trim() to handler.phoneNumber?.trim().orEmpty()
}
