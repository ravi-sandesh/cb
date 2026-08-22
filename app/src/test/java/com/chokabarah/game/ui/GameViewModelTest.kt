package com.chokabarah.game.ui

import androidx.lifecycle.SavedStateHandle
import com.chokabarah.game.ScreenState
import com.chokabarah.game.engine.GameMode
import com.chokabarah.game.engine.GridSize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

// Process-death survival contract, exercised on the JVM: the ViewModel mirrors
// every mutation into SavedStateHandle primitives, so replaying those exact
// key/value pairs into a fresh instance must rebuild an equivalent match.
// (No emulator needed — SavedStateHandle stores our String/Int values in a
// plain map until the system actually saves.)
class GameViewModelTest {

    @Test
    fun freshInstanceStartsAtHomeWithoutEngine() {
        val vm = GameViewModel(SavedStateHandle())
        assertEquals(ScreenState.HOME, vm.screen)
        assertNull(vm.engine)
        assertEquals(0, vm.revision)
    }

    @Test
    fun startGameSeedsAPlayingMatch() {
        val vm = GameViewModel(SavedStateHandle())
        vm.startGame(GridSize.SEVEN_BY_SEVEN, 3, GameMode.VS_BOT)
        assertEquals(ScreenState.PLAYING, vm.screen)
        assertEquals(GridSize.SEVEN_BY_SEVEN, vm.gridSize)
        assertEquals(3, vm.playerCount)
        assertEquals(GameMode.VS_BOT, vm.gameMode)
        assertNotNull(vm.engine)
    }

    @Test
    fun startGameClampsInvalidPlayerCounts() {
        val vm = GameViewModel(SavedStateHandle())
        vm.startGame(GridSize.FIVE_BY_FIVE, 1, GameMode.PASS_AND_PLAY)
        assertEquals(2, vm.playerCount) // BUG-08 defensive clamp
        vm.startGame(GridSize.FIVE_BY_FIVE, 9, GameMode.PASS_AND_PLAY)
        assertEquals(4, vm.playerCount)
    }

    @Test
    fun mutationsBumpTheRevision() {
        val vm = GameViewModel(SavedStateHandle())
        vm.startGame(GridSize.FIVE_BY_FIVE, 2, GameMode.PASS_AND_PLAY)
        val before = vm.revision
        vm.rollCowries()
        assertEquals(before + 1, vm.revision)
    }

    @Test
    fun sessionSurvivesSimulatedProcessDeath() {
        val original = GameViewModel(SavedStateHandle())
        original.startGame(GridSize.FIVE_BY_FIVE, 2, GameMode.VS_BOT)
        // Drive real gameplay: roll until moves exist, then take the best move.
        var attempts = 0
        while (original.engine!!.validMoves.isEmpty() && original.engine!!.winner == null) {
            original.rollCowries()
            check(++attempts < 200) { "Never rolled a move" }
        }
        original.engine!!.getBestBotMove()?.let { original.executeMove(it) }
        original.selectPawn(3)

        val revived = GameViewModel(rebornHandleOf(original))
        assertEquals(ScreenState.PLAYING, revived.screen)
        assertEquals(original.gridSize, revived.gridSize)
        assertEquals(original.playerCount, revived.playerCount)
        assertEquals(original.gameMode, revived.gameMode)

        val src = original.engine!!
        val dst = requireNotNull(revived.engine)
        assertEquals(src.currentPlayerIndex, dst.currentPlayerIndex)
        assertEquals(src.winner, dst.winner)
        assertEquals(src.currentRoll?.shells, dst.currentRoll?.shells)
        assertEquals(src.hasCapturedOpponent, dst.hasCapturedOpponent)
        assertEquals(
            src.pawns.map { Triple(it.id, it.state, it.pathIndex) },
            dst.pawns.map { Triple(it.id, it.state, it.pathIndex) }
        )
        assertEquals(3, revived.selectedPawnId)
        // A live match keeps flowing after revival: rolling still mutates.
        val revBefore = revived.revision
        revived.rollCowries()
        assertEquals(revBefore + 1, revived.revision)
    }

    @Test
    fun corruptSnapshotFallsBackToFreshHomeFlow() {
        // Screen says PLAYING but the payload is garbage: the ViewModel must
        // not crash and must not pretend a match was restored.
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
        assertNull(vm.engine)
    }

    @Test
    fun exitToMenuClearsTheMatch() {
        val vm = GameViewModel(SavedStateHandle())
        vm.startGame(GridSize.FIVE_BY_FIVE, 2, GameMode.PASS_AND_PLAY)
        vm.exitToMenu()
        assertEquals(ScreenState.HOME, vm.screen)
        assertNull(vm.engine)
        assertNull(vm.selectedPawnId)
    }

    // ---- helpers ----

    private fun rebornHandleOf(vm: GameViewModel): SavedStateHandle {
        // Rebuild the handle exactly as the system would after process death:
        // only the persisted primitives survive.
        return SavedStateHandle(buildMap {
            put("cb_screen", vm.screen.name)
            put("cb_grid_columns", vm.gridSize.columns)
            put("cb_player_count", vm.playerCount)
            put("cb_game_mode", vm.gameMode.name)
            vm.engine?.let {
                put("cb_engine_snapshot",
                    com.chokabarah.game.engine.GameSnapshotCodec.encode(it.snapshot()))
            }
            vm.selectedPawnId?.let { put("cb_selected_pawn_id", it) }
        })
    }
}
