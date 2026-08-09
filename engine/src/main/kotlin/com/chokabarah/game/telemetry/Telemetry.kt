package com.chokabarah.game.telemetry

import kotlin.math.pow
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import java.util.logging.Level
import java.util.logging.Logger

/**
 * Structured telemetry / observability logger for Choka Barah (Android).
 *
 * Google/Meta-style structured (NDJSON) logging, gated by an enable flag so it
 * imposes ZERO runtime cost when disabled.
 *
 * Enablement resolution (highest priority first):
 *   1. Runtime system property "cb.telemetry.enabled"
 *   2. Environment variable "CB_TELEMETRY_ENABLED"
 *
 * On Android, callers may drive enablement explicitly via [setEnabled]
 * (e.g. from BuildConfig at startup) so the app keeps a build-time flag without
 * the pure-JVM engine depending on Android generated code.
 *
 * Output: single-line JSON records (NDJSON) via java.util.logging so they flow
 * through Logcat / adb logcat / a file handler unchanged.
 *
 * Record schema:
 *   timestamp, severity, level, logger(component), event, sessionId, traceId,
 *   spanId, message, context{}
 */
object Telemetry {

    @Volatile
    private var enabled: Boolean = computeEnabled()

    // ---- Level constants (machinable, matching web log levels) ----
    const val LEVEL_TRACE = 10
    const val LEVEL_DEBUG = 20
    const val LEVEL_INFO  = 30
    const val LEVEL_WARN  = 40
    const val LEVEL_ERROR = 50

    var minLevel: Int = LEVEL_INFO

    private val sessionId: String = "sess_" + UUID.randomUUID().toString()
    private val traceId: String = sessionId

    // OTel-style span stack for nested operation tracing.
    private val spanStack = ArrayDeque<Span>()

    private data class Span(
        val name: String,
        val spanId: String,
        val parentId: String?,
        val startNanos: Long,
        val fields: Map<String, Any?>
    )

    internal fun computeEnabled(): Boolean {
        // Runtime override wins (allows enabling without rebuild in debug).
        try {
            System.getProperty("cb.telemetry.enabled")?.let { prop ->
                return parseBool(prop)
            }
        } catch (_: Exception) { /* ignore */ }

        // Env override.
        try {
            System.getenv("CB_TELEMETRY_ENABLED")?.let { env ->
                return parseBool(env)
            }
        } catch (_: Exception) { /* ignore */ }

        return false
    }

    private fun parseBool(v: String): Boolean {
        return when (v.lowercase()) {
            "1", "true", "yes", "on" -> true
            else -> false
        }
    }

    fun setEnabled(value: Boolean) {
        enabled = value
        // Re-enabling starts a clean session: drop any level filter that a
        // previous session/test changed, and flush any span left open when the
        // telemetry was disabled mid-flight (BUG-11). A stale spanStack would
        // otherwise give new spans a bogus parent (span leak isolation).
        minLevel = LEVEL_INFO
        if (!value) {
            spanStack.clear()
        }
    }

    fun isEnabled(): Boolean = enabled

    // Test seam: number of spans currently on the stack. Used to verify the
    // span-leak isolation guarantees in setEnabled(false)/endSpan (BUG-11).
    internal fun spanDepth(): Int = spanStack.size

    fun getSessionId(): String = sessionId

    fun getTraceId(): String = traceId

    private val logger: Logger = Logger.getLogger("ChokaBarah.Telemetry")

    // ---- Span management (OTel-style) ----
    fun startSpan(name: String, fields: Map<String, Any?> = emptyMap()): String? {
        if (!enabled) return null
        val spanId = UUID.randomUUID().toString()
        val parent = spanStack.lastOrNull()
        val span = Span(
            name = name,
            spanId = spanId,
            parentId = parent?.spanId,
            startNanos = System.nanoTime(),
            fields = fields
        )
        spanStack.addLast(span)
        log(LEVEL_TRACE, "telemetry", "span.start", "start span $name",
            HashMap<String, Any?>().apply {
                put("spanId", spanId)
                put("parentId", span.parentId)
                put("name", name)
                putAll(fields)
            })
        return spanId
    }

    fun endSpan(spanId: String?, fields: Map<String, Any?> = emptyMap()) {
        // Always pop the span off the stack even when disabled: dropping telemetry
        // mid-flight must not leave a stale span that corrupts a later re-enable
        // (parent linkage / span leak isolation, BUG-11).
        if (spanId == null) return
        val idx = spanStack.indexOfFirst { it.spanId == spanId }
        if (idx < 0) {
            return
        }
        val span = spanStack.removeAt(idx)
        if (!enabled) return
        val durationMillis = (System.nanoTime() - span.startNanos) / 1_000_000
        val ctx = HashMap<String, Any?>()
        ctx["spanId"] = span.spanId
        ctx["parentId"] = span.parentId
        ctx["name"] = span.name
        ctx["durationMs"] = durationMillis
        ctx.putAll(span.fields)
        ctx.putAll(fields)
        log(LEVEL_DEBUG, "telemetry", "span.end", "end span ${span.name} (${durationMillis}ms)", ctx)
    }

    // ---- Core log ----
    private fun log(level: Int, component: String, event: String, message: String, context: Map<String, Any?>) {
        if (!enabled) return
        if (level < minLevel) return

        val record = buildRecord(level, component, event, message, context)
        val jl = when (level) {
            LEVEL_TRACE, LEVEL_DEBUG -> Level.FINE
            LEVEL_WARN -> Level.WARNING
            LEVEL_ERROR -> Level.SEVERE
            else -> Level.INFO
        }
        // Log as a single flat line (NDJSON) so aggregators can parse it.
        logger.log(jl, record)
    }

    private fun buildRecord(level: Int, component: String, event: String, message: String, context: Map<String, Any?>): String {
        val sb = StringBuilder(256)
        sb.append('{')
        sb.append("\"timestamp\":\"").append(jsonEscape(Instant.now().toString())).append('"')
        sb.append(",\"severity\":\"").append(severityName(level)).append('"')
        sb.append(",\"level\":").append(level)
        sb.append(",\"logger\":\"").append(jsonEscape(component)).append('"')
        sb.append(",\"event\":\"").append(jsonEscape(event)).append('"')
        sb.append(",\"sessionId\":\"").append(jsonEscape(sessionId)).append('"')
        sb.append(",\"traceId\":\"").append(jsonEscape(traceId)).append('"')
        val currentSpan = spanStack.lastOrNull()
        if (currentSpan != null) {
            sb.append(",\"spanId\":\"").append(jsonEscape(currentSpan.spanId)).append('"')
        }
        sb.append(",\"message\":\"").append(jsonEscape(message)).append('"')
        sb.append(",\"context\":{")
        var first = true
        for ((k, v) in context) {
            if (!first) sb.append(',')
            first = false
            sb.append('"').append(jsonEscape(k)).append("\":")
            sb.append(jsonSerializeValue(v))
        }
        sb.append("}}")
        return sb.toString()
    }

    private fun severityName(level: Int): String = when (level) {
        LEVEL_TRACE -> "TRACE"
        LEVEL_DEBUG -> "DEBUG"
        LEVEL_INFO -> "INFO"
        LEVEL_WARN -> "WARN"
        LEVEL_ERROR -> "ERROR"
        else -> "INFO"
    }

    // ---- Public convenience ----
    fun trace(component: String, event: String, message: String, context: Map<String, Any?> = emptyMap()) =
        log(LEVEL_TRACE, component, event, message, context)

    fun debug(component: String, event: String, message: String, context: Map<String, Any?> = emptyMap()) =
        log(LEVEL_DEBUG, component, event, message, context)

    fun info(component: String, event: String, message: String, context: Map<String, Any?> = emptyMap()) =
        log(LEVEL_INFO, component, event, message, context)

    fun warn(component: String, event: String, message: String, context: Map<String, Any?> = emptyMap()) =
        log(LEVEL_WARN, component, event, message, context)

    fun error(component: String, event: String, message: String, context: Map<String, Any?> = emptyMap()) =
        log(LEVEL_ERROR, component, event, message, context)

    // ---- JSON helpers ----
    private fun jsonEscape(s: String): String {
        val sb = StringBuilder(s.length)
        for (ch in s) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> sb.append(ch)
            }
        }
        return sb.toString()
    }

    private fun jsonSerializeValue(v: Any?): String = when (v) {
        null -> "null"
        is Boolean -> if (v) "true" else "false"
        is Int, is Long, is Short, is Byte -> v.toString()
        is Double, is Float -> formatNumber(v)
        is String -> "\"${jsonEscape(v)}\""
        is List<*> -> v.joinToString(prefix = "[", postfix = "]") { jsonSerializeValue(it) }
        is Map<*, *> -> v.entries.joinToString(prefix = "{", postfix = "}") { (k, value) ->
            "\"${jsonEscape(k.toString())}\":${jsonSerializeValue(value)}"
        }
        else -> "\"${jsonEscape(v.toString())}\""
    }

    private fun formatNumber(v: Any?): String {
        val d = when (v) {
            is Double -> v
            is Float -> v.toDouble()
            else -> 0.0
        }
        if (d == d.toLong().toDouble()) return d.toLong().toString()
        return d.toString()
    }
}
