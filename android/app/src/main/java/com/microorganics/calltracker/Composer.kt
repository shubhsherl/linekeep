package com.microorganics.calltracker

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** A picked file waiting in the composer. It is uploaded when sent and stays uploaded if sending the message is retried. */
internal class AttachmentDraft(val file: PickedAttachment) {
    var uploaded by mutableStateOf<UploadedAttachment?>(null)
    /** 0f..1f while the upload runs, otherwise null. */
    var progress by mutableStateOf<Float?>(null)
}

@Composable
internal fun ChatComposer(
    colors: ChatColors,
    draft: String,
    onDraft: (String) -> Unit,
    enabled: Boolean,
    busy: Boolean,
    attachment: AttachmentDraft?,
    onRemoveAttachment: () -> Unit,
    onQuickReplies: () -> Unit,
    onAttach: () -> Unit,
    onTemplate: () -> Unit,
    onSend: () -> Unit,
) {
    val canSend = enabled && !busy && (draft.isNotBlank() || attachment != null)
    Column(
        Modifier.fillMaxWidth().background(colors.background).padding(horizontal = 8.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (attachment != null) AttachmentPreview(attachment, colors, onRemoveAttachment)
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Surface(Modifier.weight(1f), shape = RoundedCornerShape(26.dp), color = colors.composer) {
                Row(verticalAlignment = Alignment.Bottom) {
                    IconAction(R.drawable.ic_chat_bolt, "Quick replies", onQuickReplies, enabled = enabled && !busy, tint = colors.meta)
                    BasicTextField(
                        value = draft,
                        onValueChange = onDraft,
                        modifier = Modifier.weight(1f).padding(vertical = 14.dp).semantics { contentDescription = "Message" },
                        enabled = enabled && !busy,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.text),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        maxLines = 5,
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        decorationBox = { inner ->
                            Box {
                                if (draft.isEmpty()) Text(if (attachment != null) "Add a caption" else "Message", style = MaterialTheme.typography.bodyLarge, color = colors.meta)
                                inner()
                            }
                        },
                    )
                    IconAction(R.drawable.ic_chat_attach, "Attach a file or photo", onAttach, enabled = enabled && !busy, tint = colors.meta)
                    IconAction(R.drawable.ic_chat_template, "Send a template", onTemplate, enabled = enabled && !busy, tint = colors.meta)
                }
            }
            FilledIconButton(onClick = onSend, enabled = canSend, modifier = Modifier.size(48.dp)) {
                if (busy) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                else Icon(painterResource(R.drawable.ic_chat_send), contentDescription = "Send", modifier = Modifier.size(22.dp))
            }
        }
    }
}

@Composable
private fun AttachmentPreview(draft: AttachmentDraft, colors: ChatColors, onRemove: () -> Unit) {
    val thumbnail by produceState<Bitmap?>(null, draft.file) {
        value = if (draft.file.kind == "image") withContext(Dispatchers.Default) { decodeSampled(draft.file.bytes, 192) } else null
    }
    val uploading = draft.progress != null
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp), color = colors.composer) {
        Row(Modifier.padding(start = 8.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            val shown = thumbnail
            if (shown != null) {
                Image(shown.asImageBitmap(), contentDescription = "Selected photo", modifier = Modifier.size(56.dp).clip(RoundedCornerShape(10.dp)), contentScale = ContentScale.Crop)
            } else {
                Box(Modifier.size(56.dp).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
                    Icon(
                        painterResource(if (draft.file.kind == "video") R.drawable.ic_chat_video else R.drawable.ic_chat_document), contentDescription = null,
                        tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.size(28.dp),
                    )
                }
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(draft.file.fileName, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val progress = draft.progress
                if (progress != null) {
                    LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Uploading, ${(progress * 100).toInt()} percent" })
                    Text("Uploading ${(progress * 100).toInt()}%", style = MaterialTheme.typography.labelSmall, color = colors.meta)
                } else {
                    Text(
                        listOfNotNull(formatSize(draft.file.bytes.size.toLong()), if (draft.uploaded != null) "Uploaded" else null).joinToString(" · "),
                        style = MaterialTheme.typography.labelSmall, color = colors.meta,
                    )
                }
            }
            IconAction(R.drawable.ic_close, "Remove attachment", onRemove, enabled = !uploading, tint = colors.meta)
        }
    }
}

/** Shown instead of the composer once the customer's 24-hour window has closed. */
@Composable
internal fun ClosedWindowBanner(colors: ChatColors, enabled: Boolean, onTemplate: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().background(colors.background).padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp), color = colors.composer) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
                    Icon(painterResource(R.drawable.ic_chat_clock), contentDescription = null, tint = colors.meta, modifier = Modifier.size(22.dp))
                    Text("The 24-hour reply window is closed. Send a template to start the conversation again.", style = MaterialTheme.typography.bodyMedium, color = colors.text)
                }
                Button(onClick = onTemplate, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Icon(painterResource(R.drawable.ic_chat_template), contentDescription = null, modifier = Modifier.size(20.dp))
                    Text("Send template", Modifier.padding(start = 8.dp))
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AttachSheet(onDismiss: () -> Unit, onPhoto: () -> Unit, onDocument: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 16.dp)) {
            SheetRow(R.drawable.ic_chat_image, "Photo or video from gallery", onPhoto)
            SheetRow(R.drawable.ic_chat_document, "Document", onDocument)
        }
    }
}

private sealed interface QuickState {
    data object Loading : QuickState
    data class Failed(val message: String) : QuickState
    data class Ready(val items: List<QuickMessage>) : QuickState
}

/** Lists the shared quick replies, filled in for this customer; tapping one hands the text back for editing. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun QuickReplySheet(customers: CustomersRepository, fill: FillContext, onDismiss: () -> Unit, onPick: (QuickFill) -> Unit) {
    var attempt by remember { mutableStateOf(0) }
    var state by remember { mutableStateOf<QuickState>(QuickState.Loading) }
    LaunchedEffect(attempt) {
        state = QuickState.Loading
        state = try {
            QuickState.Ready(customers.quickMessages(force = attempt > 0))
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            QuickState.Failed(customersFailureMessage(error))
        }
    }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 16.dp)) {
            Text("Quick replies", Modifier.padding(horizontal = 20.dp, vertical = 8.dp), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            when (val current = state) {
                QuickState.Loading -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                is QuickState.Failed -> Column(Modifier.padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(current.message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                    OutlinedButton(onClick = { attempt++ }) { Text("Try again") }
                }
                is QuickState.Ready -> if (current.items.isEmpty()) {
                    SupportingText("No quick replies have been set up yet. Your manager can add them.")
                } else {
                    LazyColumn(Modifier.heightIn(max = 420.dp)) {
                        items(current.items, key = { it.id }) { quick ->
                            val filled = fillQuickPlaceholders(quick.text, fill.customerName, fill.handlerName, fill.handlerPhone)
                            Surface(onClick = { onPick(filled) }, color = androidx.compose.ui.graphics.Color.Transparent, modifier = Modifier.fillMaxWidth()) {
                                Column(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 20.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                    Text(quick.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(filled.text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                }
                            }
                        }
                    }
                }
            }
            TextButton(onClick = onDismiss, modifier = Modifier.padding(horizontal = 12.dp)) { Text("Cancel") }
        }
    }
}
