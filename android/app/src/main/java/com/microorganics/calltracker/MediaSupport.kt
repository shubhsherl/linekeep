package com.microorganics.calltracker

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.LruCache
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException

/** Chat thumbnails are drawn 220 dp wide. */
private const val THUMBNAIL_WIDTH_DP = 220
private const val THUMBNAIL_MAX_EDGE_PX = 900
private const val SHARE_DIRECTORY = "shared-media"

/** Longest edge, in pixels, a chat thumbnail needs on a screen with this density (660 at 3x). */
internal fun thumbnailEdgePx(density: Float): Int =
    Math.ceil((THUMBNAIL_WIDTH_DP * density).toDouble()).toInt().coerceIn(THUMBNAIL_WIDTH_DP, THUMBNAIL_MAX_EDGE_PX)

/** Largest power-of-two divisor that keeps the longest edge at or above [maxEdge]. */
internal fun sampleSizeFor(width: Int, height: Int, maxEdge: Int): Int {
    val longest = maxOf(width, height)
    var sample = 1
    while (maxEdge > 0 && longest / (sample * 2) >= maxEdge) sample *= 2
    return sample
}

/**
 * Largest power-of-two divisor for which the decoded image is still at least as large as the image fitted into
 * [maxWidth] x [maxHeight]. A 4000x3000 photo on a 1080x2400 screen decodes at 2000x1500, not at 4000x3000.
 */
internal fun fitSampleSize(width: Int, height: Int, maxWidth: Int, maxHeight: Int): Int {
    if (width <= 0 || height <= 0 || maxWidth <= 0 || maxHeight <= 0) return 1
    val ratio = maxOf(width / maxWidth, height / maxHeight)
    var sample = 1
    while (sample * 2 <= ratio) sample *= 2
    return sample
}

/** Decodes [bytes] at reduced size so a large photo never needs its full bitmap in memory; null when undecodable. */
internal fun decodeSampled(bytes: ByteArray, maxEdge: Int): Bitmap? =
    decodeWith(bytes) { width, height -> sampleSizeFor(width, height, maxEdge) }

/** Decodes [bytes] to fit a [maxWidth] x [maxHeight] area (a full-screen viewer); null when undecodable. */
internal fun decodeFitted(bytes: ByteArray, maxWidth: Int, maxHeight: Int): Bitmap? =
    decodeWith(bytes) { width, height -> fitSampleSize(width, height, maxWidth, maxHeight) }

private inline fun decodeWith(bytes: ByteArray, sampleSize: (width: Int, height: Int) -> Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val options = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight) }
    return try {
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    } catch (_: OutOfMemoryError) {
        null
    }
}

/** A sixteenth of the app's heap limit, between 4 and 16 MiB: 8 MiB on a 128 MiB heap. */
internal fun thumbnailCacheBytes(maxHeapBytes: Long): Int = (maxHeapBytes / 16).coerceIn(4L * 1024 * 1024, 16L * 1024 * 1024).toInt()

/** Android's own "memory is getting short" levels start at TRIM_MEMORY_RUNNING_LOW (10); the UI-hidden level is 20. */
internal fun shouldDropThumbnails(trimLevel: Int): Boolean = trimLevel >= 10

/** In-memory thumbnails only, bounded by [thumbnailCacheBytes]; nothing is written to disk. Emptied when Android trims memory. */
internal object ThumbnailCache {
    private val cache = object : LruCache<String, Bitmap>(thumbnailCacheBytes(Runtime.getRuntime().maxMemory())) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    fun get(key: String): Bitmap? = cache.get(key)
    fun put(key: String, bitmap: Bitmap) { cache.put(key, bitmap) }
    fun clear() = cache.evictAll()
    fun onTrimMemory(level: Int) { if (shouldDropThumbnails(level)) cache.evictAll() }
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
