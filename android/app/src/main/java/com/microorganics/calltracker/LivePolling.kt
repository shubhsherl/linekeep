package com.microorganics.calltracker

/** Failed polls stretch the interval up to this, whatever the policy. */
internal const val POLL_ERROR_MAX_MS = 60_000L

/**
 * How often the foreground app asks the server whether any WhatsApp message changed. The interval stays at [baseMs]
 * for [graceUnchanged] unchanged answers, then doubles per further unchanged answer up to [idleMaxMs]. A change,
 * a user action or a push puts it back to [baseMs].
 */
internal data class PollPolicy(val baseMs: Long, val idleMaxMs: Long, val graceUnchanged: Int) {
    companion object {
        /** Customers, chats and the other tabs: only the unread badge and the chat list depend on the answer. */
        val BROWSING = PollPolicy(baseMs = 15_000L, idleMaxMs = 60_000L, graceUnchanged = 2)

        /** A conversation is open and the employee may be waiting for a reply, so the ceiling stays low. */
        val CONVERSATION = PollPolicy(baseMs = 5_000L, idleMaxMs = 20_000L, graceUnchanged = 6)
    }
}

/**
 * Milliseconds to wait before the next poll. [failureStreak] counts consecutive failed polls and dominates
 * (doubling from the base up to [POLL_ERROR_MAX_MS]); otherwise [unchangedStreak] counts consecutive answers that
 * showed nothing new.
 */
internal fun nextPollDelay(policy: PollPolicy, unchangedStreak: Int, failureStreak: Int): Long {
    if (failureStreak > 0) return minOf(doubled(policy.baseMs, failureStreak), POLL_ERROR_MAX_MS)
    val beyondGrace = unchangedStreak - policy.graceUnchanged
    if (beyondGrace <= 0) return policy.baseMs
    return minOf(doubled(policy.baseMs, beyondGrace), maxOf(policy.idleMaxMs, policy.baseMs))
}

private fun doubled(base: Long, times: Int): Long {
    var value = base
    repeat(minOf(times, 20)) { value *= 2 }
    return value
}
