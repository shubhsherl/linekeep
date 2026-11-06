package com.microorganics.calltracker

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.graphics.Bitmap
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.ButtonDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

private const val STALE_SHARE_MS = 2 * 60_000L

/** Save / share / open for message media, plus which message the viewer or the file menu is showing. */
@Stable
internal class MediaController(
    private val context: Context,
    private val customers: CustomersRepository,
    private val scope: CoroutineScope,
    private val launchSave: (suggestedName: String) -> Unit,
    private val pendingSave: androidx.compose.runtime.MutableState<String?>,
) {
    var viewer by mutableStateOf<WhatsAppMessage?>(null)
    var menu by mutableStateOf<WhatsAppMessage?>(null)

    fun tap(message: WhatsAppMessage) {
        val media = message.media ?: return
        if (media.kind == MediaKind.IMAGE || media.kind == MediaKind.STICKER) viewer = message else menu = message
    }

    private fun toast(text: String) = Toast.makeText(context, text, Toast.LENGTH_LONG).show()

    fun save(message: WhatsAppMessage) {
        val media = message.media ?: return
        pendingSave.value = media.url
        try {
            launchSave(suggestedFileName(message.id, media))
        } catch (_: ActivityNotFoundException) {
            pendingSave.value = null
            toast("This phone has no file picker to save with.")
        }
    }

    /** Result of the system "create document" picker; [uri] is null when cancelled. */
    fun saved(uri: Uri?) {
        val url = pendingSave.value
        pendingSave.value = null
        if (uri == null || url == null) return
        scope.launch {
            try {
                val bytes = customers.mediaBytes(url)
                withContext(Dispatchers.IO) {
                    (context.contentResolver.openOutputStream(uri, "wt") ?: throw IOException("No output stream")).use { it.write(bytes) }
                }
                toast("Saved.")
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                toast("Could not save: " + if (error is IOException && error !is ApiFailure && error !is MediaTooLarge) "writing the file failed." else mediaFailureMessage(error))
            }
        }
    }

    fun share(message: WhatsAppMessage, bytes: ByteArray?) = send(message, bytes, share = true)

    fun open(message: WhatsAppMessage) = send(message, null, share = false)

    private fun send(message: WhatsAppMessage, known: ByteArray?, share: Boolean) {
        val media = message.media ?: return
        scope.launch {
            try {
                if (known == null) toast("Downloading…")
                val bytes = known ?: customers.mediaBytes(media.url)
                val uri = withContext(Dispatchers.IO) {
                    clearSharedFiles(context, STALE_SHARE_MS)
                    writeShareFile(context, bytes, suggestedFileName(message.id, media))
                }
                val mime = mediaMimeType(media)
                val intent = if (share) {
                    Intent.createChooser(Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), null)
                } else {
                    Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                try {
                    context.startActivity(intent)
                } catch (_: ActivityNotFoundException) {
                    toast(if (share) "No app is available to share with." else "No app can open this file. Use Save instead.")
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                toast(if (error is IOException && error !is ApiFailure && error !is MediaTooLarge) "Could not prepare the file." else mediaFailureMessage(error))
            }
        }
    }
}

@Composable
internal fun rememberMediaController(customers: CustomersRepository, scope: CoroutineScope): MediaController {
    val context = LocalContext.current
    val pending = rememberSaveable { mutableStateOf<String?>(null) }
    val holder = remember { arrayOfNulls<MediaController>(1) }
    // Storage Access Framework: the user picks the destination, so no storage permission is involved.
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri -> holder[0]?.saved(uri) }
    val controller = remember { MediaController(context, customers, scope, { launcher.launch(it) }, pending) }
    holder[0] = controller
    return controller
}

@Composable
internal fun MediaBlock(message: WhatsAppMessage, media: MessageMedia, customers: CustomersRepository, controller: MediaController) {
    if (media.kind == MediaKind.IMAGE || media.kind == MediaKind.STICKER) ImageThumbnail(message, media, customers) { controller.tap(message) }
    else FileRow(media) { controller.tap(message) }
}

private sealed interface ThumbState {
    data object Loading : ThumbState
    data object Failed : ThumbState
    data class Ready(val bitmap: Bitmap) : ThumbState
}

@Composable
private fun ImageThumbnail(message: WhatsAppMessage, media: MessageMedia, customers: CustomersRepository, onClick: () -> Unit) {
    val key = message.id + media.url
    var attempt by remember(key) { mutableStateOf(0) }
    var state by remember(key) { mutableStateOf<ThumbState>(ThumbnailCache.get(key)?.let { ThumbState.Ready(it) } ?: ThumbState.Loading) }
    LaunchedEffect(key, attempt) {
        if (state is ThumbState.Ready) return@LaunchedEffect
        state = ThumbState.Loading
        state = try {
            val bytes = customers.mediaBytes(media.url)
            val bitmap = withContext(Dispatchers.Default) { decodeSampled(bytes, THUMBNAIL_EDGE_PX) }
            if (bitmap == null) ThumbState.Failed else {
                ThumbnailCache.put(key, bitmap)
                ThumbState.Ready(bitmap)
            }
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            ThumbState.Failed
        }
    }
    val shape = RoundedCornerShape(12.dp)
    val current = state
    when (current) {
        is ThumbState.Ready -> {
            val ratio = (current.bitmap.width.toFloat() / current.bitmap.height.coerceAtLeast(1)).coerceIn(0.5f, 2f)
            Image(
                current.bitmap.asImageBitmap(),
                contentDescription = if (media.kind == MediaKind.STICKER) "Sticker" else "Photo, tap to open",
                modifier = Modifier.width(220.dp).height((220f / ratio).dp).clip(shape).clickable(onClick = onClick),
                contentScale = ContentScale.Crop,
            )
        }
        ThumbState.Loading -> Box(
            Modifier.width(220.dp).height(160.dp).clip(shape).background(MaterialTheme.colorScheme.outlineVariant).semantics { contentDescription = "Loading image" },
            contentAlignment = Alignment.Center,
        ) { CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp) }
        ThumbState.Failed -> Box(
            Modifier.width(220.dp).height(72.dp).clip(shape).background(MaterialTheme.colorScheme.outlineVariant).clickable { attempt++ },
            contentAlignment = Alignment.Center,
        ) { Text("Image unavailable", style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun FileRow(media: MessageMedia, onClick: () -> Unit) {
    val (icon, label) = when (media.kind) {
        MediaKind.VIDEO -> R.drawable.ic_chat_video to "Video"
        MediaKind.AUDIO -> R.drawable.ic_chat_document to "Audio"
        else -> R.drawable.ic_chat_document to "Document"
    }
    Row(
        Modifier.width(240.dp).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surface.copy(alpha = 0.6f)).clickable(onClick = onClick).padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(28.dp))
        Column(Modifier.weight(1f)) {
            Text(media.fileName ?: label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull(label, media.size?.let(::formatSize)).joinToString(" · "), style = MaterialTheme.typography.labelSmall)
        }
    }
}

/** Dialogs for the conversation: the image viewer and the Save / Open choice for other media. */
@Composable
internal fun MediaDialogs(controller: MediaController, customers: CustomersRepository) {
    controller.viewer?.let { message ->
        val media = message.media
        if (media != null) ImageViewer(message, media, customers, controller) { controller.viewer = null }
    }
    controller.menu?.let { message ->
        val media = message.media
        if (media != null) {
            AlertDialog(
                onDismissRequest = { controller.menu = null },
                title = { Text(media.fileName ?: "Attachment", maxLines = 2, overflow = TextOverflow.Ellipsis) },
                text = { Text(listOfNotNull(media.size?.let(::formatSize), "Save it to your phone or open it with another app.").joinToString(" · ")) },
                confirmButton = {
                    Row {
                        TextButton(onClick = { controller.menu = null; controller.save(message) }) { Text("Save") }
                        TextButton(onClick = { controller.menu = null; controller.open(message) }) { Text("Open") }
                    }
                },
                dismissButton = { TextButton(onClick = { controller.menu = null }) { Text("Cancel") } },
            )
        }
    }
}

private sealed interface ViewerState {
    data object Loading : ViewerState
    data class Failed(val message: String) : ViewerState
    data class Ready(val bytes: ByteArray, val bitmap: Bitmap) : ViewerState
}

@Composable
private fun ImageViewer(message: WhatsAppMessage, media: MessageMedia, customers: CustomersRepository, controller: MediaController, close: () -> Unit) {
    val context = LocalContext.current
    var state by remember(media.url) { mutableStateOf<ViewerState>(ViewerState.Loading) }
    LaunchedEffect(media.url) {
        state = try {
            val bytes = customers.mediaBytes(media.url)
            val bitmap = withContext(Dispatchers.Default) { decodeSampled(bytes, VIEWER_EDGE_PX) }
            if (bitmap == null) ViewerState.Failed("Image unavailable") else ViewerState.Ready(bytes, bitmap)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            ViewerState.Failed(mediaFailureMessage(error))
        }
    }
    DisposableEffect(Unit) { onDispose { clearSharedFiles(context, STALE_SHARE_MS) } }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = Color.Black) {
            Column(Modifier.fillMaxSize()) {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    when (val current = state) {
                        ViewerState.Loading -> CircularProgressIndicator(color = Color.White)
                        is ViewerState.Failed -> Text(current.message, color = Color.White, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(24.dp))
                        is ViewerState.Ready -> Image(
                            current.bitmap.asImageBitmap(),
                            contentDescription = "Full-size image",
                            modifier = Modifier.fillMaxSize(),
                            contentScale = ContentScale.Fit,
                        )
                    }
                }
                val colors = ButtonDefaults.textButtonColors(contentColor = Color.White, disabledContentColor = Color.Gray)
                Row(Modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                    TextButton(onClick = { controller.save(message) }, colors = colors) { Text("Save") }
                    TextButton(
                        onClick = { (state as? ViewerState.Ready)?.let { controller.share(message, it.bytes) } },
                        enabled = state is ViewerState.Ready, colors = colors,
                    ) { Text("Share") }
                    IconAction(R.drawable.ic_close, "Close", close, tint = Color.White)
                }
            }
        }
    }
}
