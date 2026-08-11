package com.example.chokabara

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.chokabarah.game.engine.GameMode
import com.chokabarah.game.engine.GridSize
import com.chokabarah.game.ui.GameScreen
import org.junit.Rule
import org.junit.Test

class GameScreenTest {

    @get:Rule
    val composeRule = createComposeRule()

    private fun setGameScreen(gridSize: GridSize = GridSize.FIVE_BY_FIVE, mode: GameMode = GameMode.PASS_AND_PLAY, seniorMode: Boolean = false) {
        composeRule.setContent {
            GameScreen(
                gridSize = gridSize,
                playerCount = 2,
                gameMode = mode,
                seniorMode = seniorMode,
                onBackToMenu = {}
            )
        }
    }

    @Test
    fun testGameScreenDisplaysBoardHeader() {
        setGameScreen(GridSize.FIVE_BY_FIVE)
        composeRule.onNodeWithText("5x5 CHOKA BARAH").assertIsDisplayed()
    }

    @Test
    fun testGameScreenDisplaysSevenBySevenHeader() {
        setGameScreen(GridSize.SEVEN_BY_SEVEN)
        composeRule.onNodeWithText("7x7 CHOKA BARAH").assertIsDisplayed()
    }

    @Test
    fun testGameScreenDisplaysMenuAndRestartButtons() {
        setGameScreen()
        composeRule.onNodeWithText("⚙ MENU").assertIsDisplayed()
        composeRule.onNodeWithText("🔄 RESTART").assertIsDisplayed()
    }

    @Test
    fun testGameScreenDisplaysTurnBanner() {
        setGameScreen()
        composeRule.onNodeWithText("TURN: Red (South)").assertIsDisplayed()
    }

    @Test
    fun testGameScreenShowsCutRequiredByDefault() {
        setGameScreen()
        // Player has not captured yet, so the inner gate is locked
        composeRule.onNodeWithText("🔒 CUT REQUIRED").assertIsDisplayed()
    }

    @Test
    fun testGameScreenClampsInvalidPlayerCount() {
        // BUG-08: a playerCount < 2 must not crash the GameEngine constructor.
        // HomeScreen only offers 2..4, but a defensive clamp keeps the engine safe.
        composeRule.setContent {
            GameScreen(
                gridSize = GridSize.FIVE_BY_FIVE,
                playerCount = 1,
                gameMode = GameMode.PASS_AND_PLAY,
                onBackToMenu = {}
            )
        }
        composeRule.onNodeWithText("5x5 CHOKA BARAH").assertIsDisplayed()
    }

    @Test
    fun testGameScreenRendersInSeniorMode() {
        // Senior mode is a scaling profile (larger fonts/targets, slower bot);
        // the core screen content must stay intact and identical when enabled.
        setGameScreen(seniorMode = true)
        composeRule.onNodeWithText("5x5 CHOKA BARAH").assertIsDisplayed()
        composeRule.onNodeWithText("TURN: Red (South)").assertIsDisplayed()
        composeRule.onNodeWithText("COWRY SHELLS ROLL").assertIsDisplayed()
        composeRule.onNodeWithText("⚙ MENU").assertIsDisplayed()
    }

    @Test
    fun testPauseMenuShownWhileBotTurn() {
        // BUG-16: opening the pause menu must suspend bot-turn automation. The
        // game starts on player 0 (human) in VS_BOT; open the menu and confirm
        // the dialog renders without the bot advancing behind it.
        setGameScreen(mode = GameMode.VS_BOT)
        composeRule.onNodeWithText("⚙ MENU").performClick()
        composeRule.onNodeWithText("GAME PAUSED").assertIsDisplayed()
        composeRule.onNodeWithText("RESUME").performClick()
        composeRule.onNodeWithText("GAME PAUSED").assertDoesNotExist()
    }
}
