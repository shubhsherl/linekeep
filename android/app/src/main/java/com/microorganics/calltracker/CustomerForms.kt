package com.microorganics.calltracker

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** Name and notes are editable, the phone number is shown read-only with a lock. */
@Composable
internal fun CustomerDetailsScreen(
    customers: CustomersRepository,
    scope: CoroutineScope,
    customer: Customer?,
    phone: String,
    onBack: () -> Unit,
    reload: () -> Unit,
    dial: () -> Unit,
) {
    var name by remember(customer?.id) { mutableStateOf(customer?.name.orEmpty()) }
    var notes by remember(customer?.id) { mutableStateOf(customer?.notes.orEmpty()) }
    var saving by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var failed by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        ScreenTopBar("Customer details", onBack) { IconAction(R.drawable.ic_refresh, "Refresh details", reload) }
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (customer == null) {
                SupportingText("Loading customer details…")
            } else {
                OutlinedTextField(
                    value = name, onValueChange = { name = it.take(200); message = null }, modifier = Modifier.fillMaxWidth(),
                    label = { Text("Name") }, singleLine = true, enabled = !saving,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words),
                )
                OutlinedTextField(
                    value = phone.ifEmpty { customer.phone }, onValueChange = {}, modifier = Modifier.fillMaxWidth(),
                    label = { Text("Phone") }, singleLine = true, readOnly = true,
                    trailingIcon = { Icon(painterResource(R.drawable.ic_chat_lock), contentDescription = "Locked", modifier = Modifier.size(20.dp)) },
                    supportingText = { Text("The phone number can't be changed. Ask your manager if it is wrong.") },
                )
                OutlinedTextField(
                    value = notes, onValueChange = { notes = it.take(4000); message = null }, modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp),
                    label = { Text("Notes") }, enabled = !saving, minLines = 3, maxLines = 8,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                )
                message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary) }
                val changed = patchCustomerBody(customer, name, notes) != null
                Button(
                    onClick = {
                        scope.launch {
                            saving = true
                            message = null
                            try {
                                val result = customers.updateCustomer(customer, name, notes)
                                failed = result.isFailure
                                message = result.fold({ "Saved." }, { it.message ?: "Could not save." })
                            } catch (error: Exception) {
                                if (error is CancellationException) throw error
                                failed = true
                                message = customersFailureMessage(error)
                            } finally {
                                saving = false
                            }
                        }
                    },
                    enabled = changed && name.isNotBlank() && !saving,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) {
                    if (saving) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                    Text(if (saving) "Saving…" else "Save changes", Modifier.padding(start = if (saving) 8.dp else 0.dp))
                }
                OutlinedButton(onClick = dial, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Dial ${customer.phone}") }
                customer.email?.let { DetailField("Email", it) }
                customer.source?.let { DetailField("Source", it) }
                customer.district?.let { DetailField("District", it) }
                customer.state?.let { DetailField("State", it) }
                customer.country?.let { DetailField("Country", it) }
                if (customer.employees.isNotEmpty()) {
                    DetailField("Handled by", customer.employees.joinToString(", ") { it.name.ifEmpty { "Employee" } })
                }
            }
        }
    }
}

/** Add-customer form. Checks the number against the server first; [open] shows the conversation of a created or existing customer. */
@Composable
internal fun AddCustomerScreen(
    customers: CustomersRepository,
    scope: CoroutineScope,
    onBack: () -> Unit,
    open: (id: String, name: String, phone: String, message: String) -> Unit,
) {
    var name by rememberSaveable { mutableStateOf("") }
    var phone by rememberSaveable { mutableStateOf("") }
    var notes by rememberSaveable { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val normalized = normalizePhone(phone)
    Column(Modifier.fillMaxSize()) {
        ScreenTopBar("Add customer", onBack)
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            OutlinedTextField(
                value = name, onValueChange = { name = it.take(200); error = null }, modifier = Modifier.fillMaxWidth(),
                label = { Text("Name") }, singleLine = true, enabled = !saving,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words),
            )
            OutlinedTextField(
                value = phone, onValueChange = { phone = it.filter { c -> c.isDigit() || c in "+ -()" }.take(32); error = null }, modifier = Modifier.fillMaxWidth(),
                label = { Text("Phone number") }, singleLine = true, enabled = !saving,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                isError = phone.isNotBlank() && normalized == null,
                supportingText = {
                    Text(
                        when {
                            normalized != null -> "Will be saved as $normalized"
                            phone.isNotBlank() -> "Enter a valid phone number, with country code if it is not an Indian number."
                            else -> "Include the country code. Ten-digit numbers are saved as India (+91)."
                        }
                    )
                },
            )
            OutlinedTextField(
                value = notes, onValueChange = { notes = it.take(4000); error = null }, modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp),
                label = { Text("Notes (optional)") }, enabled = !saving, minLines = 3, maxLines = 8,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            )
            error?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error) }
            SupportingText("The customer is added to your list only. The phone number can't be changed afterwards.")
        }
        androidx.compose.material3.Surface(color = MaterialTheme.colorScheme.background) {
            Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Button(
                    onClick = {
                        error = null
                        scope.launch {
                            saving = true
                            try {
                                when (val outcome = customers.addCustomer(name, phone, notes)) {
                                    is AddCustomerOutcome.Created -> open(outcome.customer.id, outcome.customer.name, outcome.customer.phone, "Customer added.")
                                    is AddCustomerOutcome.Existing -> open(outcome.customerId, outcome.name, outcome.phone, "This number is already in your customers.")
                                    AddCustomerOutcome.OtherHandler -> error = OTHER_HANDLER_MESSAGE
                                    is AddCustomerOutcome.Failed -> error = outcome.message
                                }
                            } finally {
                                saving = false
                            }
                        }
                    },
                    enabled = !saving && validateNewCustomer(name, phone, notes) == null,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) {
                    if (saving) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                    Text(if (saving) "Checking…" else "Add customer", Modifier.padding(start = if (saving) 8.dp else 0.dp))
                }
            }
        }
    }
}
