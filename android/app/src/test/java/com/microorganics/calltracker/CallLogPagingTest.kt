package com.microorganics.calltracker

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class CallLogPagingTest {
    private fun item(id: Int) = CallLogItem("cl_$id", id.toLong(), 0, "incoming", null, null, null, null, false)

    /** 5 calls served two at a time; cursors are the id of the last item served. */
    private class Server(var filterHits: MutableList<String?> = mutableListOf(), var failNext: Boolean = false)

    private fun list(server: Server, total: Int = 5): PagedList<CallLogItem> = PagedList({ it.id }) { query, cursor ->
        server.filterHits += query
        if (server.failNext) { server.failNext = false; throw IOException("offline") }
        val start = cursor?.toInt() ?: 0
        val end = minOf(start + 2, total)
        Page((start until end).map(::item), if (end < total) end.toString() else null)
    }

    @Test fun firstPageThenCursorPagesAreAppendedWithoutDuplicates() = runBlocking {
        val calls = list(Server())
        calls.refresh()
        assertEquals(listOf("cl_0", "cl_1"), calls.state.value.items.map { it.id })
        assertTrue(calls.state.value.loaded)
        calls.loadMore()
        calls.loadMore()
        assertEquals(5, calls.state.value.items.size)
        assertNull(calls.state.value.nextCursor)
        calls.loadMore()
        assertEquals(5, calls.state.value.items.size)
    }

    @Test fun refreshStartsOverFromTheNewestPage() = runBlocking {
        val calls = list(Server())
        calls.refresh()
        calls.loadMore()
        calls.refresh()
        assertEquals(listOf("cl_0", "cl_1"), calls.state.value.items.map { it.id })
        assertEquals("2", calls.state.value.nextCursor)
    }

    @Test fun searchQueryIsSentAndRepeatedSearchIsIgnored() = runBlocking {
        val server = Server()
        val calls = list(server)
        calls.search(" 9000 ")
        assertEquals(listOf<String?>("9000"), server.filterHits)
        calls.search("9000")
        assertEquals(1, server.filterHits.size)
        calls.search("")
        assertEquals(listOf<String?>("9000", null), server.filterHits)
    }

    @Test fun aFailedFirstLoadKeepsTheListUnloadedSoItRetries() = runBlocking {
        val server = Server(failNext = true)
        val calls = list(server)
        calls.ensureLoaded()
        assertFalse(calls.state.value.loaded)
        assertTrue(calls.state.value.error != null)
        calls.ensureLoaded()
        assertTrue(calls.state.value.loaded)
        assertNull(calls.state.value.error)
        assertEquals(2, calls.state.value.items.size)
    }

    @Test fun aFailedPageKeepsWhatIsLoaded() = runBlocking {
        val server = Server()
        val calls = list(server)
        calls.refresh()
        server.failNext = true
        calls.loadMore()
        assertEquals(2, calls.state.value.items.size)
        assertEquals("2", calls.state.value.nextCursor)
        assertFalse(calls.state.value.loadingMore)
        calls.loadMore()
        assertEquals(4, calls.state.value.items.size)
    }
}
