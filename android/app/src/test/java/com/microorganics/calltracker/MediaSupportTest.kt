package com.microorganics.calltracker

import org.junit.Assert.assertEquals
import org.junit.Test

class MediaSupportTest {
    private fun media(kind: MediaKind, mime: String? = null, name: String? = null) = MessageMedia(kind, "/v1/device/whatsapp/messages/m/media", mime, name)

    @Test fun sampleSizeKeepsLongestEdgeAtLeastTarget() {
        assertEquals(1, sampleSizeFor(600, 400, 660))
        assertEquals(1, sampleSizeFor(1000, 800, 660))
        assertEquals(2, sampleSizeFor(1400, 900, 660))
        assertEquals(4, sampleSizeFor(5000, 4000, 660))
    }

    @Test fun fileNameUsesServerNameOrFallsBackToIdAndExtension() {
        assertEquals("report.pdf", suggestedFileName("wam_1", media(MediaKind.DOCUMENT, "application/pdf", "report.pdf")))
        assertEquals("_report.pdf", suggestedFileName("wam_1", media(MediaKind.DOCUMENT, null, "../report.pdf")))
        assertEquals("whatsapp-wam_1.jpg", suggestedFileName("wam_1", media(MediaKind.IMAGE, "image/jpeg")))
        assertEquals("whatsapp-wam_1.webp", suggestedFileName("wam_1", media(MediaKind.STICKER)))
        assertEquals("whatsapp-wam_1.bin", suggestedFileName("wam_1", media(MediaKind.DOCUMENT, "application/x-weird")))
    }

    @Test fun pathSeparatorsNeverSurviveInFileNames() {
        assertEquals("_etc_passwd", safeFileName("../etc/passwd"))
    }

    @Test fun sizesAreHumanReadable() {
        assertEquals("512 B", formatSize(512))
        assertEquals("2 KB", formatSize(2048))
        assertEquals("1.5 MB", formatSize(1_572_864))
    }

    @Test fun mergeKeepsOlderItemsAndRefreshesNewest() {
        val known = listOf("c", "b", "a")
        assertEquals(listOf("d", "c", "b", "a"), mergeNewestPage(known, listOf("d", "c"), { it }))
        assertEquals(listOf("z", "y"), mergeNewestPage(known, listOf("z", "y"), { it }))
        assertEquals(known, mergeNewestPage(known, emptyList(), { it }))
    }
}
