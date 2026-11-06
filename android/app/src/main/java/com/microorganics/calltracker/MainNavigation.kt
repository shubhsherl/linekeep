package com.microorganics.calltracker

import androidx.annotation.DrawableRes

/** Bottom navigation, in display order. */
internal enum class MainDestination(val label: String, @DrawableRes val icon: Int) {
    CUSTOMERS("Customers", R.drawable.ic_nav_customers),
    CHATS("WhatsApp", R.drawable.ic_nav_chat),
    ANALYTICS("Call analytics", R.drawable.ic_nav_analytics),
    SETTINGS("Settings", R.drawable.ic_nav_settings),
    ;

    companion object {
        /** Unknown values (for example a state saved by an older build) fall back to the first destination. */
        fun fromIndex(index: Int): MainDestination = entries.getOrElse(index) { CUSTOMERS }
    }
}

internal enum class SettingsSection(val label: String) {
    SETUP("Setup"),
    ADVANCED("Advanced"),
    ;

    companion object {
        fun fromIndex(index: Int): SettingsSection = entries.getOrElse(index) { SETUP }
    }
}

internal enum class AnalyticsSection(val label: String) {
    ANALYTICS("Analytics"),
    CALL_LOGS("Call logs"),
    ;

    companion object {
        fun fromIndex(index: Int): AnalyticsSection = entries.getOrElse(index) { ANALYTICS }
    }
}

/** The destination a notification tap lands on: new assignments open Customers, new messages open WhatsApp. */
internal fun OpenRequest.destination(): MainDestination =
    if (type == PUSH_TYPE_ASSIGNED) MainDestination.CUSTOMERS else MainDestination.CHATS

/** An open conversation fills the screen with its own top bar; every other screen keeps the bottom bar. */
internal fun showsBottomBar(conversationId: String?): Boolean = conversationId == null

/** Live chat updates matter only while the chat list is what the employee sees. */
internal fun chatsVisible(destination: MainDestination): Boolean = destination == MainDestination.CHATS
