package com.example.chokabara

import androidx.compose.runtime.remember
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.lifecycle.SavedStateHandle
import com.chokabarah.game.ChokaBarahApp
import com.chokabarah.game.ui.GameViewModel
import org.junit.Rule
import org.junit.Test

class HomeScreenTest {

    @get:Rule
    val composeRule = createComposeRule()

    private fun setAppContent() {
        composeRule.setContent {
            val session = remember { GameViewModel(SavedStateHandle()) }
            ChokaBarahApp(session)
        }
    }

    @Test
    fun testHomeScreenDisplaysTitle() {
        setAppContent()

        composeRule.onNodeWithText("CHOKA BARAH").assertIsDisplayed()
        composeRule.onNodeWithText("TRADITIONAL INDIAN STRATEGY BOARD GAME").assertIsDisplayed()
    }

    @Test
    fun testHomeScreenDisplaysBoardSizeOptions() {
        setAppContent()

        composeRule.onNodeWithText("5-Column (5x5)").assertIsDisplayed()
        composeRule.onNodeWithText("7-Column (7x7)").assertIsDisplayed()
    }

    @Test
    fun testHomeScreenDisplaysPlayerCountOptions() {
        setAppContent()

        composeRule.onNodeWithText("2 Players").assertIsDisplayed()
        composeRule.onNodeWithText("3 Players").assertIsDisplayed()
        composeRule.onNodeWithText("4 Players").assertIsDisplayed()
    }

    @Test
    fun testHomeScreenDisplaysGameModeOptions() {
        setAppContent()

        composeRule.onNodeWithText("Pass & Play").assertIsDisplayed()
        composeRule.onNodeWithText("vs Bot (AI)").assertIsDisplayed()
    }

    @Test
    fun testHomeScreenHasStartAndRulesButtons() {
        setAppContent()

        // The action buttons live at the bottom of the scrollable home
        // column — assert their PRESENCE rather than on-screen visibility,
        // which depends on the device viewport.
        composeRule.onNodeWithText("▶ START GAME").assertExists()
        composeRule.onNodeWithText("📖 HOW TO PLAY RULES").assertExists()
    }

    @Test
    fun testHomeScreenDisplaysAccessibilitySection() {
        setAppContent()

        // Senior mode card: the accessibility section (added with Senior Mode)
        // must render its header plus the Standard / Senior Mode toggle chips.
        composeRule.onNodeWithText("4. ACCESSIBILITY — EASY READING").assertIsDisplayed()
        composeRule.onNodeWithText("Standard").assertIsDisplayed()
        composeRule.onNodeWithText("Senior Mode").assertIsDisplayed()
    }
}
