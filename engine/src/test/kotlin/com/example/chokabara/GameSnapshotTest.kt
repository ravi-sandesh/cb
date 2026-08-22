package com.example.chokabara

import com.chokabarah.game.engine.GameEngine
import com.chokabarah.game.engine.GameSnapshot
import com.chokabarah.game.engine.GameSnapshotCodec
import com.chokabarah.game.engine.GridSize
import com.chokabarah.game.engine.Pawn
import com.chokabarah.game.engine.PawnState
import com.chokabarah.game.engine.PawnSnapshot
import com.chokabarah.game.engine.PlayerColor
import com.chokabarah.game.engine.RollSnapshot
import com.chokabarah.game.engine.TrackBuilder
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Snapshot / restore round-trips: the persistence contract behind the app's
// process-death survival. All state is crafted through public fields so the
// tests are fully deterministic (no RNG, no reflection).
class GameSnapshotTest {

    private fun newEngine(
        gridSize: GridSize = GridSize.FIVE_BY_FIVE,
        players: List<PlayerColor> = listOf(PlayerColor.RED, PlayerColor.GREEN)
    ) = GameEngine(gridSize = gridSize, playerColors = players)

    // ---- Codec ----

    @Test
    fun codecRoundTripsAFreshGame() {
        val engine = newEngine()
        val decoded = GameSnapshotCodec.decode(GameSnapshotCodec.encode(engine.snapshot()))
        assertEquals(0, decoded.currentPlayerIndex)
        assertEquals(-1, decoded.rollActorIndex)
        assertEquals(-1, decoded.winnerIndex)
        assertEquals(8, decoded.pawns.size)
        assertTrue(decoded.pawns.all { it.state == PawnState.HOME_BASE && it.pathIndex == -1 })
        assertNull(decoded.currentRoll)
        assertEquals(mapOf(0 to false, 1 to false), decoded.hasCapturedOpponent)
    }

    @Test
    fun codecRoundTripsAMidGameWithPendingRollAndCaptures() {
        val engine = newEngine()
        engine.rollCowries()
        val snap = engine.snapshot()
        val decoded = GameSnapshotCodec.decode(GameSnapshotCodec.encode(snap))
        assertEquals(snap.currentPlayerIndex, decoded.currentPlayerIndex)
        assertEquals(snap.rollActorIndex, decoded.rollActorIndex)
        assertEquals(snap.pawns, decoded.pawns)
        assertEquals(snap.hasCapturedOpponent, decoded.hasCapturedOpponent)
        assertEquals(snap.currentRoll?.shells, decoded.currentRoll?.shells)
    }

    @Test
    fun decodeRejectsGarbage() {
        assertFailsWith<IllegalArgumentException> { GameSnapshotCodec.decode("not a snapshot") }
        assertFailsWith<IllegalArgumentException> { GameSnapshotCodec.decode("WRONG1|0|0|-1|0=0|0:0:-1;|") }
        assertFailsWith<IllegalArgumentException> { GameSnapshotCodec.decode("CBENGINE1|x|0|-1|0=0|0:0:-1|-") }
        assertFailsWith<IllegalArgumentException> { GameSnapshotCodec.decode("CBENGINE1|0|0|-1|0=0||-") }
        assertFailsWith<IllegalArgumentException> {
            // 5 shells is never legal (4 or 6 only)
            GameSnapshotCodec.decode("CBENGINE1|0|0|-1|0=0|0:2:-1;1:2:-1;2:2:-1;3:2:-1;4:2:-1;5:2:-1;6:2:-1;7:2:-1|01010")
        }
        assertFailsWith<IllegalArgumentException> {
            // Unknown pawn-state ordinal
            GameSnapshotCodec.decode("CBENGINE1|0|0|-1|0=0|0:9:-1;1:2:-1;2:2:-1;3:2:-1;4:2:-1;5:2:-1;6:2:-1;7:2:-1|-")
        }
    }

    // ---- Restore equivalence ----

    @Test
    fun restoreReproducesAFreshGame() {
        val source = newEngine()
        val target = newEngine()
        assertTrue(target.restore(source.snapshot()))
        assertEnginesEquivalent(source, target)
    }

    @Test
    fun restoreReproducesAPendingRoll() {
        val source = newEngine()
        // Keep rolling until a roll WITH moves is pending so the restored
        // engine must also reproduce non-empty validMoves.
        var attempts = 0
        while (source.validMoves.isEmpty()) {
            if (source.winner != null) break
            source.rollCowries()
            check(++attempts < 200) { "Never produced a roll with moves" }
        }
        val target = newEngine()
        assertTrue(target.restore(source.snapshot()))
        assertEnginesEquivalent(source, target)
    }

    @Test
    fun restoreReproducesProgressedPawnsCaptureFlagAndWinner() {
        val source = newEngine()

        // Craft progress through the public state surface (deterministic):
        // player 0 has two pawns on track and has earned the inner gate.
        source.hasCapturedOpponent[0] = true
        fun setPawn(id: Int, state: PawnState, pathIndex: Int) {
            val pawn = source.pawns.first { it.id == id }
            pawn.state = state
            pawn.pathIndex = pathIndex
        }
        setPawn(0, PawnState.ON_TRACK, 10)
        setPawn(1, PawnState.ON_TRACK, 12)
        setPawn(2, PawnState.FINISHED, TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0).lastIndex)

        val midGame = newEngine()
        assertTrue(midGame.restore(source.snapshot()))
        assertEnginesEquivalent(source, midGame)

        // A finished match restores with the winner seated and no pending roll.
        source.pawns.filter { it.playerIndex == 0 }.forEach {
            it.state = PawnState.FINISHED
            it.pathIndex = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0).lastIndex
        }
        val finished = newEngine()
        assertTrue(finished.restore(source.snapshot()))
        // winner is derived from all-finished pawns only via executeMove; a raw
        // snapshot carries whatever winnerIndex was stored (-1 here).
        assertNull(finished.winner)
        assertNull(finished.currentRoll)
    }

    @Test
    fun restoreReproducesAStoredWinner() {
        val source = newEngine()
        val tampered = GameSnapshotCodec.decode(GameSnapshotCodec.encode(source.snapshot()))
            .copy(winnerIndex = 1)
        val target = newEngine()
        assertTrue(target.restore(tampered))
        assertEquals(PlayerColor.GREEN, target.winner)
        assertNull(target.currentRoll)
        assertTrue(target.validMoves.isEmpty())
    }

    // ---- Restore rejection leaves the engine untouched ----

    @Test
    fun restoreRejectsMismatchedShapeAndKeepsTargetIntact() {
        val target = newEngine()
        target.rollCowries()
        val before = target.snapshot()
        val freshMoveCount = target.validMoves.size

        val wrongPlayerCount = GameSnapshot(
            currentPlayerIndex = 0, rollActorIndex = -1, winnerIndex = -1,
            pawns = List(12) { PawnSnapshot(it, PawnState.HOME_BASE, -1) },
            hasCapturedOpponent = mapOf(0 to false, 1 to false, 2 to false),
            currentRoll = null
        )
        assertFalse(target.restore(wrongPlayerCount))

        val badCurrentPlayer = GameSnapshot(
            currentPlayerIndex = 5, rollActorIndex = -1, winnerIndex = -1,
            pawns = before.pawns, hasCapturedOpponent = before.hasCapturedOpponent,
            currentRoll = null
        )
        assertFalse(target.restore(badCurrentPlayer))

        // Wrong board size: a 7x7 pending roll carries 6 shells; the 5x5
        // target only accepts its own 4-shell rolls.
        val sevenBySeven = newEngine(GridSize.SEVEN_BY_SEVEN)
        var attempts = 0
        while (sevenBySeven.currentRoll == null && sevenBySeven.winner == null) {
            sevenBySeven.rollCowries()
            check(++attempts < 200) { "Never produced a pending 7x7 roll" }
        }
        assertFalse(target.restore(sevenBySeven.snapshot()))

        // Engine still exactly as before every rejected attempt.
        assertEnginesEquivalent(
            GameSnapshotCodec.decode(GameSnapshotCodec.encode(before)).let { s ->
                newEngine().apply { restore(s) }
            },
            target
        )
        assertEquals(freshMoveCount, target.validMoves.size)
    }

    @Test
    fun restoredValidMovesAreRecomputedFromLiveStateNotTrusted() {
        // Hand-crafted, fully deterministic snapshot: ALL player-0 pawns sit
        // one cell before the inner gate (index 15) with a pending CHOWKA roll
        // of 4 (four mouths up). Every candidate lands at 15+4=19, crossing the
        // gate, so moves exist ONLY when the capture flag is set — no
        // HOME_BASE entry can sneak past the gate check.
        val gate = TrackBuilder.innerGateIndex(GridSize.FIVE_BY_FIVE)
        val pawns = List(8) { id ->
            if (id < 4) PawnSnapshot(id, PawnState.ON_TRACK, gate - 1)
            else PawnSnapshot(id, PawnState.HOME_BASE, -1)
        }

        val locked = newEngine()
        assertTrue(locked.restore(GameSnapshot(0, 0, -1, pawns, mapOf(0 to false, 1 to false), RollSnapshot(listOf(true, true, true, true)))))
        assertTrue(locked.validMoves.isEmpty(), "Gate must stay shut without a cut")

        // Same board + same pending roll, but the snapshot claims the cut was
        // made: the restored engine must now recompute and OFFER the gate
        // crossing — proving moves derive from live state + re-derived roll.
        val unlocked = newEngine()
        assertTrue(unlocked.restore(GameSnapshot(0, 0, -1, pawns, mapOf(0 to true, 1 to false), RollSnapshot(listOf(true, true, true, true)))))
        assertEquals(4, unlocked.currentRoll?.score)
        assertTrue(
            unlocked.validMoves.any { it.targetPathIndex >= gate },
            "Restored engine must recompute moves against the unlocked gate"
        )
    }

    // ---- Helpers ----

    private fun assertEnginesEquivalent(expected: GameEngine, actual: GameEngine) {
        assertEquals(expected.currentPlayerIndex, actual.currentPlayerIndex)
        assertEquals(expected.winner, actual.winner)
        assertEquals(expected.currentRoll?.shells, actual.currentRoll?.shells)
        assertEquals(expected.currentRoll?.score, actual.currentRoll?.score)
        assertEquals(expected.gameLogMessage.isNotBlank(), actual.gameLogMessage.isNotBlank())
        assertContentEquals(
            expected.pawns.map { Triple(it.id, it.state, it.pathIndex) }.sortedBy { it.first },
            actual.pawns.map { Triple(it.id, it.state, it.pathIndex) }.sortedBy { it.first }
        )
        assertEquals(expected.hasCapturedOpponent, actual.hasCapturedOpponent)
        assertEquals(
            expected.validMoves.map { it.targetCoords to it.grpPawns.map(Pawn::id) },
            actual.validMoves.map { it.targetCoords to it.grpPawns.map(Pawn::id) }
        )
    }
}
