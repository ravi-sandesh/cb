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
import com.chokabarah.game.engine.GameEngine
import com.chokabarah.game.engine.GameMode
import com.chokabarah.game.engine.GridSize
import com.chokabarah.game.engine.MoveOption
import com.chokabarah.game.engine.Pawn
import com.chokabarah.game.engine.PawnState
import com.chokabarah.game.engine.PlayerColor
import com.chokabarah.game.engine.TrackBuilder
import com.chokabarah.game.telemetry.Telemetry
import kotlinx.coroutines.delay

@Composable
fun GameScreen(
    gridSize: GridSize,
    playerCount: Int,
    gameMode: GameMode,
    onBackToMenu: () -> Unit
) {
    val activeColors = remember(playerCount) {
        // Defensive: the engine requires 2..4 players. If an entry point ever
        // passes <2 (HomeScreen only offers 2..4), clamp instead of crashing on
        // the GameEngine init guard (BUG-08).
        PlayerColor.entries.take(playerCount.coerceIn(2, PlayerColor.entries.size))
    }
    val gameEngine = remember(gridSize, playerCount, gameMode) {
        GameEngine(gridSize = gridSize, playerColors = activeColors)
    }

    var selectedPawn by remember { mutableStateOf<Pawn?>(null) }
    var stateTrigger by remember { mutableStateOf(0) }
    var showPauseMenu by remember { mutableStateOf(false) }
    var botProcessing by remember { mutableStateOf(false) }

    val currentPlayer = gameEngine.playerColors[gameEngine.currentPlayerIndex]
    val isBotTurn = gameMode == GameMode.VS_BOT && gameEngine.currentPlayerIndex != 0

    // Bot turn automation
    LaunchedEffect(
        gameEngine.currentPlayerIndex,
        gameEngine.currentRoll,
        gameEngine.validMoves,
        stateTrigger,
        isBotTurn,
        showPauseMenu
    ) {
        // Pausing the game must also pause a bot that is mid-turn; a bot must
        // not keep rolling/moving (and thus telemetry-spanning) behind the
        // pause dialog (BUG-16). Cancelling mid-flight must not strand the
        // botProcessing latch, or the bot would never move again after resume.
        if (showPauseMenu) {
            botProcessing = false
            return@LaunchedEffect
        }
        if (isBotTurn && gameEngine.winner == null && !botProcessing) {
            botProcessing = true
            delay(700)
            if (gameEngine.currentRoll == null) {
                gameEngine.rollCowries()
            }
            delay(700)
            val botMove = gameEngine.getBestBotMove()
            if (botMove != null) {
                gameEngine.executeMove(botMove)
            }
            selectedPawn = null
            stateTrigger++
            botProcessing = false
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
                            mapOf("gridSize" to gridSize.columns, "mode" to gameMode.name)
                        )
                        showPauseMenu = true
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
                    text = "${gridSize.columns}x${gridSize.columns} CHOKA BARAH",
                    color = headerColor,
                    fontSize = 16.sp,
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
                            mapOf("gridSize" to gridSize.columns)
                        )
                        gameEngine.resetGame()
                        selectedPawn = null
                        stateTrigger++
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
                            fontSize = 16.sp,
                            fontWeight = FontWeight.Bold
                        )

                        val isCutUnlocked =
                            gameEngine.hasCapturedOpponent[gameEngine.currentPlayerIndex] == true
                        Text(
                            text = if (isCutUnlocked) "\uD83D\uDD13 INNER UNLOCKED" else "\uD83D\uDD12 CUT REQUIRED",
                            color = if (isCutUnlocked) unlockedColor else headerColor,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }

                    Spacer(Modifier.height(8.dp))

                    BoardCanvas(
                        gameEngine = gameEngine,
                        selectedPawn = selectedPawn,
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
                                    gameEngine.executeMove(matchingMove)
                                    selectedPawn = null
                                    stateTrigger++
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
                                        selectedPawn = clickedPawn
                                        stateTrigger++
                                    } else {
                                        Telemetry.trace(
                                            "input",
                                            "board.tapped_empty",
                                            "User tapped an empty/non-move cell",
                                            mapOf("row" to row, "col" to col)
                                        )
                                        selectedPawn = null
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
                        fontSize = 14.sp,
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
                                        gameEngine.executeMove(move)
                                        selectedPawn = null
                                        stateTrigger++
                                    },
                                    modifier = Modifier.weight(1f),
                                    colors = ButtonDefaults.buttonColors(
                                        containerColor = if (isSelected) Color(0xFFFFD54F) else Color(0xFF5D4037),
                                        contentColor = Color(0xFF1E1B18)
                                    ),
                                    shape = RoundedCornerShape(10.dp)
                                ) {
                                    Text(
                                        text = pawnName + (if (move.grpPawns.size > 1) " [GATTI]" else ""),
                                        fontSize = 13.sp,
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
                    gameEngine.rollCowries()
                    selectedPawn = null
                    stateTrigger++
                },
                gridSize = gridSize
            )

            Spacer(Modifier.height(16.dp))

            Text(
                text = "Board: ${gridSize.columns}x${gridSize.columns}   " +
                    "Players: $playerCount   " +
                    "Mode: ${if (gameMode == GameMode.PASS_AND_PLAY) "Pass & Play" else "vs Bot"}",
                color = Color.White,
                fontSize = 12.sp,
                textAlign = TextAlign.Center
            )
        }
    }

    // Pause menu dialog
    if (showPauseMenu) {
        AlertDialog(
            onDismissRequest = { showPauseMenu = false },
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
                        text = "Board: ${gridSize.columns}x${gridSize.columns}",
                        color = Color.White
                    )
                    Text(text = "Players: $playerCount", color = Color.White)
                    Text(
                        text = "Mode: ${if (gameMode == GameMode.PASS_AND_PLAY) "Pass & Play" else "vs Bot"}",
                        color = Color.White
                    )
                    Spacer(Modifier.height(12.dp))
                    Button(
                        onClick = { showPauseMenu = false },
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
                        mapOf("gridSize" to gridSize.columns)
                    )
                    showPauseMenu = false
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
                gameEngine.resetGame()
                selectedPawn = null
                stateTrigger++
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
                    fontSize = 16.sp
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
                        gameEngine.resetGame()
                        selectedPawn = null
                        stateTrigger++
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
