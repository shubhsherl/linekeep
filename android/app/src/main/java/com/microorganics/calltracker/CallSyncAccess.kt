package com.microorganics.calltracker

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/** One thing the call sync needs that is not in place yet, named in the plain words the employee sees. */
internal enum class CallSyncItem(@StringRes val label: Int) {
    SHARING(R.string.perm_item_sharing),
    CALL_HISTORY(R.string.perm_item_call_history),
    PHONE_STATE(R.string.perm_item_phone_state),
    PHONE_NUMBERS(R.string.perm_item_phone_numbers),
    NOTIFICATIONS(R.string.perm_item_notifications),
    BACKGROUND(R.string.perm_item_background),
    FOLDER(R.string.perm_item_folder),
}

/** What the banner button does. Every action starts from a tap; nothing is ever requested automatically. */
internal enum class CallSyncAction(@StringRes val button: Int) {
    OPEN_SETUP(R.string.perm_action_setup),
    REQUEST_PERMISSIONS(R.string.perm_action_grant),
    OPEN_APP_SETTINGS(R.string.perm_action_settings),
    ALLOW_BACKGROUND(R.string.perm_action_background),
    CHOOSE_FOLDER(R.string.perm_action_folder),
}

internal sealed interface CallSyncNotice {
    /** Everything the call sync needs is in place. */
    data object Hidden : CallSyncNotice

    /** The phone is not connected yet, so there is nothing to grant before Settings > Setup. */
    data object NotEnrolled : CallSyncNotice

    data class Missing(val items: List<CallSyncItem>, val action: CallSyncAction) : CallSyncNotice
}

/**
 * Decides whether the call-sync banner shows, what is missing and what one tap should do next. [requestable] holds the
 * runtime permissions Android will still prompt for; a permission left out of it yet not granted was permanently denied.
 */
internal fun callSyncNotice(
    enrolled: Boolean,
    setupAccepted: Boolean,
    phoneState: Boolean,
    phoneNumbers: Boolean,
    callHistory: Boolean,
    notifications: Boolean,
    background: BackgroundStatus,
    folderAccessible: Boolean,
    requestable: Collection<String>,
): CallSyncNotice {
    if (!enrolled) return CallSyncNotice.NotEnrolled
    val items = buildList {
        if (!setupAccepted) add(CallSyncItem.SHARING)
        if (!callHistory) add(CallSyncItem.CALL_HISTORY)
        if (!phoneState) add(CallSyncItem.PHONE_STATE)
        if (!phoneNumbers) add(CallSyncItem.PHONE_NUMBERS)
        if (!notifications) add(CallSyncItem.NOTIFICATIONS)
        if (!background.unrestricted) add(CallSyncItem.BACKGROUND)
        if (!folderAccessible) add(CallSyncItem.FOLDER)
    }
    if (items.isEmpty()) return CallSyncNotice.Hidden
    val runtimeMissing = items.any {
        it == CallSyncItem.CALL_HISTORY || it == CallSyncItem.PHONE_STATE || it == CallSyncItem.PHONE_NUMBERS ||
            it == CallSyncItem.NOTIFICATIONS
    }
    val action = when {
        CallSyncItem.SHARING in items -> CallSyncAction.OPEN_SETUP
        requestable.isNotEmpty() && runtimeMissing -> CallSyncAction.REQUEST_PERMISSIONS
        runtimeMissing -> CallSyncAction.OPEN_APP_SETTINGS
        CallSyncItem.BACKGROUND in items ->
            if (background.ignoringOptimizations) CallSyncAction.OPEN_APP_SETTINGS else CallSyncAction.ALLOW_BACKGROUND
        else -> CallSyncAction.CHOOSE_FOLDER
    }
    return CallSyncNotice.Missing(items, action)
}

/** Shown on top of both call-analytics tabs; the owner re-evaluates [notice] on resume so it disappears once fixed. */
@Composable
internal fun CallSyncBanner(notice: CallSyncNotice, act: (CallSyncAction) -> Unit, modifier: Modifier = Modifier) {
    when (notice) {
        CallSyncNotice.Hidden -> Unit
        CallSyncNotice.NotEnrolled -> Box(modifier) { SupportingText(stringResource(R.string.perm_not_enrolled)) }
        is CallSyncNotice.Missing -> Surface(
            modifier = modifier.fillMaxWidth(),
            color = MaterialTheme.colorScheme.errorContainer,
            contentColor = MaterialTheme.colorScheme.onErrorContainer,
            shape = MaterialTheme.shapes.medium,
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    stringResource(R.string.perm_banner_title),
                    Modifier.semantics { heading() },
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(stringResource(R.string.perm_banner_intro), style = MaterialTheme.typography.bodyMedium)
                notice.items.forEach { Text("• " + stringResource(it.label), style = MaterialTheme.typography.bodyMedium) }
                Button(onClick = { act(notice.action) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Text(stringResource(notice.action.button))
                }
            }
        }
    }
}
