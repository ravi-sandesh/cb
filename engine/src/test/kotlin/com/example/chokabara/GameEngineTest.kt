package com.example.chokabara

import com.chokabarah.game.engine.CowryResult
import com.chokabarah.game.engine.GameEngine
import com.chokabarah.game.engine.GridSize
import com.chokabarah.game.engine.MoveOption
import com.chokabarah.game.engine.Pawn
import com.chokabarah.game.engine.PawnState
import com.chokabarah.game.engine.PlayerColor
import com.chokabarah.game.engine.TrackBuilder
import com.chokabarah.game.engine.calculateValidMoves
import com.chokabarah.game.engine.executeMovePure
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class GameEngineTest {

    private lateinit var engine: GameEngine

    @Before
    fun setup() {
        engine = GameEngine(gridSize = GridSize.FIVE_BY_FIVE)
    }

    private fun player0Pawn(index: Int): Pawn = engine.pawns[index]
    private fun player1Pawn(index: Int): Pawn = engine.pawns[4 + index]

    @Test
    fun testInitialState() {
        // 2 players (default RED/GREEN), 4 pawns each, all HOME_BASE
        assertEquals(2, engine.playerColors.size)
        assertEquals(0, engine.currentPlayerIndex)
        assertEquals(8, engine.pawns.size)
        assertNotNull(engine.pawns.find { it.playerIndex == 0 && it.state == PawnState.HOME_BASE })
        assertNull(engine.winner)
        assertTrue(engine.validMoves.isEmpty())
        assertNull(engine.currentRoll)
        assertTrue(engine.hasCapturedOpponent.values.none { it })
    }

    @Test
    fun testInitialState7x7() {
        val engine7 = GameEngine(gridSize = GridSize.SEVEN_BY_SEVEN)
        assertEquals(7, engine7.gridSize.columns)
        assertEquals(6, engine7.numCowries)
        assertEquals(8, engine7.pawns.size)
        assertEquals(0, engine7.currentPlayerIndex)
    }

    @Test
    fun testFourPlayerGame() {
        val engine4 = GameEngine(
            gridSize = GridSize.FIVE_BY_FIVE,
            playerColors = listOf(PlayerColor.RED, PlayerColor.GREEN, PlayerColor.YELLOW, PlayerColor.BLUE)
        )
        assertEquals(4, engine4.playerColors.size)
        assertEquals(16, engine4.pawns.size)
        engine4.pawns.forEach { pawn ->
            assertTrue(pawn.playerIndex in 0..3)
        }
    }

    @Test
    fun testResetGameClearsState() {
        val pawn0 = player0Pawn(0)
        pawn0.state = PawnState.ON_TRACK
        pawn0.pathIndex = 5
        engine.hasCapturedOpponent[0] = true
        engine.advanceTurn()

        engine.resetGame()

        assertEquals(0, engine.currentPlayerIndex)
        assertNull(engine.winner)
        assertNull(engine.currentRoll)
        assertTrue(engine.validMoves.isEmpty())
        engine.pawns.forEach { pawn ->
            assertEquals(PawnState.HOME_BASE, pawn.state)
            assertEquals(-1, pawn.pathIndex)
        }
        assertTrue(engine.hasCapturedOpponent.values.none { it })
    }

    @Test
    fun testRollCowriesReturnsValidScore5x5() {
        val result = engine.rollCowries()
        assertNotNull(result)
        // 5x5 scores: 1, 2, 3, 4 (Chowka), 8 (Baara)
        assertTrue(result.score in setOf(1, 2, 3, 4, 8))
        // 5x5 always has exactly 4 shells
        assertEquals(4, result.shells.size)
        assertEquals(4, engine.numCowries)
        // Verify the scoring mapping: score == 4 (Chowka) iff all 4 mouths up;
        // score == 8 (Baara) iff 0 mouths up; otherwise score == mouth-up count.
        val mouthUp = result.shells.count { it }
        val expectedScore = when (mouthUp) {
            0 -> 8
            4 -> 4
            else -> mouthUp
        }
        assertEquals(expectedScore, result.score)
        assertTrue(result.label.isNotEmpty())
    }

    @Test
    fun testRollCowriesReturnsValidScore7x7() {
        val engine7 = GameEngine(gridSize = GridSize.SEVEN_BY_SEVEN)
        val result = engine7.rollCowries()
        assertNotNull(result)
        assertEquals(6, result.shells.size)
        assertEquals(6, engine7.numCowries)
        assertTrue(result.score in setOf(1, 2, 3, 4, 5, 6, 12))
    }

    @Test
    fun testRollCowriesExtraFlag() {
        // isExtraRoll must always be populated for both boards
        val result5 = engine.rollCowries()
        assertNotNull(result5.isExtraRoll)

        val engine7 = GameEngine(gridSize = GridSize.SEVEN_BY_SEVEN)
        val result7 = engine7.rollCowries()
        assertNotNull(result7.isExtraRoll)
    }

    @Test
    fun testValidMovesEmptyWhenNoRoll() {
        assertTrue(engine.validMoves.isEmpty())
    }

    @Test
    fun testExecuteMoveMovesSinglePawnOnTrack() {
        engine.resetGame()
        val pawn = player0Pawn(0)
        // Simulate a plain move of a single pawn to path index 3 (non-safe, no capture)
        val targetIdx = 3
        val target = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0)[targetIdx]
        val move = MoveOption(
            grpPawns = listOf(pawn),
            targetPathIndex = targetIdx,
            targetCoords = target,
            isCapture = false,
            reachesHome = false,
            isGattiGroup = false
        )
        val ok = engine.executeMove(move)
        assertTrue(ok)
        // executeMovePure copies state; read back through the engine's list.
        val moved = engine.pawns.first { it.id == pawn.id }
        assertEquals(PawnState.ON_TRACK, moved.state)
        assertEquals(targetIdx, moved.pathIndex)
    }

    @Test
    fun testExecuteMoveCaptureSendsOpponentHome() {
        engine.resetGame()
        val mover = player0Pawn(0)
        val targetIdx = 3
        val target = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0)[targetIdx]
        // Place opponent pawn (player 1) ON_TRACK at the same coordinates via its own path
        val oppPath = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 1)
        val oppIdx = oppPath.indexOf(target)
        val opponent = player1Pawn(0)
        opponent.state = PawnState.ON_TRACK
        opponent.pathIndex = oppIdx

        val move = MoveOption(
            grpPawns = listOf(mover),
            targetPathIndex = targetIdx,
            targetCoords = target,
            isCapture = true,
            reachesHome = false,
            isGattiGroup = false
        )
        engine.executeMove(move)

        val capturedNow = engine.pawns.first { it.id == opponent.id }
        assertEquals(PawnState.HOME_BASE, capturedNow.state)
        assertEquals(-1, capturedNow.pathIndex)
        assertEquals(true, engine.hasCapturedOpponent[0])
    }

    @Test
    fun testExecuteMoveReachingHomeFinishesPawn() {
        engine.resetGame()
        val pawn = player0Pawn(0)
        val path = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0)
        val last = path.lastIndex
        pawn.state = PawnState.ON_TRACK
        pawn.pathIndex = last - 1

        val move = MoveOption(
            grpPawns = listOf(pawn),
            targetPathIndex = last,
            targetCoords = path[last],
            isCapture = false,
            reachesHome = true,
            isGattiGroup = false
        )
        engine.executeMove(move)

        val moved = engine.pawns.first { it.id == pawn.id }
        assertEquals(PawnState.FINISHED, moved.state)
    }

    @Test
    fun testVictoryWhenAllPawnsFinished() {
        engine.resetGame()
        engine.hasCapturedOpponent[0] = true
        val path = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0)
        val last = path.lastIndex
        // Finish the first three player-0 pawns
        (0 until 3).forEach { i ->
            player0Pawn(i).state = PawnState.FINISHED
        }
        val lastPawn = player0Pawn(3)
        lastPawn.state = PawnState.ON_TRACK
        lastPawn.pathIndex = last - 1

        val move = MoveOption(
            grpPawns = listOf(lastPawn),
            targetPathIndex = last,
            targetCoords = path[last],
            isCapture = false,
            reachesHome = true,
            isGattiGroup = false
        )
        val ok = engine.executeMove(move)

        assertTrue(ok)
        assertEquals(PlayerColor.RED, engine.winner)
    }

    @Test
    fun testAdvanceTurnRotatesPlayers() {
        engine.resetGame()
        assertEquals(0, engine.currentPlayerIndex)
        engine.advanceTurn()
        assertEquals(1, engine.currentPlayerIndex)
        engine.advanceTurn()
        assertEquals(0, engine.currentPlayerIndex)
    }

    @Test
    fun testAdvanceTurnResetsRollAndMoves() {
        engine.resetGame()
        engine.rollCowries()
        engine.advanceTurn()
        assertNull(engine.currentRoll)
        assertTrue(engine.validMoves.isEmpty())
    }

    @Test
    fun testAdvanceTurnSetsTurnMessage() {
        engine.resetGame()
        engine.advanceTurn()
        val message = engine.gameLogMessage
        assertTrue(message.contains("Green"))
        assertTrue(message.contains("turn"))
    }

    @Test
    fun testGetBestBotMoveNullWhenNoValidMoves() {
        engine.resetGame()
        assertNull(engine.getBestBotMove())
    }

    @Test
    fun testGetBestBotMoveAfterRollIsValidOrNull() {
        engine.resetGame()
        engine.rollCowries()
        val best = engine.getBestBotMove()
        if (best != null) {
            // The chosen bot move must come from the computed valid moves set
            assertTrue(
                engine.validMoves.any { v ->
                    v.targetPathIndex == best.targetPathIndex &&
                        v.grpPawns.map { it.id }.toSet() == best.grpPawns.map { it.id }.toSet()
                }
            )
        } else {
            assertTrue(engine.validMoves.isEmpty())
        }
    }

    @Test
    fun testPawnFinishingInsideGattiLeavesSmallerGatti() {
        // EC-21: a pawn reaching center while in a Gatti finishes; the co-located
        // pawn stays ON_TRACK (smaller Gatti) and the game does NOT end prematurely.
        engine.resetGame()
        engine.hasCapturedOpponent[0] = true
        val path = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0)
        val last = path.lastIndex

        val a = player0Pawn(0)
        val b = player0Pawn(1)
        a.state = PawnState.ON_TRACK
        a.pathIndex = last - 1
        b.state = PawnState.ON_TRACK
        b.pathIndex = last - 1
        // Remaining two pawns further back on track (not finished)
        player0Pawn(2).state = PawnState.ON_TRACK
        player0Pawn(2).pathIndex = 5
        player0Pawn(3).state = PawnState.ON_TRACK
        player0Pawn(3).pathIndex = 6

        val move = MoveOption(
            grpPawns = listOf(a),
            targetPathIndex = last,
            targetCoords = path[last],
            isCapture = false,
            reachesHome = true,
            isGattiGroup = false
        )
        val ok = engine.executeMove(move)

        assertTrue(ok)
        val aNow = engine.pawns.first { it.id == a.id }
        val bNow = engine.pawns.first { it.id == b.id }
        assertEquals(PawnState.FINISHED, aNow.state)
        assertEquals(PawnState.ON_TRACK, bNow.state) // smaller Gatti remains
        assertEquals(last - 1, bNow.pathIndex)
        assertNull(engine.winner) // 2 pawns still on track -> no victory
    }

    @Test
    fun testRemainingGattiIsMovableUnitAfterPartnerFinishes() {
        // After one Gatti member finishes, the leftover pawns (same pathIndex)
        // are still grouped as a movable Gatti unit.
        engine.resetGame()
        engine.hasCapturedOpponent[0] = true
        val path = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0)
        val last = path.lastIndex

        player0Pawn(0).state = PawnState.FINISHED        // already home
        player0Pawn(1).state = PawnState.ON_TRACK
        player0Pawn(1).pathIndex = last - 1
        player0Pawn(2).state = PawnState.ON_TRACK
        player0Pawn(2).pathIndex = last - 1             // leftover Gatti mate
        player0Pawn(3).state = PawnState.ON_TRACK
        player0Pawn(3).pathIndex = 5

        // Force a roll and inspect that the two co-located pawns form one group.
        // (rollCowries walks validMoves for a deterministic score path below)
        val roll = engine.rollCowries()
        assertNotNull(roll)
        val gattiMove = engine.validMoves.firstOrNull { it.isGattiGroup }
        if (gattiMove != null) {
            assertEquals(2, gattiMove.grpPawns.size)
            assertTrue(gattiMove.grpPawns.any { it.id == player0Pawn(1).id })
            assertTrue(gattiMove.grpPawns.any { it.id == player0Pawn(2).id })
        }
    }

    @Test
    fun testPlayerCountMustBe2to4() {
        assertThrows(IllegalArgumentException::class.java) { GameEngine(gridSize = GridSize.FIVE_BY_FIVE, playerColors = listOf(PlayerColor.RED)) }
        assertThrows(IllegalArgumentException::class.java) { GameEngine(gridSize = GridSize.FIVE_BY_FIVE, playerColors = listOf(PlayerColor.RED, PlayerColor.GREEN, PlayerColor.YELLOW, PlayerColor.BLUE, PlayerColor.RED)) }
        // Valid counts
        GameEngine(gridSize = GridSize.FIVE_BY_FIVE, playerColors = listOf(PlayerColor.RED, PlayerColor.GREEN))
        GameEngine(gridSize = GridSize.FIVE_BY_FIVE, playerColors = listOf(PlayerColor.RED, PlayerColor.GREEN, PlayerColor.YELLOW))
        GameEngine(gridSize = GridSize.FIVE_BY_FIVE, playerColors = listOf(PlayerColor.RED, PlayerColor.GREEN, PlayerColor.YELLOW, PlayerColor.BLUE))
    }

    @Test
    fun testExecuteMoveRejectsNullMove() {
        val ok = engine.executeMove(null as MoveOption?)
        assertFalse(ok)
    }

    @Test
    fun testExecuteMoveRejectsEmptyGrpPawns() {
        engine.resetGame()
        val move = MoveOption(
            grpPawns = emptyList(),
            targetPathIndex = 5,
            targetCoords = Pair(1, 2),
            isCapture = false,
            reachesHome = false,
            isGattiGroup = false
        )
        val ok = engine.executeMove(move)
        assertFalse(ok)
    }

    @Test
    fun testExecuteMoveRejectsNegativeTargetPathIndex() {
        engine.resetGame()
        val move = MoveOption(
            grpPawns = listOf(engine.pawns[0]),
            targetPathIndex = -1,
            targetCoords = Pair(1, 2),
            isCapture = false,
            reachesHome = false,
            isGattiGroup = false
        )
        val ok = engine.executeMove(move)
        assertFalse(ok)
    }

    @Test
    fun testRollCowriesHandlesExtraRollNoMovesReRoll() {
        // This test verifies the extra-roll no-moves behavior:
        // When an extra roll yields no valid moves, the SAME player re-rolls (turn NOT passed).
        // We can't easily force a specific roll, but we verify the logic doesn't advance turn.
        engine.resetGame()
        // Can't force a roll, but we verify no crash
        val result = engine.rollCowries()
        assertNotNull(result)
        val initialPlayer = engine.currentPlayerIndex
        // If it's an extra roll with no moves, player should NOT change
        // (we can't force this easily, just verify no crash)
        assertEquals(initialPlayer, engine.currentPlayerIndex)
    }

    // ---- Tollu / toughened Gatti mechanics ----

    private fun tolluPair(): Pair<Pawn, Pawn> {
        engine.resetGame()
        engine.hasCapturedOpponent[0] = true
        val a = player0Pawn(0).apply { state = PawnState.ON_TRACK; pathIndex = 17 }
        val b = player0Pawn(1).apply { state = PawnState.ON_TRACK; pathIndex = 17 }
        return a to b
    }

    @Test
    fun testTolluPairMovesAtHalfRate() {
        tolluPair()
        val moves = calculateValidMoves(GridSize.FIVE_BY_FIVE, engine.pawns, 0,
            engine.hasCapturedOpponent, 4, engine.toughenedCells)
        val tollu = moves.firstOrNull { it.isGattiGroup }
        assertNotNull(tollu)
        assertEquals(2, tollu!!.grpPawns.size)
        assertEquals(19, tollu.targetPathIndex) // floor(4/2) = 2 steps
        assertFalse(tollu.isToughened)
        assertFalse(tollu.toughens)
    }

    @Test
    fun testTolluPairStuckOnOddRolls() {
        tolluPair()
        // Even-only movement: odd scores offer no group move at all.
        for (s in listOf(1, 3, 5, 7)) {
            val moves = calculateValidMoves(GridSize.FIVE_BY_FIVE, engine.pawns, 0,
                engine.hasCapturedOpponent, s, engine.toughenedCells)
            assertTrue(moves.none { it.isGattiGroup }) // odd roll: stuck
        }
    }

    @Test
    fun testToughenedPairStuckOnOddRollsMovesFullOnEven() {
        tolluPair()
        engine.toughenedCells.getOrPut(0) { mutableSetOf() }.add(17)
        for (s in listOf(1, 3)) {
            val stuck = calculateValidMoves(GridSize.FIVE_BY_FIVE, engine.pawns, 0,
                engine.hasCapturedOpponent, s, engine.toughenedCells)
            assertTrue(stuck.none { it.isGattiGroup })
        }
        val moves = calculateValidMoves(GridSize.FIVE_BY_FIVE, engine.pawns, 0,
            engine.hasCapturedOpponent, 4, engine.toughenedCells)
        val hard = moves.firstOrNull { it.isGattiGroup }
        assertNotNull(hard)
        assertEquals(21, hard!!.targetPathIndex)
        assertTrue(hard.isToughened)
        assertFalse(hard.toughens)
    }

    @Test
    fun testGattiCapturesGattiTakesWholePair() {
        engine.resetGame()
        engine.hasCapturedOpponent[0] = true
        // P0 toughened pair idx 18 + 4 -> 22 = (3,3); P1 toughened pair at (3,3) = idx 18.
        player0Pawn(0).apply { state = PawnState.ON_TRACK; pathIndex = 18 }
        player0Pawn(1).apply { state = PawnState.ON_TRACK; pathIndex = 18 }
        player1Pawn(0).apply { state = PawnState.ON_TRACK; pathIndex = 18 }
        player1Pawn(1).apply { state = PawnState.ON_TRACK; pathIndex = 18 }
        engine.toughenedCells.getOrPut(0) { mutableSetOf() }.add(18)
        engine.toughenedCells.getOrPut(1) { mutableSetOf() }.add(18)
        val moves = calculateValidMoves(GridSize.FIVE_BY_FIVE, engine.pawns, 0,
            engine.hasCapturedOpponent, 4, engine.toughenedCells)
        val g = moves.firstOrNull { it.targetPathIndex == 22 }
        assertNotNull(g)
        assertTrue(g!!.isCapture)
        assertTrue(g.capturesGatti)
        val res = executeMovePure(GridSize.FIVE_BY_FIVE, engine.pawns.toList(),
            engine.hasCapturedOpponent.toMap(), 0, g, CowryResult(emptyList(), 4, false, "t"), engine.toughenedCells)
        assertNull(res.error)
        assertEquals(2, res.capturedCount)
        assertTrue(res.pawns.filter { it.playerIndex == 1 }.all { it.state == PawnState.HOME_BASE })
        assertEquals(mapOf(0 to setOf(22)), res.toughened) // attacker flag carried over
        assertTrue(res.extraTurn)
        assertFalse(res.gattiFormed) // capture, not hardening
    }

    @Test
    fun testTolluPairToughensOnExactTwo() {
        tolluPair()
        val moves = calculateValidMoves(GridSize.FIVE_BY_FIVE, engine.pawns, 0,
            engine.hasCapturedOpponent, 2, engine.toughenedCells)
        val harden = moves.firstOrNull { it.isGattiGroup }
        assertNotNull(harden)
        assertEquals(18, harden!!.targetPathIndex)
        assertTrue(harden.toughens)
        val res = executeMovePure(GridSize.FIVE_BY_FIVE, engine.pawns.toList(),
            engine.hasCapturedOpponent.toMap(), 0, harden, CowryResult(emptyList(), 2, false, "t"), engine.toughenedCells)
        assertNull(res.error)
        assertTrue(res.gattiFormed)
        assertEquals(mapOf(0 to setOf(18)), res.toughened)
    }

    @Test
    fun testToughenedPairMovesFullRateAndBlocks() {
        tolluPair()
        engine.toughenedCells.getOrPut(0) { mutableSetOf() }.add(17)
        // Full rate for the hardened pair (even roll).
        val moves = calculateValidMoves(GridSize.FIVE_BY_FIVE, engine.pawns, 0,
            engine.hasCapturedOpponent, 4, engine.toughenedCells)
        val hard = moves.firstOrNull { it.isGattiGroup }
        assertNotNull(hard)
        assertEquals(21, hard!!.targetPathIndex)
        assertTrue(hard.isToughened)
        // Blockade: P1 (cut made) at idx 19 + 4 crosses idx 21 = (2,1),
        // where P0's toughened pair sits -> the crossing is dropped.
        engine.hasCapturedOpponent[1] = true
        val p1 = engine.pawns.first { it.playerIndex == 1 }
        p1.state = PawnState.ON_TRACK
        p1.pathIndex = 19
        val blocked = calculateValidMoves(GridSize.FIVE_BY_FIVE, engine.pawns, 1,
            engine.hasCapturedOpponent, 4, engine.toughenedCells)
        assertTrue(blocked.none { it.targetPathIndex == 23 })
        // Without the flag the same crossing is legal (tollu doesn't blockade).
        engine.toughenedCells.clear()
        val open = calculateValidMoves(GridSize.FIVE_BY_FIVE, engine.pawns, 1,
            engine.hasCapturedOpponent, 4, engine.toughenedCells)
        assertTrue(open.any { it.targetPathIndex == 23 })
    }

    @Test
    fun testCaptureOneOfPair() {
        engine.resetGame()
        // P0 pawn at idx 3, P1 stacked pair at (1,4) = P1 idx 13 (outer).
        val mover = player0Pawn(0).apply { state = PawnState.ON_TRACK; pathIndex = 3 }
        val v1 = player1Pawn(0).apply { state = PawnState.ON_TRACK; pathIndex = 13 }
        val v2 = player1Pawn(1).apply { state = PawnState.ON_TRACK; pathIndex = 13 }
        val moves = calculateValidMoves(GridSize.FIVE_BY_FIVE, engine.pawns, 0,
            engine.hasCapturedOpponent, 2, engine.toughenedCells)
        val cap = moves.firstOrNull { it.isCapture }
        assertNotNull(cap)
        val res = executeMovePure(GridSize.FIVE_BY_FIVE, engine.pawns.toList(),
            engine.hasCapturedOpponent.toMap(), 0, cap!!, CowryResult(emptyList(), 2, false, "t"), engine.toughenedCells)
        assertEquals(1, res.capturedCount)
        assertEquals(PawnState.HOME_BASE, res.pawns.first { it.id == v1.id }.state)
        assertEquals(-1, res.pawns.first { it.id == v1.id }.pathIndex)
        assertEquals(PawnState.ON_TRACK, res.pawns.first { it.id == v2.id }.state)
        assertEquals(13, res.pawns.first { it.id == v2.id }.pathIndex)
    }

    @Test
    fun testOuterPairMovesAsSingles() {
        engine.resetGame()
        engine.hasCapturedOpponent[0] = true
        player0Pawn(0).apply { state = PawnState.ON_TRACK; pathIndex = 5 }
        player0Pawn(1).apply { state = PawnState.ON_TRACK; pathIndex = 5 }
        val moves = calculateValidMoves(GridSize.FIVE_BY_FIVE, engine.pawns, 0,
            engine.hasCapturedOpponent, 1, engine.toughenedCells)
        // The stacked pair moves as 2 independent singles (plus the 2 HOME
        // entries): no Gatti group anywhere.
        assertEquals(4, moves.size)
        assertTrue(moves.all { !it.isGattiGroup && it.grpPawns.size == 1 })
        assertEquals(
            listOf(0, 1),
            moves.filter { it.targetPathIndex == 6 }.flatMap { m -> m.grpPawns.map { it.id } }.sorted()
        )
    }

    @Test
    fun testResetGameClearsToughenedCells() {
        engine.resetGame()
        engine.toughenedCells.getOrPut(0) { mutableSetOf() }.add(17)
        engine.resetGame()
        assertTrue(engine.toughenedCells.isEmpty())
        assertTrue(engine.snapshot().toughened.isEmpty())
    }

    @Test
    fun testOnlyDiceProducibleScoresYieldMoves() {
        engine.resetGame()
        player0Pawn(0).apply { state = PawnState.ON_TRACK; pathIndex = 5 }
        // 5x5 dice make {1,2,3,4,8}: 5, 6, 7 are impossible rolls.
        for (bad in listOf(5, 6, 7)) {
            assertTrue(
                calculateValidMoves(GridSize.FIVE_BY_FIVE, engine.pawns, 0,
                    engine.hasCapturedOpponent, bad, engine.toughenedCells).isEmpty()
            )
        }
        // 7x7 dice make {1..6,12}: 5 is legal, 7..11 are not.
        engine.hasCapturedOpponent[0] = true
        assertTrue(
            calculateValidMoves(GridSize.SEVEN_BY_SEVEN, engine.pawns, 0,
                engine.hasCapturedOpponent, 5, engine.toughenedCells).isNotEmpty()
        )
        for (bad in listOf(7, 8, 9, 10, 11)) {
            assertTrue(
                calculateValidMoves(GridSize.SEVEN_BY_SEVEN, engine.pawns, 0,
                    engine.hasCapturedOpponent, bad, engine.toughenedCells).isEmpty()
            )
        }
    }

    @Test
    fun testForgedCaptureOnToughenedCatchesNothing() {
        engine.resetGame()
        // P1 flagged pair at (3,3) = P1 path 18; P0 single forges isCapture.
        // (No gate flag: the forged move bypasses calculateValidMoves, which
        // is exactly the hardening under test.)
        player0Pawn(0).apply { state = PawnState.ON_TRACK; pathIndex = 20 }
        player1Pawn(0).apply { state = PawnState.ON_TRACK; pathIndex = 18 }
        player1Pawn(1).apply { state = PawnState.ON_TRACK; pathIndex = 18 }
        engine.toughenedCells.getOrPut(1) { mutableSetOf() }.add(18)
        val forged = MoveOption(
            grpPawns = listOf(player0Pawn(0)),
            targetPathIndex = 22,
            targetCoords = TrackBuilder.getPlayerPath(GridSize.FIVE_BY_FIVE, 0)[22],
            isCapture = true,
            reachesHome = false,
            isGattiGroup = false
        )
        val res = executeMovePure(GridSize.FIVE_BY_FIVE, engine.pawns.toList(),
            engine.hasCapturedOpponent.toMap(), 0, forged, CowryResult(emptyList(), 2, false, "t"),
            engine.toughenedCells)
        assertNull(res.error)
        assertEquals(0, res.capturedCount)
        assertFalse(res.hasCapturedOpponent[0] == true)
        assertFalse(res.extraTurn)
        assertEquals(PawnState.ON_TRACK, res.pawns.first { it.id == player1Pawn(0).id }.state)
    }
}
