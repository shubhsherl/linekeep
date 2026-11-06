package com.microorganics.calltracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CallSyncAccessTest {
    private val unrestricted = BackgroundStatus(ignoringOptimizations = true)
    private val phone = "android.permission.READ_PHONE_STATE"

    private fun notice(
        enrolled: Boolean = true,
        accepted: Boolean = true,
        phoneState: Boolean = true,
        phoneNumbers: Boolean = true,
        callHistory: Boolean = true,
        notifications: Boolean = true,
        background: BackgroundStatus = unrestricted,
        folder: Boolean = true,
        requestable: List<String> = emptyList(),
    ) = callSyncNotice(enrolled, accepted, phoneState, phoneNumbers, callHistory, notifications, background, folder, requestable)

    @Test fun hiddenWhenEverythingIsGranted() {
        assertEquals(CallSyncNotice.Hidden, notice())
    }

    @Test fun notEnrolledShowsTheSetupHintInsteadOfTheBanner() {
        assertEquals(CallSyncNotice.NotEnrolled, notice(enrolled = false, callHistory = false, folder = false))
    }

    @Test fun listsEveryMissingItem() {
        val result = notice(
            accepted = false, phoneState = false, phoneNumbers = false, callHistory = false,
            notifications = false, background = BackgroundStatus(), folder = false,
        ) as CallSyncNotice.Missing
        assertEquals(CallSyncItem.entries.toList(), result.items.sortedBy { it.ordinal })
    }

    @Test fun requestablePermissionsAreRequestedWithTheStandardPrompt() {
        val result = notice(callHistory = false, folder = false, requestable = listOf(phone)) as CallSyncNotice.Missing
        assertEquals(listOf(CallSyncItem.CALL_HISTORY, CallSyncItem.FOLDER), result.items)
        assertEquals(CallSyncAction.REQUEST_PERMISSIONS, result.action)
    }

    @Test fun permanentlyDeniedPermissionOpensAppSettings() {
        val result = notice(callHistory = false) as CallSyncNotice.Missing
        assertEquals(CallSyncAction.OPEN_APP_SETTINGS, result.action)
    }

    @Test fun unacceptedSharingSendsTheEmployeeToSetup() {
        val result = notice(accepted = false, callHistory = false, requestable = listOf(phone)) as CallSyncNotice.Missing
        assertEquals(CallSyncAction.OPEN_SETUP, result.action)
    }

    @Test fun batteryOptimisationUsesTheAllowDialogUnlessAlreadyExempt() {
        val optimised = notice(background = BackgroundStatus()) as CallSyncNotice.Missing
        assertEquals(listOf(CallSyncItem.BACKGROUND), optimised.items)
        assertEquals(CallSyncAction.ALLOW_BACKGROUND, optimised.action)
        val restricted = notice(background = BackgroundStatus(ignoringOptimizations = true, backgroundRestricted = true)) as CallSyncNotice.Missing
        assertEquals(CallSyncAction.OPEN_APP_SETTINGS, restricted.action)
    }

    @Test fun folderIsLastAndUsesThePicker() {
        val result = notice(folder = false) as CallSyncNotice.Missing
        assertEquals(CallSyncAction.CHOOSE_FOLDER, result.action)
        assertTrue(CallSyncItem.FOLDER in result.items)
    }
}
