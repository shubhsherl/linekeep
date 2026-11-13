package com.microorganics.calltracker

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

// Manager-only widgets. Each one renders nothing unless the profile says the signed-in employee is a manager with a team.

private fun TeamMember.display(selfId: String?) = if (id == selfId) "You" else name.ifEmpty { "Employee" }

/** All / Mine / Team chips and a person menu for the lists. Hidden for non-managers and managers without reports. */
@Composable
internal fun ScopeFilterBar(profile: EmployeeProfile?, filter: ScopeFilter, onChange: (ScopeFilter) -> Unit, modifier: Modifier = Modifier) {
    val manager = profile.asManager() ?: return
    if (manager.team.isEmpty()) return
    var menuOpen by remember { mutableStateOf(false) }
    Row(modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf(ScopeFilter.All, ScopeFilter.Mine, ScopeFilter.Team).forEach { option ->
            FilterChip(
                selected = filter == option, onClick = { onChange(option) },
                label = { Text(scopeFilterLabel(option, manager)) }, modifier = Modifier.heightIn(min = 48.dp),
            )
        }
        Box {
            FilterChip(
                selected = filter is ScopeFilter.Member, onClick = { menuOpen = true },
                label = { Text(if (filter is ScopeFilter.Member) scopeFilterLabel(filter, manager) else "Person…") },
                modifier = Modifier.heightIn(min = 48.dp),
            )
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                manager.team.forEach { member ->
                    DropdownMenuItem(text = { Text(member.name.ifEmpty { "Employee" }) }, onClick = { menuOpen = false; onChange(ScopeFilter.Member(member.id)) })
                }
            }
        }
    }
}

/** Small "Team" marker for customers and chats the manager does not handle personally. */
@Composable
internal fun TeamTag() {
    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.secondaryContainer) {
        Text(
            "Team", Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSecondaryContainer, maxLines = 1,
        )
    }
}

/** "Assign to" menu of the add-customer form: yourself (default) or a team member. */
@Composable
internal fun AssignToPicker(profile: EmployeeProfile?, selectedId: String?, enabled: Boolean, onSelect: (String?) -> Unit) {
    val manager = profile.asManager() ?: return
    if (manager.team.isEmpty()) return
    var open by remember { mutableStateOf(false) }
    val current = manager.team.firstOrNull { it.id == selectedId }
    Box {
        OutlinedButton(onClick = { open = true }, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text("Assign to · " + (current?.name?.ifEmpty { "Employee" } ?: "Me"))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text("Me") }, onClick = { open = false; onSelect(null) })
            manager.team.forEach { member ->
                DropdownMenuItem(text = { Text(member.name.ifEmpty { "Employee" }) }, onClick = { open = false; onSelect(member.id) })
            }
        }
    }
}

@Composable
private fun MemberCheckbox(label: String, checked: Boolean, enabled: Boolean, onToggle: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(value = checked, enabled = enabled, role = Role.Checkbox, onValueChange = onToggle),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
        Text(label, style = MaterialTheme.typography.bodyLarge)
    }
}

/**
 * Hand a customer over: the manager and each report as checkboxes, the current in-scope handlers ticked. Handlers outside
 * the team are listed as staying on the customer. [onConfirm] gets only in-scope ids; the owner shows [busy] and [error].
 */
@Composable
internal fun HandoverDialog(
    customer: Customer,
    profile: EmployeeProfile?,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onConfirm: (List<String>) -> Unit,
) {
    val manager = profile.asManager() ?: return
    val candidates = remember(manager) { handoverCandidates(manager) }
    // Saved as a list so ticks survive rotation.
    var selectedIds by rememberSaveable(customer.id) { mutableStateOf(initialHandoverSelection(customer.employees, candidates).toList()) }
    val selected = selectedIds.toSet()
    val outside = outsideHandlers(customer.employees, candidates)
    val problem = handoverProblem(selected, customer.employees, candidates)
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Hand over customer") },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Choose who handles ${customer.name}.", style = MaterialTheme.typography.bodyMedium)
                candidates.forEach { member ->
                    MemberCheckbox(member.display(manager.id), member.id in selected, !busy) { on ->
                        selectedIds = (if (on) selected + member.id else selected - member.id).toList()
                    }
                }
                if (outside.isNotEmpty()) {
                    SupportingText("Handlers outside your team stay: " + outside.joinToString(", ") { it.name.ifEmpty { "Employee" } } + ".")
                } else {
                    SupportingText("Only you and your team are listed. Everyone ticked will see this customer.")
                }
                error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                if (error == null && problem != null) Text(problem, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(handoverRequestIds(selected, candidates)) },
                enabled = !busy && problem == null && handoverChanged(selected, customer.employees, candidates),
            ) {
                if (busy) CircularProgressIndicator(Modifier.padding(end = 8.dp), strokeWidth = 2.dp)
                Text(if (busy) "Saving…" else "Hand over")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel") } },
    )
}

/** Analytics scope: All / Mine / Team chips and a multi-select for any other combination. */
@Composable
internal fun AnalyticsScopeBar(profile: EmployeeProfile?, selected: Set<String>, onChange: (Set<String>) -> Unit) {
    val manager = profile.asManager() ?: return
    if (manager.team.isEmpty()) return
    var choosing by rememberSaveable { mutableStateOf(false) }
    val chip = analyticsChip(selected, manager)
    if (choosing) EmployeeSelectDialog(manager, selected, onDismiss = { choosing = false }, onApply = { choosing = false; onChange(it) })
    Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf(AnalyticsChip.ALL to "All", AnalyticsChip.MINE to "Mine", AnalyticsChip.TEAM to "Team").forEach { (option, label) ->
            FilterChip(
                selected = chip == option, onClick = { onChange(analyticsSelectionFor(option, manager, selected)) },
                label = { Text(label) }, modifier = Modifier.heightIn(min = 48.dp),
            )
        }
        FilterChip(
            selected = chip == AnalyticsChip.CUSTOM, onClick = { choosing = true },
            label = { Text("Choose…") }, modifier = Modifier.heightIn(min = 48.dp),
        )
    }
}

@Composable
private fun EmployeeSelectDialog(manager: EmployeeProfile, selected: Set<String>, onDismiss: () -> Unit, onApply: (Set<String>) -> Unit) {
    val members = remember(manager) { scopeMembers(manager) }
    var pickedIds by rememberSaveable { mutableStateOf((if (selected.isEmpty()) members.map { it.id }.toSet() else selected).toList()) }
    val picked = pickedIds.toSet()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Choose employees") },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                members.forEach { member ->
                    MemberCheckbox(member.display(manager.id), member.id in picked, true) { on -> pickedIds = (if (on) picked + member.id else picked - member.id).toList() }
                }
            }
        },
        confirmButton = { TextButton(onClick = { onApply(picked) }, enabled = picked.isNotEmpty()) { Text("Show") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
