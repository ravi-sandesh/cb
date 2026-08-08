package com.chokabarah.game.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.chokabarah.game.engine.GameMode
import com.chokabarah.game.engine.GridSize
import com.chokabarah.game.telemetry.Telemetry

@Composable
fun HomeScreen(
    onStartGame: (GridSize, Int, GameMode) -> Unit
) {
    var selectedGridSize by remember { mutableStateOf(GridSize.FIVE_BY_FIVE) }
    var playerCount by remember { mutableStateOf(2) }
    var gameMode by remember { mutableStateOf(GameMode.PASS_AND_PLAY) }
    var showRulesDialog by remember { mutableStateOf(false) }

    var lastLoggedGrid by remember { mutableStateOf<GridSize?>(null) }
    var lastLoggedPlayers by remember { mutableStateOf<Int?>(null) }
    var lastLoggedMode by remember { mutableStateOf<GameMode?>(null) }

    val titleColor = Color(0xFFFFD54F)
    val accentColor = Color(0xFFFFB74D)
    val bgColor = Color(0xFF1E1B18)
    val cardColor = Color(0xFF2C241E)

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
            Spacer(Modifier.height(16.dp))

            Text(
                text = "CHOKA BARAH",
                color = titleColor,
                fontSize = 36.sp,
                fontWeight = FontWeight.Black,
                textAlign = TextAlign.Center,
                letterSpacing = 2.sp
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = "TRADITIONAL INDIAN STRATEGY BOARD GAME",
                color = accentColor,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(24.dp))

            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = cardColor)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "1. SELECT BOARD SIZE",
                        modifier = Modifier.fillMaxWidth(),
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Bold,
                        style = TextStyle(color = titleColor)
                    )
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OptionChip(
                            text = "5-Column (5x5)",
                            subtext = "Classic Board",
                            isSelected = selectedGridSize == GridSize.FIVE_BY_FIVE,
                            onClick = {
                                selectedGridSize = GridSize.FIVE_BY_FIVE
                                if (lastLoggedGrid != GridSize.FIVE_BY_FIVE) {
                                    lastLoggedGrid = GridSize.FIVE_BY_FIVE
                                    Telemetry.info(
                                        "ui.config",
                                        "config.board_size_selected",
                                        "User selected 5x5 board",
                                        mapOf("gridSize" to 5)
                                    )
                                }
                            },
                            modifier = Modifier.weight(1f)
                        )
                        OptionChip(
                            text = "7-Column (7x7)",
                            subtext = "Ashta Chamma",
                            isSelected = selectedGridSize == GridSize.SEVEN_BY_SEVEN,
                            onClick = {
                                selectedGridSize = GridSize.SEVEN_BY_SEVEN
                                if (lastLoggedGrid != GridSize.SEVEN_BY_SEVEN) {
                                    lastLoggedGrid = GridSize.SEVEN_BY_SEVEN
                                    Telemetry.info(
                                        "ui.config",
                                        "config.board_size_selected",
                                        "User selected 7x7 board",
                                        mapOf("gridSize" to 7)
                                    )
                                }
                            },
                            modifier = Modifier.weight(1f)
                        )
                    }
                }
            }

            Spacer(Modifier.height(24.dp))

            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = cardColor)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "2. NUMBER OF PLAYERS",
                        modifier = Modifier.fillMaxWidth(),
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Bold,
                        style = TextStyle(color = titleColor)
                    )
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        (2..4).forEach { count ->
                            OptionChip(
                                text = "$count Players",
                                subtext = if (count == 2) "1v1 Duel" else "$count Way",
                                isSelected = playerCount == count,
                                onClick = {
                                    playerCount = count
                                    if (lastLoggedPlayers != count) {
                                        lastLoggedPlayers = count
                                        Telemetry.info(
                                            "ui.config",
                                            "config.player_count_selected",
                                            "User selected $count players",
                                            mapOf("playerCount" to count)
                                        )
                                    }
                                },
                                modifier = Modifier.weight(1f)
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.height(24.dp))

            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = cardColor)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "3. GAME MODE",
                        modifier = Modifier.fillMaxWidth(),
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Bold,
                        style = TextStyle(color = titleColor)
                    )
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OptionChip(
                    text = "Pass & Play",
                    subtext = "Local Friends",
                    isSelected = gameMode == GameMode.PASS_AND_PLAY,
                    onClick = {
                        gameMode = GameMode.PASS_AND_PLAY
                        if (lastLoggedMode != GameMode.PASS_AND_PLAY) {
                            lastLoggedMode = GameMode.PASS_AND_PLAY
                            Telemetry.info(
                                "ui.config",
                                "config.game_mode_selected",
                                "User selected Pass & Play mode",
                                mapOf("gameMode" to "PASS_AND_PLAY")
                            )
                        }
                    },
                    modifier = Modifier.weight(1f)
                )
                OptionChip(
                    text = "vs Bot (AI)",
                    subtext = "Single Player",
                    isSelected = gameMode == GameMode.VS_BOT,
                    onClick = {
                        gameMode = GameMode.VS_BOT
                        if (lastLoggedMode != GameMode.VS_BOT) {
                            lastLoggedMode = GameMode.VS_BOT
                            Telemetry.info(
                                "ui.config",
                                "config.game_mode_selected",
                                "User selected vs Bot mode",
                                mapOf("gameMode" to "VS_BOT")
                            )
                        }
                    },
                    modifier = Modifier.weight(1f)
                )
                }
                }
                }

                Spacer(Modifier.height(32.dp))

            Button(
                onClick = {
                    Telemetry.info(
                        "ui.config",
                        "config.game_started",
                        "User started the game with the selected configuration",
                        mapOf(
                            "gridSize" to selectedGridSize.columns,
                            "playerCount" to playerCount,
                            "gameMode" to gameMode.name,
                            "action" to "start"
                        )
                    )
                    onStartGame(selectedGridSize, playerCount, gameMode)
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFF5D4037),
                    contentColor = titleColor
                ),
                shape = RoundedCornerShape(12.dp)
            ) {
                Text(
                    text = "\u25B6 START GAME",
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold
                )
            }

            Spacer(Modifier.height(12.dp))

            OutlinedButton(
                onClick = {
                    Telemetry.info(
                        "ui.config",
                        "config.rules_opened",
                        "User opened the How to Play rules dialog",
                        mapOf("action" to "open_rules")
                    )
                    showRulesDialog = true
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp),
                shape = RoundedCornerShape(12.dp)
            ) {
                Text(
                    text = "\uD83D\uDCD6 HOW TO PLAY RULES",
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                    style = TextStyle(color = accentColor)
                )
            }

            Spacer(Modifier.height(24.dp))
        }
    }

    if (showRulesDialog) {
        RulesDialog(onDismiss = {
            Telemetry.info(
                "ui.config",
                "config.rules_closed",
                "User closed the How to Play rules dialog",
                mapOf("action" to "close_rules")
            )
            showRulesDialog = false
        })
    }
}

@Composable
private fun OptionChip(
    text: String,
    subtext: String,
    isSelected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val selectedBg = Color(0xFF5D4037)
    val unselectedBg = Color(0xFF1E1B18)
    val selectedBorder = Color(0xFFFFD54F)
    val unselectedBorder = Color(0xFF4E342E)

    Column(
        modifier = modifier
            .background(
                color = if (isSelected) selectedBg else unselectedBg,
                shape = RoundedCornerShape(12.dp)
            )
            .border(
                width = if (isSelected) 2.dp else 1.dp,
                color = if (isSelected) selectedBorder else unselectedBorder,
                shape = RoundedCornerShape(12.dp)
            )
            .clickable(onClick = onClick)
            .padding(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            text = text,
            color = if (isSelected) selectedBorder else Color(0xFFFFF8D6),
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = subtext,
            color = if (isSelected) selectedBorder else Color(0xFFB59F7A),
            fontSize = 11.sp,
            textAlign = TextAlign.Center
        )
    }
}

@Composable
private fun RulesDialog(onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = "CHOKA BARAH RULES",
                color = Color(0xFFFFD54F),
                fontWeight = FontWeight.Bold
            )
        },
        text = {
            Column {
                RuleItem(
                    title = "1. Objective",
                    description = "Move all 4 of your pawns around the board track into the central Home square."
                )
                RuleItem(
                    title = "2. Cowry Scoring",
                    description = "1, 2, 3, 4 (Chauka) or 0 (Bara=8). Rolling 4 or 8 earns an EXTRA roll!"
                )
                RuleItem(
                    title = "3. Cut Requirement",
                    description = "IMPORTANT: You MUST capture ('cut') at least 1 opponent pawn to unlock entry into the inner track toward Center Home!"
                )
                RuleItem(
                    title = "4. Safe Squares ('X')",
                    description = "Pawns on safe squares ('X') cannot be captured. Multiple pawns can rest safely together."
                )
                RuleItem(
                    title = "5. Extra Turn",
                    description = "Capturing an opponent pawn grants an immediate EXTRA turn."
                )
            }
        },
        containerColor = Color(0xFF2C241E),
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(
                    text = "GOT IT!",
                    color = Color(0xFFFFD54F),
                    fontWeight = FontWeight.Bold
                )
            }
        }
    )
}

@Composable
private fun RuleItem(title: String, description: String) {
    Column(modifier = Modifier.padding(vertical = 6.dp)) {
        Text(
            text = title,
            color = Color(0xFFF9E8C7),
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold
        )
        Spacer(Modifier.height(2.dp))
        Text(
            text = description,
            color = Color(0xFFB9D7C7), 
            fontSize = 14.sp
        )
    }
}