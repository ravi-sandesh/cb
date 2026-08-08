package com.example.chokabara

import com.chokabarah.game.telemetry.Telemetry
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class TelemetryTest {

    @Before
    fun setup() {
        // Reset to a clean, disabled state before each test so a failed test
        // never leaks telemetry state into the next one.
        Telemetry.setEnabled(false)
        Telemetry.minLevel = Telemetry.LEVEL_INFO
    }

    @Test
    fun testDefaultDisabled() {
        assertFalse(Telemetry.isEnabled())
    }

    @Test
    fun testEnableDisable() {
        Telemetry.setEnabled(true)
        assertTrue(Telemetry.isEnabled())

        Telemetry.setEnabled(false)
        assertFalse(Telemetry.isEnabled())
    }

    @Test
    fun testLevelConstantsOrdered() {
        assertTrue(Telemetry.LEVEL_TRACE < Telemetry.LEVEL_DEBUG)
        assertTrue(Telemetry.LEVEL_DEBUG < Telemetry.LEVEL_INFO)
        assertTrue(Telemetry.LEVEL_INFO < Telemetry.LEVEL_WARN)
        assertTrue(Telemetry.LEVEL_WARN < Telemetry.LEVEL_ERROR)
    }

    @Test
    fun testMinLevelDefaultAndMutable() {
        assertEquals(Telemetry.LEVEL_INFO, Telemetry.minLevel)
        Telemetry.minLevel = Telemetry.LEVEL_WARN
        assertEquals(Telemetry.LEVEL_WARN, Telemetry.minLevel)
    }

    @Test
    fun testSessionAndTraceIdPresent() {
        assertNotNull(Telemetry.getSessionId())
        assertTrue(Telemetry.getSessionId().startsWith("sess_"))
        assertEquals(Telemetry.getSessionId(), Telemetry.getTraceId())
    }

    @Test
    fun testStartSpanReturnsNullWhenDisabled() {
        Telemetry.setEnabled(false)
        val spanId = Telemetry.startSpan("test.span", mapOf("k" to "v"))
        assertNull(spanId)
    }

    @Test
    fun testStartSpanReturnsIdWhenEnabled() {
        Telemetry.setEnabled(true)
        val spanId = Telemetry.startSpan("test.span", emptyMap())
        assertNotNull(spanId)
        assertTrue(spanId!!.isNotEmpty())
    }

    @Test
    fun testSpanLifecycleNoCrash() {
        Telemetry.setEnabled(true)
        val outer = Telemetry.startSpan("outer")
        val inner = Telemetry.startSpan("inner")
        assertNotNull(outer)
        assertNotNull(inner)
        Telemetry.endSpan(inner)
        Telemetry.endSpan(outer)
    }

    @Test
    fun testNestedSpansNoCrash() {
        Telemetry.setEnabled(true)
        val parent = Telemetry.startSpan("parent")
        val child1 = Telemetry.startSpan("child")
        Telemetry.endSpan(child1)
        val child2 = Telemetry.startSpan("child2")
        Telemetry.endSpan(child2)
        Telemetry.endSpan(parent)
    }

    @Test
    fun testEndSpanWithUnknownIdNoCrash() {
        Telemetry.setEnabled(true)
        Telemetry.endSpan("does-not-exist")
    }

    @Test
    fun testConvenienceMethodsNoCrash() {
        // Must not throw whether enabled or disabled
        Telemetry.setEnabled(false)
        Telemetry.trace("c", "evt", "msg")
        Telemetry.debug("c", "evt", "msg")
        Telemetry.info("c", "evt", "msg")
        Telemetry.warn("c", "evt", "msg")
        Telemetry.error("c", "evt", "msg")

        Telemetry.setEnabled(true)
        Telemetry.trace("c", "evt", "msg", mapOf("k" to 1))
        Telemetry.debug("c", "evt", "msg", mapOf("k" to "v"))
        Telemetry.info("c", "evt", "msg", mapOf("k" to listOf(1, 2)))
        Telemetry.warn("c", "evt", "msg", mapOf("k" to mapOf("nested" to true)))
        Telemetry.error("c", "evt", "msg", mapOf("k" to null))
    }

    @Test
    fun testGetTraceIdMatchesSession() {
        assertEquals(Telemetry.getSessionId(), Telemetry.getTraceId())
    }
}
