package com.microorganics.calltracker

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.LruCache
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException

internal const val THUMBNAIL_EDGE_PX = 660
internal const val VIEWER_EDGE_PX = 2048
private const val SHARE_DIRECTORY = "shared-media"

/** Largest power-of-two divisor that keeps the longest edge at or above [maxEdge]. */
internal fun sampleSizeFor(width: Int, height: Int, maxEdge: Int): Int {
    val longest = maxOf(width, height)
    var sample = 1
    while (maxEdge > 0 && longest / (sample * 2) >= maxEdge) sample *= 2
    return sample
}

/** Decodes [bytes] at reduced size so a large photo never needs its full bitmap in memory; null when undecodable. */
internal fun decodeSampled(bytes: ByteArray, maxEdge: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val options = BitmapFactory.Options().apply { inSampleSize = sampleSizeFor(bounds.outWidth, bounds.outHeight, maxEdge) }
    return try {
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    } catch (_: OutOfMemoryError) {
        null
    }
}

/** In-memory thumbnails only, bounded to 16 MiB; nothing is written to disk. */
internal object ThumbnailCache {
    private val cache = object : LruCache<String, Bitmap>(16 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    fun get(key: String): Bitmap? = cache.get(key)
    fun put(key: String, bitmap: Bitmap) { cache.put(key, bitmap) }
    fun clear() = cache.evictAll()
}

internal fun mediaMimeType(media: MessageMedia): String =
    media.mimeType?.substringBefore(';')?.trim()?.lowercase()?.takeIf { '/' in it } ?: "application/octet-stream"

private fun extensionFor(media: MessageMedia): String = when (mediaMimeType(media)) {
    "image/jpeg" -> "jpg"
    "image/png" -> "png"
    "image/webp" -> "webp"
    "image/gif" -> "gif"
    "video/mp4" -> "mp4"
    "video/3gpp" -> "3gp"
    "audio/ogg" -> "ogg"
    "audio/mpeg" -> "mp3"
    "audio/mp4", "audio/aac" -> "m4a"
    "application/pdf" -> "pdf"
    else -> when (media.kind) {
        MediaKind.IMAGE -> "jpg"
        MediaKind.STICKER -> "webp"
        MediaKind.VIDEO -> "mp4"
        MediaKind.AUDIO -> "ogg"
        MediaKind.DOCUMENT -> "bin"
    }
}

/** Keeps a name usable as a single file name: no separators or control characters. */
internal fun safeFileName(name: String): String =
    name.map { if (it.isLetterOrDigit() || it in "._- ()") it else '_' }.joinToString("").trim().trim('.').take(120)

internal fun suggestedFileName(messageId: String, media: MessageMedia): String =
    media.fileName?.let(::safeFileName)?.takeIf { it.isNotEmpty() } ?: "whatsapp-${safeFileName(messageId)}.${extensionFor(media)}"

internal fun formatSize(bytes: Long): String = when {
    bytes >= 1024 * 1024 -> "%.1f MB".format(java.util.Locale.US, bytes / (1024.0 * 1024.0))
    bytes >= 1024 -> "${bytes / 1024} KB"
    else -> "$bytes B"
}

internal fun mediaFailureMessage(error: Exception): String = when {
    error is MediaTooLarge -> "This file is larger than 25 MB and can't be opened here."
    error is ApiFailure && error.status == 404 -> "This file is no longer available."
    else -> customersFailureMessage(error)
}

/** Writes [bytes] to the app cache and returns a content Uri another app may read. */
internal fun writeShareFile(context: Context, bytes: ByteArray, fileName: String): Uri {
    val directory = File(context.cacheDir, SHARE_DIRECTORY).apply { mkdirs() }
    val file = File(directory, safeFileName(fileName).ifEmpty { "whatsapp-file" })
    file.writeBytes(bytes)
    return FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
}

/** Deletes cached share files older than [olderThanMs]; used when the viewer closes. */
internal fun clearSharedFiles(context: Context, olderThanMs: Long = 0) {
    val cutoff = System.currentTimeMillis() - olderThanMs
    try {
        File(context.cacheDir, SHARE_DIRECTORY).listFiles()?.forEach { if (it.lastModified() <= cutoff) it.delete() }
    } catch (_: IOException) {
    }
}
