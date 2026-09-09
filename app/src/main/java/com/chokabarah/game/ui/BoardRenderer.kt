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
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.chokabarah.game.engine.PawnState
import com.chokabarah.game.engine.TrackBuilder
import com.chokabarah.game.telemetry.Telemetry

// Renders purely from the immutable BoardUi projection — it never touches
// the engine, so a draw pass can never observe a half-applied move.
@Composable
fun BoardCanvas(
    board: BoardUi,
    selectedPawnId: Int?,
    onCellClicked: (row: Int, col: Int) -> Unit,
    modifier: Modifier = Modifier,
    seniorMode: Boolean = false,
    contentDescription: String = ""
) {
    val gridSize = board.gridSize.columns
    // Senior mode keeps the board square (cells scale naturally) but thickens
    // the grid strokes and enlarges pawn/safe-cell markings so each cell reads
    // more clearly (low-vision accessibility profile).
    val gridStroke = if (seniorMode) 5f else 3f
    Canvas(
        modifier = modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .semantics { this.contentDescription = contentDescription }
            .pointerInput(board.validMoves, selectedPawnId) {
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
                            "validMoveCount" to board.validMoves.size,
                            "hasSelectedPawn" to (selectedPawnId != null)
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
                val isSafe = TrackBuilder.isSafeCell(board.gridSize, row, col)
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

        for (move in board.validMoves) {
            val target = move.targetCoords
            val highlightColor = if (move.isCapture) Color(0xFFFF5252) else Color(0xFF76FF03)
            val center = Offset(target.second * cellSize + cellSize / 2f, target.first * cellSize + cellSize / 2f)
            drawCircle(highlightColor.copy(alpha = 0.45f), cellSize * 0.38f, center)
            drawCircle(highlightColor, cellSize * 0.38f, center, style = Stroke(if (seniorMode) 9f else 6f))
        }

        val cellPawnsMap = mutableMapOf<Pair<Int, Int>, MutableList<PawnUi>>()
        // BUG-10 (parity with web): only pawns still ON_TRACK are drawn. FINISHED
        // pawns have reached center home and belong to the victory overlay, not a
        // board stack (and must never merge into a Gatti-looking bundle at center).
        for (pawn in board.pawns) {
            if (pawn.state != PawnState.ON_TRACK) continue
            val coords = TrackBuilder.getPlayerPath(board.gridSize, pawn.playerIndex)[pawn.pathIndex]
            cellPawnsMap.getOrPut(coords) { mutableListOf() }.add(pawn)
        }
        for ((coords, pawnsOnCell) in cellPawnsMap) {
            val row = coords.first
            val col = coords.second
            val cellCenterX = col * cellSize + cellSize / 2f
            val cellCenterY = row * cellSize + cellSize / 2f
            drawPawnsGroup(pawnsOnCell, cellCenterX, cellCenterY, cellSize, selectedPawnId, board.playerColors, seniorMode,
                cellRing(board.gridSize, board.toughened, pawnsOnCell))
        }
        drawHomeBasePawns(board, cellSize, selectedPawnId, seniorMode)
    }
}

// Pure layout math for a stack of `count` pawns, slot `index` (0-based).
// 1/2/3 pawns keep the classic tight patterns; 4+ spread evenly on a circle
// so every pawn occupies a DISTINCT position (the old i % 4 table wrapped
// and drew the 5th+ pawns exactly on top of the first four).
fun pawnStackOffset(count: Int, index: Int, radius: Float): Pair<Float, Float> {
    if (count <= 1) return 0f to 0f
    if (count == 2) {
        return if (index == 0) -radius * 0.7f to -radius * 0.7f
        else radius * 0.7f to radius * 0.7f
    }
    if (count == 3) {
        return when (index) {
            0 -> 0f to -radius * 0.8f
            1 -> -radius * 0.8f to radius * 0.8f
            else -> radius * 0.8f to radius * 0.8f
        }
    }
    // count >= 4: even circular distribution — distinct by construction.
    val angle = (2.0 * Math.PI * index / count).toFloat()
    val r = radius * (if (count == 4) 0.85f else 0.95f)
    return (kotlin.math.cos(angle) * r) to (kotlin.math.sin(angle) * r)
}

private fun DrawScope.drawSafeCellMarking(row: Int, col: Int, cellSize: Float, seniorMode: Boolean) {    val margin = cellSize * 0.15f
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

// Pair-ring classification for one board cell (web parity: gold = toughened
// Gatti, gray dashed = tollu; stacked outer singles and home-base markers
// get no ring). Same-cell same-player ON_TRACK pawns share a pathIndex
// (tracks never revisit a cell), so the first pawn locates the whole stack.
private enum class CellRing { NONE, TOLLU, TOUGHENED }

private fun cellRing(
    gridSize: com.chokabarah.game.engine.GridSize,
    toughened: Map<Int, Set<Int>>,
    pawnsOnCell: List<PawnUi>
): CellRing {
    if (pawnsOnCell.size < 2) return CellRing.NONE
    val first = pawnsOnCell[0]
    if (pawnsOnCell.any { it.playerIndex != first.playerIndex || it.state != PawnState.ON_TRACK }) {
        return CellRing.NONE
    }
    if ((toughened[first.playerIndex] ?: emptySet()).contains(first.pathIndex)) {
        return CellRing.TOUGHENED
    }
    val gate = TrackBuilder.innerGateIndex(gridSize, first.playerIndex)
    return if (first.pathIndex >= gate) CellRing.TOLLU else CellRing.NONE
}

private fun DrawScope.drawPawnsGroup(
    pawnsOnCell: List<PawnUi>,
    centerX: Float,
    centerY: Float,
    cellSize: Float,
    selectedPawnId: Int?,
    playerColors: List<com.chokabarah.game.engine.PlayerColor>,
    seniorMode: Boolean = false,
    ring: CellRing = CellRing.NONE
) {
    val pawnRadius = cellSize * (if (seniorMode) 0.22f else 0.18f)
    val pawnStroke = if (seniorMode) 6f else 4f
    val count = pawnsOnCell.size
    for (i in 0 until count) {
        val pawn = pawnsOnCell[i]
        val pColor = playerColors[pawn.playerIndex]
        val isSelected = selectedPawnId == pawn.id
        val offset = pawnStackOffset(count, i, pawnRadius)
        val pawnCenterX = centerX + offset.first
        val pawnCenterY = centerY + offset.second
        if (ring != CellRing.NONE) {
            val (ringColor, dash) = if (ring == CellRing.TOUGHENED) {
                Color(0xFFFFD54F) to null
            } else {
                Color(0xFFB0BEC5) to floatArrayOf(10f, 6f)
            }
            drawCircle(
                ringColor, pawnRadius + 4f, Offset(pawnCenterX, pawnCenterY),
                style = Stroke(5f, pathEffect = dash?.let { PathEffect.dashPathEffect(it) })
            )
        }
        drawCircle(Color(pColor.hexColor), pawnRadius, Offset(pawnCenterX, pawnCenterY))
        drawCircle(Color.White, pawnRadius, Offset(pawnCenterX, pawnCenterY), style = Stroke(pawnStroke))
        if (isSelected) {
            drawCircle(Color(0xFFFFD54F), pawnRadius + (if (seniorMode) 9f else 6f), Offset(pawnCenterX, pawnCenterY), style = Stroke(if (seniorMode) 9f else 6f))
        }
    }
}

private fun DrawScope.drawHomeBasePawns(board: BoardUi, cellSize: Float, selectedPawnId: Int?, seniorMode: Boolean = false) {
    for (pIndex in board.playerColors.indices) {
        val startCoords = TrackBuilder.getPlayerPath(board.gridSize, pIndex)[0]
        val homePawns = board.pawns.filter { it.playerIndex == pIndex && it.state == PawnState.HOME_BASE }
        if (homePawns.isEmpty()) continue
        val cellCenterX = startCoords.second * cellSize + cellSize / 2f
        val cellCenterY = startCoords.first * cellSize + cellSize / 2f
        drawPawnsGroup(homePawns, cellCenterX, cellCenterY, cellSize, selectedPawnId, board.playerColors, seniorMode)
    }
}
