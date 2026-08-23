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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.SavedStateHandle
import com.chokabarah.game.R
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

    // TalkBack summary for the board canvas.
    val modeLabel = stringResource(
        if (ui.gameMode == GameMode.PASS_AND_PLAY) R.string.mode_pass_and_play
        else R.string.mode_vs_bot
    )
    val rollLabel = board.currentRoll?.label ?: stringResource(R.string.no_roll)
    val boardDescription = stringResource(
        R.string.cd_board, currentPlayer.displayName, rollLabel, board.validMoves.size
    )

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
                        text = stringResource(R.string.menu),
                        fontWeight = FontWeight.Bold,
                        color = accentColor
                    )
                }

                Spacer(Modifier.weight(1f))

                Text(
                    text = stringResource(R.string.board_header, ui.gridSize.columns),
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
                        text = stringResource(R.string.restart),
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
                            text = stringResource(R.string.turn_banner, currentPlayer.displayName,
                                if (ui.isBotTurn) stringResource(R.string.bot_suffix) else ""),
                            color = Color.White,
                            fontSize = if (seniorMode) 21.sp else 16.sp,
                            fontWeight = FontWeight.Bold
                        )

                        Text(
                            text = if (board.isCutUnlocked) stringResource(R.string.inner_unlocked)
                                   else stringResource(R.string.cut_required),
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
                        contentDescription = boardDescription,
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
                        text = stringResource(R.string.select_pawn),
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
                            board.validMoves.forEach { move ->
                                val isSelected = move.pawnIds.contains(selectedPawnId)
                                val pawnName = if (isHomeBaseLead(board, move))
                                    stringResource(R.string.pawn_start)
                                else
                                    stringResource(R.string.pawn_nth, move.pawnIds.first() % 4 + 1)
                                val gattiTag = if (move.pawnIds.size > 1) stringResource(R.string.gatti_tag) else ""
                                val buttonDescription = stringResource(
                                    R.string.cd_move_button,
                                    pawnName,
                                    move.targetCoords.first,
                                    move.targetCoords.second,
                                    if (move.pawnIds.size > 1) stringResource(R.string.cd_gatti_tag) else ""
                                )
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
                                        .height(if (seniorMode) 56.dp else 40.dp)
                                        .semantics { contentDescription = buttonDescription },
                                    colors = ButtonDefaults.buttonColors(
                                        containerColor = if (isSelected) Color(0xFFFFD54F) else Color(0xFF5D4037),
                                        contentColor = Color(0xFF1E1B18)
                                    ),
                                    shape = RoundedCornerShape(10.dp)
                                ) {
                                    Text(
                                        text = pawnName + gattiTag,
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
                text = stringResource(R.string.config_line, ui.gridSize.columns, ui.playerCount, modeLabel),
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
                    text = stringResource(R.string.game_paused),
                    color = Color(0xFFFFD54F),
                    fontWeight = FontWeight.Bold
                )
            },
            text = {
                Column {
                    Text(
                        text = stringResource(R.string.paused_board, ui.gridSize.columns),
                        color = Color.White
                    )
                    Text(text = stringResource(R.string.players_label, ui.playerCount), color = Color.White)
                    Text(text = modeLabel, color = Color.White)
                    Spacer(Modifier.height(12.dp))
                    Button(
                        onClick = { state.setShowPauseMenu(false) },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF5D4037))
                    ) {
                        Text(stringResource(R.string.resume), color = Color(0xFF76FF03), fontWeight = FontWeight.Bold)
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
                    Text(stringResource(R.string.exit_to_menu), color = Color(0xFFFF5252))
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
                    text = stringResource(R.string.winner_title),
                    color = Color(0xFFFFD54F),
                    fontWeight = FontWeight.Bold
                )
            },
            text = {
                Text(
                    text = stringResource(R.string.victory_message, winner.displayName),
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
                    Text(stringResource(R.string.play_again), fontWeight = FontWeight.Bold)
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
                    Text(stringResource(R.string.main_menu), color = Color(0xFFFFB74D))
                }
            }
        )
    }
}

private fun isHomeBaseLead(board: BoardUi, move: MoveUi): Boolean =
    board.pawns.firstOrNull { it.id == move.pawnIds.first() }?.state ==
        com.chokabarah.game.engine.PawnState.HOME_BASE
