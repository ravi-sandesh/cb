package com.chokabarah.game.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.SavedStateHandle
import com.chokabarah.game.engine.GameMode
import com.chokabarah.game.engine.GridSize
import com.chokabarah.game.engine.MoveOption
import com.chokabarah.game.engine.Pawn
import com.chokabarah.game.engine.PawnState
import com.chokabarah.game.engine.PlayerColor
import com.chokabarah.game.engine.TrackBuilder
import com.chokabarah.game.telemetry.Telemetry
import kotlinx.coroutines.delay

// Legacy entry point kept for previews/tests: builds a composition-scoped
// session. Production navigation goes through MainActivity, which owns a real
// GameViewModel that survives rotation AND process death.
@Composable
fun GameScreen(
    gridSize: GridSize,
    playerCount: Int,
    gameMode: GameMode,
    onBackToMenu: () -> Unit,
    seniorMode: Boolean = false
) {
    val session = remember(gridSize, playerCount, gameMode) {
        GameViewModel(SavedStateHandle()).apply {
            startGame(gridSize, playerCount.coerceIn(2, PlayerColor.entries.size), gameMode)
        }
    }
    GameScreen(session, seniorMode, onBackToMenu)
}

@Composable
fun GameScreen(
    state: GameViewModel,
    seniorMode: Boolean = false,
    onBackToMenu: () -> Unit
) {
    val gameEngine = requireNotNull(state.engine)
    // Bump point for engine mutations: every roll/move/restart increments the
    // revision in the ViewModel, re-reading the engine's plain fields here.
    val revision = state.revision

    // Derived straight from the observable selection id, so pawn highlighting
    // updates without an explicit recomposition trigger.
    val selectedPawn: Pawn? = gameEngine.pawns.firstOrNull { it.id == state.selectedPawnId }

    val currentPlayer = gameEngine.playerColors[gameEngine.currentPlayerIndex]
    val isBotTurn = state.gameMode == GameMode.VS_BOT && gameEngine.currentPlayerIndex != 0

    // Bot turn automation
    LaunchedEffect(
        gameEngine.currentPlayerIndex,
        gameEngine.currentRoll,
        gameEngine.validMoves,
        revision,
        isBotTurn,
        state.showPauseMenu
    ) {
        // Pausing the game must also pause a bot that is mid-turn; a bot must
        // not keep rolling/moving (and thus telemetry-spanning) behind the
        // pause dialog (BUG-16). Cancelling mid-flight must not strand the
        // botProcessing latch, or the bot would never move again after resume.
        if (state.showPauseMenu) {
            state.botProcessing = false
            return@LaunchedEffect
        }
        if (isBotTurn && gameEngine.winner == null && !state.botProcessing) {
            state.botProcessing = true
            // Senior mode gives the bot a longer "thinking" beat so a slower
            // player can follow what happened turn by turn (700ms -> 1500ms).
            val botDelayMs = if (seniorMode) 1500L else 700L
            delay(botDelayMs)
            if (gameEngine.currentRoll == null) {
                state.rollCowries()
            }
            delay(botDelayMs)
            val botMove = gameEngine.getBestBotMove()
            if (botMove != null) {
                state.executeMove(botMove)
            }
            state.selectPawn(null)
            state.botProcessing = false
        }
    }

    val headerColor = Color(0xFFFFD54F)
    val accentColor = Color(0xFFFFB74D)
    val bgColor = Color(0xFF1E1B18)
    val cardColor = Color(0xFF2C241E)
    val unlockedColor = Color(0xFF76FF03)

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(bgColor)
            .padding(16.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // Header row: Menu button (left), turn info (center), Restart button (right)
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedButton(
                    onClick = {
                        Telemetry.info(
                            "ui",
                            "menu.opened",
                            "Pause menu opened",
                            mapOf("gridSize" to state.gridSize.columns, "mode" to state.gameMode.name)
                        )
                        state.showPauseMenu = true
                    },
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Text(
                        text = "\u2699 MENU",
                        fontWeight = FontWeight.Bold,
                        color = accentColor
                    )
                }

                Spacer(Modifier.weight(1f))

                Text(
                    text = "${state.gridSize.columns}x${state.gridSize.columns} CHOKA BARAH",
                    color = headerColor,
                    fontSize = if (seniorMode) 20.sp else 16.sp,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center
                )

                Spacer(Modifier.weight(1f))

                Button(
                    onClick = {
                        Telemetry.info(
                            "ui",
                            "game.restarted",
                            "Game restarted by user",
                            mapOf("gridSize" to state.gridSize.columns)
                        )
                        state.restart()
                    },
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF5D4037))
                ) {
                    Text(
                        text = "\uD83D\uDD04 RESTART",
                        color = Color.White,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }

            Spacer(Modifier.height(12.dp))

            // Board card
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = Color(currentPlayer.hexColor))
            ) {
                Column(modifier = Modifier.padding(8.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = "TURN: ${currentPlayer.displayName}" +
                                (if (isBotTurn) " \uD83E\uDD16 (BOT)" else ""),
                            color = Color.White,
                            fontSize = if (seniorMode) 21.sp else 16.sp,
                            fontWeight = FontWeight.Bold
                        )

                        val isCutUnlocked =
                            gameEngine.hasCapturedOpponent[gameEngine.currentPlayerIndex] == true
                        Text(
                            text = if (isCutUnlocked) "\uD83D\uDD13 INNER UNLOCKED" else "\uD83D\uDD12 CUT REQUIRED",
                            color = if (isCutUnlocked) unlockedColor else headerColor,
                            fontSize = if (seniorMode) 15.sp else 12.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }

                    Spacer(Modifier.height(8.dp))

                    BoardCanvas(
                        gameEngine = gameEngine,
                        selectedPawn = selectedPawn,
                        seniorMode = seniorMode,
                        onCellClicked = { row, col ->
                            if (!isBotTurn && gameEngine.winner == null) {
                                val matchingMove = gameEngine.validMoves.firstOrNull {
                                    it.targetCoords == row to col
                                }
                                if (matchingMove != null) {
                                    Telemetry.debug(
                                        "input",
                                        "board.tapped_move",
                                        "User tapped cell to move pawn",
                                        mapOf(
                                            "row" to row,
                                            "col" to col,
                                            "pawnIds" to matchingMove.grpPawns.map { it.id }
                                        )
                                    )
                                    state.executeMove(matchingMove)
                                    state.selectPawn(null)
                                } else {
                                    // Selecting a pawn to preview its moves
                                    val clickedPawn = gameEngine.pawns.firstOrNull { pawn ->
                                        pawn.playerIndex == gameEngine.currentPlayerIndex && when (pawn.state) {
                                            PawnState.HOME_BASE ->
                                                TrackBuilder.getPlayerPath(gameEngine.gridSize, pawn.playerIndex)
                                                    .getOrNull(0) == row to col
                                            PawnState.ON_TRACK ->
                                                pawn.pathIndex >= 0 &&
                                                    TrackBuilder.getPlayerPath(gameEngine.gridSize, pawn.playerIndex)
                                                        .getOrNull(pawn.pathIndex) == row to col
                                            PawnState.FINISHED -> false
                                        }
                                    }
                                    if (clickedPawn != null) {
                                        Telemetry.debug(
                                            "input",
                                            "pawn.selected_via_tap",
                                            "User selected a pawn on the board",
                                            mapOf(
                                                "pawnIds" to listOf(clickedPawn.id),
                                                "targetPathIndex" to clickedPawn.pathIndex
                                            )
                                        )
                                        state.selectPawn(clickedPawn.id)
                                    } else {
                                        Telemetry.trace(
                                            "input",
                                            "board.tapped_empty",
                                            "User tapped an empty/non-move cell",
                                            mapOf("row" to row, "col" to col)
                                        )
                                        state.selectPawn(null)
                                    }
                                }
                            }
                        }
                    )
                }
            }

            Spacer(Modifier.height(12.dp))

            // Quick-select / valid moves card
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = cardColor)
            ) {
                Column(
                    modifier = Modifier.padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text(
                        text = "SELECT PAWN TO ADVANCE:",
                        color = headerColor,
                        fontSize = if (seniorMode) 18.sp else 14.sp,
                        fontWeight = FontWeight.Bold
                    )

                    if (gameEngine.validMoves.isNotEmpty() && !isBotTurn) {
                        Spacer(Modifier.height(4.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            gameEngine.validMoves.forEach { move ->
                                val lead = move.grpPawns.first()
                                val isSelected = selectedPawn?.id == lead.id
                                val pawnName = if (lead.state == PawnState.HOME_BASE)
                                    "Start"
                                else
                                    "PAWN #${lead.id % 4 + 1}"
                                Button(
                                    onClick = {
                                        Telemetry.debug(
                                            "input",
                                            "pawn.selected_via_list",
                                            "User selected a pawn via quick-list",
                                            mapOf("pawnIds" to move.grpPawns.map { it.id })
                                        )
                                        state.executeMove(move)
                                        state.selectPawn(null)
                                    },
                                    modifier = Modifier
                                        .weight(1f)
                                        .height(if (seniorMode) 56.dp else 40.dp),
                                    colors = ButtonDefaults.buttonColors(
                                        containerColor = if (isSelected) Color(0xFFFFD54F) else Color(0xFF5D4037),
                                        contentColor = Color(0xFF1E1B18)
                                    ),
                                    shape = RoundedCornerShape(10.dp)
                                ) {
                                    Text(
                                        text = pawnName + (if (move.grpPawns.size > 1) " [GATTI]" else ""),
                                        fontSize = if (seniorMode) 17.sp else 13.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            }
                        }
                    }
                }
            }

            Spacer(Modifier.height(16.dp))

            CowryRollSection(
                currentRoll = gameEngine.currentRoll,
                canRoll = gameEngine.currentRoll == null && !isBotTurn && gameEngine.winner == null,
                onRollRequested = {
                    Telemetry.debug(
                        "input",
                        "dice.roll_requested",
                        "User requested a cowry roll",
                        mapOf("playerIndex" to gameEngine.currentPlayerIndex)
                    )
                    state.rollCowries()
                    state.selectPawn(null)
                },
                gridSize = state.gridSize,
                seniorMode = seniorMode
            )

            Spacer(Modifier.height(16.dp))

            Text(
                text = "Board: ${state.gridSize.columns}x${state.gridSize.columns}   " +
                    "Players: ${state.playerCount}   " +
                    "Mode: ${if (state.gameMode == GameMode.PASS_AND_PLAY) "Pass & Play" else "vs Bot"}",
                color = Color.White,
                fontSize = if (seniorMode) 15.sp else 12.sp,
                textAlign = TextAlign.Center
            )
        }
    }

    // Pause menu dialog
    if (state.showPauseMenu) {
        AlertDialog(
            onDismissRequest = { state.showPauseMenu = false },
            title = {
                Text(
                    text = "GAME PAUSED",
                    color = Color(0xFFFFD54F),
                    fontWeight = FontWeight.Bold
                )
            },
            text = {
                Column {
                    Text(
                        text = "Board: ${state.gridSize.columns}x${state.gridSize.columns}",
                        color = Color.White
                    )
                    Text(text = "Players: ${state.playerCount}", color = Color.White)
                    Text(
                        text = "Mode: ${if (state.gameMode == GameMode.PASS_AND_PLAY) "Pass & Play" else "vs Bot"}",
                        color = Color.White
                    )
                    Spacer(Modifier.height(12.dp))
                    Button(
                        onClick = { state.showPauseMenu = false },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF5D4037))
                    ) {
                        Text("RESUME", color = Color(0xFF76FF03), fontWeight = FontWeight.Bold)
                    }
                }
            },
            containerColor = cardColor,
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = {
                    Telemetry.info(
                        "ui",
                        "menu.exit",
                        "User exited to menu from pause",
                        mapOf("gridSize" to state.gridSize.columns)
                    )
                    state.showPauseMenu = false
                    onBackToMenu()
                }) {
                    Text("EXIT TO MENU", color = Color(0xFFFF5252))
                }
            }
        )
    }

    // Victory dialog
    gameEngine.winner?.let { winner ->
        AlertDialog(
            onDismissRequest = {
                Telemetry.info(
                    "ui",
                    "victory.dialog_dismissed",
                    "Victory dialog dismissed; restarting",
                    mapOf("winner" to winner.displayName)
                )
                state.restart()
            },
            title = {
                Text(
                    text = "\uD83C\uDF89 WINNER!",
                    color = Color(0xFFFFD54F),
                    fontWeight = FontWeight.Bold
                )
            },
            text = {
                Text(
                    text = "Player ${winner.displayName} has navigated all pawns to the Center Home!",
                    color = Color.White,
                    fontSize = if (seniorMode) 19.sp else 16.sp
                )
            },
            containerColor = cardColor,
            confirmButton = {
                Button(
                    onClick = {
                        Telemetry.info(
                            "ui",
                            "victory.play_again",
                            "User chose to play again",
                            mapOf("winner" to winner.displayName)
                        )
                        state.restart()
                    },
                    shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF5D4037))
                ) {
                    Text("PLAY AGAIN", fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(onClick = {
                    Telemetry.info(
                        "ui",
                        "victory.to_menu",
                        "User navigated to main menu after victory",
                        mapOf("winner" to winner.displayName)
                    )
                    onBackToMenu()
                }) {
                    Text("MAIN MENU", color = Color(0xFFFFB74D))
                }
            }
        )
    }
}
