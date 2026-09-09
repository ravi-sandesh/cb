package com.example.chokabara

import com.chokabarah.game.engine.CowryResult
import com.chokabarah.game.engine.GameEngine
import com.chokabarah.game.engine.GridSize
import com.chokabarah.game.engine.MoveOption
import com.chokabarah.game.engine.PawnState
import com.chokabarah.game.engine.PlayerColor
import com.chokabarah.game.engine.TrackBuilder
import org.junit.Assert.*
import org.junit.Test/**
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

    // Inject a roll that LOOKS like it belongs to a different acting turn.
    private fun GameEngine.setRollActor(actor: Int) {
        val f = GameEngine::class.java.getDeclaredField("rollActor")
        f.isAccessible = true
        f.setInt(this, actor)
    }

    private fun GameEngine.setCurrentPlayer(index: Int) {
        val f = GameEngine::class.java.getDeclaredField("currentPlayerIndex")
        f.isAccessible = true
        f.setInt(this, index)
    }

    private fun playerIndexAt(player: Int, target: Pair<Int, Int>): Int {
        return TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, player)
            .indexOf(target)
    }

    // ============================================================
    // BUG-01 (FIXED): opponents from DIFFERENT players are capturable
    // DOC / EC-26: single mover landing on a cell shared by pawns of TWO
    // DIFFERENT opponents MUST be able to capture them (all sent home).
    // FIX: Gatti immunity requires 2+ pawns of the SAME player.
    // ============================================================
    @Test
    fun bug01_opponentsFromDifferentPlayersAreCapturable() {
        val engine = GameEngine(
            gridSize = GridSize.FIVE_BY_FIVE,
            playerColors = listOf(PlayerColor.RED, PlayerColor.GREEN, PlayerColor.YELLOW, PlayerColor.BLUE)
        )
        engine.putOnTrack(0, 2)                      // P0 mover, roll 3 -> idx 5
        val target = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0)[5]
        engine.putOnTrack(engine.pawns.first { it.playerIndex == 1 }.id, playerIndexAt(1, target))
        engine.putOnTrack(engine.pawns.first { it.playerIndex == 2 }.id, playerIndexAt(2, target))

        engine.forceMoves(3)

        val captureMove = engine.validMoves.firstOrNull { it.targetCoords == target }
        assertNotNull(
            "EC-26: move to cell shared by two different opponents must be offered",
            captureMove
        )
        assertEquals("move must be a capture of both opponents", true, captureMove!!.isCapture)
    }

    @Test
    fun bug01b_samePlayerGattiStillBlocks() {
        val engine = GameEngine(gridSize = GridSize.FIVE_BY_FIVE)
        engine.hasCapturedOpponent[0] = true
        engine.putOnTrack(0, 18)
        val target = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0)[20] // (1,3)
        // TRUE Gatti: two pawns of player 1 on the same inner cell, TOUGHENED.
        val p1 = engine.pawns.filter { it.playerIndex == 1 }
        p1[0].state = PawnState.ON_TRACK; p1[0].pathIndex = 16
        p1[1].state = PawnState.ON_TRACK; p1[1].pathIndex = 16
        engine.toughenedCells.getOrPut(1) { mutableSetOf() }.add(16)

        engine.forceMoves(2)

        val hasCapture = engine.validMoves.any { it.isCapture }
        assertEquals("real toughened Gatti correctly blocks", false, hasCapture)

        // Same pair UNTOUGHENED (tollu): capturable.
        engine.toughenedCells.clear()
        engine.forceMoves(2)
        assertEquals(
            "untoughened tollu pair is capturable",
            true,
            engine.validMoves.any { it.isCapture && it.targetCoords == target }
        )
    }

    // ============================================================
    // BUG-02 (FIXED): moving an EXISTING pair is NOT a new formation.
    // DOC §5.1: gattiFormed fires ONLY on the toughen transition (a tollu
    // pair hardening on an exact 2). Moving a pre-existing pair — tollu or
    // toughened — never re-announces.
    // ============================================================
    @Test
    fun bug02_movingExistingGattiDoesNotReportFormation() {
        val engine = GameEngine(gridSize = GridSize.FIVE_BY_FIVE)
        engine.hasCapturedOpponent[0] = true
        engine.putOnTrack(0, 17)
        engine.putOnTrack(1, 17)                     // pre-existing tollu pair

        engine.forceMoves(4) // half rate: pair 17 -> 19, no hardening
        val tolluMove = engine.validMoves.firstOrNull { it.isGattiGroup }!!
        engine.setRoll(4, isExtra = true)        // extra roll: no advanceTurn, message survives
        engine.executeMove(tolluMove)
        assertFalse(
            "FIXED: moving a pre-existing pair must NOT announce a new formation",
            engine.gameLogMessage.contains("GATTI")
        )
    }

    // EC-16 guard: a tollu pair hardening onto our OWN single pawn grows to
    // a toughened 3-stack — the toughen transition MUST announce.
    @Test
    fun ec16_gattiGroupLandsOnOwnPawnGrowsToThree() {
        val engine = GameEngine(gridSize = GridSize.FIVE_BY_FIVE)
        engine.hasCapturedOpponent[0] = true
        engine.putOnTrack(0, 17)
        engine.putOnTrack(1, 17)                     // tollu pair at 17
        engine.putOnTrack(2, 18)                     // own single pawn at 18

        engine.forceMoves(2)
        val tolluMove = engine.validMoves.firstOrNull { it.isGattiGroup }!!
        assertEquals("pair should harden onto our single pawn", 18, tolluMove.targetPathIndex)
        assertTrue(tolluMove.toughens)
        engine.setRoll(2, isExtra = true)
        engine.executeMove(tolluMove)
        assertTrue(
            "EC-16: hardening a pair onto one of our own pawns forms a toughened 3-stack",
            engine.gameLogMessage.contains("GATTI")
        )
        assertEquals(setOf(18), engine.toughenedCells[0])
    }

    // ============================================================
    // BUG-03 (FIXED + RULE CHANGE): a CAPTURE onto my OWN pawn forms a
    // tollu pair — NOT a Gatti. Only hardening on an exact 2 toughens it.
    // ============================================================
    @Test
    fun bug03_captureOntoOwnStackAnnouncesGatti() {
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

        // FIXED: 2 own pawns now share the cell as tollu — silent until hardened.
        assertFalse(
            "FIXED: capture onto own stack forms tollu, must NOT announce Gatti",
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
        // entry index = 12 < gate 24 -> the gate branch can never fire
        assertTrue(engine.validMoves.all { it.targetPathIndex == 12 })
    }

    // ============================================================
    // BUG-08 (FIXED): a playerCount < 2 must not crash GameEngine init.
    // DOC / defensive guard: the engine requires 2..4 players. Previously a
    // <2 list slipped to take() in the caller and blew up the constructor.
    // ============================================================
    @Test
    fun bug08_fewerThanTwoPlayersFailsFastNotCrash() {
        val e = assertThrows(IllegalArgumentException::class.java) {
            GameEngine(
                gridSize = GridSize.FIVE_BY_FIVE,
                playerColors = listOf(PlayerColor.RED)
            )
        }
        assertTrue(e.message!!.contains("must be 2..4"))
    }

    // ============================================================
    // BUG-09 (FIXED): a winning move must clear the consumed roll + moves.
    // Previously executeMove returned on victory WITHOUT clearing
    // currentRoll/validMoves, leaking the winning roll into any follow-up
    // (e.g. a post-victory roll or a fresh game).
    // ============================================================
    @Test
    fun bug09_victoryClearsRollAndMoves() {
        val engine = GameEngine(gridSize = GridSize.FIVE_BY_FIVE)
        engine.hasCapturedOpponent[0] = true
        val path = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0)
        val last = path.lastIndex
        // 3 pawns already home; last pawn one step from center.
        (0 until 3).forEach { engine.putOnTrack(it, last - 1); engine.pawns[it].state = PawnState.FINISHED }
        engine.putOnTrack(3, last - 1)

        engine.forceMoves(1)
        val winMove = engine.validMoves.first { it.reachesHome }
        engine.setRoll(1, isExtra = false)
        engine.executeMove(winMove)

        assertEquals(PlayerColor.RED, engine.winner)
        assertNull("FIXED: victory must clear the consumed roll", engine.currentRoll)
        assertTrue("FIXED: victory must clear valid moves", engine.validMoves.isEmpty())
    }

    // ============================================================
    // BUG-10 (FIXED): rollCowries must only auto-clear / re-roll / resurrect a
    // pending roll for the SAME acting turn. A roll that belongs to a previous
    // actor (left over from a different turn) is orphaned state: it must be
    // discarded, never returned to / cleared for a new actor.
    // ============================================================
    @Test
    fun bug10_pendingRollFromOtherTurnIsDiscardedNotResurrected() {
        val engine = GameEngine(gridSize = GridSize.FIVE_BY_FIVE)
        engine.setRoll(2, isExtra = false)            // pending roll "for" some actor
        engine.setRollActor(0)                        // roll actually belongs to player 0
        engine.setCurrentPlayer(1)                    // but player 1 is now acting
        engine.forceMoves(2)

        val result = engine.rollCowries()

        // Player 1 must NOT be handed player 0's stale roll, and the stale roll
        // must not be auto-cleared as if it were player 1's re-roll.
        assertEquals(
            "FIXED: player 1 must receive a FRESH roll, not player 0's stale one",
            4, result.shells.size
        )
        assertEquals(
            "FIXED: a fresh roll's label must never be the injected stale label",
            false, result.label == "injected"
        )
        assertEquals(
            "FIXED: the stale roll must not linger as currentRoll (label)",
            false, engine.currentRoll?.label == "injected"
        )
        // The turn was NOT recycled to player 0; player 1 stays the actor.
        assertEquals("player 1 remains the acting player after the discard", 1, engine.currentPlayerIndex)
    }

    // ============================================================
    // BUG-13 (FIXED): the "No valid moves" outcome must survive in the log even
    // when the turn auto-advances. Previously advanceTurn() overwrote the message
    // so the UI never saw why the roll was rejected.
    // ============================================================
    @Test
    fun bug13_noValidMovesMessageSurvivesAdvanceTurn() {
        val engine = GameEngine(gridSize = GridSize.SEVEN_BY_SEVEN)
        // Block every path so any roll yields no valid moves: all pawns finished
        // except the current player's own lifeline, with a roll that overshoots...
        // Simpler deterministic approach: put ALL of player 0's pawns in a state
        // where a computed move list is empty via a full-board finished state.
        engine.pawns.forEach { it.state = PawnState.FINISHED }

        // Non-extra roll that yields no moves must preserve the message.
        // Force a deterministic non-extra score by injecting the computation.
        engine.forceMoves(1)
        assertTrue("setup: all pawns finished => no valid moves", engine.validMoves.isEmpty())

        // Re-establish a full board then roll for real: no pawns movable.
        val msg = with(engine) {
            // WAS: advanceTurn() inside rollCowries would overwrite the log.
            rollCowries()
            gameLogMessage
        }
        assertTrue(
            "FIXED: 'No valid moves' must remain in the log after the turn passes",
            msg.contains("No valid moves")
        )
    }
}
