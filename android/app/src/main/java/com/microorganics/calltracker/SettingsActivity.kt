package com.microorganics.calltracker

import android.Manifest
import android.app.StatusBarManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon as AndroidIcon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Shapes
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.format.FormatStyle

/** A scanned, not yet confirmed connection. The one-use code stays in memory only and is never saved across recreation. */
private class PendingConnect(val server: String?, val effective: String, val code: String)

private data class RequiredAccess(
    val phoneState: Boolean = false,
    val phoneNumbers: Boolean = false,
    val callHistory: Boolean = false,
    val notifications: Boolean = false,
    val needsSettings: Boolean = false,
    val background: BackgroundStatus = BackgroundStatus(),
) {
    val runtimeGranted get() = phoneState && phoneNumbers && callHistory && notifications && background.unrestricted
}

class SettingsActivity : ComponentActivity() {
    private val app get() = application as CalltrackerApplication
    private var access by mutableStateOf(RequiredAccess())
    private var server by mutableStateOf<String?>(null)
    private var scanMessage by mutableStateOf<String?>(null)
    private var pendingConnect by mutableStateOf<PendingConnect?>(null)
    private var confirmReset by mutableStateOf(false)
    private val permissionRequests get() = getSharedPreferences("permission-requests", MODE_PRIVATE)

    private fun granted(permission: String) =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun requiredPermissions(): List<String> = buildList {
        add(Manifest.permission.READ_PHONE_STATE)
        add(Manifest.permission.READ_PHONE_NUMBERS)
        add(Manifest.permission.READ_CALL_LOG)
        if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun needsSettings(permission: String) = !granted(permission) &&
        permissionRequests.getBoolean(permission, false) && !shouldShowRequestPermissionRationale(permission)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        server = app.repository.serverUrl()
        enableEdgeToEdge()
        setContent {
            val status by app.repository.status.collectAsStateWithLifecycle()
            val content by app.repository.contentStatus.collectAsStateWithLifecycle()
            // Only flow progress and the chosen folder survive recreation, never an invitation code.
            var permissionStep by rememberSaveable { mutableStateOf("idle") }
            var selectedFolder by rememberSaveable { mutableStateOf<String?>(null) }
            var setupFailure by rememberSaveable { mutableStateOf<String?>(null) }
            val folderPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
                selectedFolder = uri?.toString()
                permissionStep = if (uri != null) "save_folder" else "background"
            }
            val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
                permissionRequests.edit().apply {
                    results.keys.forEach { putBoolean(it, true) }
                }.apply()
                refreshAccess()
                permissionStep = "folder"
            }
            val backgroundRequest = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
                refreshAccess()
                permissionStep = "finish"
            }
            LaunchedEffect(permissionStep) {
                try {
                    when (permissionStep) {
                        "accept" -> {
                            app.repository.acceptSetup()
                            if (app.repository.contentStatus.value.setupAccepted) {
                                permissionStep = "permissions"
                            } else {
                                setupFailure = "Setup could not be saved. Try again; see Advanced for details."
                                permissionStep = "idle"
                            }
                        }
                        "permissions" -> {
                            val missing = requiredPermissions().filter { !granted(it) && !needsSettings(it) }
                            if (missing.isEmpty()) permissionStep = "folder"
                            else {
                                permissionStep = "await_permissions"
                                permissions.launch(missing.toTypedArray())
                            }
                        }
                        "folder" -> {
                            app.repository.refreshContent()
                            if (app.repository.contentStatus.value.folderAccessible) permissionStep = "background"
                            else {
                                permissionStep = "await_folder"
                                folderPicker.launch(null)
                            }
                        }
                        "change_folder" -> {
                            permissionStep = "await_folder"
                            folderPicker.launch(null)
                        }
                        "save_folder" -> {
                            selectedFolder?.let { app.repository.selectRecordingFolder(Uri.parse(it)) }
                            selectedFolder = null
                            if (!app.repository.contentStatus.value.folderAccessible) {
                                setupFailure = "Folder access was not granted. Choose the recordings folder again in Advanced."
                            }
                            permissionStep = "background"
                        }
                        "background" -> {
                            refreshAccess()
                            val current = BackgroundAccess.read(this@SettingsActivity)
                            if (current.unrestricted) permissionStep = "finish"
                            else {
                                permissionStep = "await_background"
                                try {
                                    backgroundRequest.launch(BackgroundAccess.requestIntent(this@SettingsActivity, current))
                                } catch (_: ActivityNotFoundException) {
                                    // Some ROMs omit the direct dialog; app battery settings remain reachable.
                                    backgroundRequest.launch(BackgroundAccess.appSettingsIntent(this@SettingsActivity))
                                }
                            }
                        }
                        "finish" -> {
                            app.repository.refreshContent()
                            app.repository.refreshSim()
                            refreshAccess()
                            permissionStep = "idle"
                        }
                    }
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    selectedFolder = null
                    setupFailure = "Setup could not finish. Try again or open Android settings in Advanced."
                    permissionStep = "idle"
                }
            }
            LinekeepTheme {
                if (confirmReset) {
                    AlertDialog(
                        onDismissRequest = { confirmReset = false },
                        title = { Text("Remove the old connection?") },
                        text = { Text("This phone's saved connection was rejected by the server. Removing it lets you scan a new code from your manager. Calls and recordings already uploaded stay on the server. Items still waiting on this phone are sent again under the new connection.") },
                        confirmButton = {
                            TextButton(onClick = {
                                confirmReset = false
                                scanMessage = null
                                app.scope.launch { app.repository.resetRejectedConnection() }
                            }) { Text("Remove") }
                        },
                        dismissButton = { TextButton(onClick = { confirmReset = false }) { Text("Cancel") } },
                    )
                }
                pendingConnect?.let { pending ->
                    AlertDialog(
                        onDismissRequest = { pendingConnect = null },
                        title = { Text("Connect this phone to ${serverHost(pending.effective)}?") },
                        text = { Text("Call history and recordings you allow will be sent to ${pending.effective}. Only continue if your manager gave you this QR code.") },
                        confirmButton = {
                            TextButton(onClick = {
                                pendingConnect = null
                                enrollAt(pending.code, pending.server)
                            }) { Text("Connect") }
                        },
                        dismissButton = { TextButton(onClick = { pendingConnect = null }) { Text("Cancel") } },
                    )
                }
                DeviceScreen(
                    status = status,
                    content = content,
                    access = access,
                    granting = permissionStep != "idle",
                    setupFailure = setupFailure,
                    grant = {
                        setupFailure = null
                        permissionStep = "accept"
                    },
                    server = server,
                    scanMessage = scanMessage,
                    scan = ::scanQr,
                    enroll = ::enrollAt,
                    saveServer = { origin ->
                        app.scope.launch {
                            app.repository.setServer(origin)
                            server = app.repository.serverUrl()
                        }
                    },
                    sync = { app.scope.launch { app.repository.requestSync() } },
                    reset = { confirmReset = true },
                    settings = ::openAppSettings,
                    addTile = if (Build.VERSION.SDK_INT >= 33) ({
                        getSystemService(StatusBarManager::class.java)?.requestAddTileService(
                            ComponentName(this, CalltrackerTileService::class.java), getString(R.string.tile_label),
                            AndroidIcon.createWithResource(this, R.drawable.ic_linekeep_mark), mainExecutor,
                        ) { }
                    }) else null,
                    chooseFolder = {
                        setupFailure = null
                        permissionStep = "change_folder"
                    },
                    inspectFolder = { app.scope.launch { app.repository.inspectRecordingFolder() } },
                    customers = app.customers,
                    scope = app.scope,
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        server = app.repository.serverUrl()
        refreshAccess()
        app.scope.launch {
            app.repository.refreshContent()
            app.repository.refreshSim()
            refreshAccess()
        }
    }

    private fun enrollAt(code: String, newServer: String?) {
        scanMessage = null
        app.scope.launch {
            app.repository.enroll(code, newServer)
            server = app.repository.serverUrl()
        }
    }

    private fun scanQr() {
        scanMessage = null
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { barcode -> handleScan(barcode.rawValue) }
            .addOnCanceledListener { scanMessage = "Scan cancelled. You can also enter the details manually in Advanced." }
            .addOnFailureListener { scanMessage = "QR scanning is not available right now. Enter the server and code manually in Advanced." }
    }

    private fun handleScan(raw: String?) {
        val current = app.repository.status.value
        val parsed = raw?.let(::parseEnrollmentQr)
        val effective = parsed?.server ?: app.repository.serverUrl()
        scanMessage = when {
            current.deviceId != null -> "This phone is already connected. Reset the app data to connect to another server."
            current.storageUnavailable -> "Saved credentials could not be opened. Contact your manager."
            parsed == null -> "This QR code is not a Linekeep setup code."
            effective == null -> "This QR code does not name a server and none is set. Set one in Advanced."
            else -> {
                pendingConnect = PendingConnect(parsed.server, effective, parsed.code)
                null
            }
        }
    }

    private fun refreshAccess() {
        val notifications = StatusNotification.enabled(this)
        access = RequiredAccess(
            phoneState = granted(Manifest.permission.READ_PHONE_STATE),
            phoneNumbers = granted(Manifest.permission.READ_PHONE_NUMBERS),
            callHistory = granted(Manifest.permission.READ_CALL_LOG),
            notifications = notifications,
            needsSettings = requiredPermissions().any(::needsSettings) ||
                (!notifications && (Build.VERSION.SDK_INT < 33 || granted(Manifest.permission.POST_NOTIFICATIONS))),
            background = BackgroundAccess.read(this),
        )
        app.repository.updateContentNotification()
    }

    private fun openAppSettings() {
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
    }
}

private val LinekeepLight = lightColorScheme(
    primary = Color(0xFF103F3A),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE0F0E7),
    onPrimaryContainer = Color(0xFF103F3A),
    secondary = Color(0xFF426558),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFB9E7CF),
    onSecondaryContainer = Color(0xFF103F3A),
    background = Color(0xFFF7F8F4),
    onBackground = Color(0xFF1B2924),
    surface = Color.White,
    onSurface = Color(0xFF1B2924),
    surfaceVariant = Color(0xFFEEF2EC),
    onSurfaceVariant = Color(0xFF52635A),
    outline = Color(0xFF738279),
    outlineVariant = Color(0xFFDCE5DC),
    error = Color(0xFF9D3029),
    errorContainer = Color(0xFFFFEDEA),
    onErrorContainer = Color(0xFF70201B),
)

private val LinekeepDark = darkColorScheme(
    primary = Color(0xFFB9E7CF),
    onPrimary = Color(0xFF103F3A),
    primaryContainer = Color(0xFF1C3B32),
    onPrimaryContainer = Color(0xFFD3F1DF),
    secondary = Color(0xFFADD1BE),
    onSecondary = Color(0xFF16392C),
    secondaryContainer = Color(0xFF294E3C),
    onSecondaryContainer = Color(0xFFB9E7CF),
    background = Color(0xFF101A18),
    onBackground = Color(0xFFE2ECE5),
    surface = Color(0xFF192622),
    onSurface = Color(0xFFE2ECE5),
    surfaceVariant = Color(0xFF25352F),
    onSurfaceVariant = Color(0xFFB5C8BC),
    outline = Color(0xFF84998B),
    outlineVariant = Color(0xFF35483E),
    error = Color(0xFFFFB4A9),
    errorContainer = Color(0xFF512A25),
    onErrorContainer = Color(0xFFFFDAD3),
)

@Composable
private fun LinekeepTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) LinekeepDark else LinekeepLight,
        shapes = Shapes(
            small = RoundedCornerShape(12.dp),
            medium = RoundedCornerShape(16.dp),
            large = RoundedCornerShape(24.dp),
        ),
        content = content,
    )
}

@Composable
private fun DeviceScreen(
    status: DeviceStatus,
    content: ContentSyncStatus,
    access: RequiredAccess,
    granting: Boolean,
    setupFailure: String?,
    grant: () -> Unit,
    server: String?,
    scanMessage: String?,
    scan: () -> Unit,
    enroll: (String, String?) -> Unit,
    saveServer: (String) -> Unit,
    sync: () -> Unit,
    reset: () -> Unit,
    settings: () -> Unit,
    addTile: (() -> Unit)?,
    chooseFolder: () -> Unit,
    inspectFolder: () -> Unit,
    customers: CustomersRepository,
    scope: CoroutineScope,
) {
    var tab by rememberSaveable { mutableStateOf(0) }
    // Only the id survives recreation; names and phone numbers are re-read from the in-memory repository.
    var conversationId by rememberSaveable { mutableStateOf<String?>(null) }
    var conversationName by remember { mutableStateOf("") }
    var conversationPhone by remember { mutableStateOf("") }
    val openConversation = { id: String, name: String, phone: String ->
        conversationName = name
        conversationPhone = phone
        conversationId = id
    }
    Scaffold(containerColor = MaterialTheme.colorScheme.background) { insets ->
        Column(
            Modifier.fillMaxSize().padding(insets).imePadding(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            val open = conversationId
            if (open != null) {
                ConversationScreen(
                    customers, scope, open, conversationName, conversationPhone,
                    close = {
                        customers.closeConversation()
                        conversationId = null
                    },
                    modifier = Modifier.widthIn(max = 640.dp).weight(1f),
                )
            } else {
                Row(
                    Modifier.widthIn(max = 640.dp).fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Surface(color = Color(0xFF103F3A), shape = RoundedCornerShape(14.dp)) {
                        Icon(
                            painterResource(R.drawable.ic_linekeep_mark),
                            contentDescription = null,
                            tint = Color(0xFFB9E7CF),
                            modifier = Modifier.padding(8.dp).size(32.dp),
                        )
                    }
                    Column(Modifier.weight(1f)) {
                        Text(
                            stringResource(R.string.app_name),
                            style = MaterialTheme.typography.headlineSmall,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text("Calls, kept together", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                TabRow(
                    selectedTabIndex = tab,
                    modifier = Modifier.widthIn(max = 640.dp),
                    containerColor = MaterialTheme.colorScheme.background,
                    contentColor = MaterialTheme.colorScheme.primary,
                    divider = {},
                ) {
                    Tab(selected = tab == 0, onClick = { tab = 0 }, modifier = Modifier.heightIn(min = 48.dp), text = { Text("Home") })
                    Tab(selected = tab == 1, onClick = { tab = 1 }, modifier = Modifier.heightIn(min = 48.dp), text = { Text("Advanced") })
                    Tab(selected = tab == 2, onClick = { tab = 2 }, modifier = Modifier.heightIn(min = 48.dp), text = { Text("Customers") })
                    Tab(selected = tab == 3, onClick = { tab = 3 }, modifier = Modifier.heightIn(min = 48.dp), text = { Text("Chats") })
                }
                Box(Modifier.widthIn(max = 640.dp).weight(1f)) {
                    when (tab) {
                        0 -> HomeScreen(status, content, access, granting, setupFailure, grant, server, scanMessage, scan, enroll, sync, reset)
                        1 -> AdvancedScreen(status, content, access, granting, server, scanMessage, scan, enroll, saveServer, settings, addTile, chooseFolder, inspectFolder)
                        2 -> CustomersTab(customers, scope, openConversation)
                        else -> ChatsTab(customers, scope, openConversation)
                    }
                }
            }
        }
    }
}

@Composable
internal fun SectionCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(
                title,
                modifier = Modifier.semantics { heading() },
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            content()
        }
    }
}

@Composable
internal fun SupportingText(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
internal fun DetailField(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SupportingText(label)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun readableTime(value: String?): String = remember(value) {
    if (value.isNullOrBlank()) "Not yet"
    else try {
        DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
            .withZone(ZoneId.systemDefault()).format(Instant.parse(value))
    } catch (_: DateTimeParseException) {
        value
    }
}

@Composable
private fun HomeScreen(
    status: DeviceStatus,
    content: ContentSyncStatus,
    access: RequiredAccess,
    granting: Boolean,
    setupFailure: String?,
    grant: () -> Unit,
    server: String?,
    scanMessage: String?,
    scan: () -> Unit,
    enroll: (String, String?) -> Unit,
    sync: () -> Unit,
    reset: () -> Unit,
) {
    // Plaintext is intentionally not saved across recreation or tab changes.
    var invitation by remember { mutableStateOf("") }
    var connectionAttempted by remember { mutableStateOf(false) }
    val connected = status.deviceId != null && !status.unauthorized && !status.storageUnavailable
    val ready = connected && content.setupAccepted && access.runtimeGranted && content.folderAccessible
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Surface(
            shape = MaterialTheme.shapes.large,
            color = MaterialTheme.colorScheme.primaryContainer,
            contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    when {
                        !status.loaded -> "Loading connection…"
                        status.storageUnavailable -> "Connection unavailable"
                        status.unauthorized -> "Connection needs attention"
                        connected -> "Connected"
                        else -> "Not connected"
                    },
                    style = MaterialTheme.typography.labelLarge,
                )
                Text(
                    if (connected) status.employeeName.ifBlank { "Your device" } else "Connect your device",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    when {
                        !status.loaded -> "Checking this device’s saved connection."
                        status.storageUnavailable -> "Saved credentials could not be opened. Contact your manager; no new connection has been created."
                        status.unauthorized -> "This connection has expired or been revoked. Contact your manager."
                        ready -> "All access is granted. Your device is ready to sync."
                        connected && !content.setupAccepted -> "Accept sharing and grant access below to start syncing."
                        connected -> "Some access is missing. After sharing is accepted, available call history and recordings can sync independently."
                        else -> "Use a one-time setup or recovery code from your manager to connect this device."
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (connected) {
                    Text("${content.pendingCallLogs} calls · ${content.pendingUploads} recordings waiting", style = MaterialTheme.typography.labelLarge)
                    Text("Last upload · ${readableTime(content.lastSuccessfulUploadAt)}", style = MaterialTheme.typography.bodySmall)
                }
                Button(
                    onClick = sync,
                    enabled = connected && !status.busy && !granting,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) { Text(if (status.busy && connected) "Syncing…" else "Sync now") }
            }
        }
        if (status.unauthorized) {
            SectionCard("Connection rejected") {
                SupportingText("The server no longer accepts this phone's saved connection. It may have been revoked, or replaced by a recovery on a reinstall. Ask your manager for a new setup or recovery code, then remove the old connection here and scan it.")
                OutlinedButton(
                    onClick = reset,
                    enabled = !status.busy,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) { Text("Remove old connection and scan again") }
            }
        }
        if (status.loaded && status.deviceId == null && !status.storageUnavailable) {
            SectionCard("Setup or recovery") {
                SupportingText("Scan the QR code from your manager, or enter the code by hand. Recovery reconnects an existing enrollment after a reinstall.")
                Button(
                    onClick = scan,
                    enabled = !status.busy,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) { Text("Scan QR code") }
                scanMessage?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                OutlinedTextField(
                    value = invitation,
                    onValueChange = { if (it.length <= MAX_SETUP_CODE_CHARS) invitation = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Setup or recovery code") },
                    singleLine = true,
                    enabled = !status.busy,
                    shape = MaterialTheme.shapes.medium,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
                )
                Text(
                    if (server != null) "Server: ${serverHost(server)}" else "No server set — scan a QR code or set one in Advanced",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (server != null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
                )
                Button(
                    enabled = invitation.isNotBlank() && server != null && !status.busy,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    onClick = {
                        val code = invitation
                        invitation = ""
                        connectionAttempted = true
                        enroll(code, null)
                    },
                ) { Text(if (status.busy) "Connecting…" else "Connect") }
                if (connectionAttempted && !status.busy) {
                    Text("Could not connect. Check your code and internet connection; see Advanced for details.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                }
            }
        }
        SectionCard("Sharing & access") {
            SupportingText("Only the access you grant is used. Review what will be shared before continuing.")
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                AccessRow("Phone information", access.phoneState)
                AccessRow("SIM phone numbers", access.phoneNumbers)
                AccessRow("Call history", access.callHistory)
                AccessRow("Status notifications", access.notifications)
                AccessRow("Unrestricted background activity", access.background.unrestricted)
                AccessRow("Recordings folder", content.folderAccessible)
            }
            SupportingText(stringResource(R.string.sharing_disclosure))
            Button(
                onClick = grant,
                enabled = !granting && status.loaded && !status.storageUnavailable,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) {
                Text(if (granting) "Setting up access…" else "Grant permissions")
            }
            if (access.needsSettings) {
                Text(
                    "Some access needs Android settings. Open Advanced for permission and notification controls.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            } else if (!content.setupAccepted || !access.runtimeGranted || !content.folderAccessible) {
                SupportingText("Grant permissions walks through sharing consent, Android access and the recordings folder. Once sharing is accepted, sources with access can sync.")
            }
            access.background.problem?.let {
                Text(
                    "$it This is required for calls and recordings to upload while the app is closed. Tap Grant permissions and choose Allow, or set Battery to Unrestricted in Android app settings.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            if (setupFailure != null) {
                Text(setupFailure, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        }
        SectionCard("Sync activity") {
            Text(content.detail, style = MaterialTheme.typography.bodyMedium)
            content.recordingWaitMessage?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            status.heartbeatMessage?.let { SupportingText(it) }
            DetailField("Last scan", readableTime(content.lastScanAt))
            SupportingText("Call-end and folder changes trigger sync. Recordings are checked for up to 5 minutes; hourly recovery catches missed work. Android may delay background checks.")
        }
    }
}

@Composable
private fun AccessRow(label: String, granted: Boolean) {
    val green = if (isSystemInDarkTheme()) Color(0xFF9CDEB5) else Color(0xFF20623B)
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).semantics(mergeDescendants = true) {}.padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Surface(
            shape = CircleShape,
            color = if (granted) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.size(32.dp),
        ) {
            Box(contentAlignment = Alignment.Center) {
                if (granted) {
                    Icon(painterResource(R.drawable.ic_access_check), contentDescription = null, tint = green, modifier = Modifier.size(20.dp))
                } else {
                    Text("—", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelLarge)
                }
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, style = MaterialTheme.typography.bodyMedium)
            Text(
                if (granted) "Granted" else "Not granted",
                color = if (granted) green else MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelMedium,
            )
        }
    }
}

@Composable
private fun AdvancedScreen(
    status: DeviceStatus,
    content: ContentSyncStatus,
    access: RequiredAccess,
    granting: Boolean,
    server: String?,
    scanMessage: String?,
    scan: () -> Unit,
    enroll: (String, String?) -> Unit,
    saveServer: (String) -> Unit,
    settings: () -> Unit,
    addTile: (() -> Unit)?,
    chooseFolder: () -> Unit,
    inspectFolder: () -> Unit,
) {
    // The server receives this phone's bearer token, so it is locked once enrolled. Plaintext codes are never saved.
    val serverLocked = status.deviceId != null || status.storageUnavailable
    var serverInput by remember(server) { mutableStateOf(server.orEmpty()) }
    var serverError by remember { mutableStateOf<String?>(null) }
    var setupCode by remember { mutableStateOf("") }
    val appName = stringResource(R.string.app_name)
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Device details & controls", Modifier.padding(horizontal = 4.dp), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        SupportingText("Manage Android access and view the details your manager may need.")
        SectionCard("Android controls") {
            OutlinedButton(onClick = settings, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text("Android app & permission settings")
            }
            SupportingText("You can revoke permissions, manage notifications, clear app data or uninstall in Android Settings. The launcher remains available. The ongoing status notification is available when notifications are allowed.")
            if (access.needsSettings) {
                Text("Android will not show every permission prompt again. Open app settings, then Permissions or Notifications, to grant missing access.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
            }
            if (!access.callHistory) {
                SupportingText(stringResource(R.string.restricted_history_explanation, appName))
            }
            if (addTile != null) {
                OutlinedButton(onClick = addTile, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Text("Add Quick Settings shortcut")
                }
            } else {
                SupportingText(stringResource(R.string.tile_instructions, appName))
            }
        }
        SectionCard("Recordings folder") {
            Text(content.folderLabel ?: "No folder selected", style = MaterialTheme.typography.bodyMedium)
            AccessRow("Selected folder access", content.folderAccessible)
            SupportingText(stringResource(R.string.recording_explanation, appName))
            OutlinedButton(
                onClick = chooseFolder,
                enabled = !status.busy && !granting,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) {
                Text(if (content.folderLabel == null) "Choose recordings folder" else "Change recordings folder")
            }
            OutlinedButton(
                onClick = inspectFolder,
                enabled = content.folderAccessible && !status.busy && !granting,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) { Text("Inspect folder") }
        }
        SectionCard("Sync diagnostics") {
            SupportingText(if (content.setupAccepted) "Company sharing setup accepted." else "Sharing has not been accepted. Use Grant permissions on Home.")
            SupportingText(if (access.notifications) "Status notifications are enabled." else "Status notifications are not enabled. Check app and notification-channel settings.")
            SupportingText(access.background.problem ?: "Unrestricted background activity is allowed.")
            SupportingText("New calls and readable recordings trigger sync when Android permits. Files must finish writing; network and background restrictions can delay uploads. Periodic checks provide a fallback.")
            SelectionContainer {
                Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text(content.detail, style = MaterialTheme.typography.bodyMedium)
                    content.recordingWaitMessage?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    DetailField("Pending", "${content.pendingUploads} recordings · ${content.pendingCallLogs} calls")
                    DetailField("Completed", "${content.uploadedRecordings} uploaded recordings · ${content.syncedCallLogs} synced calls")
                    DetailField("Last scan", content.lastScanAt ?: "Never")
                    DetailField("Last successful upload", content.lastSuccessfulUploadAt ?: "Never")
                    if (content.recent.isNotEmpty()) {
                        Text("Recent results", style = MaterialTheme.typography.titleSmall)
                        content.recent.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                    }
                }
            }
        }
        SectionCard("Connection") {
            OutlinedTextField(
                value = serverInput,
                onValueChange = {
                    if (it.length <= 2048) {
                        serverInput = it
                        serverError = null
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Server URL") },
                placeholder = { Text("https://example.com") },
                singleLine = true,
                enabled = !serverLocked && !status.busy,
                isError = serverError != null,
                supportingText = serverError?.let { message -> @Composable { Text(message) } },
                shape = MaterialTheme.shapes.medium,
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Uri),
            )
            if (serverLocked) {
                SupportingText("The server cannot be changed while this phone is connected, because it receives this phone's credential. To use another server, clear this app's data in Android Settings or reinstall, then connect with a new setup or recovery code.")
            } else {
                OutlinedButton(
                    enabled = serverInput.isNotBlank() && !status.busy,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    onClick = {
                        val origin = validateServerUrl(serverInput)
                        if (origin == null) serverError = "Enter an HTTPS address such as https://example.com, without a path, query or login."
                        else saveServer(origin)
                    },
                ) { Text("Save server") }
                SupportingText("Setup QR codes from your manager include the server. Enter it here only if you were given the address and code separately.")
                Button(
                    onClick = scan,
                    enabled = !status.busy,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) { Text("Scan QR code") }
                OutlinedTextField(
                    value = setupCode,
                    onValueChange = { if (it.length <= MAX_SETUP_CODE_CHARS) setupCode = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Setup or recovery code") },
                    singleLine = true,
                    enabled = !status.busy,
                    shape = MaterialTheme.shapes.medium,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
                )
                Button(
                    enabled = setupCode.isNotBlank() && !status.busy && (serverInput.isNotBlank() || server != null),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    onClick = {
                        val typed = serverInput.trim()
                        val origin = if (typed.isEmpty()) null else validateServerUrl(typed)
                        if (typed.isNotEmpty() && origin == null) {
                            serverError = "Enter an HTTPS address such as https://example.com, without a path, query or login."
                        } else {
                            val code = setupCode
                            setupCode = ""
                            enroll(code, origin?.takeIf { it != server })
                        }
                    },
                ) { Text(if (status.busy) "Connecting…" else "Connect") }
                scanMessage?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            }
        }
        SectionCard("Upload destination") {
            SelectionContainer {
                Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    DetailField("Backend URL", server ?: "Not set")
                    DetailField("Enrollment ID", status.deviceId ?: "Not enrolled")
                    DetailField("Device credential (partially hidden)", status.credentialHint.ifEmpty { "None saved" })
                }
            }
            SupportingText("Call history and recordings upload to this backend using this installation's credential. The full credential is never shown.")
        }
        SectionCard("Enrollment") {
            SelectionContainer {
                Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    DetailField("Enrollment ID", status.deviceId ?: "Not enrolled")
                    DetailField("Original invitation ID", status.invitationId ?: "Unknown")
                    DetailField("Latest setup / recovery invitation ID", status.lastInvitationId ?: "Unknown")
                    DetailField("Employee", status.employeeName.ifBlank { "Unknown" })
                    DetailField("Employee ID", status.employeeId.ifBlank { "Unknown" })
                    DetailField("Last successful heartbeat", status.lastSync.ifEmpty { "Never" })
                    status.heartbeatMessage?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    Text(status.message, style = MaterialTheme.typography.bodyMedium)
                }
            }
            SupportingText("Your manager controls assignment. Reinstalling clears credentials and requires a new one-use recovery code from your manager to reconnect the same enrollment. Permissions and folder access must be granted again. Public IDs cannot reconnect the app.")
        }
        SectionCard("SIM information") {
            SupportingText("Read-only · reported by Android")
            Text(status.sim.explanation, style = MaterialTheme.typography.bodyMedium)
            SelectionContainer {
                Text(status.sim.numbers.joinToString("\n").ifEmpty { "No numbers available" }, style = MaterialTheme.typography.bodyMedium)
            }
            SupportingText("Carrier-reported SIM numbers may be missing or incorrect. They are not verified and do not identify your enrollment. Call-specific SIM details are shared only when Android identifies that call's line; no default SIM is assumed.")
        }
        SupportingText("$appName · ${BuildConfig.VERSION_NAME}")
    }
}
