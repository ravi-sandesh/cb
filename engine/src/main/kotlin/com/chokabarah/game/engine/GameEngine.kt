package com.chokabarah.game.engine

import com.chokabarah.game.telemetry.Telemetry
import kotlin.random.Random

data class MoveOption(
    val grpPawns: List<Pawn>,         // All pawns moving (1 or 2 if Gatti)
    val targetPathIndex: Int,
    val targetCoords: Pair<Int, Int>,
    val isCapture: Boolean,
    val reachesHome: Boolean,
    val isGattiGroup: Boolean
)

data class CowryResult(
    val shells: List<Boolean>,   // true = Mouth UP
    val score: Int,              // actual move value
    val isExtraRoll: Boolean,    // true if Chowka or Baara
    val label: String            // display text
)

// Pure cowry-scoring rule surface. Board type is implied by shell count
// (5x5 plays 4 shells, 7x7 plays 6). Kept top-level so the same logic is
// exercised by both the engine and the JS<->Kotlin parity tests.
fun scoreShells(shells: List<Boolean>): CowryResult {
    require(shells.size == 4 || shells.size == 6) {
        "Expected 4 (5x5) or 6 (7x7) shells, got ${shells.size}"
    }
    val mouthUpCount = shells.count { it }
    val isFive = shells.size == 4

    // Scoring per official rules:
    // 5-house: 4 shells. 0 mouths = 8 (Baara), 4 mouths = 4 (Chowka). Else = count.
    // 7-house: 6 shells. 0 mouths = 12 (Baara), 6 mouths = 6 (Chowka). Else = count.
    val score: Int
    val label: String
    if (isFive) {
        score = when (mouthUpCount) {
            0    -> 8
            4    -> 4
            else -> mouthUpCount
        }
        label = when (score) {
            4    -> "CHOWKA (4) — EXTRA ROLL!"
            8    -> "BAARA (8) — EXTRA ROLL!"
            else -> "Score: $score"
        }
    } else {
        score = when (mouthUpCount) {
            0    -> 12
            6    -> 6
            else -> mouthUpCount
        }
        label = when (score) {
            6    -> "CHOWKA (6) — EXTRA ROLL!"
            12   -> "BAARA (12) — EXTRA ROLL!"
            else -> "Score: $score"
        }
    }
    val isExtra = if (isFive) (score == 4 || score == 8) else (score == 6 || score == 12)

    return CowryResult(shells, score, isExtra, label)
}

// Pure move-calculation rule surface, mirroring web/game-engine.js
// calculateValidMoves. Deterministic — no RNG, no engine state mutation —
// so the JS and Kotlin engines can be differentially tested against a
// shared corpus. Behavior is identical to the original engine method:
// Gatti grouping, home-base entry, gate enforcement, safe/capture/Gatti
// resolution. Move order mirrors the JS engine: numeric (pathIndex) groups
// ascend first, then HOME_* groups follow in insertion order.
fun calculateValidMoves(
    gridSize: GridSize,
    pawns: List<Pawn>,
    currentPlayerIndex: Int,
    hasCapturedOpponent: Map<Int, Boolean>,
    score: Int
): List<MoveOption> {
    val maxScore = if (gridSize == GridSize.FIVE_BY_FIVE) 8 else 12
    if (score !in 1..maxScore) return emptyList()

    val path      = TrackBuilder.getPlayerPath(gridSize, currentPlayerIndex)
    val innerGate = TrackBuilder.innerGateIndex(gridSize)
    val hasInner  = hasCapturedOpponent[currentPlayerIndex] == true

    // Group current player's non-finished pawns by cell (Gatti groups)
    val myPawns = pawns.filter {
        it.playerIndex == currentPlayerIndex && it.state != PawnState.FINISHED
    }

    val groups = LinkedHashMap<String, MutableList<Pawn>>()
    myPawns.forEach { pawn ->
        // NOTE: Each HOME_BASE pawn is its OWN movable group. A roll brings exactly ONE
        // pawn into play — never all pawns still in the base together (that would wrongly
        // form an impossible all-home Gatti unit). The id suffix keeps them distinct.
        val key = if (pawn.state == PawnState.HOME_BASE) "HOME_${pawn.id}" else "${pawn.pathIndex}"
        groups.getOrPut(key) { mutableListOf() }.add(pawn)
    }

    // Iterate keys in the same order the JS engine does (Object.values over the
    // group map): numeric (pathIndex) keys ascend numerically first, non-numeric
    // (HOME_*) keys follow in insertion order. Keeps JS/Kotlin move ordering identical.
    val orderedKeys =
        groups.keys.filter { it.toIntOrNull() != null }.sortedBy { it.toInt() } +
        groups.keys.filter { it.toIntOrNull() == null }

    val moves = mutableListOf<MoveOption>()

    orderedKeys.forEach { key ->
        val grp = groups.getValue(key)
        val isHome = key.startsWith("HOME")
        val curIdx = if (isHome) -1 else key.toInt()
        // A home pawn enters the track at its starting cell (index 0) and then advances
        // the remaining (roll-1) steps → lands at path[score - 1].
        val nextIdx = if (isHome) score - 1 else curIdx + score

        if (nextIdx < 0 || nextIdx >= path.size) {
            Telemetry.trace("engine", "move.overshoot_skipped",
                "Group at idx $curIdx + $score overshoots path (len ${path.size})",
                mapOf(
                    "pawnIds" to grp.map { it.id },
                    "curIdx" to curIdx,
                    "score" to score,
                    "nextIdx" to nextIdx,
                    "reason" to "overshoot"
                )
            )
            return@forEach
        }
        // Cannot enter the inner (gate) region until the player has made a cut:
        // the gate index (16 for 5x5, 24 for 7x7) is the entry to the inner loop
        // of the track. Only a successful capture flips hasCapturedOpponent (see
        // executeMove) — with `hasInner == false` every candidate that would land
        // on or past the gate is dropped here, so players can never shortcut the
        // center before earning the cut with an opponent's pawn.
        if (!hasInner && nextIdx >= innerGate) {
            Telemetry.trace("engine", "move.gate_blocked",
                "Group cannot enter inner path (no cut yet)",
                mapOf(
                    "pawnIds" to grp.map { it.id },
                    "nextIdx" to nextIdx,
                    "innerGate" to innerGate,
                    "reason" to "gate"
                )
            )
            return@forEach
        }

        val target = path[nextIdx]
        val isSafe = TrackBuilder.isSafeCell(gridSize, target.first, target.second)
        val reachesHome = (nextIdx == path.size - 1)

        // Find pawns at target cell
        val atTarget = pawns.filter { p ->
            p.state == PawnState.ON_TRACK &&
            TrackBuilder.getPlayerPath(gridSize, p.playerIndex).getOrNull(p.pathIndex) == target
        }
        val opponents = atTarget.filter { it.playerIndex != currentPlayerIndex }

        val opponentGatti = opponents.groupBy { it.playerIndex }.any { (_, list) -> list.size >= 2 }
        val myGroupIsGatti = grp.size >= 2

        var isCapture = false
        var blocked   = false

        if (opponents.isNotEmpty()) {
            when {
                isSafe -> {
                    // Safe square: everyone coexists, no capture
                    isCapture = false
                    blocked = false
                }
                opponentGatti -> {
                    // Opponent has a Gatti (2+ pawns) — CANNOT BE CAPTURED BY ANYONE
                    // Not even by another Gatti. This is the traditional rule.
                    blocked = true
                    Telemetry.trace("engine", "move.gatti_blocked",
                        "Target is an opponent Gatti; cannot capture",
                        mapOf(
                            "pawnIds" to grp.map { it.id },
                            "targetCoords" to listOf(target.first, target.second),
                            "opponentCount" to opponents.size,
                            "reason" to "opponent_gatti"
                        )
                    )
                }
                else -> {
                    // Normal capture (single opponent pawn)
                    isCapture = true
                }
            }
        }

        if (blocked) return@forEach

        moves.add(
            MoveOption(
                grpPawns       = grp,
                targetPathIndex = nextIdx,
                targetCoords   = target,
                isCapture      = isCapture,
                reachesHome    = reachesHome,
                isGattiGroup   = myGroupIsGatti
            )
        )
    }

    return moves
}

class GameEngine(
    val gridSize: GridSize = GridSize.FIVE_BY_FIVE,
    val playerColors: List<PlayerColor> = listOf(PlayerColor.RED, PlayerColor.GREEN)
) {
    var currentPlayerIndex: Int = 0
        private set

    val pawns: MutableList<Pawn> = mutableListOf()
    val hasCapturedOpponent: MutableMap<Int, Boolean> = mutableMapOf()

    var currentRoll: CowryResult? = null
        private set

    var validMoves: List<MoveOption> = emptyList()
        private set

    // Which player's turn the pending roll belongs to. rollCowries() may only
    // auto-clear / re-roll / resurrect a pending roll for the SAME acting
    // player; a roll left over from a different actor is orphaned state and
    // must be discarded before a fresh roll (BUG-10).
    private var rollActor: Int = -1

    var winner: PlayerColor? = null
        private set

    var gameLogMessage: String = ""

    // Official: 5-house uses 4 cowries, 7-house uses 6 cowries
    val numCowries: Int get() = if (gridSize == GridSize.FIVE_BY_FIVE) 4 else 6

    init {
        require(playerColors.size in 2..4) { "Player count must be 2..4, got ${playerColors.size}" }
        resetGame()
    }

    fun resetGame() {
        pawns.clear()
        hasCapturedOpponent.clear()
        for (pIndex in playerColors.indices) {
            hasCapturedOpponent[pIndex] = false
            for (pawnId in 0 until 4) {
                pawns.add(Pawn(id = pIndex * 4 + pawnId, playerIndex = pIndex))
            }
        }
        currentPlayerIndex = 0
        currentRoll = null
        rollActor = -1
        validMoves = emptyList()
        winner = null
        gameLogMessage = "Player ${playerColors[0].displayName}'s turn! Roll cowries."
        Telemetry.info("engine", "state.reset", "Game state reset",
            stateContext(gridSize, playerColors.size, currentPlayerIndex, null, validMoves.size, winner, hasCapturedOpponent))
    }

    fun rollCowries(): CowryResult {
        val spanId = Telemetry.startSpan("roll", mapOf("player" to currentPlayerIndex))
        // A pending roll only belongs to the player whose turn produced it
        // (BUG-10). If the acting turn changed, an existing roll is orphaned
        // state from a previous actor and must be discarded — it must NEVER be
        // auto-cleared-as-fresh, re-rolled for, or returned to a new actor.
        if (currentRoll != null && rollActor != -1 && rollActor != currentPlayerIndex) {
            Telemetry.warn("engine", "roll.orphaned_discarded",
                "Discarding pending roll from a different player's turn",
                mapOf("player" to currentPlayerIndex, "rollActor" to rollActor))
            currentRoll = null
            validMoves = emptyList()
            rollActor = -1
        }

        // If a previous extra-roll had no moves, currentRoll would still be set.
        // Clear it so a fresh roll can happen (only for the SAME acting turn,
        // which the guard above guarantees).
        if (currentRoll != null && validMoves.isEmpty()) {
            Telemetry.debug("engine", "roll.stale_cleared", "Stale roll (no moves) cleared before fresh roll",
                mapOf("player" to currentPlayerIndex))
            currentRoll = null
            rollActor = -1
        } else if (currentRoll != null) {
            // Normal case: a roll is already pending (shouldn't call rollCowries again)
            Telemetry.warn("engine", "roll.ignored", "Roll requested while a roll is already pending",
                mapOf("player" to currentPlayerIndex))
            Telemetry.endSpan(spanId, mapOf("outcome" to "ignored"))
            return currentRoll!!
        }

        val shells = List(numCowries) { Random.nextBoolean() }
        val scoreShell = scoreShells(shells)
        val score = scoreShell.score
        val label = scoreShell.label
        val isExtra = scoreShell.isExtraRoll

        // Re-wrap the pure result so currentRoll carries the same shape as before
        // the scoreShells extraction.
        val rolled = CowryResult(shells, score, isExtra, label)
        currentRoll = rolled
        rollActor = currentPlayerIndex

        Telemetry.info("dice", "dice.rolled", "Player $currentPlayerIndex rolled score $score",
            mapOf(
                "playerIndex" to currentPlayerIndex,
                "shells" to shells,
                "mouthUp" to shells.count { it },
                "score" to score,
                "isExtraRoll" to isExtra,
                "gridSize" to gridSize.columns,
                "numCowries" to numCowries
            )
        )

        calculateValidMoves(score)

        Telemetry.debug("engine", "moves.computed", "Computed ${validMoves.size} valid moves",
            mapOf(
                "playerIndex" to currentPlayerIndex,
                "score" to score,
                "validMoveCount" to validMoves.size,
                "moveTargets" to validMoves.map { moveContext(it) }
            )
        )

        // Preserve the "No valid moves" outcome in the game log. advanceTurn()
        // overwrites the banner, so (for non-extra rolls) restore the
        // informational message AFTER the turn passes (BUG-13).
        if (validMoves.isEmpty()) {
            val rollOwner = playerColors[currentPlayerIndex].displayName
            val noMovesMessage = "$rollOwner rolled $label — No valid moves!"
            Telemetry.info("engine", "roll.no_valid_moves", "Player $currentPlayerIndex rolled $score with no valid moves",
                mapOf("playerIndex" to currentPlayerIndex, "score" to score, "isExtraRoll" to isExtra))
            if (!isExtra) {
                advanceTurn()
                gameLogMessage = noMovesMessage + " ${playerColors[currentPlayerIndex].displayName}'s turn! Roll cowries."
            } else {
                // Extra roll (Chowka/Baara) but no valid moves.
                // Clear currentRoll so the player/bot can roll again.
                // The roll result is kept in 'rolled' for display, but we mark it consumed.
                currentRoll = null
                rollActor = -1
                gameLogMessage = noMovesMessage
                Telemetry.info("engine", "roll.extra_no_moves_reset", "Extra roll had no moves; roll reset for re-roll",
                    mapOf("playerIndex" to currentPlayerIndex))
            }
        } else {
            gameLogMessage = "${playerColors[currentPlayerIndex].displayName} rolled $label! Select a pawn."
        }

        Telemetry.endSpan(spanId, mapOf("outcome" to "applied", "score" to score, "validMoveCount" to validMoves.size))
        return rolled
    }

    // =========================================================
    // MOVE CALCULATION — Gatti aware, home-base safe, gate enforced
    // =========================================================
    // Stateful wrapper: validates the roll value (with telemetry), then
    // delegates the pure rule computation to the top-level calculateValidMoves
    // so the SAME logic can be differentially tested against the JS engine.
    private fun calculateValidMoves(rollValue: Int) {
        if (!validateScore(rollValue)) {
            Telemetry.warn("engine", "move.invalid_score", "calculateValidMoves rejected: invalid score",
                mapOf("score" to rollValue, "gridSize" to gridSize.columns))
            validMoves = emptyList()
            return
        }
        validMoves = calculateValidMoves(
            gridSize,
            pawns,
            currentPlayerIndex,
            hasCapturedOpponent,
            score = rollValue
        )
    }

    // ---- Input validation helpers ----
    private fun validateMove(move: MoveOption): Boolean {
        return move.grpPawns.isNotEmpty()
            && move.targetPathIndex >= 0
            && move.targetCoords.first >= 0 && move.targetCoords.second >= 0
    }

    private fun validateScore(score: Int): Boolean {
        val maxScore = if (gridSize == GridSize.FIVE_BY_FIVE) 8 else 12
        return score in 1..maxScore
    }

    fun executeMove(move: MoveOption?): Boolean {
        if (move == null || !validateMove(move)) {
            Telemetry.warn("engine", "move.invalid_input", "executeMove rejected: invalid MoveOption",
                mapOf("move" to move?.toString()))
            return false
        }
        val spanId = Telemetry.startSpan("move", mapOf(
            "player" to currentPlayerIndex,
            "target" to listOf(move.targetCoords.first, move.targetCoords.second)
        ))
        val target  = move.targetCoords
        val isSafe  = TrackBuilder.isSafeCell(gridSize, target.first, target.second)

        Telemetry.debug("engine", "move.start", "Executing move",
            mapOf(
                "pawnIds" to move.grpPawns.map { it.id },
                "targetPathIndex" to move.targetPathIndex,
                "targetCoords" to listOf(target.first, target.second),
                "isCapture" to move.isCapture,
                "reachesHome" to move.reachesHome,
                "isSafe" to isSafe
            )
        )

        // Move all pawns in group
        move.grpPawns.forEach { pawn ->
            pawn.state     = if (move.reachesHome) PawnState.FINISHED else PawnState.ON_TRACK
            pawn.pathIndex = move.targetPathIndex
        }

        var extraTurn = currentRoll?.isExtraRoll == true
        var gattiFormed = false

        // Handle capture
        if (move.isCapture && !isSafe) {
            val captured = pawns.filter { p ->
                p.playerIndex != currentPlayerIndex &&
                p.state == PawnState.ON_TRACK &&
                TrackBuilder.getPlayerPath(gridSize, p.playerIndex).getOrNull(p.pathIndex) == target
            }
            captured.forEach { c ->
                c.state     = PawnState.HOME_BASE
                c.pathIndex = -1
            }
            hasCapturedOpponent[currentPlayerIndex] = true
            extraTurn = true
            gameLogMessage = "✂️ CUT! Opponent pawn captured. Inner path unlocked! Extra turn!"
            Telemetry.info("engine", "move.capture", "Player $currentPlayerIndex captured ${captured.size} opponent pawns",
                mapOf(
                    "byPlayer" to currentPlayerIndex,
                    "capturedIds" to captured.map { it.id },
                    "targetCoords" to listOf(target.first, target.second)
                )
            )
        }

        // Check for Gatti formation at the destination after move.
        // Announce only when this move SURPASSES the moving group: the landed pawns
        // must exceed the mover count (pre-existing own pawns sharing the cell).
        //  - BUG-02: a pre-existing Gatti repositioning alone does NOT re-announce.
        //  - BUG-03: a capture onto a cell holding our own pawn still forms a Gatti.
        //  - EC-16 : a moving Gatti landing on our own single pawn grows to size 3.
        val nowAtDest = pawns.filter {
            it.playerIndex == currentPlayerIndex &&
            it.state == PawnState.ON_TRACK &&
            it.pathIndex == move.targetPathIndex
        }
        if (nowAtDest.size >= 2 && nowAtDest.size > move.grpPawns.size) {
            gattiFormed = true
            gameLogMessage = "🔗 GATTI! Your pawns are toughened at this square!"
            Telemetry.info("engine", "move.gatti_formed", "Player $currentPlayerIndex formed a Gatti",
                mapOf(
                    "byPlayer" to currentPlayerIndex,
                    "targetCoords" to listOf(target.first, target.second),
                    "count" to nowAtDest.size,
                    "pawnIds" to nowAtDest.map { it.id }
                )
            )
        }

        // Victory check
        val allDone = pawns.filter { it.playerIndex == currentPlayerIndex }.all { it.state == PawnState.FINISHED }
        if (allDone) {
            winner = playerColors[currentPlayerIndex]
            // Preserve Gatti message if it was just formed on the winning move
            if (gattiFormed) {
                gameLogMessage += "\n🎉 VICTORY! ${winner?.displayName} wins!"
            } else {
                gameLogMessage = "🎉 VICTORY! ${winner?.displayName} wins!"
            }
            // The winning move consumed the roll; never let the stale roll or
            // its move options leak into the next game/turn (BUG-09).
            currentRoll = null
            rollActor = -1
            validMoves = emptyList()
            Telemetry.info("game", "game.victory", "Player $currentPlayerIndex (${winner?.displayName}) won the game",
                mapOf(
                    "winnerIndex" to currentPlayerIndex,
                    "winnerName" to winner?.displayName,
                    "gridSize" to gridSize.columns,
                    "hasCaptured" to hasCapturedOpponent[currentPlayerIndex]
                )
            )
            Telemetry.endSpan(spanId, mapOf("outcome" to "victory", "reachesHome" to true, "gattiFormed" to gattiFormed))
            return true
        }

        currentRoll = null
        rollActor = -1
        validMoves  = emptyList()

        if (!extraTurn) {
            advanceTurn()
        } else {
            gameLogMessage += " 🎲 Extra roll!"
            Telemetry.debug("engine", "turn.extra", "Player $currentPlayerIndex gets an extra turn",
                mapOf("playerIndex" to currentPlayerIndex, "reason" to if (move.isCapture) "capture" else "score"))
        }

        Telemetry.endSpan(spanId, mapOf("outcome" to "applied", "extraTurn" to extraTurn, "gattiFormed" to gattiFormed))
        return true
    }

    fun advanceTurn() {
        val from = currentPlayerIndex
        currentPlayerIndex = (currentPlayerIndex + 1) % playerColors.size
        currentRoll        = null
        rollActor          = -1
        validMoves         = emptyList()
        gameLogMessage     = "Player ${playerColors[currentPlayerIndex].displayName}'s turn! Roll cowries."
        Telemetry.info("engine", "turn.advanced", "Turn advanced from player $from to player $currentPlayerIndex",
            mapOf("from" to from, "to" to currentPlayerIndex, "playerCount" to playerColors.size))
    }

    // AI Bot Strategy — capture > reach home > safe > Gatti advance > furthest
    fun getBestBotMove(): MoveOption? {
        if (validMoves.isEmpty()) return null
        val best = validMoves.firstOrNull { it.isCapture }
            ?: validMoves.firstOrNull { it.reachesHome }
            ?: validMoves.firstOrNull { TrackBuilder.isSafeCell(gridSize, it.targetCoords.first, it.targetCoords.second) }
            ?: validMoves.firstOrNull { it.isGattiGroup }
            ?: validMoves.maxByOrNull { it.grpPawns[0].pathIndex }

        Telemetry.debug("bot", "bot.move_selected", "Bot selected a move",
            mapOf(
                "playerIndex" to currentPlayerIndex,
                "chosenMove" to best?.let { moveContext(it) },
                "candidateCount" to validMoves.size
            )
        )
        return best
    }

    // ---- Telemetry context serializers ----
    private fun stateContext(
        gridSize: GridSize,
        playerCount: Int,
        currentPlayerIndex: Int,
        currentRoll: CowryResult?,
        validMoveCount: Int,
        winner: PlayerColor?,
        hasCaptured: Map<Int, Boolean>
    ): Map<String, Any?> {
        return mapOf(
            "gridSize" to gridSize.columns,
            "playerCount" to playerCount,
            "currentPlayerIndex" to currentPlayerIndex,
            "currentRoll" to currentRoll?.let {
                mapOf("score" to it.score, "shells" to it.shells.map { b -> b })
            },
            "validMoveCount" to validMoveCount,
            "winner" to winner?.displayName,
            "hasCaptured" to hasCaptured
        )
    }

    private fun moveContext(m: MoveOption): Map<String, Any?> {
        return mapOf(
            "pawnIds" to m.grpPawns.map { it.id },
            "targetPathIndex" to m.targetPathIndex,
            "targetCoords" to listOf(m.targetCoords.first, m.targetCoords.second),
            "isCapture" to m.isCapture,
            "reachesHome" to m.reachesHome,
            "isGattiGroup" to m.isGattiGroup
        )
    }
}
