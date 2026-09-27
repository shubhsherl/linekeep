package com.microorganics.calltracker

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal data class Enrollment(
    val deviceId: String,
    val token: String,
    val employeeId: String,
    val employeeName: String,
    val lastSync: String = "",
    val unauthorized: Boolean = false,
    val invitationId: String? = null,
    val lastInvitationId: String? = null,
)

/** Only ciphertext reaches disk; neither the bearer token nor enrollment is backed up. */
internal class EnrollmentStore(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "enrollment.enc"))
    private val alias = "calltracker.enrollment.v1"

    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        check(create) { "Enrollment key unavailable" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
        }.generateKey()
    }

    fun load(): Enrollment? {
        val bytes = try { file.readFully() } catch (_: java.io.FileNotFoundException) { return null }
        require(bytes.size > 28)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, key(create = false), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        }
        val value = JSONObject(String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8))
        return Enrollment(
            value.getString("deviceId"), value.getString("token"), value.getString("employeeId"),
            value.getString("employeeName"), value.optString("lastSync"), value.optBoolean("unauthorized"),
            value.optionalString("invitationId"), value.optionalString("lastInvitationId"),
        )
    }

    fun save(enrollment: Enrollment) {
        val payload = JSONObject().put("deviceId", enrollment.deviceId).put("token", enrollment.token)
            .put("employeeId", enrollment.employeeId).put("employeeName", enrollment.employeeName)
            .put("lastSync", enrollment.lastSync).put("unauthorized", enrollment.unauthorized)
            .put("invitationId", enrollment.invitationId).put("lastInvitationId", enrollment.lastInvitationId)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key(create = true)) }
        val encrypted = cipher.doFinal(payload.toString().toByteArray(Charsets.UTF_8))
        val stream = file.startWrite()
        try {
            stream.write(cipher.iv)
            stream.write(encrypted)
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
    }
}

internal fun JSONObject.optionalString(name: String): String? =
    if (isNull(name)) null else optString(name).takeIf { it.isNotBlank() }
