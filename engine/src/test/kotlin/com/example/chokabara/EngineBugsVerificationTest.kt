package com.example.chokabara

import com.chokabarah.game.engine.CowryResult
import com.chokabarah.game.engine.GameEngine
import com.chokabarah.game.engine.GridSize
import com.chokabarah.game.engine.MoveOption
import com.chokabarah.game.engine.PawnState
import com.chokabarah.game.engine.PlayerColor
import com.chokabarah.game.engine.TrackBuilder
import org.junit.Assert.*
import org.junit.Test

/**
 * BUG VERIFICATION SUITE (Kotlin engine).
 *
 * Mirrors web/bugs-verify.test.js for the SHARED engine bugs documented in
 * the 30-bug report. Each test PINS the current BUGGY behaviour: it passes
 * while the bug exists and FAILS once the engine is fixed (at which point
 * the assertion must be flipped to the documented correct behaviour).
 *
 * The engine only exposes rollCowries()/executeMove(), so move generation is
 * driven deterministically via reflection on the private
 * `calculateValidMoves(score)` (deterministic input, no RNG).
 */
class EngineBugsVerificationTest {

    private fun GameEngine.forceMoves(score: Int) {
        val m = GameEngine::class.java.getDeclaredMethod("calculateValidMoves", Int::class.java)
        m.isAccessible = true
        m.invoke(this, score)
    }

    private fun GameEngine.putOnTrack(id: Int, pathIndex: Int) {
        pawns[id].state = PawnState.ON_TRACK
        pawns[id].pathIndex = pathIndex
    }

    // The engine treats currentRoll (esp. isExtraRoll) as "who is acting + turn
    // upkeep". executeMove only keeps gattiFormed observable via gameLogMessage
    // when extraTurn survives (no advanceTurn overwrite). Inject the roll.
    private fun GameEngine.setRoll(score: Int, isExtra: Boolean) {
        val f = GameEngine::class.java.getDeclaredField("currentRoll")
        f.isAccessible = true
        f.set(this, CowryResult(listOf(), score, isExtra, "injected"))
    }

    private fun playerIndexAt(player: Int, target: Pair<Int, Int>): Int {
        return TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, player)
            .indexOf(target)
    }

    // ============================================================
    // BUG-01: "Opponent Gatti" false positive across DIFFERENT players
    // DOC / EC-26: single mover landing on a cell shared by pawns of TWO
    // DIFFERENT opponents MUST be able to capture them (all sent home).
    // ACTUAL: 2+ opponents (any ownership) are treated as an un-capturable
    //         Gatti and the move is dropped entirely.
    // ============================================================
    @Test
    fun bug01_opponentsFromDifferentPlayersBlockCapture() {
        val engine = GameEngine(
            gridSize = GridSize.FIVE_BY_FIVE,
            playerColors = listOf(PlayerColor.RED, PlayerColor.GREEN, PlayerColor.YELLOW, PlayerColor.BLUE)
        )
        engine.putOnTrack(0, 2)                      // P0 mover, roll 3 -> idx 5
        val target = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0)[5]
        engine.putOnTrack(engine.pawns.first { it.playerIndex == 1 }.id, playerIndexAt(1, target))
        engine.putOnTrack(engine.pawns.first { it.playerIndex == 2 }.id, playerIndexAt(2, target))

        engine.forceMoves(3)

        // BUGGY actual: the move to the target is missing (all moves dropped).
        val hasTarget = engine.validMoves.any { it.targetCoords == target }
        assertEquals(
            "EC-26 violation: move to cell shared by two different opponents must be allowed",
            false, hasTarget
        )
    }

    @Test
    fun bug01b_samePlayerGattiStillBlocks() {
        val engine = GameEngine(gridSize = GridSize.FIVE_BY_FIVE)
        engine.putOnTrack(0, 2)
        val target = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0)[5]
        // TRUE Gatti: two pawns of player 1 on the same cell.
        val p1 = engine.pawns.filter { it.playerIndex == 1 }
        p1[0].state = PawnState.ON_TRACK; p1[0].pathIndex = playerIndexAt(1, target)
        p1[1].state = PawnState.ON_TRACK; p1[1].pathIndex = playerIndexAt(1, target)

        engine.forceMoves(3)

        val hasCapture = engine.validMoves.any { it.isCapture }
        assertEquals("real Gatti correctly blocks", false, hasCapture)
    }

    // ============================================================
    // BUG-02: moving an EXISTING Gatti is re-announced as a new formation.
    // DOC §5.1: formation is announced when pawns newly join a cell.
    // ACTUAL: executeMove recomputes from post-move state -> reports again.
    // ============================================================
    @Test
    fun bug02_movingExistingGattiReportsFormationAgain() {
        val engine = GameEngine(gridSize = GridSize.FIVE_BY_FIVE)
        engine.putOnTrack(0, 5)
        engine.putOnTrack(1, 5)                     // pre-existing Gatti

        engine.forceMoves(2)
        val gattiMove = engine.validMoves.firstOrNull { it.isGattiGroup }!!
        engine.setRoll(2, isExtra = true)        // extra roll: no advanceTurn, message survives
        engine.executeMove(gattiMove)
        assertTrue(
            "BUG: moving a pre-existing Gatti must NOT announce a new formation",
            engine.gameLogMessage.contains("GATTI")
        )
    }

    // ============================================================
    // BUG-03: a CAPTURE that also lands onto my OWN pawn suppresses the
    // Gatti announcement even though a 2-pawn stack now exists.
    // ============================================================
    @Test
    fun bug03_captureOntoOwnStackSuppressesGattiMessage() {
        val engine = GameEngine(gridSize = GridSize.FIVE_BY_FIVE)
        engine.putOnTrack(0, 4)                     // mover -> idx 6 on score 2
        val dest = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0)[6]
        engine.putOnTrack(1, 6)                     // my own pawn already on dest
        val p1 = engine.pawns.first { it.playerIndex == 1 }
        p1.state = PawnState.ON_TRACK
        p1.pathIndex = playerIndexAt(1, dest)  // opponent on dest too

        engine.forceMoves(2)
        val captureMove = engine.validMoves.first { it.targetCoords == dest && it.isCapture }
        engine.setRoll(2, isExtra = false)
        engine.executeMove(captureMove)

        // BUG: even though 2 own pawns now share the cell, no GATTI message.
        assertFalse(
            "BUG: capture onto own stack must still announce the new Gatti",
            engine.gameLogMessage.contains("GATTI")
        )
    }

    // ============================================================
    // BUG-04 (informational): HOME-BASE entry can never reach the inner
    // gate, so the gate branch is dead for entry moves (EC-09 unimplemented).
    // ============================================================
    @Test
    fun bug04_homeEntryNeverReachesGate() {
        val engine = GameEngine(gridSize = GridSize.SEVEN_BY_SEVEN)
        engine.forceMoves(12)                       // max Baara entry on 7x7
        // entry index = 12 - 1 = 11 < gate 24 -> the gate branch can never fire
        assertTrue(engine.validMoves.all { it.targetPathIndex == 11 })
    }
}