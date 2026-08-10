package com.chokabarah.game.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.chokabarah.game.engine.CowryResult
import com.chokabarah.game.engine.GridSize
import com.chokabarah.game.telemetry.Telemetry
import kotlinx.coroutines.launch

@Composable
fun CowryRollSection(
    currentRoll: CowryResult?,
    canRoll: Boolean,
    onRollRequested: () -> Unit,
    gridSize: GridSize = GridSize.FIVE_BY_FIVE,
    modifier: Modifier = Modifier
) {
    val rotation = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val numShells = if (gridSize == GridSize.SEVEN_BY_SEVEN) 6 else 4

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(Color(0xFF2C241E), RoundedCornerShape(16.dp))
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            text = "COWRY SHELLS ROLL",
            color = Color(0xFFFFD54F),
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.sp
        )
        Spacer(modifier = Modifier.height(12.dp))

        Row(
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            val shells = currentRoll?.shells ?: List(numShells) { it % 2 == 0 }
            val shellWidth = if (numShells >= 6) 42.dp else 54.dp
            for (i in 0 until numShells) {
                val isOpen = shells.getOrElse(i) { false }
                CowryShellView(
                    isOpen = isOpen,
                    rotationAngle = rotation.value,
                    modifier = Modifier.padding(horizontal = 3.dp),
                    shellWidth = shellWidth
                )
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        Button(
            onClick = {
                Telemetry.trace(
                    "ui.roll",
                    "roll.button_clicked",
                    "User tapped the ROLL COWRIES button",
                    mapOf(
                        "canRoll" to canRoll,
                        "gridSize" to gridSize.columns,
                        "numShells" to numShells
                    )
                )
                scope.launch {
                    rotation.animateTo(rotation.value + 720f, animationSpec = tween(400))
                }
                onRollRequested()
            },
            modifier = Modifier.fillMaxWidth(0.7f),
            enabled = canRoll,
            shape = RoundedCornerShape(12.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = Color(0xFFFF8F00),
                contentColor = Color.White,
                disabledContainerColor = Color(0xFF5D4037),
                disabledContentColor = Color(0xFF8D6E63)
            )
        ) {
            Text(
                text = if (canRoll) "\uD83C\uDFB2 ROLL COWRIES" else "MOVE PAWN",
                fontWeight = FontWeight.Bold,
                fontSize = 16.sp
            )
        }

        if (currentRoll != null) {
            Spacer(modifier = Modifier.height(8.dp))
            // BUG-19: render the engine-authoritative label (scoreShells /
            // rollCowries output), not a UI-side re-derivation. The cowry labels
            // were duplicating the formatter ("SCORE: N", " - ") and drifting
            // from the Kotlin engine + rules doc ("Score: N", " — ").
            Text(
                text = currentRoll.label,
                color = if (currentRoll.isExtraRoll) Color(0xFF76FF03) else Color.White,
                fontWeight = FontWeight.Bold,
                fontSize = 16.sp
            )
        }
    }
}

@Composable
fun CowryShellView(
    isOpen: Boolean,
    rotationAngle: Float,
    modifier: Modifier = Modifier,
    shellWidth: Dp = 54.dp
) {
    val shellHeight = shellWidth * (64f / 54f)
    Canvas(
        modifier = modifier
            .size(shellWidth, shellHeight)
            .graphicsLayer { rotationZ = rotationAngle }
    ) {
        val w = size.width
        val h = size.height
        val shellPath = Path().apply {
            moveTo(w * 0.5f, 2f)
            cubicTo(w * 0.95f, h * 0.15f, w * 0.95f, h * 0.85f, w * 0.5f, h - 2f)
            cubicTo(w * 0.05f, h * 0.85f, w * 0.05f, h * 0.15f, w * 0.5f, 2f)
            close()
        }
        if (isOpen) {
            drawPath(shellPath, Color(0xFFFFF8E1))
            drawPath(shellPath, color = Color(0xFF8D6E63), style = Stroke(4f))
            val mouthPath = Path().apply {
                moveTo(w * 0.5f, h * 0.2f)
                lineTo(w * 0.5f, h * 0.8f)
            }
            drawPath(mouthPath, color = Color(0xFF4E342E), style = Stroke(6f))
            for (yOffset in listOf(0.3f, 0.45f, 0.6f, 0.7f)) {
                drawLine(
                    color = Color(0xFF4E342E),
                    start = Offset(w * 0.38f, h * yOffset),
                    end = Offset(w * 0.62f, h * yOffset),
                    strokeWidth = 3f
                )
            }
        } else {
            drawPath(shellPath, color = Color(0xFF8D6E63))
            drawPath(shellPath, color = Color(0xFF3E2723), style = Stroke(4f))
            drawArc(
                color = Color(0xFFA1887F),
                startAngle = -60f,
                sweepAngle = 120f,
                useCenter = false,
                topLeft = Offset(w * 0.25f, h * 0.25f),
                size = Size(w * 0.5f, h * 0.5f),
                style = Stroke(4f)
            )
        }
    }
}