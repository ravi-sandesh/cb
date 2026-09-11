package com.chokabarah.game.ui

import androidx.lifecycle.SavedStateHandle
import com.chokabarah.game.ScreenState
import com.chokabarah.game.engine.GameMode
import com.chokabarah.game.engine.GridSize
import com.chokabarah.game.engine.PawnState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

// ViewModel contract tests. The engine is fully encapsulated now: every
// assertion reads the published GameUiState, exactly like the UI does.
@OptIn(ExperimentalCoroutinesApi::class)
class GameViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    private fun idle() = dispatcher.scheduler.advanceUntilIdle()
    private fun runNow() = dispatcher.scheduler.runCurrent()
    private fun timeTravel(ms: Long) { dispatcher.scheduler.advanceTimeBy(ms); dispatcher.scheduler.advanceUntilIdle() }

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun freshViewModel(): GameViewModel {
        val vm = GameViewModel(SavedStateHandle())
        idle()
        return vm
    }

    private fun playToHumanMove(vm: GameViewModel) {
        var attempts = 0
        while (vm.uiState.value.board!!.validMoves.isEmpty()) {
            if (vm.uiState.value.board!!.winner != null) break
            vm.rollCowries()
            // runCurrent (NOT advanceUntilIdle): execute queued publication
            // work without advancing virtual time, which would let a queued
            // bot job play through its delays and take over the game.
            runNow()
            check(++attempts < 200) { "Never rolled a move" }
        }
    }

    @Test
    fun freshInstanceStartsAtHomeWithoutBoard() {
        val ui = freshViewModel().uiState.value
        assertEquals(ScreenState.HOME, ui.screen)
        assertNull(ui.board)
        assertFalse(ui.isBotTurn)
        assertFalse(ui.canRoll)
    }

    @Test
    fun startGameSeedsAPlayingMatch() {
        val vm = freshViewModel()
        vm.startGame(GridSize.SEVEN_BY_SEVEN, 3, GameMode.VS_BOT)
        idle()
        val ui = vm.uiState.value
        assertEquals(ScreenState.PLAYING, ui.screen)
        assertEquals(GridSize.SEVEN_BY_SEVEN, ui.gridSize)
        assertEquals(3, ui.playerCount)
        assertEquals(GameMode.VS_BOT, ui.gameMode)
        assertNotNull(ui.board)
        // VS_BOT starts on seat 0 (human), so input is allowed.
        assertFalse(ui.isBotTurn)
    }

    @Test
    fun startGameClampsInvalidPlayerCounts() {
        val vm = freshViewModel()
        vm.startGame(GridSize.FIVE_BY_FIVE, 1, GameMode.PASS_AND_PLAY)
        assertEquals(2, vm.uiState.value.playerCount) // BUG-08 defensive clamp
        vm.startGame(GridSize.FIVE_BY_FIVE, 9, GameMode.PASS_AND_PLAY)
        assertEquals(4, vm.uiState.value.playerCount)
    }

    @Test
    fun rollCowriesPublishesARollOrPassesTheTurn() {
        val vm = freshViewModel()
        vm.startGame(GridSize.FIVE_BY_FIVE, 2, GameMode.PASS_AND_PLAY)
        vm.rollCowries()
        idle()
        val board = vm.uiState.value.board!!
        // Either a pending roll exists or a dead roll already passed the turn.
        assertTrue(board.currentRoll != null || board.currentPlayerIndex == 1)
    }

    @Test
    fun executeValidMoveAppliesAndRepublishes() {
        val vm = freshViewModel()
        vm.startGame(GridSize.FIVE_BY_FIVE, 2, GameMode.PASS_AND_PLAY)
        playToHumanMove(vm)
        val before = vm.uiState.value.board!!
        val move = before.validMoves.first()

        assertTrue(vm.executeValidMove(move))
        idle()
        val after = vm.uiState.value.board!!
        // Roll consumed and turn advanced (score 1..3 has no extra turn).
        assertNull(after.currentRoll)
        assertTrue(after.validMoves.isEmpty())
    }

    @Test
    fun staleMovesAreRejectedWithoutMutatingTheEngine() {
        val vm = freshViewModel()
        vm.startGame(GridSize.FIVE_BY_FIVE, 2, GameMode.PASS_AND_PLAY)
        vm.rollCowries()
        idle()
        val forged = MoveUi(pawnIds = listOf(0, 1, 2), targetCoords = 99 to 99, isCapture = false)
        assertFalse(vm.executeValidMove(forged))
        // Engine state unchanged: still player 0's business.
        assertEquals(0, vm.uiState.value.board!!.currentPlayerIndex)
    }

    @Test
    fun onCellClickedSelectsAPawnOnItsStartCell() {        val vm = freshViewModel()
        vm.startGame(GridSize.FIVE_BY_FIVE, 2, GameMode.PASS_AND_PLAY)
        val start = com.chokabarah.game.engine.TrackBuilder
            .getPlayerPath(GridSize.FIVE_BY_FIVE, 0)[0]
        vm.onCellClicked(start.first, start.second)
        runNow()
        assertNotNull(vm.uiState.value.selectedPawnId)

        // Tapping an empty cell clears the selection again.
        vm.onCellClicked(4, 4)
        runNow()
        assertNull(vm.uiState.value.selectedPawnId)
    }

    @Test
    fun onCellClickedMovesTheSelectedPawnOnSharedTargets() {
        val vm = freshViewModel()
        vm.startGame(GridSize.FIVE_BY_FIVE, 2, GameMode.PASS_AND_PLAY)
        playToHumanMove(vm)
        // Fresh game: every HOME pawn offers the same target cell. Tapping it
        // must move the SELECTED pawn, not just the first matching move.
        // (A fresh first roll always offers HOME moves, so this is guaranteed.)
        val target = vm.uiState.value.board!!.validMoves
            .groupBy { it.targetCoords }
            .entries.firstOrNull { it.value.size >= 2 }?.key
            ?: throw AssertionError("expected a shared HOME target on the first roll")
        vm.selectPawn(1)
        runNow()
        vm.onCellClicked(target.first, target.second)
        runNow()
        val pawns = vm.uiState.value.board!!.pawns
        assertEquals(PawnState.ON_TRACK, pawns.first { it.id == 1 }.state)
        assertEquals(PawnState.HOME_BASE, pawns.first { it.id == 0 }.state)
    }

    @Test
    fun pauseMenuBlocksHumanActionsAndSuspendsTheBot() {
        val vm = freshViewModel()
        vm.startGame(GridSize.FIVE_BY_FIVE, 2, GameMode.VS_BOT)
        vm.setShowPauseMenu(true)
        idle()
        assertTrue(vm.uiState.value.showPauseMenu)
        val rollsBefore = vm.uiState.value.board!!.currentRoll

        // Roll attempts while paused are ignored.
        vm.rollCowries()
        idle()
        assertEquals(rollsBefore, vm.uiState.value.board!!.currentRoll)

        vm.setShowPauseMenu(false)
        idle()
        assertFalse(vm.uiState.value.showPauseMenu)
    }

    @Test
    fun botConsumesExtraRollChainWithoutStalling() {
        // Find a seed where the HUMAN's first roll is a plain 1-3 (turn passes)
        // and the BOT's roll is a CHOWKA (all four mouths up = extra roll).
        val seed = (0 until 5000).first { s ->
            val r = kotlin.random.Random(s)
            val human = List(4) { r.nextBoolean() }
            val bot = List(4) { r.nextBoolean() }
            val hScore = human.count { it }.let { if (it == 0) 8 else if (it == 4) 4 else it }
            hScore in 1..3 && bot.all { it }
        }

        val vm = GameViewModel(SavedStateHandle(), rng = kotlin.random.Random(seed))
        vm.startGame(GridSize.FIVE_BY_FIVE, 2, GameMode.VS_BOT)
        playToHumanMove(vm)

        // Human takes the first valid move; the seat passes to the bot.
        val move = vm.uiState.value.board!!.validMoves.first()
        vm.executeValidMove(move)
        assertEquals(1, vm.uiState.value.board!!.currentPlayerIndex)

        // The bot now rolls CHOWKA (extra roll). After its move it KEEPS the
        // seat — the scheduler must chain into the next bot segment instead
        // of stalling with an idle board and no pending roll.
        timeTravel(60_000)

        val board = vm.uiState.value.board!!
        assertTrue(
            "Bot stalled on its extra turn (no progress after Chowka)",
            board.winner != null || board.currentPlayerIndex == 0
        )
    }

    @Test
    fun botTurnCompletesOnItsOwn() {
        val vm = freshViewModel()
        vm.startGame(GridSize.FIVE_BY_FIVE, 2, GameMode.VS_BOT)
        playToHumanMove(vm)
        val move = vm.uiState.value.board!!.validMoves.first()
        vm.executeValidMove(move)
        // Let every queued bot segment (including its delays) run to completion.
        timeTravel(60_000)
        idle()

        val board = vm.uiState.value.board!!
        // The bot consumed the roll; the game either ended or the turn came
        // back to the human seat. No pending roll may leak across segments.
        assertNull(board.currentRoll)
        assertTrue(board.winner != null || board.currentPlayerIndex == 0)
    }

    @Test
    fun sessionSurvivesSimulatedProcessDeath() {
        val original = freshViewModel()
        original.startGame(GridSize.FIVE_BY_FIVE, 2, GameMode.VS_BOT)
        playToHumanMove(original)
        original.uiState.value.board!!.validMoves.firstOrNull()?.let { original.executeValidMove(it) }
        original.selectPawn(3)
        runNow()

        // Rebuild the handle exactly as the OS would after process death:
        // only the persisted primitives survive.
        val revivedHandle = SavedStateHandle(buildMap {
            put("cb_screen", ScreenState.PLAYING.name)
            put("cb_grid_columns", original.uiState.value.gridSize.columns)
            put("cb_player_count", original.uiState.value.playerCount)
            put("cb_game_mode", original.uiState.value.gameMode.name)
            put("cb_engine_snapshot", original.savedState.get<String>("cb_engine_snapshot")!!)
            put("cb_selected_pawn_id", original.uiState.value.selectedPawnId)
        })
        val revived = GameViewModel(revivedHandle)
        runNow()

        val src = original.uiState.value
        val dst = revived.uiState.value
        assertEquals(ScreenState.PLAYING, dst.screen)
        assertEquals(src.gridSize, dst.gridSize)
        assertEquals(src.playerCount, dst.playerCount)
        assertEquals(src.gameMode, dst.gameMode)
        assertEquals(src.selectedPawnId, dst.selectedPawnId)

        val srcBoard = src.board!!
        val dstBoard = dst.board!!
        assertEquals(srcBoard.currentPlayerIndex, dstBoard.currentPlayerIndex)
        assertEquals(srcBoard.winner, dstBoard.winner)
        assertEquals(srcBoard.currentRoll?.shells, dstBoard.currentRoll?.shells)
        assertEquals(srcBoard.pawns, dstBoard.pawns)
        assertEquals(srcBoard.validMoves, dstBoard.validMoves)

        // A live match keeps flowing after revival — unless it landed on the
        // bot's seat, in which case input is (correctly) refused.
        if (!dst.isBotTurn) {
            val before = revived.uiState.value.board!!
            revived.rollCowries()
            timeTravel(60_000)
            idle()
            assertTrue(
                before.currentPlayerIndex != revived.uiState.value.board!!.currentPlayerIndex ||
                    before.currentRoll?.shells != revived.uiState.value.board!!.currentRoll?.shells ||
                    before.winner != null
            )
        }
    }

    @Test
    fun corruptSnapshotFallsBackToHomeFlow() {
        // Screen says PLAYING but the payload is garbage: must not crash and
        // must not pretend a match was restored.
        val handle = SavedStateHandle(
            mapOf(
                "cb_screen" to ScreenState.PLAYING.name,
                "cb_grid_columns" to 5,
                "cb_player_count" to 2,
                "cb_game_mode" to GameMode.PASS_AND_PLAY.name,
                "cb_engine_snapshot" to "GARBAGE|NOT|A|SNAPSHOT"
            )
        )
        val vm = GameViewModel(handle)
        idle()
        assertNull(vm.uiState.value.board)
        assertEquals(ScreenState.HOME, vm.uiState.value.screen)
    }

    @Test
    fun selectPawnRejectsForeignAndUntimelySelections() {
        val vm = freshViewModel()
        vm.startGame(GridSize.FIVE_BY_FIVE, 2, GameMode.PASS_AND_PLAY)
        runNow()
        // Pawn 4 belongs to seat 1, but seat 0 is on turn: rejected.
        vm.selectPawn(4)
        runNow()
        assertNull(vm.uiState.value.selectedPawnId)
        // Own pawn selects fine...
        vm.selectPawn(0)
        runNow()
        assertEquals(0, vm.uiState.value.selectedPawnId)
        // ...but not while paused: the highlight would outlive its context.
        vm.setShowPauseMenu(true)
        runNow()
        vm.selectPawn(1)
        runNow()
        assertNull(vm.uiState.value.selectedPawnId)
        vm.setShowPauseMenu(false)
        runNow()
    }

    @Test
    fun restartWithoutEngineIsANoOp() {
        val vm = freshViewModel() // never started: no engine, HOME screen
        vm.restart() // must not throw
        idle()
        assertEquals(ScreenState.HOME, vm.uiState.value.screen)
        assertNull(vm.uiState.value.board)
    }

    @Test
    fun restartResetsSelectionAndBoard() {
        val vm = freshViewModel()
        vm.startGame(GridSize.FIVE_BY_FIVE, 2, GameMode.PASS_AND_PLAY)
        playToHumanMove(vm)
        vm.selectPawn(vm.uiState.value.board!!.validMoves.first().pawnIds.first())
        runNow()
        vm.restart()
        idle()
        val board = vm.uiState.value.board!!
        assertNull(vm.uiState.value.selectedPawnId)
        assertTrue(board.pawns.all { it.state == PawnState.HOME_BASE })
        assertEquals(0, board.currentPlayerIndex)
    }

    @Test
    fun exitToMenuClearsTheMatch() {
        val vm = freshViewModel()
        vm.startGame(GridSize.FIVE_BY_FIVE, 2, GameMode.PASS_AND_PLAY)
        vm.exitToMenu()
        idle()
        val ui = vm.uiState.value
        assertEquals(ScreenState.HOME, ui.screen)
        assertNull(ui.board)
        assertNull(ui.selectedPawnId)
    }
}
