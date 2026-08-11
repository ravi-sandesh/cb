package com.example.chokabara

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.chokabarah.game.ChokaBarahApp
import org.junit.Rule
import org.junit.Test

class HomeScreenTest {

    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun testHomeScreenDisplaysTitle() {
        composeRule.setContent {
            ChokaBarahApp()
        }

        composeRule.onNodeWithText("CHOKA BARAH").assertIsDisplayed()
        composeRule.onNodeWithText("TRADITIONAL INDIAN STRATEGY BOARD GAME").assertIsDisplayed()
    }

    @Test
    fun testHomeScreenDisplaysBoardSizeOptions() {
        composeRule.setContent {
            ChokaBarahApp()
        }

        composeRule.onNodeWithText("5-Column (5x5)").assertIsDisplayed()
        composeRule.onNodeWithText("7-Column (7x7)").assertIsDisplayed()
    }

    @Test
    fun testHomeScreenDisplaysPlayerCountOptions() {
        composeRule.setContent {
            ChokaBarahApp()
        }

        composeRule.onNodeWithText("2 Players").assertIsDisplayed()
        composeRule.onNodeWithText("3 Players").assertIsDisplayed()
        composeRule.onNodeWithText("4 Players").assertIsDisplayed()
    }

    @Test
    fun testHomeScreenDisplaysGameModeOptions() {
        composeRule.setContent {
            ChokaBarahApp()
        }

        composeRule.onNodeWithText("Pass & Play").assertIsDisplayed()
        composeRule.onNodeWithText("vs Bot (AI)").assertIsDisplayed()
    }

    @Test
    fun testHomeScreenHasStartAndRulesButtons() {
        composeRule.setContent {
            ChokaBarahApp()
        }

        composeRule.onNodeWithText("▶ START GAME").assertIsDisplayed()
        composeRule.onNodeWithText("📖 HOW TO PLAY RULES").assertIsDisplayed()
    }

    @Test
    fun testHomeScreenDisplaysAccessibilitySection() {
        composeRule.setContent {
            ChokaBarahApp()
        }

        // Senior mode card: the accessibility section (added with Senior Mode)
        // must render its header plus the Standard / Senior Mode toggle chips.
        composeRule.onNodeWithText("4. ACCESSIBILITY — EASY READING").assertIsDisplayed()
        composeRule.onNodeWithText("Standard").assertIsDisplayed()
        composeRule.onNodeWithText("Senior Mode").assertIsDisplayed()
    }
}
