package com.chokabarah.game.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import com.chokabarah.game.ScreenState
import com.chokabarah.game.engine.GameEngine
import com.chokabarah.game.engine.GameMode
import com.chokabarah.game.engine.GameSnapshotCodec
import com.chokabarah.game.engine.GridSize
import com.chokabarah.game.engine.MoveOption
import com.chokabarah.game.engine.PlayerColor
import com.chokabarah.game.telemetry.Telemetry

// ============================================================
// ChokaBarah – Game session ViewModel
// ------------------------------------------------------------
// Owns EVERYTHING a match needs to survive an Activity recreation
// (rotation) and a process death:
//  - navigation (HOME vs PLAYING) and match configuration,
//  - the authoritative GameEngine instance itself,
//  - cross-recomposition gameplay latches (bot busy flag),
//  - the pawn selection + pause menu UI state.
//
// Rotation survival comes free: the ViewModelStore outlives the
// Activity. Process-death survival works by mirroring the full
// engine snapshot (GameSnapshotCodec) into SavedStateHandle after
// every mutation; init() replays it into a fresh engine.
// ============================================================

class GameViewModel(private val savedState: SavedStateHandle) : ViewModel() {

    companion object {
        private const val KEY_SCREEN = "cb_screen"
        private const val KEY_GRID_COLUMNS = "cb_grid_columns"
        private const val KEY_PLAYER_COUNT = "cb_player_count"
        private const val KEY_GAME_MODE = "cb_game_mode"
        private const val KEY_ENGINE_SNAPSHOT = "cb_engine_snapshot"
        private const val KEY_SELECTED_PAWN_ID = "cb_selected_pawn_id"
    }

    var screen by mutableStateOf(ScreenState.HOME)
        private set
    var gridSize by mutableStateOf(GridSize.FIVE_BY_FIVE)
        private set
    var playerCount by mutableIntStateOf(2)
        private set
    var gameMode by mutableStateOf(GameMode.PASS_AND_PLAY)
        private set

    // Non-null exactly while screen == PLAYING. Mutations bump [revision],
    // which the UI observes to re-read the engine's plain fields.
    var engine: GameEngine? = null
        private set
    var revision by mutableIntStateOf(0)
        private set

    var selectedPawnId by mutableStateOf<Int?>(null)
        private set
    var showPauseMenu by mutableStateOf(false)
        internal set

    // Bot automation latch. Deliberately NOT persisted: after process death a
    // fresh LaunchedEffect re-drives the bot from the restored board.
    var botProcessing by mutableStateOf(false)

    init {
        if (savedState.get<String>(KEY_SCREEN) == ScreenState.PLAYING.name) {
            runCatching {
                val columns = requireNotNull(savedState.get<Int>(KEY_GRID_COLUMNS)) { "missing grid" }
                val grid = GridSize.entries.first { it.columns == columns }
                val players = requireNotNull(savedState.get<Int>(KEY_PLAYER_COUNT)) { "missing player count" }
                val mode = GameMode.valueOf(requireNotNull(savedState.get<String>(KEY_GAME_MODE)) { "missing mode" })
                val encoded = requireNotNull(savedState.get<String>(KEY_ENGINE_SNAPSHOT)) { "missing snapshot" }

                val restored = GameEngine(
                    gridSize = grid,
                    playerColors = PlayerColor.entries.take(players.coerceIn(2, PlayerColor.entries.size))
                )
                check(restored.restore(GameSnapshotCodec.decode(encoded))) { "snapshot rejected" }

                gridSize = grid
                playerCount = restored.playerColors.size
                gameMode = mode
                engine = restored
                val savedSelection = savedState.get<Int>(KEY_SELECTED_PAWN_ID)
                selectedPawnId = savedSelection?.takeIf { id -> restored.pawns.any { it.id == id } }
                screen = ScreenState.PLAYING
            }.onSuccess {
                Telemetry.info("ui", "session.restored", "Match restored after process death",
                    mapOf("gridSize" to gridSize.columns, "playerCount" to playerCount))
            }.onFailure { err ->
                Telemetry.warn("ui", "session.restore_failed", "Saved match unusable; starting fresh",
                    mapOf("error" to err.message))
            }
        }
    }

    /** Start a new match from the home screen configuration. */
    fun startGame(gridSize: GridSize, playerCount: Int, gameMode: GameMode) {
        this.gridSize = gridSize
        // Defensive clamp mirrors GameScreen's BUG-08 guard: HomeScreen only
        // offers 2..4, but keep the engine constructor contract safe anyway.
        this.playerCount = playerCount.coerceIn(2, PlayerColor.entries.size)
        this.gameMode = gameMode
        engine = GameEngine(
            gridSize = gridSize,
            playerColors = PlayerColor.entries.take(this.playerCount)
        )
        resetTransientUiState()
        screen = ScreenState.PLAYING
        Telemetry.info("ui", "game.started", "New match started",
            mapOf("gridSize" to gridSize.columns, "playerCount" to this.playerCount, "mode" to gameMode.name))
        notifyGameStateChanged()
    }

    fun exitToMenu() {
        screen = ScreenState.HOME
        engine = null
        savedState[KEY_SCREEN] = ScreenState.HOME.name
        resetTransientUiState()
        Telemetry.info("ui", "menu.exited", "Session ended; back to home")
    }

    /** Reset the current match to its initial state (RESTART / PLAY AGAIN). */
    fun restart() {
        requireNotNull(engine).resetGame()
        resetTransientUiState()
        notifyGameStateChanged()
    }

    fun rollCowries() {
        val eng = engine ?: return
        eng.rollCowries()
        notifyGameStateChanged()
    }

    /** Apply a move on behalf of the current seat; no-op without a live match. */
    fun executeMove(move: MoveOption): Boolean {
        val eng = engine ?: return false
        val applied = eng.executeMove(move)
        if (applied) notifyGameStateChanged()
        return applied
    }

    /**
     * Call after ANY direct engine mutation (the UI still touches the engine's
     * public state for reads); bumps the recomposition trigger and persists.
     */
    fun notifyGameStateChanged() {
        if (engine == null) return
        revision++
        persist()
    }

    /**
     * Select/deselect a pawn for move preview. Persisted immediately so the
     * selection also survives process death, not just the board itself.
     */
    fun selectPawn(pawnId: Int?) {
        selectedPawnId = pawnId
        persist()
    }

    private fun resetTransientUiState() {
        selectedPawnId = null
        showPauseMenu = false
        botProcessing = false
    }

    private fun persist() {
        val eng = engine ?: return
        savedState[KEY_SCREEN] = screen.name
        savedState[KEY_GRID_COLUMNS] = gridSize.columns
        savedState[KEY_PLAYER_COUNT] = playerCount
        savedState[KEY_GAME_MODE] = gameMode.name
        savedState[KEY_ENGINE_SNAPSHOT] = GameSnapshotCodec.encode(eng.snapshot())
        savedState[KEY_SELECTED_PAWN_ID] = selectedPawnId
    }
}
