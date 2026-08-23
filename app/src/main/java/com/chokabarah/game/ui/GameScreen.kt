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
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
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
import com.chokabarah.game.engine.PlayerColor
import com.chokabarah.game.telemetry.Telemetry

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

// Renders exclusively from the ViewModel's StateFlow<GameUiState>: every
// engine mutation republishes an immutable snapshot, so recomposition is
// data-driven (no revision counters, no manual triggers). All input is
// routed back through the session's action methods.
@Composable
fun GameScreen(
    state: GameViewModel,
    seniorMode: Boolean = false,
    onBackToMenu: () -> Unit
) {
    // Keep the bot's pacing in sync with the accessibility profile.
    LaunchedEffect(seniorMode) { state.setSeniorPacing(seniorMode) }

    val ui by state.uiState.collectAsState()
    val board = requireNotNull(ui.board)

    val currentPlayer = board.playerColors[board.currentPlayerIndex]
    val selectedPawnId = ui.selectedPawnId

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
                            mapOf("gridSize" to ui.gridSize.columns, "mode" to ui.gameMode.name)
                        )
                        state.setShowPauseMenu(true)
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
                    text = "${ui.gridSize.columns}x${ui.gridSize.columns} CHOKA BARAH",
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
                            mapOf("gridSize" to ui.gridSize.columns)
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
                                (if (ui.isBotTurn) " \uD83E\uDD16 (BOT)" else ""),
                            color = Color.White,
                            fontSize = if (seniorMode) 21.sp else 16.sp,
                            fontWeight = FontWeight.Bold
                        )

                        Text(
                            text = if (board.isCutUnlocked) "\uD83D\uDD13 INNER UNLOCKED" else "\uD83D\uDD12 CUT REQUIRED",
                            color = if (board.isCutUnlocked) unlockedColor else headerColor,
                            fontSize = if (seniorMode) 15.sp else 12.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }

                    Spacer(Modifier.height(8.dp))

                    BoardCanvas(
                        board = board,
                        selectedPawnId = selectedPawnId,
                        seniorMode = seniorMode,
                        onCellClicked = { row, col -> state.onCellClicked(row, col) }
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

                    if (board.validMoves.isNotEmpty() && !ui.isBotTurn) {
                        Spacer(Modifier.height(4.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            board.validMoves.forEachIndexed { index, move ->
                                val isSelected = move.pawnIds.contains(selectedPawnId)
                                val pawnName = if (isHomeBaseLead(board, move)) "Start" else "PAWN #${move.pawnIds.first() % 4 + 1}"
                                Button(
                                    onClick = {
                                        Telemetry.debug(
                                            "input",
                                            "pawn.selected_via_list",
                                            "User selected a pawn via quick-list",
                                            mapOf("pawnIds" to move.pawnIds)
                                        )
                                        state.executeValidMove(move)
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
                                        text = pawnName + (if (move.pawnIds.size > 1) " [GATTI]" else ""),
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
                currentRoll = board.currentRoll,
                canRoll = ui.canRoll,
                onRollRequested = {
                    Telemetry.debug(
                        "input",
                        "dice.roll_requested",
                        "User requested a cowry roll",
                        mapOf("playerIndex" to board.currentPlayerIndex)
                    )
                    state.rollCowries()
                },
                gridSize = ui.gridSize,
                seniorMode = seniorMode
            )

            Spacer(Modifier.height(16.dp))

            Text(
                text = "Board: ${ui.gridSize.columns}x${ui.gridSize.columns}   " +
                    "Players: ${ui.playerCount}   " +
                    "Mode: ${if (ui.gameMode == GameMode.PASS_AND_PLAY) "Pass & Play" else "vs Bot"}",
                color = Color.White,
                fontSize = if (seniorMode) 15.sp else 12.sp,
                textAlign = TextAlign.Center
            )
        }
    }

    // Pause menu dialog
    if (ui.showPauseMenu) {
        AlertDialog(
            onDismissRequest = { state.setShowPauseMenu(false) },
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
                        text = "Board: ${ui.gridSize.columns}x${ui.gridSize.columns}",
                        color = Color.White
                    )
                    Text(text = "Players: ${ui.playerCount}", color = Color.White)
                    Text(
                        text = "Mode: ${if (ui.gameMode == GameMode.PASS_AND_PLAY) "Pass & Play" else "vs Bot"}",
                        color = Color.White
                    )
                    Spacer(Modifier.height(12.dp))
                    Button(
                        onClick = { state.setShowPauseMenu(false) },
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
                        mapOf("gridSize" to ui.gridSize.columns)
                    )
                    state.setShowPauseMenu(false)
                    onBackToMenu()
                }) {
                    Text("EXIT TO MENU", color = Color(0xFFFF5252))
                }
            }
        )
    }

    // Victory dialog
    board.winner?.let { winner ->
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

private fun isHomeBaseLead(board: BoardUi, move: MoveUi): Boolean =
    board.pawns.firstOrNull { it.id == move.pawnIds.first() }?.state ==
        com.chokabarah.game.engine.PawnState.HOME_BASE
