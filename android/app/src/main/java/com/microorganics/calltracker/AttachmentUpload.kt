package com.microorganics.calltracker

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException

/** Longest edge of a re-encoded photo, and its JPEG quality. */
private const val SHRUNK_EDGE_PX = 2048
private const val SHRUNK_QUALITY = 85
/** Photos larger than this are not read at all; they could not be shrunk safely in memory either. */
private const val MAX_PHOTO_READ_BYTES = 48L * 1024 * 1024

/** BitmapFactory ignores the EXIF orientation, so a re-encoded camera photo is turned upright here. */
private fun upright(source: ByteArray, bitmap: Bitmap): Bitmap {
    val degrees = try {
        when (android.media.ExifInterface(java.io.ByteArrayInputStream(source)).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, android.media.ExifInterface.ORIENTATION_NORMAL)) {
            android.media.ExifInterface.ORIENTATION_ROTATE_90 -> 90f
            android.media.ExifInterface.ORIENTATION_ROTATE_180 -> 180f
            android.media.ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            else -> 0f
        }
    } catch (_: Exception) {
        0f
    }
    if (degrees == 0f) return bitmap
    return try {
        val matrix = android.graphics.Matrix().apply { postRotate(degrees) }
        Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true).also { if (it !== bitmap) bitmap.recycle() }
    } catch (_: OutOfMemoryError) {
        bitmap
    }
}

/** A file chosen with the system picker, read into memory (at most 16 MB) and ready to upload. */
internal class PickedAttachment(val fileName: String, val mimeType: String, val bytes: ByteArray) {
    val kind: String get() = attachmentKind(mimeType)
}

internal sealed interface PickResult {
    data class Picked(val file: PickedAttachment) : PickResult
    data class Rejected(val message: String) : PickResult
}

/**
 * Reads [uri] (granted by the Photo Picker or the document picker, so no storage permission is involved). Photos
 * larger than WhatsApp accepts, and image formats WhatsApp doesn't take (for example HEIC), are re-encoded as JPEG.
 */
internal suspend fun readPickedAttachment(context: Context, uri: Uri): PickResult = withContext(Dispatchers.IO) {
    val resolver = context.contentResolver
    var name: String? = null
    var size: Long? = null
    try {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 && !cursor.isNull(it) }?.let { name = cursor.getString(it) }
                cursor.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !cursor.isNull(it) }?.let { size = cursor.getLong(it) }
            }
        }
    } catch (_: Exception) {
        // The name and size are optional; the read below still decides.
    }
    val fileName = safeFileName(name.orEmpty()).ifEmpty { "attachment" }
    var mime = cleanMimeType(resolver.getType(uri))
    if (mime.isEmpty() || mime == "application/octet-stream") {
        mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(fileName.substringAfterLast('.', "").lowercase()).orEmpty()
    }
    val convertible = mime.startsWith("image/") && mime !in IMAGE_ATTACHMENT_TYPES
    if (!convertible) (checkAttachment(mime, size) as? AttachmentCheck.Rejected)?.let { return@withContext PickResult.Rejected(it.message) }
    val limit = if (mime.startsWith("image/")) MAX_PHOTO_READ_BYTES else MAX_ATTACHMENT_BYTES
    val bytes = try {
        resolver.openInputStream(uri)?.use { input ->
            val out = ByteArrayOutputStream(((size ?: 64 * 1024).coerceIn(8 * 1024, limit)).toInt())
            val buffer = ByteArray(32 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (out.size() + count > limit) return@withContext PickResult.Rejected("Files can be up to ${formatSize(MAX_ATTACHMENT_BYTES)}.")
                out.write(buffer, 0, count)
            }
            out.toByteArray()
        }
    } catch (_: IOException) {
        null
    } catch (_: SecurityException) {
        null
    } ?: return@withContext PickResult.Rejected("Could not read this file.")
    if (bytes.isEmpty()) return@withContext PickResult.Rejected("This file is empty.")
    if (convertible || shouldShrinkImage(mime, bytes.size.toLong())) {
        val bitmap = decodeSampled(bytes, SHRUNK_EDGE_PX)?.let { upright(bytes, it) }
        if (bitmap != null) {
            val jpeg = ByteArrayOutputStream()
            val ok = bitmap.compress(Bitmap.CompressFormat.JPEG, SHRUNK_QUALITY, jpeg)
            bitmap.recycle()
            if (ok && (convertible || jpeg.size() < bytes.size)) {
                val converted = jpeg.toByteArray()
                if (converted.size > MAX_ATTACHMENT_BYTES) return@withContext PickResult.Rejected("This photo is too large.")
                return@withContext PickResult.Picked(PickedAttachment(withExtension(fileName, "jpg"), "image/jpeg", converted))
            }
        } else if (convertible) {
            return@withContext PickResult.Rejected("This image format can't be sent on WhatsApp.")
        }
    }
    (checkAttachment(mime, bytes.size.toLong()) as? AttachmentCheck.Rejected)?.let { return@withContext PickResult.Rejected(it.message) }
    if (bytes.size > MAX_ATTACHMENT_BYTES) return@withContext PickResult.Rejected("Files can be up to ${formatSize(MAX_ATTACHMENT_BYTES)}.")
    PickResult.Picked(PickedAttachment(fileName, mime, bytes))
}
