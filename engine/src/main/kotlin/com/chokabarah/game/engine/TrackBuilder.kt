package com.chokabarah.game.engine

object TrackBuilder {

    // Returns array of (row, col) coordinates for a player's path from start to center home
    fun getPlayerPath(gridSize: GridSize, playerIndex: Int): List<Pair<Int, Int>> {
        return if (gridSize == GridSize.FIVE_BY_FIVE) {
            get5x5PlayerPath(playerIndex)
        } else {
            get7x7PlayerPath(playerIndex)
        }
    }

    // Index of first inner path cell (the gate — must have a cut before entering)
    // 5x5: outer has 16 cells → inner gate is at index 16
    // 7x7: outer has 24 cells → inner gate is at index 24
    fun innerGateIndex(gridSize: GridSize): Int {
        return if (gridSize == GridSize.FIVE_BY_FIVE) 16 else 24
    }

    // Check if cell coordinate is a safe square ('X' / 'a' on official board)
    // Official 7x7 board layout from rollthedice.in:
    //   4 outer corners:         (0,0),(0,6),(6,0),(6,6)
    //   4 outer edge midpoints:  (0,3),(3,0),(3,6),(6,3)  ← player home squares
    //   4 inner DIAGONAL squares: (1,1),(1,5),(5,1),(5,5) ← × pattern NOT + pattern
    //   Center home:             (3,3)
    fun isSafeCell(gridSize: GridSize, row: Int, col: Int): Boolean {
        if (gridSize == GridSize.FIVE_BY_FIVE) {
            return (row == 4 && col == 2) || // South home
                    (row == 0 && col == 2) || // North home
                    (row == 2 && col == 4) || // East home
                    (row == 2 && col == 0) || // West home
                    (row == 2 && col == 2)    // Center Home
        } else {
            // 4 outer corners
            return (row == 0 && col == 0) ||
                    (row == 0 && col == 6) ||
                    (row == 6 && col == 0) ||
                    (row == 6 && col == 6) ||
                    // 4 outer edge midpoints (player homes)
                    (row == 6 && col == 3) ||
                    (row == 0 && col == 3) ||
                    (row == 3 && col == 6) ||
                    (row == 3 && col == 0) ||
                    // 4 inner DIAGONAL safe squares (× pattern, corrected)
                    (row == 1 && col == 1) ||
                    (row == 1 && col == 5) ||
                    (row == 5 && col == 1) ||
                    (row == 5 && col == 5) ||
                    // Center Home
                    (row == 3 && col == 3)
        }
    }

    // 5x5 Full Outer Loop counter-clockwise (16 cells)
    private val outer5x5Loop = listOf(
        Pair(4, 2), Pair(4, 3), Pair(4, 4), Pair(3, 4), Pair(2, 4), Pair(1, 4), Pair(0, 4), Pair(0, 3),
        Pair(0, 2), Pair(0, 1), Pair(0, 0), Pair(1, 0), Pair(2, 0), Pair(3, 0), Pair(4, 0), Pair(4, 1)
    )

    // 5x5 Inner Loop (8 cells) + Center Home (1 cell)
    private val inner5x5Loop = listOf(
        Pair(3, 1), Pair(3, 2), Pair(3, 3), Pair(2, 3), Pair(1, 3), Pair(1, 2), Pair(1, 1), Pair(2, 1),
        Pair(2, 2) // Center Home
    )

    private fun get5x5PlayerPath(playerIndex: Int): List<Pair<Int, Int>> {
        // Offset starting cell based on player (0: South, 1: North, 2: East, 3: West)
        val startOffset = when (playerIndex) {
            0 -> 0   // (4,2)
            1 -> 8   // (0,2)
            2 -> 4   // (2,4)
            3 -> 12  // (2,0)
            else -> 0
        }

        val rotatedOuter = ArrayList<Pair<Int, Int>>()
        for (i in 0 until 16) {
            rotatedOuter.add(outer5x5Loop[(startOffset + i) % 16])
        }

        return rotatedOuter + inner5x5Loop
    }

    // 7x7 Outer Loop counter-clockwise (24 cells)
    private val outer7x7Loop = listOf(
        Pair(6, 3), Pair(6, 4), Pair(6, 5), Pair(6, 6), Pair(5, 6), Pair(4, 6), Pair(3, 6), Pair(2, 6), Pair(1, 6), Pair(0, 6),
        Pair(0, 5), Pair(0, 4), Pair(0, 3), Pair(0, 2), Pair(0, 1), Pair(0, 0), Pair(1, 0), Pair(2, 0), Pair(3, 0), Pair(4, 0),
        Pair(5, 0), Pair(6, 0), Pair(6, 1), Pair(6, 2)
    )

    // 7x7 Middle Loop (16 cells) + Inner Loop (8 cells) + Center Home (1 cell)
    private val inner7x7Loop = listOf(
        Pair(5, 2), Pair(5, 3), Pair(5, 4), Pair(5, 5), Pair(4, 5), Pair(3, 5), Pair(2, 5), Pair(1, 5),
        Pair(1, 4), Pair(1, 3), Pair(1, 2), Pair(1, 1), Pair(2, 1), Pair(3, 1), Pair(4, 1), Pair(5, 1),
        Pair(4, 2), Pair(4, 3), Pair(4, 4), Pair(3, 4), Pair(2, 4), Pair(2, 3), Pair(2, 2), Pair(3, 2),
        Pair(3, 3) // Center Home
    )

    private fun get7x7PlayerPath(playerIndex: Int): List<Pair<Int, Int>> {
        val startOffset = when (playerIndex) {
            0 -> 0   // (6,3)
            1 -> 12  // (0,3)
            2 -> 6   // (3,6)
            3 -> 18  // (3,0)
            else -> 0
        }

        val rotatedOuter = ArrayList<Pair<Int, Int>>()
        for (i in 0 until 24) {
            rotatedOuter.add(outer7x7Loop[(startOffset + i) % 24])
        }

        return rotatedOuter + inner7x7Loop
    }
}
