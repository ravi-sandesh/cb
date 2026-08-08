package com.example.chokabara

import com.chokabarah.game.engine.GridSize
import com.chokabarah.game.engine.TrackBuilder
import org.junit.Assert.*
import org.junit.Test

class TrackBuilderTest {

    @Test
    fun testPathLength5x5() {
        (0..3).forEach { playerIndex ->
            val path = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, playerIndex)
            assertEquals(25, path.size) // 16 outer + 8 inner + 1 center
        }
    }

    @Test
    fun testPathLength7x7() {
        (0..3).forEach { playerIndex ->
            val path = TrackBuilder.getPlayerPath(GridSize.SEVEN_BY_SEVEN, playerIndex)
            assertEquals(49, path.size) // 24 outer + 24 inner + 1 center
        }
    }

    @Test
    fun testAllPathsEndAtCenter() {
        (0..3).forEach { playerIndex ->
            val path5 = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, playerIndex)
            assertEquals(Pair(2, 2), path5.last())

            val path7 = TrackBuilder.getPlayerPath(GridSize.SEVEN_BY_SEVEN, playerIndex)
            assertEquals(Pair(3, 3), path7.last())
        }
    }

    @Test
    fun testPlayer0StartCells() {
        assertEquals(Pair(4, 2), TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0)[0])
        assertEquals(Pair(6, 3), TrackBuilder.getPlayerPath(GridSize.SEVEN_BY_SEVEN, 0)[0])
    }

    @Test
    fun testPlayerOffsets5x5() {
        // Offsets {0, 8, 4, 12} for players 0..3
        assertEquals(Pair(4, 2), TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0)[0])
        assertEquals(Pair(0, 2), TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 1)[0])
        assertEquals(Pair(2, 4), TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 2)[0])
        assertEquals(Pair(2, 0), TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 3)[0])
    }

    @Test
    fun testPlayerOffsets7x7() {
        // Offsets {0, 12, 6, 18} for players 0..3
        assertEquals(Pair(6, 3), TrackBuilder.getPlayerPath(GridSize.SEVEN_BY_SEVEN, 0)[0])
        assertEquals(Pair(0, 3), TrackBuilder.getPlayerPath(GridSize.SEVEN_BY_SEVEN, 1)[0])
        assertEquals(Pair(3, 6), TrackBuilder.getPlayerPath(GridSize.SEVEN_BY_SEVEN, 2)[0])
        assertEquals(Pair(3, 0), TrackBuilder.getPlayerPath(GridSize.SEVEN_BY_SEVEN, 3)[0])
    }

    @Test
    fun testInnerGateIndex() {
        assertEquals(16, TrackBuilder.innerGateIndex(GridSize.FIVE_BY_FIVE))
        assertEquals(24, TrackBuilder.innerGateIndex(GridSize.SEVEN_BY_SEVEN))
    }

    @Test
    fun testIsSafeSquare5x5() {
        // 5x5 safes: 4 player homes + center home
        val safe5 = listOf(
            Pair(4, 2), Pair(0, 2), Pair(2, 4), Pair(2, 0), Pair(2, 2)
        )
        safe5.forEach { (r, c) ->
            assertTrue("Expected ($r,$c) safe", TrackBuilder.isSafeCell(GridSize.FIVE_BY_FIVE, r, c))
        }
    }

    @Test
    fun testIsSafeSquare5x5Negative() {
        // Corners are NOT safe in 5x5 (only homes + center are safe)
        val notSafe5 = listOf(
            Pair(0, 0), Pair(0, 4), Pair(4, 0), Pair(4, 4),
            Pair(3, 1), Pair(1, 1)
        )
        notSafe5.forEach { (r, c) ->
            assertFalse("Expected ($r,$c) not safe", TrackBuilder.isSafeCell(GridSize.FIVE_BY_FIVE, r, c))
        }
    }

    @Test
    fun testIsSafeSquare7x7() {
        // 7x7 safes: 4 corners + 4 edge homes + 4 inner DIAGONAL (X pattern) + center
        val safe7 = listOf(
            // corners
            Pair(0, 0), Pair(0, 6), Pair(6, 0), Pair(6, 6),
            // edge homes
            Pair(0, 3), Pair(3, 0), Pair(3, 6), Pair(6, 3),
            // inner diagonal (X pattern)
            Pair(1, 1), Pair(1, 5), Pair(5, 1), Pair(5, 5),
            // center
            Pair(3, 3)
        )
        safe7.forEach { (r, c) ->
            assertTrue("Expected ($r,$c) safe", TrackBuilder.isSafeCell(GridSize.SEVEN_BY_SEVEN, r, c))
        }
    }

    @Test
    fun testIsSafeSquare7x7IsNotPlusPattern() {
        // CRITICAL: inner safes are the X pattern, NOT the + pattern (1,3),(3,1),(3,5),(5,3)
        val notSafePlus = listOf(
            Pair(1, 3), Pair(3, 1), Pair(3, 5), Pair(5, 3), Pair(2, 2)
        )
        notSafePlus.forEach { (r, c) ->
            assertFalse("Expected ($r,$c) NOT safe (X pattern only)", TrackBuilder.isSafeCell(GridSize.SEVEN_BY_SEVEN, r, c))
        }
    }

    @Test
    fun testSafeSquareCount() {
        var safe5 = 0
        (0..4).forEach { r -> (0..4).forEach { c -> if (TrackBuilder.isSafeCell(GridSize.FIVE_BY_FIVE, r, c)) safe5++ } }
        assertEquals(5, safe5) // 4 homes + center

        var safe7 = 0
        (0..6).forEach { r -> (0..6).forEach { c -> if (TrackBuilder.isSafeCell(GridSize.SEVEN_BY_SEVEN, r, c)) safe7++ } }
        assertEquals(13, safe7) // 4 corners + 4 homes + 4 diagonal + center
    }

    @Test
    fun testTrackHasNoDuplicateCells() {
        (0..3).forEach { playerIndex ->
            val path5 = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, playerIndex)
            assertEquals(path5.size, path5.toSet().size)

            val path7 = TrackBuilder.getPlayerPath(GridSize.SEVEN_BY_SEVEN, playerIndex)
            assertEquals(path7.size, path7.toSet().size)
        }
    }

    @Test
    fun testOuterThenInnerThenCenterOrder() {
        // 5x5: outer is indices 0..15, inner starts at gate 16, center is last
        val path5 = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0)
        assertEquals(Pair(2, 2), path5[24]) // center at last index
        // Gate entry cell (index 16) equals first inner cell
        assertEquals(Pair(3, 1), path5[16])

        // 7x7: gate entry at index 24
        val path7 = TrackBuilder.getPlayerPath(GridSize.SEVEN_BY_SEVEN, 0)
        assertEquals(Pair(3, 3), path7[48])
        assertEquals(Pair(5, 2), path7[24])
    }

    @Test
    fun testInnerLoopIsOrthogonalNoReversal() {
        // EC-38: the 5x5 inner loop (from gate index 16 to center) is a
        // contiguous, orthogonally-adjacent path with no jumps or reversal.
        val inner = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0).subList(16, 25)
        for (i in 0 until inner.size - 1) {
            val a = inner[i]
            val b = inner[i + 1]
            assertEquals(1, Math.abs(a.first - b.first) + Math.abs(a.second - b.second))
        }
    }
}
