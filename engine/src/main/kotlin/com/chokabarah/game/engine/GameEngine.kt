package com.chokabarah.game.engine

import com.chokabarah.game.telemetry.Telemetry
import kotlin.random.Random

data class MoveOption(
    val grpPawns: List<Pawn>,         // All pawns moving (1 or 2 if Gatti)
    val targetPathIndex: Int,
    val targetCoords: Pair<Int, Int>,
    val isCapture: Boolean,
    val reachesHome: Boolean,
    val isGattiGroup: Boolean,        // Moving group is a same-cell pair (tollu or toughened)
    val isToughened: Boolean = false, // ...and that pair is hardened
    val toughens: Boolean = false,    // ...this move hardens a tollu pair (exact 2)
    val capturesGatti: Boolean = false // ...this move takes a whole defender Gatti home
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
    score: Int,
    toughened: Map<Int, Set<Int>> = emptyMap()
): List<MoveOption> {
    // Only scores real dice can produce: 5-house {1,2,3,4,8} (Chowka 4,
    // Baara 8), 7-house {1,2,3,4,5,6,12} (Chowka 6, Baara 12). Anything else
    // is an injected roll and yields no moves.
    val legalScores = if (gridSize == GridSize.FIVE_BY_FIVE) {
        setOf(1, 2, 3, 4, 8)
    } else {
        setOf(1, 2, 3, 4, 5, 6, 12)
    }
    if (score !in legalScores) return emptyList()

    val path      = TrackBuilder.getPlayerPath(gridSize, currentPlayerIndex)
    val innerGate = TrackBuilder.innerGateIndex(gridSize, currentPlayerIndex)
    val hasInner  = hasCapturedOpponent[currentPlayerIndex] == true
    val toughCells = toughened[currentPlayerIndex] ?: emptySet()

    // Opponent TOUGHENED cells, keyed by board coordinate, for the blockade:
    // a non-toughened mover can neither pass through nor stop on one.
    val oppToughCoords = mutableSetOf<Pair<Int, Int>>()
    for (p in pawns) {
        if (p.playerIndex == currentPlayerIndex || p.state != PawnState.ON_TRACK) continue
        if ((toughened[p.playerIndex] ?: emptySet()).contains(p.pathIndex)) {
            TrackBuilder.getPlayerPath(gridSize, p.playerIndex).getOrNull(p.pathIndex)?.let { oppToughCoords.add(it) }
        }
    }

    // Group current player's non-finished pawns by cell — EXCEPT outer-track
    // pawns (pathIndex < gate), which move as vulnerable singles even when
    // stacked: Gatti is inner-only now, so an outer stack is never one unit.
    val myPawns = pawns.filter {
        it.playerIndex == currentPlayerIndex && it.state != PawnState.FINISHED
    }

    val groups = LinkedHashMap<String, MutableList<Pawn>>()
    myPawns.forEach { pawn ->
        // NOTE: Each HOME_BASE pawn is its OWN movable group. A roll brings exactly ONE
        // pawn into play — never all pawns still in the base together (that would wrongly
        // form an impossible all-home Gatti unit). The id suffix keeps them distinct.
        // Same for outer-track pawns (see above): singles, never a group.
        val key = if (pawn.state == PawnState.HOME_BASE || pawn.pathIndex < innerGate) "SINGLE_${pawn.id}" else "${pawn.pathIndex}"
        groups.getOrPut(key) { mutableListOf() }.add(pawn)
    }

    // Iterate keys in the same order the JS engine does (Object.values over the
    // group map): numeric (pathIndex) keys ascend numerically first, non-numeric
    // (SINGLE_*) keys follow in insertion order. Keeps JS/Kotlin move ordering identical.
    val orderedKeys =
        groups.keys.filter { it.toIntOrNull() != null }.sortedBy { it.toInt() } +
        groups.keys.filter { it.toIntOrNull() == null }

    val moves = mutableListOf<MoveOption>()

    orderedKeys.forEach { key ->
        val grp = groups.getValue(key)
        // HOME_BASE pawns carry pathIndex -1, so the first pawn's index is
        // the group's position (never parse the key: SINGLE_* is not numeric).
        val isHome = grp.all { it.state == PawnState.HOME_BASE }
        val curIdx = grp[0].pathIndex
        val isPair = grp.size >= 2
        // Inner pairs are tollu until toughened (a roll of 2 hardens them).
        // The flag alone is not enough: a lone single sitting on a stale
        // flagged cell moves as an ordinary single (no blockade pass).
        val moverToughened = !isHome && isPair && toughCells.contains(curIdx)
        val isTollu = isPair && !isHome && !moverToughened
        // Pairs move on even rolls only, together: tollu at half rate,
        // toughened at full rate. Odd rolls offer no pair move at all.
        if (isPair && !isHome && score % 2 != 0) {
            Telemetry.trace("engine", "move.pair_stuck",
                "Pair cannot move on odd score $score",
                mapOf(
                    "pawnIds" to grp.map { it.id },
                    "curIdx" to curIdx,
                    "score" to score,
                    "reason" to "pair-even-only"
                )
            )
            return@forEach
        }
        var step = score
        if (isTollu) step = score / 2
        // A home pawn entering the track moves `score` steps from the start
        // cell (path[0]) — same distance an on-track pawn covers from its
        // current position. With score=2, both land at path[2].
        val nextIdx = if (isHome) score else curIdx + step

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
        // the gate index (16 for 5x5, 24 for 7x7 except North's 23) is the
        // entry to the inner loop of the track. Only a successful capture
        // flips hasCapturedOpponent (see executeMove) — with `hasInner == false`
        // every candidate that would land on or past the gate is dropped here,
        // so players can never shortcut the center before earning the cut.
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

        // Blockade: a non-toughened mover can neither pass through nor stop
        // on an opponent's toughened cell. (A toughened mover passes freely;
        // landing capture immunity is enforced by the capture rules below.)
        if (!moverToughened) {
            val from = if (isHome) 1 else curIdx + 1
            var blockedPass = false
            for (ii in from until nextIdx) {
                val cell = path.getOrNull(ii)
                if (cell != null && oppToughCoords.contains(cell)) {
                    Telemetry.trace("engine", "move.blockade_blocked",
                        "Move crosses a toughened cell at path idx $ii",
                        mapOf(
                            "pawnIds" to grp.map { it.id },
                            "curIdx" to curIdx,
                            "nextIdx" to nextIdx,
                            "blockedIdx" to ii,
                            "reason" to "blockade"
                        )
                    )
                    blockedPass = true
                    break
                }
            }
            if (blockedPass) return@forEach
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

        // Opponent pairs at the target, grouped per player so the toughened
        // flag (stored per player + pathIndex) resolves correctly.
        val perPlayerLists = opponents.groupBy { it.playerIndex }
        // Only a TOUGHENED pair is immune: tollu pairs and stacked outer
        // singles are capturable (capture-one), matching the inner-only
        // Gatti rule. Safe squares still shelter everyone.
        val opponentToughened = perPlayerLists.any { (pi, list) ->
            list.size >= 2 && (toughened[pi] ?: emptySet()).contains(list[0].pathIndex)
        }
        val myGroupIsGatti = grp.size >= 2
        // A tollu pair moving on an exact 2 hardens into a TOUGHENED Gatti
        // at its destination (unless the destination is Center Home, where
        // the pair finishes instead of toughening).
        val toughens = isTollu && score == 2 && !reachesHome

        var isCapture = false
        var blocked   = false
        var capturesGatti = false

        if (opponents.isNotEmpty()) {
            when {
                isSafe -> {
                    // Safe square: everyone coexists, no capture
                    isCapture = false
                    blocked = false
                }
                opponentToughened -> {
                    if (moverToughened && myGroupIsGatti) {
                        // Gatti captures Gatti: a toughened pair landing on an
                        // opponent's toughened pair takes the WHOLE pair home.
                        isCapture = true
                        capturesGatti = true
                    } else {
                        // Tollu/singles cannot touch a toughened Gatti.
                        blocked = true
                        Telemetry.trace("engine", "move.gatti_blocked",
                            "Target is an opponent toughened Gatti; cannot capture",
                            mapOf(
                                "pawnIds" to grp.map { it.id },
                                "targetCoords" to listOf(target.first, target.second),
                                "opponentCount" to opponents.size,
                                "reason" to "opponent_gatti"
                            )
                        )
                    }
                }
                else -> {
                    // Normal capture (single opponent pawn, tollu pair or outer stack)
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
                isGattiGroup   = myGroupIsGatti,
                isToughened    = moverToughened && myGroupIsGatti,
                toughens       = toughens,
                capturesGatti  = capturesGatti
            )
        )
    }

    return moves
}

// Pure move-execution rule surface, mirroring web/game-engine.js
// executeMove. Observationally pure like calculateValidMoves: copies the
// pawn list and the capture-flag map, never touches caller state, and
// returns everything the stateful wrapper needs (including which pawn ids
// were captured so telemetry stays faithful). Kept top-level so JS and
// Kotlin are differentially tested against the shared parity corpus.
data class MoveExecutionResult(
    val pawns: List<Pawn>,
    val hasCapturedOpponent: Map<Int, Boolean>,
    val extraTurn: Boolean,
    val gattiFormed: Boolean,
    val capturedCount: Int,
    val capturedIds: List<Int>,
    // Index into playerColors of the winner; -1 while the game runs.
    val winnerIndex: Int,
    val reachesHome: Boolean,
    val error: String? = null,
    // Copy-on-write toughened map (same contract as hasCapturedOpponent).
    val toughened: Map<Int, Set<Int>> = emptyMap()
)

fun executeMovePure(
    gridSize: GridSize,
    pawns: List<Pawn>,
    hasCapturedOpponent: Map<Int, Boolean>,
    currentPlayerIndex: Int,
    move: MoveOption,
    currentRoll: CowryResult?,
    toughened: Map<Int, Set<Int>> = emptyMap()
): MoveExecutionResult {
    if (move.grpPawns.isEmpty()) return MoveExecutionResult(pawns, hasCapturedOpponent, false, false, 0, emptyList(), -1, false, "grpPawns empty")
    if (move.targetPathIndex < 0 || move.targetCoords.first < 0 || move.targetCoords.second < 0) {
        return MoveExecutionResult(pawns, hasCapturedOpponent, false, false, 0, emptyList(), -1, false, "invalid target")
    }

    // Copy-on-write inputs (JS BUG-17 observational-purity parity).
    val newPawns = pawns.map { it.copy() }
    val newHasCaptured = hasCapturedOpponent.toMutableMap()
    val newToughened = toughened.mapValues { (_, v) -> v.toMutableSet() }.toMutableMap()
    val grpIds = move.grpPawns.map { it.id }.toSet()

    newPawns.forEach { pawn ->
        if (pawn.id in grpIds) {
            pawn.state = if (move.reachesHome) PawnState.FINISHED else PawnState.ON_TRACK
            pawn.pathIndex = move.targetPathIndex
        }
    }

    var extraTurn = currentRoll?.isExtraRoll == true
    var gattiFormed = false
    var capturedCount = 0
    val capturedIds = mutableListOf<Int>()

    // Capture: normally capture-one (lowest id); a Gatti-vs-Gatti landing
    // takes the flagged defender pair(s) home. Flagged-pair members are
    // immune to non-Gatti captures even when the caller forged isCapture
    // onto their cell — and a forged capture with no actual victims mints
    // neither gate unlock nor extra turn (the move itself still applies).
    if (move.isCapture && !TrackBuilder.isSafeCell(gridSize, move.targetCoords.first, move.targetCoords.second)) {
        val victims = newPawns.filter { p ->
            p.playerIndex != currentPlayerIndex && p.state == PawnState.ON_TRACK &&
                TrackBuilder.getPlayerPath(gridSize, p.playerIndex).getOrNull(p.pathIndex) == move.targetCoords
        }.sortedBy { it.id }
        val byPlayer = victims.groupBy { it.playerIndex }
        val flaggedSeats = byPlayer.filter { (pi, list) ->
            list.size >= 2 && (newToughened[pi] ?: emptySet()).contains(list[0].pathIndex)
        }.keys
        val caught = if (move.capturesGatti) {
            val flagged = victims.filter { flaggedSeats.contains(it.playerIndex) }
            if (flagged.isNotEmpty()) flagged else victims.take(1)
        } else {
            victims.filter { !flaggedSeats.contains(it.playerIndex) }.take(1)
        }
        caught.forEach { p ->
            p.state = PawnState.HOME_BASE
            p.pathIndex = -1
            capturedCount++
            capturedIds.add(p.id)
        }
        if (caught.isNotEmpty()) {
            newHasCaptured[currentPlayerIndex] = true
            extraTurn = true
        }
    }

    // Toughening: a tollu pair arriving on a 2 hardens into a Gatti here.
    // (Home arrivals finish instead — the flag is never set for them, so a
    // pair finishing together does not announce a Gatti.)
    if (move.toughens && !move.reachesHome) {
        val cell = newToughened.getOrPut(currentPlayerIndex) { mutableSetOf() }
        cell.add(move.targetPathIndex)
        gattiFormed = true
    }

    // A hardened pair carries its flag to its destination (finishing pairs
    // excepted — FINISHED pawns hold no cells). The cleanup below drops the
    // vacated cell and keeps the new one.
    if (move.isToughened && !move.reachesHome) {
        newToughened.getOrPut(currentPlayerIndex) { mutableSetOf() }.add(move.targetPathIndex)
    }

    // Toughened-flag cleanup: a flag survives only while 2+ same-player
    // ON_TRACK pawns actually share the cell (moves, captures and finishes
    // could otherwise strand it and blockade the board forever).
    val stalePlayers = mutableListOf<Int>()
    for ((pi, cells) in newToughened) {
        cells.retainAll { idx ->
            newPawns.count { p -> p.playerIndex == pi && p.state == PawnState.ON_TRACK && p.pathIndex == idx } >= 2
        }
        if (cells.isEmpty()) stalePlayers.add(pi)
    }
    stalePlayers.forEach { newToughened.remove(it) }

    val mine = newPawns.filter { it.playerIndex == currentPlayerIndex }
    // Non-vacuous: all() on an empty list is true, which would crown a seat
    // with no pawns at all.
    val allDone = mine.isNotEmpty() && mine.all { it.state == PawnState.FINISHED }
    val winnerIndex = if (allDone) currentPlayerIndex else -1

    return MoveExecutionResult(
        pawns = newPawns,
        hasCapturedOpponent = newHasCaptured,
        extraTurn = extraTurn,
        gattiFormed = gattiFormed,
        capturedCount = capturedCount,
        capturedIds = capturedIds,
        winnerIndex = winnerIndex,
        reachesHome = move.reachesHome,
        toughened = newToughened
    )
}

class GameEngine(
    val gridSize: GridSize = GridSize.FIVE_BY_FIVE,
    val playerColors: List<PlayerColor> = listOf(PlayerColor.RED, PlayerColor.GREEN),
    // Injectable so tests can force deterministic rolls (e.g. Chowka chains).
    private val rng: Random = Random.Default
) {
    var currentPlayerIndex: Int = 0
        private set

    val pawns: MutableList<Pawn> = mutableListOf()
    val hasCapturedOpponent: MutableMap<Int, Boolean> = mutableMapOf()
    // Cells holding TOUGHENED (inner, roll-2-hardened) pairs, per player.
    // A flag lives only while 2+ same-player ON_TRACK pawns share the cell
    // (executeMovePure cleans up the rest); the blockade + immunity rules
    // read this map, never the raw pair layout.
    val toughenedCells: MutableMap<Int, MutableSet<Int>> = mutableMapOf()

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
        toughenedCells.clear()
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

    // =========================================================
    // STATE SNAPSHOTS — process-death / configuration-change survival
    // =========================================================

    /** A complete copy of the match state; see [restore]. */
    fun snapshot(): GameSnapshot = GameSnapshot(
        currentPlayerIndex = currentPlayerIndex,
        rollActorIndex = rollActor,
        winnerIndex = winner?.let { playerColors.indexOf(it) } ?: -1,
        pawns = pawns.map { PawnSnapshot(it.id, it.state, it.pathIndex) },
        hasCapturedOpponent = hasCapturedOpponent.toMap(),
        toughened = toughenedCells.mapValues { (_, v) -> v.toList() },
        currentRoll = currentRoll?.let { RollSnapshot(it.shells.toList()) }
    )

    /**
     * Rebuild this engine's state from a [GameSnapshot] produced by [snapshot]
     * of an engine with the SAME board size and seat count. Valid moves are
     * recomputed from the restored board (never trusted from the snapshot) and
     * the pending roll is re-scored through scoreShells(), so a tampered
     * snapshot can at worst produce a rejected restore — never illegal play.
     *
     * @return true when the snapshot was applied; false leaves this engine
     *         untouched so callers can fall back to a fresh game.
     */
    fun restore(snapshot: GameSnapshot): Boolean {
        // ---- Validate EVERYTHING before touching state so a rejected
        // snapshot truly leaves this engine untouched. ----
        val rebuilt = runCatching {
            require(snapshot.pawns.size == playerColors.size * 4) {
                "Pawn count mismatch: ${snapshot.pawns.size} for ${playerColors.size} players"
            }
            val pawns = snapshot.pawns.map { p ->
                require(p.id in 0 until playerColors.size * 4) { "Pawn id out of range: ${p.id}" }
                Pawn(id = p.id, playerIndex = p.id / 4, state = p.state, pathIndex = p.pathIndex)
            }
            require(snapshot.currentPlayerIndex in playerColors.indices) { "Bad current player ${snapshot.currentPlayerIndex}" }
            require(snapshot.rollActorIndex in -1..playerColors.lastIndex) { "Bad roll actor ${snapshot.rollActorIndex}" }
            require(snapshot.winnerIndex == -1 || snapshot.winnerIndex in playerColors.indices) {
                "Bad winner index ${snapshot.winnerIndex}"
            }
            // A declared winner must be CONSISTENT with the pawn states: every
            // pawn of that seat must be FINISHED. Anything else is an injected
            // impossible state (victory dialog over a live board).
            if (snapshot.winnerIndex != -1) {
                val allFinished = pawns.all {
                    it.playerIndex != snapshot.winnerIndex || it.state == PawnState.FINISHED
                }
                require(allFinished) { "Winner declared with unfinished pawns" }
            }
            // Pawn state/index consistency: HOME_BASE lives off-board (-1),
            // ON_TRACK lives on its seat's path, FINISHED sits exactly on the
            // center home. Anything else is corruption (or tampering) that
            // would otherwise create invisible or unhittable ghost pawns.
            // Inner-track presence additionally requires the gate flag: no
            // pawn can legally sit at/past the gate without a cut.
            for (p in pawns) {
                val last = TrackBuilder.getPlayerPath(gridSize, p.playerIndex).lastIndex
                when (p.state) {
                    PawnState.HOME_BASE -> require(p.pathIndex == -1) { "Home pawn off base index" }
                    PawnState.ON_TRACK -> require(p.pathIndex in 0..last) { "Track pawn out of range" }
                    PawnState.FINISHED -> require(p.pathIndex == last) { "Finished pawn off center" }
                }
                if (p.state == PawnState.ON_TRACK &&
                    p.pathIndex >= TrackBuilder.innerGateIndex(gridSize, p.playerIndex)
                ) {
                    require(snapshot.hasCapturedOpponent[p.playerIndex] == true) { "Inner pawn without cut" }
                }
            }
            val roll = snapshot.currentRoll?.let {
                require(it.shells.size == numCowries) { "Bad shell count ${it.shells.size}" }
                scoreShells(it.shells).let { res -> CowryResult(res.shells, res.score, res.isExtraRoll, res.label) }
            }
            // A pending roll and its actor travel together: a roll without an
            // actor (or vice versa) is an orphaned/impossible state that would
            // hand one player another seat's pending roll.
            require((roll == null) == (snapshot.rollActorIndex == -1)) { "Roll/actor mismatch" }
            // Toughened flags must reference live seats and non-negative
            // indices; anything else is an injected impossible state.
            val tough = snapshot.toughened.mapValues { (idx, cells) ->
                require(idx in playerColors.indices) { "Bad toughened seat $idx" }
                cells.toSet()
            }
            require(tough.values.all { cells -> cells.all { it >= 0 } }) { "Bad toughened index" }
            // ...and every flagged cell must actually hold a live pair there:
            // outer cells can never toughen (outer stacks are singles), and a
            // phantom or lonesome flag would otherwise inject a blockade.
            // The gate flag must also be set: no pair can sit inner without it.
            for ((seat, cells) in tough) {
                val gate = TrackBuilder.innerGateIndex(gridSize, seat)
                val last = TrackBuilder.getPlayerPath(gridSize, seat).lastIndex
                for (c in cells) {
                    require(c >= gate && c <= last) { "Toughened cell outside inner track" }
                    require(pawns.count { it.playerIndex == seat && it.state == PawnState.ON_TRACK && it.pathIndex == c } >= 2) {
                        "Toughened cell without a live pair"
                    }
                }
                if (cells.isNotEmpty()) {
                    require(snapshot.hasCapturedOpponent[seat] == true) { "Toughened pair without cut" }
                }
            }
            Triple(pawns, roll, tough)
        }.onFailure {
            Telemetry.warn("engine", "state.restore_failed", "Snapshot rejected; engine state left unchanged",
                mapOf("gridSize" to gridSize.columns, "playerCount" to playerColors.size))
        }.getOrNull() ?: return false

        val (restoredPawns, restoredRoll, restoredTough) = rebuilt
        // ---- Apply ----
        pawns.clear()
        pawns.addAll(restoredPawns)
        hasCapturedOpponent.clear()
        snapshot.hasCapturedOpponent.forEach { (idx, flag) ->
            if (idx in playerColors.indices) hasCapturedOpponent[idx] = flag
        }
        playerColors.indices.forEach { idx -> hasCapturedOpponent.putIfAbsent(idx, false) }
        toughenedCells.clear()
        restoredTough.forEach { (idx, cells) -> toughenedCells[idx] = cells.toMutableSet() }

        currentPlayerIndex = snapshot.currentPlayerIndex
        winner = if (snapshot.winnerIndex == -1) null else playerColors[snapshot.winnerIndex]
        currentRoll = if (winner != null) null else restoredRoll
        rollActor = if (currentRoll == null) -1 else snapshot.rollActorIndex
        validMoves = if (currentRoll == null) emptyList() else calculateValidMoves(
            gridSize, pawns, currentPlayerIndex, hasCapturedOpponent, currentRoll!!.score, toughenedCells
        )
        gameLogMessage = if (winner != null) {
            "\uD83C\uDF89 VICTORY! ${winner?.displayName} wins!"
        } else {
            "Player ${playerColors[currentPlayerIndex].displayName}'s turn! Roll cowries."
        }
        Telemetry.info("engine", "state.restored", "Game state restored from snapshot",
            stateContext(gridSize, playerColors.size, currentPlayerIndex, currentRoll, validMoves.size, winner, hasCapturedOpponent))
        return true
    }

    fun rollCowries(): CowryResult {
        // Terminal state: the match is over; no further rolls. Callers must
        // check winner first (all production flows do) — this guard keeps
        // direct/test callers from advancing a finished game.
        if (winner != null) {
            Telemetry.warn("engine", "roll.after_victory", "Roll requested after victory; ignored",
                mapOf("winner" to (winner?.displayName ?: "?")))
            return currentRoll ?: CowryResult(emptyList(), 0, false, "game-over")
        }
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

        val shells = List(numCowries) { rng.nextBoolean() }
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
            score = rollValue,
            toughened = toughenedCells
        )
    }

    // ---- Input validation helpers ----
    private fun validateMove(move: MoveOption): Boolean {
        return move.grpPawns.isNotEmpty()
            && move.targetPathIndex >= 0
            && move.targetCoords.first >= 0 && move.targetCoords.second >= 0
    }

    private fun validateScore(score: Int): Boolean {
        // Only scores real dice can produce: 5-house {1,2,3,4,8} (Chowka 4,
        // Baara 8), 7-house {1..6,12} (Chowka 6, Baara 12). Anything else is
        // an injected roll and yields no moves.
        if (gridSize == GridSize.FIVE_BY_FIVE) return score in setOf(1, 2, 3, 4, 8)
        return score in setOf(1, 2, 3, 4, 5, 6, 12)
    }

    fun executeMove(move: MoveOption?): Boolean {
        if (move == null || !validateMove(move)) {
            Telemetry.warn("engine", "move.invalid_input", "executeMove rejected: invalid MoveOption",
                mapOf("move" to move?.toString()))
            return false
        }
        // Terminal state: the match is over; moves must not apply. A second
        // finisher could otherwise overwrite the recorded winner.
        if (winner != null) {
            Telemetry.warn("engine", "move.after_victory", "Move requested after victory; ignored",
                mapOf("winner" to (winner?.displayName ?: "?")))
            return false
        }
        // Structural legality: the target must exist on the mover's own
        // track, agree with its coordinates, and reachesHome must mean the
        // last cell. Engine-built moves always satisfy this; anything else
        // is forged or stale and must not mutate state.
        val moverPath = TrackBuilder.getPlayerPath(gridSize, currentPlayerIndex)
        if (move.grpPawns.any { it.playerIndex != currentPlayerIndex } ||
            move.targetPathIndex >= moverPath.size ||
            moverPath.getOrNull(move.targetPathIndex) != move.targetCoords ||
            move.reachesHome != (move.targetPathIndex == moverPath.lastIndex)
        ) {
            Telemetry.warn("engine", "move.off_track", "executeMove rejected: target off mover track",
                mapOf("targetPathIndex" to move.targetPathIndex, "targetCoords" to move.targetCoords.toString()))
            return false
        }
        val spanId = Telemetry.startSpan("move", mapOf(
            "player" to currentPlayerIndex,
            "target" to listOf(move.targetCoords.first, move.targetCoords.second)
        ))
        val isSafe = TrackBuilder.isSafeCell(gridSize, move.targetCoords.first, move.targetCoords.second)

        Telemetry.debug("engine", "move.start", "Executing move",
            mapOf(
                "pawnIds" to move.grpPawns.map { it.id },
                "targetPathIndex" to move.targetPathIndex,
                "targetCoords" to listOf(move.targetCoords.first, move.targetCoords.second),
                "isCapture" to move.isCapture,
                "reachesHome" to move.reachesHome,
                "isSafe" to isSafe
            )
        )

        // All rule application lives in the PURE executeMovePure (parity with
        // web/game-engine.js); this wrapper only projects the result onto
        // engine state: telemetry spans, log messages, turn bookkeeping.
        val res = executeMovePure(gridSize, pawns.toList(), hasCapturedOpponent.toMap(), currentPlayerIndex, move, currentRoll, toughenedCells)

        pawns.clear()
        pawns.addAll(res.pawns)
        hasCapturedOpponent.clear()
        hasCapturedOpponent.putAll(res.hasCapturedOpponent)
        toughenedCells.clear()
        res.toughened.forEach { (idx, cells) -> toughenedCells[idx] = cells.toMutableSet() }

        if (res.capturedCount > 0) {
            gameLogMessage = "✂️ CUT! Opponent pawn captured. Inner path unlocked! Extra turn!"
            Telemetry.info("engine", "move.capture", "Player $currentPlayerIndex captured ${res.capturedCount} opponent pawns",
                mapOf(
                    "byPlayer" to currentPlayerIndex,
                    "capturedIds" to res.capturedIds,
                    "targetCoords" to listOf(move.targetCoords.first, move.targetCoords.second)
                )
            )
        }

        // Gatti announcement: ONLY the toughen transition (a tollu pair
        // hardening on an exact 2) is announced. Moving a pre-existing pair —
        // tollu or toughened — never re-announces (BUG-02), and merely joining
        // into a tollu pair stays silent until it hardens.
        if (res.gattiFormed) {
            val nowAtDest = res.pawns.filter {
                it.playerIndex == currentPlayerIndex &&
                it.state == PawnState.ON_TRACK &&
                it.pathIndex == move.targetPathIndex
            }
            gameLogMessage = "🔗 GATTI TOUGHENED! Your pawns are hardened at this square!"
            Telemetry.info("engine", "move.gatti_formed", "Player $currentPlayerIndex toughened a Gatti",
                mapOf(
                    "byPlayer" to currentPlayerIndex,
                    "targetCoords" to listOf(move.targetCoords.first, move.targetCoords.second),
                    "count" to nowAtDest.size,
                    "pawnIds" to nowAtDest.map { it.id }
                )
            )
        }

        // Victory check
        if (res.winnerIndex != -1) {
            winner = playerColors[res.winnerIndex]
            // Preserve Gatti message if it was just formed on the winning move
            if (res.gattiFormed) {
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
            Telemetry.endSpan(spanId, mapOf("outcome" to "victory", "reachesHome" to true, "gattiFormed" to res.gattiFormed))
            return true
        }

        currentRoll = null
        rollActor = -1
        validMoves  = emptyList()

        if (!res.extraTurn) {
            advanceTurn()
        } else {
            gameLogMessage += " 🎲 Extra roll!"
            Telemetry.debug("engine", "turn.extra", "Player $currentPlayerIndex gets an extra turn",
                mapOf("playerIndex" to currentPlayerIndex, "reason" to if (move.isCapture) "capture" else "score"))
        }

        Telemetry.endSpan(spanId, mapOf("outcome" to "applied", "extraTurn" to res.extraTurn, "gattiFormed" to res.gattiFormed))
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

    // AI Bot Strategy — Gatti-capture > capture > reach home > toughen > safe > Gatti > furthest.
    // Furthest compares DESTINATION path index (where the pawn lands), not
    // the start: a half-rate tollu starting ahead can land behind a single.
    fun getBestBotMove(): MoveOption? {
        if (validMoves.isEmpty()) return null
        val best = validMoves.firstOrNull { it.isCapture && it.capturesGatti }
            ?: validMoves.firstOrNull { it.isCapture }
            ?: validMoves.firstOrNull { it.reachesHome }
            ?: validMoves.firstOrNull { it.toughens }
            ?: validMoves.firstOrNull { TrackBuilder.isSafeCell(gridSize, it.targetCoords.first, it.targetCoords.second) }
            ?: validMoves.firstOrNull { it.isGattiGroup }
            ?: validMoves.maxByOrNull { it.targetPathIndex }

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
