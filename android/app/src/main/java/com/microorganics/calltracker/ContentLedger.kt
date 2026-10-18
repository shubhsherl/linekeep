package com.microorganics.calltracker

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import java.io.File

@Entity(tableName = "recordings")
internal data class RecordingEntry(
    @PrimaryKey val key: String,
    val deviceId: String,
    val tree: String,
    val documentId: String,
    val uri: String,
    val name: String,
    val mime: String,
    val size: Long,
    val modified: Long,
    val stableSince: Long,
    val fingerprint: String? = null,
    val contentHash: String? = null,
    val durationSeconds: Long? = null,
    val recordedAt: String? = null,
    val callId: String? = null,
    val uploadedBytes: Long? = null,
    val etag: String? = null,
    val state: String = "observing",
    val uploadedAt: String? = null,
    val error: String? = null,
    val lastAttemptAt: Long = 0,
)

@Entity(tableName = "directories", primaryKeys = ["tree", "documentId"])
internal data class DirectoryEntry(val tree: String, val documentId: String, val offset: Int = 0, val done: Boolean = false)

@Entity(tableName = "history")
internal data class HistoryEntry(
    @PrimaryKey val fingerprint: String,
    val deviceId: String,
    val providerId: Long,
    val startedAt: String,
    val durationSeconds: Long,
    val callType: String,
    val remoteNumber: String?,
    val synced: Boolean = false,
    val error: String? = null,
    val callerName: String? = null,
    val localNumber: String? = null,
    val simLabel: String? = null,
    val phoneAccountId: String? = null,
    val phoneAccountComponent: String? = null,
)

@Entity(tableName = "history_progress")
internal data class HistoryProgress(@PrimaryKey val deviceId: String, val lastId: Long)

@Entity(tableName = "recording_watches", primaryKeys = ["deviceId", "watchId"])
internal data class RecordingWatch(
    val deviceId: String,
    val watchId: String,
    val historyFingerprint: String?,
    val endedAt: Long,
    val deadline: Long,
    val state: String = "waiting",
    val checkedAt: Long = 0,
    val deferred: Boolean = false,
    val cursor: String = "",
)

@Dao
internal interface ContentDao {
    @Query("SELECT * FROM recordings WHERE `key` = :key")
    suspend fun recording(key: String): RecordingEntry?
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveRecording(entry: RecordingEntry)
    @Query("SELECT * FROM recordings WHERE deviceId = :device AND tree = :tree AND state NOT IN ('complete', 'failed') ORDER BY CASE WHEN uploadedBytes IS NOT NULL THEN 0 ELSE 1 END, lastAttemptAt, stableSince LIMIT :limit")
    suspend fun pendingRecordings(device: String, tree: String, limit: Int): List<RecordingEntry>
    @Query("SELECT * FROM recordings WHERE deviceId = :device AND tree = :tree AND state NOT IN ('complete', 'failed') ORDER BY modified DESC LIMIT 1")
    suspend fun recentPendingRecording(device: String, tree: String): List<RecordingEntry>
    @Query("SELECT COUNT(*) FROM recordings WHERE deviceId = :device AND tree = :tree AND state NOT IN ('complete', 'failed') AND error IS NULL AND (state != 'observing' OR lastAttemptAt = 0)")
    suspend fun actionableRecordingCount(device: String, tree: String): Int
    @Query("SELECT COUNT(*) FROM recordings WHERE deviceId = :device AND tree = :tree AND state NOT IN ('complete', 'failed')")
    suspend fun pendingRecordingCount(device: String, tree: String): Int
    @Query("SELECT COUNT(*) FROM recordings WHERE deviceId = :device AND state = 'complete'")
    suspend fun uploadedCount(device: String): Int
    @Query("SELECT MAX(uploadedAt) FROM recordings WHERE deviceId = :device AND state = 'complete'")
    suspend fun lastUpload(device: String): String?
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun addDirectory(entry: DirectoryEntry)
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveDirectory(entry: DirectoryEntry)
    @Query("SELECT * FROM directories WHERE tree = :tree AND done = 0 ORDER BY documentId LIMIT 1")
    suspend fun nextDirectory(tree: String): DirectoryEntry?
    @Query("DELETE FROM directories WHERE tree = :tree")
    suspend fun clearDirectories(tree: String)
    @Query("SELECT * FROM history WHERE fingerprint = :fingerprint")
    suspend fun history(fingerprint: String): HistoryEntry?
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveHistory(entry: HistoryEntry)
    @Query("SELECT * FROM history WHERE deviceId = :device AND synced = 0 AND error IS NULL ORDER BY startedAt DESC, providerId DESC LIMIT 25")
    suspend fun recentPendingHistory(device: String): List<HistoryEntry>
    @Query("SELECT * FROM history WHERE deviceId = :device AND synced = 0 AND error IS NULL ORDER BY providerId LIMIT 25")
    suspend fun oldestPendingHistory(device: String): List<HistoryEntry>
    @Query("SELECT COUNT(*) FROM history WHERE deviceId = :device AND synced = 0 AND error IS NULL")
    suspend fun pendingHistoryCount(device: String): Int
    @Query("SELECT COUNT(*) FROM history WHERE deviceId = :device AND synced = 1")
    suspend fun syncedHistoryCount(device: String): Int
    @Query("SELECT * FROM history_progress WHERE deviceId = :device")
    suspend fun historyProgress(device: String): HistoryProgress?
    @Query("SELECT COUNT(*) FROM history WHERE deviceId = :device AND error IS NOT NULL")
    suspend fun failedHistoryCount(device: String): Int
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveHistoryProgress(progress: HistoryProgress)
    @Query("SELECT * FROM history WHERE deviceId = :device AND error IS NULL AND callType IN ('incoming', 'outgoing') AND durationSeconds > 0 AND CAST(strftime('%s', startedAt) AS INTEGER) * 1000 + durationSeconds * 1000 BETWEEN :since AND :until")
    suspend fun discoveryHistory(device: String, since: Long, until: Long): List<HistoryEntry>
    @Query("SELECT * FROM history WHERE deviceId = :device AND callType IN ('incoming', 'outgoing') AND durationSeconds BETWEEN :minimum AND :maximum AND (CAST(strftime('%s', startedAt) AS INTEGER) BETWEEN :mediaSeconds - 30 AND :mediaSeconds OR CAST(strftime('%s', startedAt) AS INTEGER) BETWEEN :mediaSeconds - :duration - 30 AND :mediaSeconds - :duration) LIMIT 201")
    suspend fun recordingMatchHistory(device: String, minimum: Long, maximum: Long, mediaSeconds: Long, duration: Long): List<HistoryEntry>
    @Query("SELECT * FROM recordings WHERE deviceId = :device AND tree = :tree AND `key` > :after ORDER BY `key` LIMIT 128")
    suspend fun discoveryRecordings(device: String, tree: String, after: String): List<RecordingEntry>
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun addRecordingWatch(watch: RecordingWatch)
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveRecordingWatch(watch: RecordingWatch)
    @Query("SELECT * FROM recording_watches WHERE deviceId = :device ORDER BY checkedAt, endedAt")
    suspend fun recordingWatches(device: String): List<RecordingWatch>
}

@Database(entities = [RecordingEntry::class, DirectoryEntry::class, HistoryEntry::class, HistoryProgress::class, RecordingWatch::class], version = 3, exportSchema = false)
internal abstract class ContentLedger : RoomDatabase() {
    abstract fun entries(): ContentDao

    companion object {
        @Volatile private var instance: ContentLedger? = null
        private val migration1To2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE history ADD COLUMN callerName TEXT")
                db.execSQL("ALTER TABLE history ADD COLUMN localNumber TEXT")
                db.execSQL("ALTER TABLE history ADD COLUMN simLabel TEXT")
                db.execSQL("ALTER TABLE history ADD COLUMN phoneAccountId TEXT")
                db.execSQL("ALTER TABLE history ADD COLUMN phoneAccountComponent TEXT")
            }
        }
        private val migration2To3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS recording_watches (deviceId TEXT NOT NULL, watchId TEXT NOT NULL, historyFingerprint TEXT, endedAt INTEGER NOT NULL, deadline INTEGER NOT NULL, state TEXT NOT NULL, checkedAt INTEGER NOT NULL, deferred INTEGER NOT NULL, cursor TEXT NOT NULL, PRIMARY KEY(deviceId, watchId))")
            }
        }
        fun get(context: Context): ContentLedger = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context.applicationContext, ContentLedger::class.java,
                File(context.noBackupFilesDir, "content-ledger.db").absolutePath)
                .addMigrations(migration1To2, migration2To3).build().also { instance = it }
        }
    }
}
