package com.microorganics.calltracker

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

private sealed interface TemplatesState {
    data object Loading : TemplatesState
    data class Failed(val message: String) : TemplatesState
    data class Ready(val items: List<MessageTemplate>) : TemplatesState
}

/** Full-screen template chooser and sender. [onBack] leaves it; [onSent] is called after a template was sent. */
@Composable
internal fun TemplatePickerScreen(
    customers: CustomersRepository,
    scope: CoroutineScope,
    customerName: String,
    onBack: () -> Unit,
    onSent: () -> Unit,
) {
    var attempt by remember { mutableStateOf(0) }
    var state by remember { mutableStateOf<TemplatesState>(TemplatesState.Loading) }
    var selected by remember { mutableStateOf<MessageTemplate?>(null) }
    val profile by customers.profile.collectAsStateWithLifecycle()
    val customer by customers.selectedCustomer.collectAsStateWithLifecycle()
    val fill = remember(customerName, profile, customer) { customers.handlerContext(customerName, customer) }
    LaunchedEffect(attempt) {
        state = TemplatesState.Loading
        // Variable values are filled from the profile, so it is known before the list and forms appear.
        customers.ensureProfile()
        state = try {
            TemplatesState.Ready(customers.templates(force = attempt > 0))
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            TemplatesState.Failed(
                if (error is ApiFailure && error.status == 503) "Templates are not set up yet. Ask your manager." else customersFailureMessage(error)
            )
        }
    }
    BackHandler(enabled = selected != null) { selected = null }
    Column(Modifier.fillMaxSize()) {
        ScreenTopBar(selected?.name ?: "Send a template", onBack = { if (selected != null) selected = null else onBack() }) {
            if (selected == null) IconAction(R.drawable.ic_refresh, "Refresh templates", { attempt++ })
        }
        val chosen = selected
        if (chosen != null) {
            TemplateForm(chosen, fill, customers, scope, onSent)
        } else {
            when (val current = state) {
                TemplatesState.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                is TemplatesState.Failed -> Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(current.message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                    OutlinedButton(onClick = { attempt++ }) { Text("Try again") }
                }
                is TemplatesState.Ready -> if (current.items.isEmpty()) {
                    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) { SupportingText("No approved templates are available yet. Ask your manager.") }
                } else {
                    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        items(current.items, key = { it.key }) { template -> TemplateCard(template, fill) { selected = template } }
                    }
                }
            }
        }
    }
}

@Composable
private fun TemplateCard(template: MessageTemplate, fill: FillContext, onClick: () -> Unit) {
    val preview = remember(template, fill) { renderTemplate(template, initialTemplateValues(template, fill)) }
    Surface(
        onClick = onClick, enabled = template.sendable, modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surface, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(
            Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            val dim = if (template.sendable) 1f else 0.55f
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    template.name, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = dim), maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                if (template.needsHeaderImage) Icon(painterResource(R.drawable.ic_chat_image), contentDescription = "Has an image header", modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = dim))
            }
            Text(
                listOf(template.category, template.language).filter { it.isNotEmpty() }.joinToString(" · "),
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = dim),
            )
            Text(preview, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface.copy(alpha = dim), maxLines = 3, overflow = TextOverflow.Ellipsis)
            if (!template.sendable) {
                Text(template.reason ?: "This template can't be sent from the app yet.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

@Composable
private fun TemplateForm(template: MessageTemplate, fill: FillContext, customers: CustomersRepository, scope: CoroutineScope, onSent: () -> Unit) {
    val context = LocalContext.current
    val sources = remember(template.key) { mutableStateListOf<VariableSource>().apply { template.variables.forEachIndexed { index, v -> add(defaultVariableSource(v.key, index)) } } }
    val values = remember(template.key) { mutableStateListOf<String>().apply { addAll(initialTemplateValues(template, fill)) } }
    var headerFile by remember(template.key) { mutableStateOf<PickedAttachment?>(null) }
    var headerUploaded by remember(template.key) { mutableStateOf<UploadedAttachment?>(null) }
    var headerProgress by remember(template.key) { mutableStateOf<Float?>(null) }
    var sending by remember(template.key) { mutableStateOf(false) }
    var error by remember(template.key) { mutableStateOf<String?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) scope.launch {
            when (val result = readPickedAttachment(context, uri)) {
                is PickResult.Picked -> if (result.file.kind == "image") { headerFile = result.file; headerUploaded = null; error = null } else error = "Choose a photo for the header."
                is PickResult.Rejected -> error = result.message
            }
        }
    }
    val problem = templateProblem(template, values.toList(), headerFile != null)
    Column(Modifier.fillMaxSize()) {
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            val colors = chatColors()
            Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp), color = colors.background) {
                Surface(Modifier.padding(12.dp).fillMaxWidth(), shape = RoundedCornerShape(10.dp), color = colors.outgoing, contentColor = colors.text) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (template.needsHeaderImage) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Icon(painterResource(R.drawable.ic_chat_image), contentDescription = null, modifier = Modifier.size(18.dp))
                                Text(headerFile?.fileName ?: if (template.headerImageConfigured) "Default header image" else "No header image yet", style = MaterialTheme.typography.labelMedium)
                            }
                        }
                        Text(renderTemplate(template, values.toList()), style = MaterialTheme.typography.bodyMedium)
                        if (template.buttons.isNotEmpty()) Text(template.buttons.joinToString("  ·  "), style = MaterialTheme.typography.labelMedium, color = colors.meta)
                    }
                }
            }
            if (template.needsHeaderImage) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Header image", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    SupportingText(
                        if (headerFile != null) "This photo is sent instead of the template's default image."
                        else if (template.headerImageConfigured) "The default image for this template is used. You can choose another photo instead."
                        else "This template needs a header image. Choose a photo."
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, enabled = !sending, modifier = Modifier.heightIn(min = 48.dp)) {
                            Text(if (headerFile != null) "Choose another photo" else if (template.headerImageConfigured) "Choose another image" else "Choose image")
                        }
                        if (headerFile != null) TextButton(onClick = { headerFile = null; headerUploaded = null }, enabled = !sending) { Text("Use default") }
                    }
                    headerProgress?.let { LinearProgressIndicator(progress = { it }, modifier = Modifier.fillMaxWidth()) }
                }
            }
            if (template.variables.isEmpty()) {
                SupportingText("This template has no variables.")
            } else {
                template.variables.forEachIndexed { index, variable ->
                    VariableField(
                        key = variable.key, example = variable.example, source = sources[index], value = values[index], enabled = !sending,
                        onSource = { source -> sources[index] = source; if (source != VariableSource.CUSTOM) values[index] = valueFor(source, fill) },
                        onValue = { text -> values[index] = cleanVariable(text).take(1024); sources[index] = VariableSource.CUSTOM },
                    )
                }
            }
            error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        }
        Surface(color = MaterialTheme.colorScheme.background, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
            Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (problem != null) SupportingText(problem)
                Button(
                    onClick = {
                        error = null
                        scope.launch {
                            sending = true
                            try {
                                val file = headerFile
                                val headerId = if (template.needsHeaderImage && file != null) {
                                    headerUploaded?.id ?: run {
                                        headerProgress = 0f
                                        customers.uploadAttachment(file) { headerProgress = it }.also { headerUploaded = it }.id
                                    }
                                } else null
                                headerProgress = null
                                when (val outcome = customers.sendTemplate(template, values.toList(), headerId)) {
                                    SendOutcome.Sent -> onSent()
                                    SendOutcome.NotConfigured -> error = "Sending WhatsApp messages from this app is not set up yet. Ask your manager."
                                    SendOutcome.WindowClosed -> error = "The 24-hour reply window is closed. Send a template to start the conversation again."
                                    is SendOutcome.Failed -> error = outcome.message
                                }
                            } catch (failure: Exception) {
                                if (failure is CancellationException) throw failure
                                error = customersFailureMessage(failure)
                            } finally {
                                headerProgress = null
                                sending = false
                            }
                        }
                    },
                    enabled = problem == null && !sending,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) {
                    if (sending) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                    else Icon(painterResource(R.drawable.ic_chat_send), contentDescription = null, modifier = Modifier.size(20.dp))
                    Text(if (sending) "Sending…" else "Send template", Modifier.padding(start = 8.dp))
                }
            }
        }
    }
}

@Composable
private fun VariableField(key: String, example: String?, source: VariableSource, value: String, enabled: Boolean, onSource: (VariableSource) -> Unit, onValue: (String) -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("{{$key}}", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Box {
                TextButton(onClick = { menu = true }, enabled = enabled, modifier = Modifier.heightIn(min = 48.dp)) { Text("Fill with: ${source.label}") }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    VariableSource.entries.forEach { option ->
                        DropdownMenuItem(text = { Text(option.label) }, onClick = { menu = false; onSource(option) })
                    }
                }
            }
        }
        OutlinedTextField(
            value = value, onValueChange = onValue, modifier = Modifier.fillMaxWidth(), enabled = enabled, singleLine = true,
            label = { Text("Value for {{$key}}") },
            placeholder = example?.let { { Text(it) } },
            supportingText = if (value.isBlank() && source != VariableSource.CUSTOM) ({ Text("Not available. Type it in.") }) else null,
            keyboardOptions = KeyboardOptions.Default,
        )
    }
}
