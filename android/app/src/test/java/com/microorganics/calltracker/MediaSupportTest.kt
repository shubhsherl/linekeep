package com.microorganics.calltracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaSupportTest {
    private fun media(kind: MediaKind, mime: String? = null, name: String? = null) = MessageMedia(kind, "/v1/device/whatsapp/messages/m/media", mime, name)

    @Test fun sampleSizeKeepsLongestEdgeAtLeastTarget() {
        assertEquals(1, sampleSizeFor(600, 400, 660))
        assertEquals(1, sampleSizeFor(1000, 800, 660))
        assertEquals(2, sampleSizeFor(1400, 900, 660))
        assertEquals(4, sampleSizeFor(5000, 4000, 660))
    }

    @Test fun thumbnailEdgeFollowsScreenDensityWithinBounds() {
        assertEquals(660, thumbnailEdgePx(3f))
        assertEquals(440, thumbnailEdgePx(2f))
        assertEquals(330, thumbnailEdgePx(1.5f))
        assertEquals(880, thumbnailEdgePx(4f))
        assertEquals(900, thumbnailEdgePx(6f))
        assertEquals(220, thumbnailEdgePx(0.5f))
    }

    @Test fun lowerDensityScreensDecodeSmallerThumbnails() {
        assertEquals(4, sampleSizeFor(4000, 3000, thumbnailEdgePx(3f)))
        assertEquals(8, sampleSizeFor(4000, 3000, thumbnailEdgePx(2f)))
    }

    @Test fun viewerDecodeFitsTheScreenInsteadOfTheFullPhoto() {
        // 4032x3000 on a 1080x2400 screen: 3.7x wider than the screen, so a 2x reduction still covers it.
        assertEquals(2, fitSampleSize(4032, 3000, 1080, 2400))
        // 720x1600 phone: a 5x reduction is not allowed, 4x is.
        assertEquals(4, fitSampleSize(4032, 3000, 720, 1600))
        assertEquals(1, fitSampleSize(1600, 1200, 1080, 2400))
        assertEquals(8, fitSampleSize(12000, 2000, 1080, 2400))
        assertEquals(1, fitSampleSize(4032, 3000, 0, 0))
    }

    @Test fun thumbnailCacheIsBoundedByTheHeapLimit() {
        assertEquals(8 * 1024 * 1024, thumbnailCacheBytes(128L * 1024 * 1024))
        assertEquals(16 * 1024 * 1024, thumbnailCacheBytes(512L * 1024 * 1024))
        assertEquals(4 * 1024 * 1024, thumbnailCacheBytes(32L * 1024 * 1024))
    }

    @Test fun thumbnailsAreDroppedOnceAndroidReportsMemoryPressure() {
        assertFalse(shouldDropThumbnails(5))
        assertTrue(shouldDropThumbnails(10))
        assertTrue(shouldDropThumbnails(20))
        assertTrue(shouldDropThumbnails(80))
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
