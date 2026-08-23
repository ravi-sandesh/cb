package com.chokabarah.game

import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.ui.platform.LocalContext
import com.chokabarah.game.telemetry.Telemetry
import com.chokabarah.game.ui.GameScreen
import com.chokabarah.game.ui.GameViewModel
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
            ChokaBarahApp(viewModel())
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

// Senior mode ("easy reading") persistence keys and helpers. The setting is
// shared with nothing else in the app; a simple SharedPreferences boolean is
// enough and survives activity recreation / app restarts.
private const val PREFS_NAME = "cb_prefs"
private const val KEY_SENIOR_MODE = "cb_senior_mode"

private fun readSeniorMode(context: Context): Boolean =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .getBoolean(KEY_SENIOR_MODE, false)

private fun writeSeniorMode(context: Context, enabled: Boolean) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .putBoolean(KEY_SENIOR_MODE, enabled)
        .apply()
}

@Composable
fun ChokaBarahApp(session: GameViewModel) {
    val context = LocalContext.current
    // Restore the persisted accessibility preference so a player who enabled it
    // never has to hunt for the toggle again on the next launch.
    var seniorMode by remember { mutableStateOf(readSeniorMode(context)) }
    val ui by session.uiState.collectAsState()

    when (ui.screen) {
        ScreenState.HOME -> {
            HomeScreen(
                seniorMode = seniorMode,
                onSeniorModeChanged = { flag ->
                    // Persist immediately so the choice sticks even if the app
                    // is closed from the home screen.
                    seniorMode = flag
                    writeSeniorMode(context, flag)
                    Telemetry.info(
                        "ui.config",
                        "config.senior_mode_changed",
                        "Senior mode ${if (flag) "enabled" else "disabled"}",
                        mapOf("seniorMode" to flag)
                    )
                },
                onStartGame = { gridSize, playerCount, gameMode ->
                    session.startGame(gridSize, playerCount, gameMode)
                }
            )
        }

        ScreenState.PLAYING -> {
            GameScreen(
                state = session,
                seniorMode = seniorMode,
                onBackToMenu = { session.exitToMenu() }
            )
        }
    }
}
