package com.chokabarah.game.engine

// Display labels live in the Android app's resources (strings.xml); the
// engine stays presentation-free so it can remain a pure-JVM module.
enum class GridSize(val columns: Int) {
    FIVE_BY_FIVE(5),
    SEVEN_BY_SEVEN(7)
}

enum class PlayerColor(
    val id: Int,
    val displayName: String,
    val hexColor: Long,
    val lightHexColor: Long
) {
    RED(0, "Red (South)", 0xFFE53935, 0xFFFFCDD2),
    GREEN(1, "Green (North)", 0xFF43A047, 0xFFC8E6C9),
    YELLOW(2, "Yellow (East)", 0xFFFDD835, 0xFFFFF9C4),
    BLUE(3, "Blue (West)", 0xFF1E88E5, 0xFFBBDEFB)
}

enum class PawnState {
    HOME_BASE,
    ON_TRACK,
    FINISHED
}

data class Pawn(
    val id: Int,
    val playerIndex: Int,
    var state: PawnState = PawnState.HOME_BASE,
    var pathIndex: Int = -1 // Index along player's specific track path
)

data class GridCell(
    val row: Int,
    val col: Int,
    val isSafe: Boolean = false,
    val isCenterHome: Boolean = false,
    val startingOwner: PlayerColor? = null
)

enum class GameMode {
    PASS_AND_PLAY,
    VS_BOT
}
