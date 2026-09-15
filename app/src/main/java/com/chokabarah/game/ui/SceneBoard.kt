package com.chokabarah.game.ui

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color as AndroidColor
import android.graphics.Paint
import android.graphics.Typeface
import android.view.MotionEvent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color as UiColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.viewinterop.AndroidView
import com.chokabarah.game.engine.PawnState
import com.chokabarah.game.engine.PlayerColor
import com.chokabarah.game.engine.TrackBuilder
import io.github.sceneview.math.Direction
import io.github.sceneview.math.Position
import io.github.sceneview.math.Rotation
import io.github.sceneview.math.Size
import io.github.sceneview.node.CylinderNode
import io.github.sceneview.node.ImageNode
import io.github.sceneview.node.Node
import io.github.sceneview.node.RenderableNode
import io.github.sceneview.node.PlaneNode
import io.github.sceneview.node.SphereNode
import io.github.sceneview.node.CubeNode
import io.github.sceneview.SceneView

@Composable
fun Board3D(
    board: BoardUi,
    selectedPawnId: Int?,
    onCellClicked: (row: Int, col: Int) -> Unit,
    modifier: Modifier = Modifier,
    seniorMode: Boolean = false,
    contentDescription: String = ""
) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val inspectionMode = LocalInspectionMode.current
    val controller = remember(context, lifecycle, inspectionMode) {
        if (inspectionMode) null else runCatching { BoardSceneController(context, lifecycle) }.getOrNull()
    }
    var useFallback by remember { mutableStateOf(controller == null) }

    if (useFallback || controller == null) {
        BoardCanvas(
            board = board,
            selectedPawnId = selectedPawnId,
            onCellClicked = onCellClicked,
            modifier = modifier
                .fillMaxWidth()
                .aspectRatio(1f)
                .semantics { this.contentDescription = contentDescription },
            seniorMode = seniorMode,
            contentDescription = contentDescription
        )
        return
    }

    LaunchedEffect(controller, onCellClicked) {
        controller?.onCellClicked = onCellClicked
    }
    LaunchedEffect(board, selectedPawnId, seniorMode) {
        val sceneController = controller ?: return@LaunchedEffect
        if (!sceneController.destroyed) runCatching {
            sceneController.render(board, selectedPawnId, animate = !seniorMode)
        }.onFailure {
            sceneController.destroy()
            useFallback = true
        }
    }
    DisposableEffect(controller) {
        onDispose { controller?.destroy() }
    }

    AndroidView(
        factory = { controller.sceneView },
        modifier = modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .semantics { this.contentDescription = contentDescription }
    )
}

private class BoardSceneController(
    context: android.content.Context,
    lifecycle: androidx.lifecycle.Lifecycle
) {
    val sceneView = SceneView(
        context = context,
        cameraManipulator = null,
        onTouchEvent = { event, hit ->
            if (event.actionMasked == MotionEvent.ACTION_UP) {
                val name = hit?.node?.name.orEmpty()
                val parts = name.split(':')
                if (parts.size == 3 && parts[0] == "cell") {
                    runCatching {
                        onCellClicked(parts[1].toInt(), parts[2].toInt())
                    }
                }
            }
            true
        }
    ).apply {
        this.lifecycle = lifecycle
        mainLightNode?.apply {
            lightPosition = Position(x = 3f, y = 7f, z = 3f)
            intensity = 35_000f
            isShadowCaster = true
            sunAngularRadius = 0.025f
        }
    }

    var onCellClicked: (row: Int, col: Int) -> Unit = { _, _ -> }

    private val materialCache = mutableMapOf<ULong, com.google.android.filament.MaterialInstance>()
    private val labelBitmaps = mutableMapOf<String, Bitmap>()
    private val pawnBodies = mutableMapOf<Int, SphereNode>()
    private val pawnBases = mutableMapOf<Int, CylinderNode>()
    private val pawnLabels = mutableMapOf<Int, ImageNode>()
    private val pawnColors = mutableMapOf<Int, Long>()
    private data class VictoryParticle(
        val node: SphereNode,
        val origin: Position,
        val velocity: Position
    )

    private data class RetiredPawn(
        val nodes: List<RenderableNode>,
        val origins: List<Position>,
        val animator: ValueAnimator
    )

    private var staticNodes = emptyList<Node>()
    private var lastPawns = emptyMap<Int, PawnUi>()
    private var lastWinner: PlayerColor? = null
    private val effectNodes = mutableListOf<Node>()
    private val victoryParticles = mutableListOf<VictoryParticle>()
    private val retiredPawns = mutableListOf<RetiredPawn>()
    private val animators = mutableListOf<ValueAnimator>()
    var destroyed = false
        private set

    fun render(board: BoardUi, selectedPawnId: Int?, animate: Boolean) {
        if (destroyed) return
        configureCamera(board.gridSize.columns)
        val currentPawns = board.pawns.associateBy { it.id }
        val capturedIds = lastPawns.values
            .filter { oldPawn ->
                oldPawn.state == PawnState.ON_TRACK && currentPawns[oldPawn.id]?.state == PawnState.HOME_BASE
            }
            .map { it.id }
            .toSet()
        val finishedIds = lastPawns.values
            .filter { oldPawn ->
                oldPawn.state == PawnState.ON_TRACK && currentPawns[oldPawn.id]?.state == PawnState.FINISHED
            }
            .map { it.id }
            .toSet()
        val newStaticNodes = buildStaticNodes(board, selectedPawnId)
        replaceStaticNodes(newStaticNodes)
        renderPawns(board, selectedPawnId, animate, capturedIds, finishedIds)
        if (animate && board.winner != null && lastWinner == null) spawnVictoryParticles(board.gridSize.columns)
        lastWinner = board.winner
        lastPawns = currentPawns
    }

    fun destroy() {
        if (destroyed) return
        destroyed = true
        animators.forEach { it.cancel() }
        animators.clear()
        retiredPawns.flatMap { it.nodes }.forEach { runCatching { it.destroy() } }
        val retiredNodes = retiredPawns.flatMap { it.nodes }.toSet()
        retiredPawns.clear()
        victoryParticles.map { it.node }.forEach { runCatching { it.destroy() } }
        val particleNodes = victoryParticles.map { it.node }.toSet()
        victoryParticles.clear()
        effectNodes.removeAll(retiredNodes)
        effectNodes.removeAll(particleNodes)
        effectNodes.forEach { runCatching { it.destroy() } }
        effectNodes.clear()
        replaceStaticNodes(emptyList())
        pawnBodies.values.forEach { it.destroy() }
        pawnBases.values.forEach { it.destroy() }
        pawnLabels.values.forEach { it.destroy() }
        pawnBodies.clear()
        pawnBases.clear()
        pawnLabels.clear()
        pawnColors.clear()
        labelBitmaps.values.forEach { if (!it.isRecycled) it.recycle() }
        labelBitmaps.clear()
        materialCache.values.forEach { runCatching { sceneView.materialLoader.destroyMaterialInstance(it) } }
        materialCache.clear()
        runCatching { sceneView.materialLoader.destroy() }
        sceneView.destroy()
    }

    private fun configureCamera(gridSize: Int) {
        val center = (gridSize - 1) / 2f
        val distance = gridSize * 1.05f
        sceneView.cameraNode.apply {
            focalLength = 38.0
            near = 0.01f
            far = 50f
            position = Position(
                x = center + distance * 0.32f,
                y = distance * 1.18f,
                z = center + distance * 1.28f
            )
            lookAt(Position(x = center, y = 0f, z = center))
        }
    }

    private fun buildStaticNodes(board: BoardUi, selectedPawnId: Int?): List<Node> {
        val gridSize = board.gridSize.columns
        val center = (gridSize - 1) / 2f
        val span = gridSize.toFloat()
        val nodes = mutableListOf<Node>()
        nodes += CubeNode(
            engine = sceneView.engine,
            size = Size(x = span + 1.15f, y = 0.28f, z = span + 1.15f),
            center = Position(x = center, y = -0.2f, z = center),
            materialInstance = material(UiColor(0xFF211812))
        ).nonInteractive()

        for (row in 0 until gridSize) {
            for (col in 0 until gridSize) {
                val isSafe = TrackBuilder.isSafeCell(board.gridSize, row, col)
                val isCenter = row == gridSize / 2 && col == gridSize / 2
                val color = when {
                    isCenter -> UiColor(0xFFC62828)
                    isSafe -> UiColor(0xFFFFF8E1)
                    (row + col) % 2 == 0 -> UiColor(0xFFF5E6CA)
                    else -> UiColor(0xFFE6D3B1)
                }
                nodes += CubeNode(
                    engine = sceneView.engine,
                    size = Size(x = 0.98f, y = 0.18f, z = 0.98f),
                    center = Position(x = col.toFloat(), y = -0.11f, z = row.toFloat()),
                    materialInstance = material(UiColor(0xFF5D4037))
                ).nonInteractive()
                nodes += CubeNode(
                    engine = sceneView.engine,
                    size = Size(x = 0.94f, y = 0.16f, z = 0.94f),
                    center = Position(x = col.toFloat(), y = -0.08f, z = row.toFloat()),
                    materialInstance = material(color)
                ).nonInteractive().apply {
                    name = "cell:$row:$col"
                    isHittable = true
                    isTouchable = true
                }
                if (isSafe && !isCenter) {
                    val marking = material(UiColor(0xFF8D6E63))
                    nodes += PlaneNode(
                        engine = sceneView.engine,
                        size = Size(x = 0.72f, y = 0.055f, z = 0f),
                        center = Position(x = col.toFloat(), y = 0.095f, z = row.toFloat()),
                        materialInstance = marking
                    ).nonInteractive().apply { rotation = Rotation(x = 0f, y = 45f, z = 0f) }
                    nodes += PlaneNode(
                        engine = sceneView.engine,
                        size = Size(x = 0.72f, y = 0.055f, z = 0f),
                        center = Position(x = col.toFloat(), y = 0.1f, z = row.toFloat()),
                        materialInstance = marking
                    ).nonInteractive().apply { rotation = Rotation(x = 0f, y = -45f, z = 0f) }
                }
                if (isCenter) {
                    nodes += PlaneNode(
                        engine = sceneView.engine,
                        size = Size(x = 0.48f, y = 0.48f, z = 0f),
                        center = Position(x = col.toFloat(), y = 0.1f, z = row.toFloat()),
                        materialInstance = material(UiColor(0xFFFFD54F))
                    ).nonInteractive().apply { rotation = Rotation(x = 0f, y = 45f, z = 0f) }
                    nodes += PlaneNode(
                        engine = sceneView.engine,
                        size = Size(x = 0.34f, y = 0.34f, z = 0f),
                        center = Position(x = col.toFloat(), y = 0.11f, z = row.toFloat()),
                        materialInstance = material(UiColor(0xFFC62828))
                    ).nonInteractive().apply { rotation = Rotation(x = 0f, y = 45f, z = 0f) }
                }
            }
        }

        board.validMoves.forEach { move ->
            val target = move.targetCoords
            if (target.first !in 0 until gridSize || target.second !in 0 until gridSize) return@forEach
            nodes += CylinderNode(
                engine = sceneView.engine,
                radius = 0.21f,
                height = 0.035f,
                center = Position(x = target.second.toFloat(), y = 0.12f, z = target.first.toFloat()),
                sideCount = 32,
                materialInstance = material(if (move.isCapture) UiColor(0xFFFF5252) else UiColor(0xFF76FF03))
            ).nonInteractive()
        }

        val grouped = board.pawns
            .filter { it.state != PawnState.FINISHED }
            .groupBy { pawn ->
                val pathIndex = if (pawn.state == PawnState.ON_TRACK) pawn.pathIndex else 0
                TrackBuilder.getPlayerPath(board.gridSize, pawn.playerIndex).getOrNull(pathIndex)
            }
        grouped.forEach { (coords, pawns) ->
            if (coords == null || pawns.isEmpty()) return@forEach
            val first = pawns.first()
            if (first.playerIndex !in board.playerColors.indices) return@forEach
            val tag = classifyPairCell(board.gridSize, board.toughened, pawns)
            val ringColor = when {
                tag == PairCellTag.TOUGHENED -> UiColor(0xFFFFD54F)
                tag == PairCellTag.TOLLU -> UiColor(0xFFB0BEC5)
                else -> null
            }
            if (ringColor != null && pawns.size >= 2) {
                nodes += CylinderNode(
                    engine = sceneView.engine,
                    radius = 0.29f,
                    height = 0.025f,
                    center = Position(x = coords.second.toFloat(), y = 0.115f, z = coords.first.toFloat()),
                    sideCount = 40,
                    materialInstance = material(ringColor)
                ).nonInteractive()
            }
            if (selectedPawnId != null && pawns.any { it.id == selectedPawnId }) {
                nodes += CylinderNode(
                    engine = sceneView.engine,
                    radius = 0.31f,
                    height = 0.025f,
                    center = Position(x = coords.second.toFloat(), y = 0.125f, z = coords.first.toFloat()),
                    sideCount = 40,
                    materialInstance = material(UiColor(0xFFFFD54F))
                ).nonInteractive()
            }
        }
        return nodes
    }

    private fun renderPawns(
        board: BoardUi,
        selectedPawnId: Int?,
        animate: Boolean,
        capturedIds: Set<Int>,
        finishedIds: Set<Int>
    ) {
        val activeIds = mutableSetOf<Int>()
        val grouped = board.pawns
            .filter { it.state != PawnState.FINISHED }
            .groupBy { pawn ->
                val pathIndex = if (pawn.state == PawnState.ON_TRACK) pawn.pathIndex else 0
                TrackBuilder.getPlayerPath(board.gridSize, pawn.playerIndex).getOrNull(pathIndex)
            }

        grouped.forEach { (coords, pawns) ->
            if (coords == null) return@forEach
            val offsets = stackOffsets(pawns.size)
            pawns.forEachIndexed { index, pawn ->
                val color = board.playerColors.getOrNull(pawn.playerIndex) ?: return@forEachIndexed
                val colorKey = color.hexColor
                val id = pawn.id
                activeIds += id
                if (pawnBodies[id] == null || pawnColors[id] != colorKey) {
                    removePawn(id)
                    val pawnColor = material(UiColor(colorKey))
                    val body = SphereNode(
                        engine = sceneView.engine,
                        radius = 0.16f,
                        center = Position(x = 0f, y = 0.2f, z = 0f),
                        stacks = 20,
                        slices = 28,
                        materialInstance = pawnColor
                    ).nonInteractive()
                    val base = CylinderNode(
                        engine = sceneView.engine,
                        radius = 0.19f,
                        height = 0.08f,
                        center = Position(x = 0f, y = 0.04f, z = 0f),
                        sideCount = 28,
                        materialInstance = pawnColor
                    ).nonInteractive()
                    val label = ImageNode(
                        materialLoader = sceneView.materialLoader,
                        bitmap = labelBitmap(pawnNumberLabel(id)),
                        size = Size(x = 0.22f, y = 0.22f, z = 0f),
                        center = Position(x = 0f, y = 0.43f, z = 0f),
                        normal = Direction(y = 1f)
                    ).nonInteractive()
                    pawnBodies[id] = body
                    pawnBases[id] = base
                    pawnLabels[id] = label
                    pawnColors[id] = colorKey
                    body.position = Position(x = coords.second.toFloat(), y = 0.2f, z = coords.first.toFloat())
                    base.position = Position(x = coords.second.toFloat(), y = 0.04f, z = coords.first.toFloat())
                    label.position = Position(x = coords.second.toFloat(), y = 0.43f, z = coords.first.toFloat())
                } else {
                    val offset = offsets[index]
                    val x = coords.second.toFloat() + offset.first
                    val z = coords.first.toFloat() + offset.second
                    pawnBodies[id]?.transform(
                        position = Position(x = x, y = 0.2f, z = z),
                        rotation = pawnBodies[id]!!.rotation,
                        scale = pawnBodies[id]!!.scale,
                        smooth = animate
                    )
                    pawnBases[id]?.transform(
                        position = Position(x = x, y = 0.04f, z = z),
                        rotation = pawnBases[id]!!.rotation,
                        scale = pawnBases[id]!!.scale,
                        smooth = animate
                    )
                    pawnLabels[id]?.transform(
                        position = Position(x = x, y = 0.43f, z = z),
                        rotation = pawnLabels[id]!!.rotation,
                        scale = pawnLabels[id]!!.scale,
                        smooth = animate
                    )
                }
            }
        }

        val removedIds = pawnBodies.keys - activeIds
        removedIds.forEach { id ->
            when {
                animate && id in capturedIds -> retirePawn(id, isHome = false)
                animate && id in finishedIds -> retirePawn(id, isHome = true)
                else -> removePawn(id)
            }
        }
        sceneView.childNodes = staticNodes + pawnBodies.values + pawnBases.values + pawnLabels.values + effectNodes
    }

    private fun replaceStaticNodes(newNodes: List<Node>) {
        val oldNodes = staticNodes
        staticNodes = newNodes
        sceneView.childNodes = staticNodes + pawnBodies.values + pawnBases.values + pawnLabels.values + effectNodes
        oldNodes.forEach { it.destroy() }
    }

    private fun removePawn(id: Int) {
        pawnBodies.remove(id)?.destroy()
        pawnBases.remove(id)?.destroy()
        pawnLabels.remove(id)?.destroy()
        pawnColors.remove(id)
    }

    private fun retirePawn(id: Int, isHome: Boolean) {
        val body = pawnBodies.remove(id)
        val base = pawnBases.remove(id)
        val label = pawnLabels.remove(id)
        pawnColors.remove(id)
        val nodes = listOfNotNull(body, base, label)
        if (nodes.isEmpty()) return
        val origins = nodes.map { it.position }
        val animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = if (isHome) 520L else 420L
            addUpdateListener { animation ->
                val progress = (animation.animatedValue as Float).coerceIn(0f, 1f)
                val eased = 1f - (1f - progress) * (1f - progress) * (1f - progress)
                nodes.forEachIndexed { index, node ->
                    val origin = origins[index]
                    node.setScale(if (isHome) 1f + eased * 0.28f else (1f - eased * 0.92f).coerceAtLeast(0.04f))
                    node.position = Position(
                        x = origin.x,
                        y = origin.y + eased * if (isHome) 0.34f else 0.48f,
                        z = origin.z
                    )
                }
            }
        }
        val retired = RetiredPawn(nodes, origins, animator)
        retiredPawns += retired
        effectNodes += nodes
        animator.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: Animator) {
                if (destroyed) return
                effectNodes.removeAll(nodes.toSet())
                retiredPawns.remove(retired)
                nodes.forEach { it.destroy() }
            }
        })
        animators += animator
        sceneView.childNodes = staticNodes + pawnBodies.values + pawnBases.values + pawnLabels.values + effectNodes
        animator.start()
    }

    private fun spawnVictoryParticles(gridSize: Int) {
        val center = (gridSize - 1) / 2f
        val colors = listOf(
            UiColor(0xFFFFD54F),
            UiColor(0xFF76FF03),
            UiColor(0xFFFF5252),
            UiColor(0xFFFFFFFF),
            UiColor(0xFFFFB74D)
        )
        repeat(28) { index ->
            val node = SphereNode(
                engine = sceneView.engine,
                radius = 0.035f,
                center = Position(x = center, y = 0.55f, z = center),
                stacks = 8,
                slices = 12,
                materialInstance = material(colors[index % colors.size])
            ).nonInteractive()
            node.isShadowCaster = false
            val angle = (Math.PI * 2 * index / 28).toFloat()
            val speed = 0.55f + (index % 5) * 0.16f
            val origin = Position(x = center, y = 0.55f, z = center)
            val velocity = Position(
                x = kotlin.math.cos(angle) * speed,
                y = 1.05f + (index % 4) * 0.12f,
                z = kotlin.math.sin(angle) * speed
            )
            val particle = VictoryParticle(node, origin, velocity)
            victoryParticles += particle
            effectNodes += node
            val animator = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = 1350L + (index % 6) * 90L
                addUpdateListener { animation ->
                    val progress = (animation.animatedValue as Float).coerceIn(0f, 1f)
                    val seconds = progress * 1.45f
                    node.position = Position(
                        x = origin.x + velocity.x * seconds,
                        y = (origin.y + velocity.y * seconds - 1.05f * seconds * seconds).coerceAtLeast(0.04f),
                        z = origin.z + velocity.z * seconds
                    )
                    node.setScale(1f - progress * 0.55f)
                }
            }
            animators += animator
            animator.addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    if (destroyed) return
                    effectNodes -= node
                    victoryParticles -= particle
                    node.destroy()
                }
            })
            animator.start()
        }
        sceneView.childNodes = staticNodes + pawnBodies.values + pawnBases.values + pawnLabels.values + effectNodes
    }

    private fun material(color: UiColor): com.google.android.filament.MaterialInstance =
        materialCache.getOrPut(color.value) {
            sceneView.materialLoader.createColorInstance(color, metallic = 0.1f, roughness = 0.42f)
        }

    private fun labelBitmap(label: String): Bitmap = labelBitmaps.getOrPut(label) {
        Bitmap.createBitmap(128, 128, Bitmap.Config.ARGB_8888).also { bitmap ->
            Canvas(bitmap).apply {
                drawColor(AndroidColor.TRANSPARENT)
                val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = AndroidColor.WHITE
                    textSize = 72f
                    typeface = Typeface.DEFAULT_BOLD
                    textAlign = Paint.Align.CENTER
                }
                drawText(label, 64f, 74f, paint)
            }
        }
    }

    private fun stackOffsets(count: Int): List<Pair<Float, Float>> = when (count) {
        0 -> emptyList()
        1 -> listOf(0f to 0f)
        2 -> listOf(-0.13f to -0.13f, 0.13f to 0.13f)
        3 -> listOf(0f to -0.15f, -0.14f to 0.13f, 0.14f to 0.13f)
        else -> (0 until count).map { index ->
            val angle = (Math.PI * 2 * index / count) - Math.PI / 4
            val distance = 0.18f
            (kotlin.math.cos(angle) * distance).toFloat() to (kotlin.math.sin(angle) * distance).toFloat()
        }
    }
}

private fun <T : Node> T.nonInteractive(): T = apply {
    isHittable = false
    isTouchable = false
    isEditable = false
    if (this is RenderableNode) {
        isShadowCaster = true
        isShadowReceiver = true
    }
}
