package com.example.chokabara

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.chokabarah.game.engine.GameMode
import com.chokabarah.game.engine.GridSize
import com.chokabarah.game.ui.GameScreen
import org.junit.Rule
import org.junit.Test

class GameScreenTest {

    @get:Rule
    val composeRule = createComposeRule()

    private fun setGameScreen(gridSize: GridSize = GridSize.FIVE_BY_FIVE, mode: GameMode = GameMode.PASS_AND_PLAY) {
        composeRule.setContent {
            GameScreen(
                gridSize = gridSize,
                playerCount = 2,
                gameMode = mode,
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
}
