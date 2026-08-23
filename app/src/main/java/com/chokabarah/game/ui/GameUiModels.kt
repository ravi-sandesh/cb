package com.chokabarah.game.ui

import com.chokabarah.game.ScreenState
import com.chokabarah.game.engine.GameMode
import com.chokabarah.game.engine.GridSize
import com.chokabarah.game.engine.PawnState
import com.chokabarah.game.engine.PlayerColor

// ============================================================
// ChokaBarah – Immutable UI projections of the game engine
// ------------------------------------------------------------
// The engine keeps MUTABLE state (Pawn has var fields) and is not
// Compose-observable by design: it stays a pure-JVM module. Every
// render therefore flows through these immutable snapshots instead:
// the ViewModel rebuilds a GameUiState after each mutation and the
// UI collects it as a StateFlow. No revision counters, no manual
// recomposition triggers — and the renderer can never observe a
// half-applied move.
// ============================================================

/** Immutable copy of an engine pawn's render-relevant fields. */
data class PawnUi(
    val id: Int,
    val playerIndex: Int,
    val state: PawnState,
    val pathIndex: Int
)

/**
 * A legal move offered to the CURRENT player. Mirrors web's serializeBoard
 * move shape: only ids + target are carried, so a stale/garbage move can be
 * re-validated against live validMoves before execution (executeValidMove).
 */
data class MoveUi(
    val pawnIds: List<Int>,
    val targetCoords: Pair<Int, Int>,
    /** Captures render with a red highlight on the board. */
    val isCapture: Boolean
)

/** The pending cowry roll, or null before the first roll of a turn. */
data class RollUi(
    val shells: List<Boolean>,
    val label: String,
    val isExtraRoll: Boolean
)

/** Everything the board canvas needs to draw one frame of the match. */
data class BoardUi(
    val gridSize: GridSize,
    val pawns: List<PawnUi>,
    val playerColors: List<PlayerColor>,
    val validMoves: List<MoveUi>,
    val currentPlayerIndex: Int,
    /** Inner-gate unlock flag for the player ON TURN. */
    val isCutUnlocked: Boolean,
    val currentRoll: RollUi?,
    val winner: PlayerColor?
)

data class GameUiState(
    val screen: ScreenState = ScreenState.HOME,
    val gridSize: GridSize = GridSize.FIVE_BY_FIVE,
    val playerCount: Int = 2,
    val gameMode: GameMode = GameMode.PASS_AND_PLAY,
    /** Null while on HOME. */
    val board: BoardUi? = null,
    val selectedPawnId: Int? = null,
    val showPauseMenu: Boolean = false
) {
    /** Human input is only meaningful when it is NOT a bot seat's turn. */
    val isBotTurn: Boolean
        get() = gameMode == GameMode.VS_BOT && board != null && board.currentPlayerIndex != 0

    val canRoll: Boolean
        get() {
            val b = board ?: return false
            return !isBotTurn && b.currentRoll == null && b.winner == null
        }
}
