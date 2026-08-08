package com.chokabarah.game

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.chokabarah.game.engine.GameMode
import com.chokabarah.game.engine.GridSize
import com.chokabarah.game.telemetry.Telemetry
import com.chokabarah.game.ui.GameScreen
import com.chokabarah.game.ui.HomeScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        Telemetry.info(
            "app",
            "app.created",
            "MainActivity created; session started",
            mapOf(
                "telemetryEnabled" to Telemetry.isEnabled(),
                "sessionId" to Telemetry.getSessionId(),
                "traceId" to Telemetry.getTraceId(),
                "savedInstanceState" to (savedInstanceState != null)
            )
        )

        setContent {
            ChokaBarahApp()
        }
    }

    override fun onStart() {
        super.onStart()
        Telemetry.trace("app", "app.on_start", "MainActivity moved to started state", mapOf("sessionId" to Telemetry.getSessionId()))
    }

    override fun onResume() {
        super.onResume()
        Telemetry.trace("app", "app.on_resume", "MainActivity resumed to foreground", mapOf("sessionId" to Telemetry.getSessionId()))
    }

    override fun onPause() {
        super.onPause()
        Telemetry.trace("app", "app.on_pause", "MainActivity paused (backgrounded)", mapOf("sessionId" to Telemetry.getSessionId()))
    }

    override fun onStop() {
        super.onStop()
        Telemetry.trace("app", "app.on_stop", "MainActivity stopped", mapOf("sessionId" to Telemetry.getSessionId()))
    }

    override fun onDestroy() {
        super.onDestroy()
        Telemetry.debug("app", "app.on_destroy", "MainActivity destroyed; session ending", mapOf("sessionId" to Telemetry.getSessionId()))
    }
}

enum class ScreenState {
    HOME,
    PLAYING
}

@Composable
fun ChokaBarahApp() {
    var screenState by remember { mutableStateOf(ScreenState.HOME) }
    var selectedGridSize by remember { mutableStateOf(GridSize.FIVE_BY_FIVE) }
    var selectedPlayerCount by remember { mutableStateOf(2) }
    var selectedGameMode by remember { mutableStateOf(GameMode.PASS_AND_PLAY) }

    when (screenState) {
        ScreenState.HOME -> {
            HomeScreen(
                onStartGame = { gridSize, playerCount, gameMode ->
                    selectedGridSize = gridSize
                    selectedPlayerCount = playerCount
                    selectedGameMode = gameMode
                    screenState = ScreenState.PLAYING
                }
            )
        }

        ScreenState.PLAYING -> {
            GameScreen(
                gridSize = selectedGridSize,
                playerCount = selectedPlayerCount,
                gameMode = selectedGameMode,
                onBack = {
                    screenState = ScreenState.HOME
                }
            )
        }
    }
}
