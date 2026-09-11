package com.chokabarah.game.ui

import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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

    // ---- Pair-cell classification + labels (web parity: rings, G/T tags,
    // pawn numbers). Pure helpers, pinned without a Compose draw pass. ----

    private fun cellPawn(id: Int, player: Int, path: Int) =
        PawnUi(id, player, com.chokabarah.game.engine.PawnState.ON_TRACK, path)

    @Test
    fun lonePawnAndMixedCellsHaveNoTag() {
        val grid = com.chokabarah.game.engine.GridSize.FIVE_BY_FIVE
        assertEquals(PairCellTag.NONE, classifyPairCell(grid, emptyMap(), listOf(cellPawn(0, 0, 20))))
        // Cross-player stack: vulnerable pile-up, never a ring.
        assertEquals(
            PairCellTag.NONE,
            classifyPairCell(grid, emptyMap(), listOf(cellPawn(0, 0, 20), cellPawn(4, 1, 10)))
        )
        // A HOME_BASE pawn sharing the start square never rings either.
        assertEquals(
            PairCellTag.NONE,
            classifyPairCell(
                grid, emptyMap(),
                listOf(cellPawn(0, 0, 0), PawnUi(1, 0, com.chokabarah.game.engine.PawnState.HOME_BASE, -1))
            )
        )
    }

    @Test
    fun innerPairIsTolluUnlessFlaggedToughened() {
        val grid = com.chokabarah.game.engine.GridSize.FIVE_BY_FIVE
        val pair = listOf(cellPawn(0, 0, 20), cellPawn(1, 0, 20)) // seat 0 inner (>= 16)
        assertEquals(PairCellTag.TOLLU, classifyPairCell(grid, emptyMap(), pair))
        assertEquals(PairCellTag.TOUGHENED, classifyPairCell(grid, mapOf(0 to setOf(20)), pair))
        // A flagged cell for ANOTHER seat does not toughen this pair.
        assertEquals(PairCellTag.TOLLU, classifyPairCell(grid, mapOf(1 to setOf(20)), pair))
    }

    @Test
    fun outerPairIsNotATollu() {
        val grid = com.chokabarah.game.engine.GridSize.FIVE_BY_FIVE
        val pair = listOf(cellPawn(0, 0, 3), cellPawn(1, 0, 3)) // outer track
        assertEquals(PairCellTag.NONE, classifyPairCell(grid, emptyMap(), pair))
    }

    @Test
    fun labelsMirrorWebParity() {
        assertEquals("1", pawnNumberLabel(0))
        assertEquals("4", pawnNumberLabel(3))
        assertEquals("2", pawnNumberLabel(5)) // second pawn of seat 1
        assertEquals("G", pairTagLetter(PairCellTag.TOUGHENED))
        assertEquals("T", pairTagLetter(PairCellTag.TOLLU))
        assertNull(pairTagLetter(PairCellTag.NONE))
    }
}
