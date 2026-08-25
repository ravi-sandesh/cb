package com.example.chokabara

import com.chokabarah.game.engine.CowryResult
import com.chokabarah.game.engine.GameMode
import com.chokabarah.game.engine.GridCell
import com.chokabarah.game.engine.GridSize
import com.chokabarah.game.engine.MoveOption
import com.chokabarah.game.engine.Pawn
import com.chokabarah.game.engine.PawnState
import com.chokabarah.game.engine.PlayerColor
import org.junit.Assert.*
import org.junit.Test

class GameModelsTest {

    @Test
    fun testGridSizeEnum() {
        assertEquals(5, GridSize.FIVE_BY_FIVE.columns)
        assertEquals(7, GridSize.SEVEN_BY_SEVEN.columns)
        assertEquals(2, GridSize.values().size)
    }

    @Test
    fun testPlayerColorEnumValues() {
        val colors = PlayerColor.values()
        assertEquals(4, colors.size)
        assertEquals(0, PlayerColor.RED.id)
        assertEquals(1, PlayerColor.GREEN.id)
        assertEquals(2, PlayerColor.YELLOW.id)
        assertEquals(3, PlayerColor.BLUE.id)
        assertTrue(colors.map { it.displayName }.any { it.contains("Red") })
        assertTrue(colors.map { it.displayName }.any { it.contains("Green") })
        assertTrue(colors.map { it.displayName }.any { it.contains("Yellow") })
        assertTrue(colors.map { it.displayName }.any { it.contains("Blue") })
        // Every light variant must be an opaque ARGB color: a mistyped
        // literal (e.g. 6 hex digits) silently yields alpha=0x00.
        for (c in colors) {
            assertEquals("${c.name}.lightHexColor must be fully opaque", 0xFF000000L, c.lightHexColor and 0xFF000000L)
        }
    }

    @Test
    fun testPawnStateEnumValues() {
        val states = PawnState.values()
        assertEquals(3, states.size)
        assertTrue(PawnState.HOME_BASE in states)
        assertTrue(PawnState.ON_TRACK in states)
        assertTrue(PawnState.FINISHED in states)
    }

    @Test
    fun testGameModeEnumValues() {
        val modes = GameMode.values()
        assertEquals(2, modes.size)
        assertTrue(GameMode.PASS_AND_PLAY in modes)
        assertTrue(GameMode.VS_BOT in modes)
    }

    @Test
    fun testPawnDefaults() {
        val pawn = Pawn(id = 0, playerIndex = 1)
        assertEquals(0, pawn.id)
        assertEquals(1, pawn.playerIndex)
        assertEquals(PawnState.HOME_BASE, pawn.state)
        assertEquals(-1, pawn.pathIndex)
    }

    @Test
    fun testPawnCopy() {
        val pawn = Pawn(id = 5, playerIndex = 2, state = PawnState.ON_TRACK, pathIndex = 10)
        val copied = pawn.copy(pathIndex = 15, state = PawnState.FINISHED)
        assertEquals(5, copied.id)
        assertEquals(2, copied.playerIndex)
        assertEquals(15, copied.pathIndex)
        assertEquals(PawnState.FINISHED, copied.state)
        // Original unchanged (data class copy is immutable except var fields)
        assertEquals(PawnState.ON_TRACK, pawn.state)
    }

    @Test
    fun testPawnVarMutation() {
        val pawn = Pawn(id = 0, playerIndex = 0)
        pawn.state = PawnState.ON_TRACK
        pawn.pathIndex = 7
        assertEquals(PawnState.ON_TRACK, pawn.state)
        assertEquals(7, pawn.pathIndex)
    }

    @Test
    fun testGridCell() {
        val cell = GridCell(row = 2, col = 2, isSafe = true, isCenterHome = true)
        assertEquals(2, cell.row)
        assertEquals(2, cell.col)
        assertTrue(cell.isSafe)
        assertTrue(cell.isCenterHome)
        assertNull(cell.startingOwner)

        val home = GridCell(row = 4, col = 2, startingOwner = PlayerColor.RED)
        assertEquals(PlayerColor.RED, home.startingOwner)
    }

    @Test
    fun testCowryResultCreation() {
        val result = CowryResult(
            shells = listOf(true, true, true, true),
            score = 4,
            isExtraRoll = true,
            label = "CHOWKA (4) — EXTRA ROLL!"
        )
        assertEquals(4, result.score)
        assertEquals(4, result.shells.size)
        assertTrue(result.isExtraRoll)
        assertEquals("CHOWKA (4) — EXTRA ROLL!", result.label)
    }

    @Test
    fun testCowryResultBaaraIsExtraRoll() {
        val result = CowryResult(
            shells = listOf(false, false, false, false),
            score = 8,
            isExtraRoll = true,
            label = "BAARA (8) — EXTRA ROLL!"
        )
        assertEquals(8, result.score)
        assertTrue(result.isExtraRoll)
    }

    @Test
    fun testMoveOptionCreation() {
        val pawn = Pawn(id = 0, playerIndex = 0)
        val moveOption = MoveOption(
            grpPawns = listOf(pawn),
            targetPathIndex = 5,
            targetCoords = Pair(2, 1),
            isCapture = false,
            reachesHome = false,
            isGattiGroup = false
        )
        assertEquals(1, moveOption.grpPawns.size)
        assertEquals(5, moveOption.targetPathIndex)
        assertEquals(Pair(2, 1), moveOption.targetCoords)
        assertFalse(moveOption.isCapture)
        assertFalse(moveOption.reachesHome)
        assertFalse(moveOption.isGattiGroup)
    }

    @Test
    fun testMoveOptionWithGatti() {
        val pawn1 = Pawn(id = 0, playerIndex = 0, state = PawnState.ON_TRACK, pathIndex = 5)
        val pawn2 = Pawn(id = 1, playerIndex = 0, state = PawnState.ON_TRACK, pathIndex = 5)
        val moveOption = MoveOption(
            grpPawns = listOf(pawn1, pawn2),
            targetPathIndex = 8,
            targetCoords = Pair(3, 3),
            isCapture = false,
            reachesHome = false,
            isGattiGroup = true
        )
        assertEquals(2, moveOption.grpPawns.size)
        assertTrue(moveOption.isGattiGroup)
    }
}
