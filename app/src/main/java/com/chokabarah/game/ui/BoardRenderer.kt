package com.chokabarah.game.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import com.chokabarah.game.engine.GameEngine
import com.chokabarah.game.engine.MoveOption
import com.chokabarah.game.engine.Pawn
import com.chokabarah.game.engine.PawnState
import com.chokabarah.game.engine.TrackBuilder
import com.chokabarah.game.telemetry.Telemetry

@Composable
fun BoardCanvas(
    gameEngine: GameEngine,
    selectedPawn: Pawn?,
    onCellClicked: (row: Int, col: Int) -> Unit,
    modifier: Modifier = Modifier,
    seniorMode: Boolean = false
) {
    val gridSize = gameEngine.gridSize.columns
    // Senior mode keeps the board square (cells scale naturally) but thickens
    // the grid strokes and enlarges pawn/safe-cell markings so each cell reads
    // more clearly (low-vision accessibility profile).
    val gridStroke = if (seniorMode) 5f else 3f
    Canvas(
        modifier = modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .pointerInput(gameEngine.validMoves, selectedPawn) {
                detectTapGestures { offset ->
                    val cellSize = size.width.toFloat() / gridSize
                    val col = (offset.x / cellSize).toInt().coerceIn(0, gridSize - 1)
                    val row = (offset.y / cellSize).toInt().coerceIn(0, gridSize - 1)
                    Telemetry.debug(
                        "ui.board",
                        "board.cell_tapped",
                        "User tapped board cell",
                        mapOf(
                            "row" to row,
                            "col" to col,
                            "gridSize" to gridSize,
                            "validMoveCount" to gameEngine.validMoves.size,
                            "hasSelectedPawn" to (selectedPawn != null)
                        )
                    )
                    onCellClicked(row, col)
                }
            }
    ) {
        val boardSize = size.width
        val cellSize = boardSize / gridSize

        for (row in 0 until gridSize) {
            for (col in 0 until gridSize) {
                val isSafe = TrackBuilder.isSafeCell(gameEngine.gridSize, row, col)
                val isCenter = row == gridSize / 2 && col == gridSize / 2
                val cellBgColor = when {
                    isCenter -> Color(0xFFD81B60)
                    isSafe -> Color(0xFFFFF8E1)
                    (row + col) % 2 == 0 -> Color(0xFFF5E6CA)
                    else -> Color(0xFFE6D3B1)
                }
                val topLeft = Offset(col * cellSize, row * cellSize)
                drawRect(cellBgColor, topLeft = topLeft, size = Size(cellSize, cellSize))
                drawRect(
                    Color(0xFF5D4037),
                    topLeft = topLeft,
                    size = Size(cellSize, cellSize),
                    style = Stroke(gridStroke)
                )
                if (isSafe && !isCenter) {
                    drawSafeCellMarking(row, col, cellSize, seniorMode)
                }
                if (isCenter) {
                    drawCenterHomeMarking(row, col, cellSize)
                }
            }
        }

        for (move in gameEngine.validMoves) {
            val target = move.targetCoords
            val highlightColor = if (move.isCapture) Color(0xFFFF5252) else Color(0xFF76FF03)
            val center = Offset(target.second * cellSize + cellSize / 2f, target.first * cellSize + cellSize / 2f)
            drawCircle(highlightColor.copy(alpha = 0.45f), cellSize * 0.38f, center)
            drawCircle(highlightColor, cellSize * 0.38f, center, style = Stroke(if (seniorMode) 9f else 6f))
        }

        val cellPawnsMap = mutableMapOf<Pair<Int, Int>, MutableList<Pawn>>()
        // BUG-10 (parity with web): only pawns still ON_TRACK are drawn. FINISHED
        // pawns have reached center home and belong to the victory overlay, not a
        // board stack (and must never merge into a Gatti-looking bundle at center).
        for (pawn in gameEngine.pawns) {
            if (pawn.state != PawnState.ON_TRACK) continue
            val coords = TrackBuilder.getPlayerPath(gameEngine.gridSize, pawn.playerIndex)[pawn.pathIndex]
            cellPawnsMap.getOrPut(coords) { mutableListOf() }.add(pawn)
        }
        for ((coords, pawnsOnCell) in cellPawnsMap) {
            val row = coords.first
            val col = coords.second
            val cellCenterX = col * cellSize + cellSize / 2f
            val cellCenterY = row * cellSize + cellSize / 2f
            drawPawnsGroup(pawnsOnCell, cellCenterX, cellCenterY, cellSize, selectedPawn, gameEngine, seniorMode)
        }
        drawHomeBasePawns(gameEngine, cellSize, selectedPawn, seniorMode)
    }
}

private fun DrawScope.drawSafeCellMarking(row: Int, col: Int, cellSize: Float, seniorMode: Boolean) {
    val margin = cellSize * 0.15f
    val strokeWidth = if (seniorMode) 8f else 5f
    val color = Color(0xFF8D6E63)
    val left = col * cellSize + margin
    val right = (col + 1) * cellSize - margin
    val top = row * cellSize + margin
    val bottom = (row + 1) * cellSize - margin
    drawLine(color, Offset(left, top), Offset(right, bottom), strokeWidth)
    drawLine(color, Offset(right, top), Offset(left, bottom), strokeWidth)
}

private fun DrawScope.drawCenterHomeMarking(row: Int, col: Int, cellSize: Float) {
    val centerX = col * cellSize + cellSize / 2f
    val centerY = row * cellSize + cellSize / 2f
    val radius = cellSize * 0.35f
    drawCircle(Color(0xFFFFD54F), radius, Offset(centerX, centerY))
    val path = Path().apply {
        moveTo(centerX, centerY - radius * 0.7f)
        lineTo(centerX + radius * 0.7f, centerY)
        lineTo(centerX, centerY + radius * 0.7f)
        lineTo(centerX - radius * 0.7f, centerY)
        close()
    }
    drawPath(path, Color(0xFFC2185B))
}

private fun DrawScope.drawPawnsGroup(
    pawnsOnCell: List<Pawn>,
    centerX: Float,
    centerY: Float,
    cellSize: Float,
    selectedPawn: Pawn?,
    gameEngine: GameEngine,
    seniorMode: Boolean = false
) {
    val pawnRadius = cellSize * (if (seniorMode) 0.22f else 0.18f)
    val pawnStroke = if (seniorMode) 6f else 4f
    val count = pawnsOnCell.size
    for (i in 0 until count) {
        val pawn = pawnsOnCell[i]
        val pColor = gameEngine.playerColors[pawn.playerIndex]
        val isSelected = selectedPawn?.id == pawn.id
        val offset = when {
            count == 1 -> Offset(0f, 0f)
            count == 2 -> if (i == 0) Offset(-pawnRadius * 0.7f, -pawnRadius * 0.7f) else Offset(pawnRadius * 0.7f, pawnRadius * 0.7f)
            count == 3 -> when (i) {
                0 -> Offset(0f, -pawnRadius * 0.8f)
                1 -> Offset(-pawnRadius * 0.8f, pawnRadius * 0.8f)
                else -> Offset(pawnRadius * 0.8f, pawnRadius * 0.8f)
            }
            else -> when (i % 4) {
                0 -> Offset(-pawnRadius * 0.8f, -pawnRadius * 0.8f)
                1 -> Offset(pawnRadius * 0.8f, -pawnRadius * 0.8f)
                2 -> Offset(-pawnRadius * 0.8f, pawnRadius * 0.8f)
                else -> Offset(pawnRadius * 0.8f, pawnRadius * 0.8f)
            }
        }
        val pawnCenterX = centerX + offset.x
        val pawnCenterY = centerY + offset.y
        drawCircle(Color(pColor.hexColor), pawnRadius, Offset(pawnCenterX, pawnCenterY))
        drawCircle(Color.White, pawnRadius, Offset(pawnCenterX, pawnCenterY), style = Stroke(pawnStroke))
        if (isSelected) {
            drawCircle(Color(0xFFFFD54F), pawnRadius + (if (seniorMode) 9f else 6f), Offset(pawnCenterX, pawnCenterY), style = Stroke(if (seniorMode) 9f else 6f))
        }
    }
}

private fun DrawScope.drawHomeBasePawns(gameEngine: GameEngine, cellSize: Float, selectedPawn: Pawn?, seniorMode: Boolean = false) {
    for (pIndex in 0 until gameEngine.playerColors.size) {
        val startCoords = TrackBuilder.getPlayerPath(gameEngine.gridSize, pIndex)[0]
        val homePawns = gameEngine.pawns.filter { it.playerIndex == pIndex && it.state == PawnState.HOME_BASE }
        if (homePawns.isEmpty()) continue
        val cellCenterX = startCoords.second * cellSize + cellSize / 2f
        val cellCenterY = startCoords.first * cellSize + cellSize / 2f
        drawPawnsGroup(homePawns, cellCenterX, cellCenterY, cellSize, selectedPawn, gameEngine, seniorMode)
    }
}