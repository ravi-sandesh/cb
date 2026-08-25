package com.chokabarah.game.ui

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.chokabarah.game.ScreenState
import com.chokabarah.game.engine.GameEngine
import com.chokabarah.game.engine.GameMode
import com.chokabarah.game.engine.GameSnapshotCodec
import com.chokabarah.game.engine.GridSize
import com.chokabarah.game.engine.MoveOption
import com.chokabarah.game.engine.PawnState
import com.chokabarah.game.engine.PlayerColor
import com.chokabarah.game.engine.TrackBuilder
import com.chokabarah.game.telemetry.Telemetry
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

// ============================================================
// ChokaBarah – Game session ViewModel (single StateFlow source of truth)
// ------------------------------------------------------------
// The GameEngine is pure JVM and deliberately NOT observable; it also
// keeps mutable pawn state. This ViewModel therefore owns the ONLY
// bridge between them and the UI:
//
//  - every mutation funnels through an action method below, each ending
//    in publish(): rebuild a fresh immutable GameUiState from the engine
//    and emit it through [uiState];
//  - the UI never touches the engine — rendering reads GameUiState,
//    input calls action methods;
//  - bot automation runs as a viewModelScope job driven by publish(),
//    so it survives rotation with the process and pauses with the menu.
//
// Rotation survival comes from the ViewModelStore; process-death
// survival from mirroring an encoded engine snapshot into
// SavedStateHandle after every mutation.
//
// NOTE: Kotlin runs property initializers in declaration order — all
// mutable fields are declared BEFORE init so restoreFromSavedState()
// can safely overwrite them during construction.
// ============================================================

class GameViewModel(
    internal val savedState: SavedStateHandle,
    // Injectable for deterministic bot tests; production uses the default.
    private val rng: kotlin.random.Random = kotlin.random.Random.Default
) : ViewModel() {

    companion object {
        private const val KEY_SCREEN = "cb_screen"
        private const val KEY_GRID_COLUMNS = "cb_grid_columns"
        private const val KEY_PLAYER_COUNT = "cb_player_count"
        private const val KEY_GAME_MODE = "cb_game_mode"
        private const val KEY_ENGINE_SNAPSHOT = "cb_engine_snapshot"
        private const val KEY_SELECTED_PAWN_ID = "cb_selected_pawn_id"

        // Senior mode gives the bot a longer "thinking" beat so a slower
        // player can follow what happened turn by turn (700ms -> 1500ms).
        private const val BOT_DELAY_MS = 700L
        private const val BOT_DELAY_SENIOR_MS = 1500L
    }

    // ---- Mutable session state (declared before init; see class note) ----

    private val _uiState = MutableStateFlow(GameUiState())
    val uiState: StateFlow<GameUiState> = _uiState.asStateFlow()

    // Intentionally private + unobservable. Reads flow through uiState;
    // writes funnel through the action methods below.
    private var engine: GameEngine? = null
    private var selectedPawnIdValue: Int? = null
    private var showPauseMenuValue: Boolean = false

    /** Mirrors the accessibility setting for bot pacing. */
    var seniorPacing: Boolean = false
        private set

    private var botJob: Job? = null

    private var gridSize: GridSize = GridSize.FIVE_BY_FIVE
    private var playerCount: Int = 2
    private var gameMode: GameMode = GameMode.PASS_AND_PLAY

    // ---- Accessibility ----

    /** Called whenever the accessibility preference changes. */
    fun setSeniorPacing(enabled: Boolean) {
        seniorPacing = enabled
    }

    // ---- Session lifecycle ----

    /** Start a new match from the home screen configuration. */
    fun startGame(gridSize: GridSize, playerCount: Int, gameMode: GameMode) {
        cancelBot()
        this.gridSize = gridSize
        // Defensive clamp mirrors the BUG-08 guard: HomeScreen only offers
        // 2..4, but keep the engine constructor contract safe anyway.
        this.playerCount = playerCount.coerceIn(2, PlayerColor.entries.size)
        this.gameMode = gameMode
        engine = GameEngine(
            gridSize = gridSize,
            playerColors = PlayerColor.entries.take(this.playerCount),
            rng = rng
        )
        resetTransientUiState()
        Telemetry.info("ui", "game.started", "New match started",
            mapOf("gridSize" to gridSize.columns, "playerCount" to this.playerCount, "mode" to gameMode.name))
        publish()
    }

    fun exitToMenu() {
        cancelBot()
        engine = null
        savedState[KEY_SCREEN] = ScreenState.HOME.name
        resetTransientUiState()
        Telemetry.info("ui", "menu.exited", "Session ended; back to home")
        publish()
    }

    /** Reset the current match to its initial state (RESTART / PLAY AGAIN). */
    fun restart() {
        requireNotNull(engine).resetGame()
        resetTransientUiState()
        publish()
    }

    fun setShowPauseMenu(show: Boolean) {
        if (showPauseMenuValue == show) return
        showPauseMenuValue = show
        if (show) {
            // Pausing must suspend a bot mid-turn (BUG-16): kill the job;
            // resume re-schedules it from the restored board state.
            cancelBot()
        }
        publish()
    }

    // ---- Human actions ----

    /**
     * Select/deselect a pawn for move preview. Persisted immediately so the
     * selection survives process death alongside the board.
     */
    fun selectPawn(pawnId: Int?) {
        selectedPawnIdValue =
            if (pawnId != null && engine?.pawns?.any { it.id == pawnId } == true) pawnId else null
        publish()
    }

    fun rollCowries() {
        val eng = engine ?: return
        if (!humanMayAct()) return
        eng.rollCowries()
        selectedPawnIdValue = null
        publish()
    }

    /**
     * Apply a move chosen from the CURRENT validMoves projection. Ids + target
     * are re-matched against the live engine move set (mirroring the web
     * relay's matchMove), so a stale or forged MoveUi can never execute
     * anything illegal.
     */
    fun executeValidMove(move: MoveUi): Boolean {
        val eng = engine ?: return false
        if (!humanMayAct()) return false
        val live = eng.validMoves.firstOrNull { candidate ->
            candidate.targetCoords == move.targetCoords &&
                candidate.grpPawns.map { p -> p.id }.sorted() == move.pawnIds.sorted()
        } ?: run {
            Telemetry.warn("input", "move.stale_rejected", "Move no longer matches valid moves",
                mapOf(
                    "pawnIds" to move.pawnIds,
                    "target" to listOf(move.targetCoords.first, move.targetCoords.second)
                ))
            return false
        }
        applyLiveMove(live)
        return true
    }

    /**
     * Board tap routing (moved out of the composable so ALL engine access
     * lives here): try the tap as a move target first, then as a pawn
     * selection, otherwise clear the selection.
     */
    fun onCellClicked(row: Int, col: Int) {
        val eng = engine ?: return
        val st = _uiState.value
        if (st.showPauseMenu || st.isBotTurn || st.board?.winner != null) return
        val target = row to col
        val matching = eng.validMoves.firstOrNull { it.targetCoords == target }
        if (matching != null) {
            Telemetry.debug(
                "input", "board.tapped_move", "User tapped cell to move pawn",
                mapOf("row" to row, "col" to col, "pawnIds" to matching.grpPawns.map { it.id })
            )
            applyLiveMove(matching)
            return
        }
        val clicked = eng.pawns.firstOrNull { pawn ->
            pawn.playerIndex == eng.currentPlayerIndex && when (pawn.state) {
                PawnState.HOME_BASE ->
                    TrackBuilder.getPlayerPath(eng.gridSize, pawn.playerIndex).getOrNull(0) == target
                PawnState.ON_TRACK ->
                    pawn.pathIndex >= 0 &&
                        TrackBuilder.getPlayerPath(eng.gridSize, pawn.playerIndex)
                            .getOrNull(pawn.pathIndex) == target
                PawnState.FINISHED -> false
            }
        }
        if (clicked != null) {
            Telemetry.debug(
                "input", "pawn.selected_via_tap", "User selected a pawn on the board",
                mapOf("pawnIds" to listOf(clicked.id), "targetPathIndex" to clicked.pathIndex)
            )
            selectedPawnIdValue = clicked.id
            publish()
        } else {
            Telemetry.trace("input", "board.tapped_empty", "User tapped an empty/non-move cell",
                mapOf("row" to row, "col" to col))
            selectedPawnIdValue = null
            publish()
        }
    }

    // ---- Bot automation ----

    private fun scheduleBotIfNeeded() {
        val eng = engine ?: return
        val st = _uiState.value
        if (botJob?.isActive == true) return
        if (st.screen != ScreenState.PLAYING || st.showPauseMenu) return
        if (st.gameMode != GameMode.VS_BOT || st.board?.winner != null) return
        if (!st.isBotTurn) return

        botJob = viewModelScope.launch {
            val pace = if (seniorPacing) BOT_DELAY_SENIOR_MS else BOT_DELAY_MS
            delay(pace)
            // Re-validate after every suspension: restart/exit/pause may have
            // changed the world under us.
            if (!isBotTurnNow()) return@launch
            if (eng.currentRoll == null && eng.winner == null) {
                eng.rollCowries()
                publish() // shows the rolled shells while the bot "thinks"
            }
            delay(pace)
            delay(pace)
            if (!isBotTurnNow()) return@launch
            eng.getBestBotMove()?.let { eng.executeMove(it) }
            selectedPawnIdValue = null
            // Release the job slot BEFORE publishing: extra rolls (Chowka /
            // Baara) and captures keep this seat on turn, and publish() must
            // be able to chain the next bot segment — otherwise the game
            // deadlocks with an idle board on the bot's extra turn.
            botJob = null
            publish() // chains into the next segment when extra rolls keep the seat
        }
    }

    private fun cancelBot() {
        botJob?.cancel()
        botJob = null
    }

    private fun isBotTurnNow(): Boolean {
        val eng = engine ?: return false
        if (eng.winner != null || showPauseMenuValue) return false
        return gameMode == GameMode.VS_BOT && eng.currentPlayerIndex != 0
    }

    private fun humanMayAct(): Boolean {
        val st = _uiState.value
        return !st.showPauseMenu && !st.isBotTurn && st.board?.winner == null
    }

    private fun applyLiveMove(live: MoveOption) {
        val eng = engine ?: return
        eng.executeMove(live)
        selectedPawnIdValue = null
        publish()
    }

    // ---- Publication ----

    private fun resetTransientUiState() {
        selectedPawnIdValue = null
        showPauseMenuValue = false
    }

    private fun publish() {
        _uiState.value = buildState()
        persist()
        scheduleBotIfNeeded()
    }

    private fun buildState(): GameUiState {
        val eng = engine
            ?: return GameUiState(screen = ScreenState.HOME, gridSize = gridSize,
                playerCount = playerCount, gameMode = gameMode)
        return GameUiState(
            screen = ScreenState.PLAYING,
            gridSize = gridSize,
            playerCount = playerCount,
            gameMode = gameMode,
            board = BoardUi(
                gridSize = eng.gridSize,
                pawns = eng.pawns.map { PawnUi(it.id, it.playerIndex, it.state, it.pathIndex) },
                playerColors = eng.playerColors.toList(),
                validMoves = eng.validMoves.map { m ->
                    MoveUi(m.grpPawns.map { p -> p.id }.sorted(), m.targetCoords, m.isCapture)
                },
                currentPlayerIndex = eng.currentPlayerIndex,
                isCutUnlocked = eng.hasCapturedOpponent[eng.currentPlayerIndex] == true,
                currentRoll = eng.currentRoll?.let { RollUi(it.shells.toList(), it.label, it.isExtraRoll) },
                winner = eng.winner,
                logMessage = eng.gameLogMessage
            ),
            selectedPawnId = selectedPawnIdValue,
            showPauseMenu = showPauseMenuValue
        )
    }

    // ---- Persistence ----

    private fun persist() {
        savedState[KEY_SCREEN] =
            (if (engine == null) ScreenState.HOME else ScreenState.PLAYING).name
        val eng = engine ?: return
        savedState[KEY_GRID_COLUMNS] = gridSize.columns
        savedState[KEY_PLAYER_COUNT] = playerCount
        savedState[KEY_GAME_MODE] = gameMode.name
        savedState[KEY_ENGINE_SNAPSHOT] = GameSnapshotCodec.encode(eng.snapshot())
        savedState[KEY_SELECTED_PAWN_ID] = selectedPawnIdValue
    }

    private fun restoreFromSavedState() {
        if (savedState.get<String>(KEY_SCREEN) != ScreenState.PLAYING.name) return
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
            selectedPawnIdValue = savedSelection?.takeIf { id -> restored.pawns.any { it.id == id } }
        }.onSuccess {
            Telemetry.info("ui", "session.restored", "Match restored after process death",
                mapOf("gridSize" to gridSize.columns, "playerCount" to playerCount))
        }.onFailure { err ->
            Telemetry.warn("ui", "session.restore_failed", "Saved match unusable; starting fresh",
                mapOf("error" to err.message))
        }
        publish()
    }

    init {
        restoreFromSavedState()
    }
}
