package com.chokabarah.game.ui

import kotlin.math.abs
import org.junit.Assert.assertTrue
import org.junit.Test

// Layout math for stacked pawn rendering: every pawn in a cell must occupy a
// DISTINCT position — the old i % 4 offset table wrapped and drew the 5th+
// pawn exactly on top of the first four (possible when two Gattis coexist on
// one square in 3-4 player games).
class PawnStackOffsetTest {

    private fun distinct(count: Int): Boolean {
        val offsets = (0 until count).map { pawnStackOffset(count, it, 10f) }
        for (a in 0 until count) for (b in a + 1 until count) {
            val (ax, ay) = offsets[a]
            val (bx, by) = offsets[b]
            if (abs(ax - bx) < 0.01f && abs(ay - by) < 0.01f) return false
        }
        return true
    }

    @Test
    fun everyPawnInStacksOfTwoToEightGetsADistinctPosition() {
        for (count in 2..8) {
            assertTrue("count=$count positions must be distinct", distinct(count))
        }
    }

    @Test
    fun singlePawnIsCentered() {
        val (x, y) = pawnStackOffset(1, 0, 10f)
        assertTrue(abs(x) < 0.001f && abs(y) < 0.001f)
    }

    @Test
    fun circularLayoutStaysWithinExpectedRadius() {
        // 4+ pawns sit on a circle of at most ~0.95 * radius.
        for (count in 4..8) {
            for (i in 0 until count) {
                val (x, y) = pawnStackOffset(count, i, 10f)
                assertTrue("count=$count i=$i radius", abs(x) <= 9.6f && abs(y) <= 9.6f)
            }
        }
    }
}
