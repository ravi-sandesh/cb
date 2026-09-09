package com.chokabarah.game.engine

// ============================================================
// ChokaBarah – Engine state snapshots
// ------------------------------------------------------------
// A GameSnapshot is a complete, immutable copy of everything a
// GameEngine needs to resume a match exactly where it left off:
// seats, pawns, capture flags, toughened cells, the pending roll
// and the winner.
//
// The engine's `validMoves` list is intentionally NOT part of the
// snapshot: it is fully derivable from (pawns, current player,
// pending roll score), so recomputing it on restore keeps the
// format small AND guarantees restored games can never carry
// stale/illegal move options.
//
// GameSnapshotCodec converts a snapshot to/from a compact string
// so the Android app can park it in SavedStateHandle (process
// death) with zero serialization dependencies. The codec is pure
// Kotlin: only ints, enum ordinals and 0/1 flags are encoded, so
// no escaping is needed.
// ============================================================

// One pawn's persistent identity + position. playerIndex is not stored:
// pawn ids are assigned as id = playerIndex * 4 + n by resetGame(), so it
// is always recoverable as id / 4 and validated against that invariant.
data class PawnSnapshot(
    val id: Int,
    val state: PawnState,
    val pathIndex: Int
)

// The pending cowry roll. Only the shell pattern is stored; score,
// extra-roll flag and display label are re-derived through scoreShells()
// so a corrupted roll can never smuggle in an impossible score.
data class RollSnapshot(
    val shells: List<Boolean>
)

data class GameSnapshot(
    val currentPlayerIndex: Int,
    // Which player the pending roll belongs to (BUG-10 semantics); -1 = none.
    val rollActorIndex: Int,
    // Index into playerColors of the winner; -1 while the game runs.
    val winnerIndex: Int,
    val pawns: List<PawnSnapshot>,
    val hasCapturedOpponent: Map<Int, Boolean>,
    // Cells holding toughened pairs, per player seat.
    val toughened: Map<Int, List<Int>>,
    val currentRoll: RollSnapshot?
)

object GameSnapshotCodec {

    private const val HEADER = "CBENGINE2"
    private const val SEP = "|"

    fun encode(snapshot: GameSnapshot): String {
        val captured = snapshot.hasCapturedOpponent.entries
            .sortedBy { it.key }
            .joinToString(",") { "${it.key}=${if (it.value) 1 else 0}" }
        val tough = snapshot.toughened.entries
            .sortedBy { it.key }
            .joinToString(";") { (seat, cells) -> "$seat:${cells.sorted().joinToString(",")}" }
        val pawns = snapshot.pawns
            .joinToString(";") { "${it.id}:${it.state.ordinal}:${it.pathIndex}" }
        val roll = snapshot.currentRoll?.shells?.joinToString("") { if (it) "1" else "0" } ?: "-"
        return listOf(
            HEADER,
            snapshot.currentPlayerIndex.toString(),
            snapshot.rollActorIndex.toString(),
            snapshot.winnerIndex.toString(),
            captured,
            tough,
            pawns,
            roll
        ).joinToString(SEP)
    }

    /** @throws IllegalArgumentException on any malformed input. */
    fun decode(text: String): GameSnapshot {
        val parts = text.split(SEP)
        require(parts.size == 8 && parts[0] == HEADER) {
            "Bad snapshot header"
        }
        val currentPlayerIndex = parts[1].toIntStrict()
        val rollActorIndex = parts[2].toIntStrict()
        val winnerIndex = parts[3].toIntStrict()

        val captured = if (parts[4].isEmpty()) emptyMap() else parts[4]
            .split(",")
            .associate { entry ->
                val kv = entry.split("=")
                require(kv.size == 2) { "Bad captured entry '$entry'" }
                kv[0].toIntStrict() to (kv[1].toIntStrict() == 1)
            }

        val toughened: Map<Int, List<Int>> = if (parts[5].isEmpty()) {
            emptyMap()
        } else {
            parts[5].split(";").associate { entry ->
                val kv = entry.split(":")
                require(kv.size == 2) { "Bad toughened entry '$entry'" }
                val seat = kv[0].toIntStrict()
                val cells = if (kv[1].isEmpty()) {
                    emptyList()
                } else {
                    kv[1].split(",").map {
                        require(it.isNotEmpty()) { "Bad toughened cell in '$entry'" }
                        it.toIntStrict()
                    }
                }
                seat to cells
            }
        }

        val pawns = parts[6].split(";").map { token ->
            val fields = token.split(":")
            require(fields.size == 3) { "Bad pawn token '$token'" }
            val stateOrdinal = fields[1].toIntStrict()
            require(stateOrdinal in PawnState.entries.indices) { "Bad pawn state $stateOrdinal" }
            PawnSnapshot(fields[0].toIntStrict(), PawnState.entries[stateOrdinal], fields[2].toIntStrict())
        }
        require(pawns.isNotEmpty()) { "Snapshot has no pawns" }

        val roll = when (val raw = parts[7]) {
            "-" -> null
            else -> {
                require(raw.all { it == '0' || it == '1' }) { "Bad roll shells '$raw'" }
                require(raw.length == 4 || raw.length == 6) { "Bad shell count ${raw.length}" }
                RollSnapshot(raw.map { it == '1' })
            }
        }

        return GameSnapshot(
            currentPlayerIndex = currentPlayerIndex,
            rollActorIndex = rollActorIndex,
            winnerIndex = winnerIndex,
            pawns = pawns,
            hasCapturedOpponent = captured,
            toughened = toughened,
            currentRoll = roll
        )
    }

    private fun String.toIntStrict(): Int {
        val digits = if (startsWith("-")) substring(1) else this
        require(digits.isNotEmpty() && digits.all { it in '0'..'9' } && digits.length <= 3) {
            "Bad int token '$this'"
        }
        return toInt()
    }
}
