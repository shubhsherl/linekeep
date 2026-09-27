package com.microorganics.calltracker

import android.content.ContentResolver
import android.database.Cursor
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import java.io.FileNotFoundException
import java.io.IOException
import java.security.MessageDigest
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter

internal data class SourceDocument(val id: String, val uri: Uri, val name: String, val mime: String, val size: Long, val modified: Long) {
    val directory: Boolean get() = mime == DocumentsContract.Document.MIME_TYPE_DIR
    val audioType: String? get() = if (name.substringAfterLast('.', "").lowercase() in setOf("part", "partial", "tmp", "temp", "download", "crdownload")) null else when (mime.lowercase()) {
        "audio/mp4", "audio/x-m4a", "audio/m4a" -> "audio/mp4"
        "audio/mpeg", "audio/mp3" -> "audio/mpeg"
        "audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave" -> "audio/wav"
        "application/octet-stream", "" -> when (name.substringAfterLast('.', "").lowercase()) {
            "m4a", "mp4" -> "audio/mp4"
            "mp3" -> "audio/mpeg"
            "wav" -> "audio/wav"
            else -> null
        }
        else -> null
    }
}

internal data class SourceMetadata(val durationSeconds: Long?, val recordedAt: String?)
internal data class DocumentPage(val documents: List<SourceDocument>, val nextOffset: Int, val finished: Boolean)

internal class RecordingSource(private val resolver: ContentResolver) {
    private val projection = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED)

    fun hasGrant(tree: Uri): Boolean = resolver.persistedUriPermissions.any { it.uri == tree && it.isReadPermission }

    fun document(tree: Uri, id: String): SourceDocument {
        val uri = DocumentsContract.buildDocumentUriUsingTree(tree, id)
        return resolver.query(uri, projection, null, null, null)?.use { cursor ->
            if (!cursor.moveToFirst()) throw FileNotFoundException("Recording or folder is no longer available")
            fromCursor(tree, cursor)
        } ?: throw IOException("Recording provider unavailable")
    }

    /** Providers may ignore paging arguments; use the cursor position in that case, never assume support. */
    fun children(tree: Uri, id: String, offset: Int, limit: Int): DocumentPage {
        val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id)
        val args = Bundle().apply {
            putInt(ContentResolver.QUERY_ARG_OFFSET, offset)
            putInt(ContentResolver.QUERY_ARG_LIMIT, limit + 1)
            putStringArray(ContentResolver.QUERY_ARG_SORT_COLUMNS, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID))
            putInt(ContentResolver.QUERY_ARG_SORT_DIRECTION, ContentResolver.QUERY_SORT_DIRECTION_ASCENDING)
        }
        var result = try {
            resolver.query(uri, projection, args, null)
        } catch (_: IllegalArgumentException) {
            resolver.query(uri, projection, null, null, "${DocumentsContract.Document.COLUMN_DOCUMENT_ID} ASC")
        } ?: throw IOException("Recording provider unavailable")
        var honorsOffset = ContentResolver.QUERY_ARG_OFFSET in result.extras.getStringArray(ContentResolver.EXTRA_HONORED_ARGS).orEmpty()
        if (offset > 0 && !honorsOffset) {
            result.close()
            // A provider honoring LIMIT but ignoring OFFSET would otherwise truncate before the resume position.
            result = resolver.query(uri, projection, null, null, "${DocumentsContract.Document.COLUMN_DOCUMENT_ID} ASC")
                ?: throw IOException("Recording provider unavailable")
            honorsOffset = false
        }
        return result.use { cursor ->
            val start = if (honorsOffset) 0 else offset
            val items = ArrayList<SourceDocument>(limit)
            var available = cursor.moveToPosition(start)
            while (available && items.size < limit) {
                items.add(fromCursor(tree, cursor))
                available = cursor.moveToNext()
            }
            DocumentPage(items, offset + items.size, !available)
        }
    }

    private fun fromCursor(tree: Uri, cursor: Cursor): SourceDocument {
        val id = cursor.getString(0)
        return SourceDocument(id, DocumentsContract.buildDocumentUriUsingTree(tree, id), cursor.getString(1) ?: "Recording",
            cursor.getString(2) ?: "", if (cursor.isNull(3)) -1 else cursor.getLong(3), if (cursor.isNull(4)) 0 else cursor.getLong(4))
    }

    fun open(uri: Uri) = resolver.openInputStream(uri) ?: throw FileNotFoundException("Recording stream unavailable")

    fun hash(uri: Uri, expectedSize: Long, checkActive: () -> Unit): String {
        require(expectedSize in 1..MAX_AUDIO_BYTES) { "Recording size must be known and between 1 byte and 100 MiB" }
        val digest = MessageDigest.getInstance("SHA-256")
        var count = 0L
        open(uri).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                checkActive()
                val bytes = input.read(buffer)
                if (bytes < 0) break
                count += bytes
                if (count > expectedSize || count > MAX_AUDIO_BYTES) throw SourceChanged()
                digest.update(buffer, 0, bytes)
            }
        }
        if (count != expectedSize) throw SourceChanged()
        return digest.digest().hex()
    }

    fun metadata(uri: Uri): SourceMetadata {
        val retriever = MediaMetadataRetriever()
        try {
            resolver.openAssetFileDescriptor(uri, "r")?.use { descriptor ->
                if (descriptor.declaredLength >= 0) retriever.setDataSource(descriptor.fileDescriptor, descriptor.startOffset, descriptor.declaredLength)
                else retriever.setDataSource(descriptor.fileDescriptor)
                require(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes") { "Recording does not contain readable audio" }
                val duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()?.takeIf { it > 0 }?.div(1000)
                val rawDate = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DATE)
                // Only accept an explicit embedded date with timezone; never use provider modification time.
                val date = rawDate?.let { value ->
                    runCatching { Instant.parse(value).toString() }.getOrNull()
                        ?: runCatching { OffsetDateTime.parse(value, DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss.SSSXX")).toInstant().toString() }.getOrNull()
                        ?: runCatching { OffsetDateTime.parse(value, DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmssXX")).toInstant().toString() }.getOrNull()
                }
                return SourceMetadata(duration, date)
            } ?: throw FileNotFoundException("Recording descriptor unavailable")
        } finally {
            retriever.release()
        }
    }
}
