# Choka Barah - Comprehensive Test Cases

> **Based on:** CHOWKA_BARA_RULES_DOCUMENTATION.md (27 User Stories, 42 Edge Cases)
> **Test Strategy:** Positive (Happy Path), Negative (Error/Invalid), Scale (Stress/Load/Boundary)
> **Platforms:** Android (Kotlin/JUnit/Espresso) + Web (Jest/Playwright)
> **Author:** Google Lead QA Engineer

---

## Rule-Change Notice (Tollu / Toughened Gatti + Per-Seat Inner Tracks)

The rows below were written for the old shared-path / any-cell-Gatti rules.
The implementation now follows the traditional rules below — where a row
below contradicts them, the rule here wins and the row is superseded as noted:

| Area | Old expectation | New rule (implemented + tested) |
|------|-----------------|----------------------------------|
| Inner paths | One shared inner run for all seats | Per-seat clockwise runs from each seat's own entry (block before home); 7×7 North turns in at (0,5): 48 cells, gate 23 |
| Gatti formation (TC-GAT-001/002/003/004/008) | Any same-cell pair = Gatti | Only a tollu pair hardening on an exact 2 becomes a TOUGHENED Gatti; joining is silent tollu |
| Gatti movement (TC-MOV-008/009/016/021, TC-GAT-005/011/012/015) | Any pair moves as one unit, anywhere | Outer pairs move as singles; inner tollu at half rate (`floor(score/2)`, stuck on 1); toughened at full rate |
| Immunity (TC-GAT-006/009/010/013, TC-CAP multi-victim) | Any 2-stack immune; landings capture all | Only TOUGHENED pairs immune; landings capture exactly ONE (lowest id) |
| Blockade (new) | Passing always allowed | Non-toughened movers can neither pass through nor stop on toughened cells; toughened movers pass (never land-capture) |
| 7×7 path length (TC-MOV-020) | 49 positions × 12 scores | 49 (S/E/W) + 48 (N) positions × 12 scores |
| EC-21 (TC-GAT-017) | Finishing from a Gatti leaves a "smaller Gatti" | Unchanged outcome, new vocabulary: the remainder is tollu until hardened |

---

## Test Organization

```
test-cases/
├── unit/                    # Pure logic tests (engine, models, track)
│   ├── cowry_scoring_test.kt
│   ├── movement_validation_test.kt
│   ├── gatti_logic_test.kt
│   ├── capture_logic_test.kt
│   ├── gate_enforcement_test.kt
│   ├── victory_detection_test.kt
│   ├── bot_ai_test.kt
│   └── track_builder_test.kt
├── integration/             # Cross-component tests
│   ├── game_flow_test.kt
│   ├── extra_roll_chain_test.kt
│   ├── turn_management_test.kt
│   └── state_persistence_test.kt
├── ui/                      # UI/UX tests
│   ├── board_rendering_test.kt
│   ├── pawn_selection_test.kt
│   ├── quick_select_bar_test.kt
│   ├── game_log_test.kt
│   └── responsive_layout_test.kt
├── e2e/                     # End-to-end scenarios
│   ├── full_game_5x5_test.kt
│   ├── full_game_7x7_test.kt
│   ├── pass_and_play_test.kt
│   ├── vs_bot_test.kt
│   └── victory_flow_test.kt
├── scale/                   # Scale/Stress tests
│   ├── rapid_tap_test.kt
│   ├── long_game_test.kt
│   ├── max_extra_rolls_test.kt
│   └── memory_leak_test.kt
└── negative/                # Negative/error case tests
    ├── invalid_moves_test.kt
    ├── illegal_state_test.kt
    ├── malformed_input_test.kt
    └── boundary_violation_test.kt
```

### Test Implementation / Automation Status

> The 200+ cases below are a **test plan**. This table records what is **actually implemented in the repo today** so a planned case is never mistaken for a shipped one. New tests must be filed against the shared engines: `web/game-engine.js` (Jest) and the pure-JVM Kotlin `:engine` module (`engine/src/main/kotlin/com/chokabarah/game/engine/GameEngine.kt` + `TrackBuilder.kt`, compiled/tested **without** the Android SDK — see §13).

| Test Target | Category | Status in repo |
|-------------|----------|----------------|
| `web/game-engine.test.js` | Unit (Jest) | ✅ Implemented — **93 passing** (paths, safe incl. 5×5-corner rule, cowry, valid-moves, Gatti incl. EC-21 finish-in-Gatti, capture, gate, victory, bot incl. EC-32 tie-break, EC-38 inner-loop direction, scale + input-validation guards; Phase 4 perf: path-cache identity/reset + 2000-iteration stability) |
| `web/sound.test.js` | Unit (Jest) | ✅ Implemented — **18 passing** (US-27: event→effect mapping, mute gating, no-op sink fallback, WebAudio sink via injected fake AudioContext) |
| `web/telemetry.test.js` | Backend observability (trace) | ✅ Implemented — **8 passing** (Phase 7: record schema, span start/end nesting + duration, severity/level gating, max-buffer cap, JSON-sink NDJSON round-trip) |
| `GameEngineTest.kt` | Unit (JVM, `:engine`) | ✅ Implemented — **24 passing** — initial state, roll scoring, move/capture/finish/victory, turn, bot, invalid counts, null/empty move rejection |
| `TrackBuilderTest.kt` | Unit (JVM, `:engine`) | ✅ Implemented — **15 passing** — path length/offsets, gate index, safe squares (incl. ✕ pattern) |
| `GameModelsTest.kt` | Unit (JVM, `:engine`) | ✅ Implemented — **12 passing** — models/enums/`MoveOption`/`CowryResult`/`GridSize` |
| `TelemetryTest.kt` | Unit (JVM, `:engine`) | ✅ Implemented — **12 passing** — enable/level/spans/convenience/JSON |
| `HomeScreenTest.kt`, `GameScreenTest.kt` | UI (instrumented) | ✅ Implemented — minimal render/title assertions |
| `cowry_scoring_test.kt`, `movement_validation_test.kt`, `gatti_logic_test.kt`, `capture_logic_test.kt`, `gate_enforcement_test.kt`, `victory_detection_test.kt`, `bot_ai_test.kt` | Unit (JVM) | ⏳ Planned — coverage currently consolidated in the 4 JVM files above |
| `integration/`, `e2e/`, `scale/`, `negative/` | Integration / E2E / Scale / Negative | ✅ Web integration/E2E/scale authored in `web/integration.test.js` + `web/e2e/robustness.spec.js` (see rows below); Android JVM integration/E2E/scale/negative still planned |
| `web/integration.test.js` | Integration / E2E / Scale | ✅ Implemented — **17 passing** (drive-to-victory across 5×5/7×7 × 2/4 players incl. every winner index, extra-roll chain TC-EXT-004, turn-rotation TC-TRN-008 @ 10k advances, gate-unlock→inner path, fresh-reset TC-INT-008). Constructed to be deterministic & bounded |
| Playwright Web E2E (`web/e2e/smoke.spec.js`) | E2E | ✅ Implemented — **6 passing** (boot + titles, board/player-legend render incl. roll-button colour for current player, cowry-roll score display, rules-modal open/close, fit-to-viewport) against a static server (`web/server.js`, port 3111; Playwright `webServer`) |
| Web E2E robustness (`web/e2e/robustness.spec.js`) | E2E / Scale | ✅ Implemented — **3 passing** (TC-SCA-005 concurrency: a burst of 30 rapid roll taps processes only one roll; rapid-tap crash-safety; TC-E2E-012 invalid board taps are a safe no-op) |
| Accessibility (a11y) — `web/e2e/a11y.spec.js` | UI / UX | ✅ Implemented — **2 passing** (axe-core over home + in-game screens; 0 critical/serious). Includes WCAG AA colour-contrast fixes (player palette, `.chip-sub`, `.btn-primary`) and structure (single `<main>` landmark, heading order, in-game `<h1>`) |

---

## 1. UNIT TESTS - Core Engine Logic

### 1.1 Cowry Scoring (`cowry_scoring_test.kt`)

#### Positive Tests (Happy Path)

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-COW-001 | US-05, US-06 | Roll 4 cowries: [UP, UP, DOWN, DOWN] | Score = 2, label = "Score: 2", isExtraRoll = false |
| TC-COW-002 | US-05, US-06 | Roll 4 cowries: [UP, UP, UP, UP] | Score = 4, label = "CHOWKA (4) — EXTRA ROLL!", isExtraRoll = true |
| TC-COW-003 | US-05, US-06 | Roll 4 cowries: [DOWN, DOWN, DOWN, DOWN] | Score = 8, label = "BAARA (8) — EXTRA ROLL!", isExtraRoll = true |
| TC-COW-004 | US-05, US-06 | Roll 6 cowries: [UP, UP, UP, UP, UP, UP] | Score = 6, label = "CHOWKA (6) — EXTRA ROLL!", isExtraRoll = true |
| TC-COW-005 | US-05, US-06 | Roll 6 cowries: [DOWN, DOWN, DOWN, DOWN, DOWN, DOWN] | Score = 12, label = "BAARA (12) — EXTRA ROLL!", isExtraRoll = true |
| TC-COW-006 | US-05, US-06 | All 16 combinations (4 shells) produce correct scores | Score distribution: 1×8, 4×1, 6×2, 4×3, 1×4 |
| TC-COW-007 | US-05, US-06 | All 64 combinations (6 shells) produce correct scores | Score distribution matches probability table |

#### Negative Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-COW-008 | US-05 | Roll with null/empty shell list | Throw IllegalArgumentException |
| TC-COW-009 | US-05 | Roll with 5 shells (invalid for both variants) | Throw IllegalArgumentException |
| TC-COW-010 | US-05 | Roll with 3 shells | Throw IllegalArgumentException |
| TC-COW-011 | US-05 | Shell list contains null elements | Throw NullPointerException |

#### Scale/Boundary Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-COW-012 | US-07 | 10,000 consecutive rolls - verify distribution matches theoretical | Chi-square test p > 0.05 |
| TC-COW-013 | US-07 | 1,000 chained extra rolls (simulate Chowka chain) | No stack overflow, all rolls processed |
| TC-COW-014 | US-07 | Roll with maximum score (8/12) on 49-cell path | Score correctly calculated, no overflow |

---

### 1.2 Movement Validation (`movement_validation_test.kt`)

#### Positive Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-MOV-001 | US-09, US-11 | Pawn in HOME_BASE, roll = 1 (5×5) | Valid move: targetIndex = 0 (home square) |
| TC-MOV-002 | US-09, US-11 | Pawn in HOME_BASE, roll = 3 (5×5) | Valid move: targetIndex = 2 |
| TC-MOV-003 | US-09, US-11 | Pawn in HOME_BASE, roll = 8 (5×5 Baara) | Valid move: targetIndex = 7 |
| TC-MOV-004 | US-09, US-11 | Pawn in HOME_BASE, roll = 12 (7×7 Baara) | Valid move: targetIndex = 11 |
| TC-MOV-005 | US-09, US-12 | Single pawn ON_TRACK at index 5, roll = 4 | Valid move: targetIndex = 9 |
| TC-MOV-006 | US-09, US-12 | Pawn at index 23 (5×5), roll = 1 | Valid move: targetIndex = 24 (center home) |
| TC-MOV-007 | US-09, US-13 | Player HAS cut, pawn at index 15 (5×5), roll = 2 | Valid move: targetIndex = 17 (inner track) |
| TC-MOV-008 | US-09, US-12 | Gatti group (2 pawns) at index 10, roll = 3 | Valid move: entire group to index 13 |
| TC-MOV-009 | US-09, US-12 | Gatti group (3 pawns) at index 20, roll = 4, has cut | Valid move: entire group to index 24 (center) |
| TC-MOV-010 | US-11 | Multiple pawns in HOME_BASE, roll = 2 | Exactly ONE valid move per pawn (4 separate MoveOptions) |

#### Negative Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-MOV-011 | US-13 | Player NO cut, pawn at index 15 (5×5), roll = 1 → target 16 (gate) | **NO valid move** - gate blocked |
| TC-MOV-012 | US-13 | Player NO cut, pawn at index 14 (5×5), roll = 3 → target 17 | **NO valid move** - would cross gate |
| TC-MOV-013 | US-13 | Player NO cut, Gatti at index 14, roll = 2 → target 16 | **NO valid move** - entire group blocked |
| TC-MOV-014 | US-09 | Pawn at index 24 (center), roll = any | **NO valid move** - pawn already FINISHED |
| TC-MOV-015 | US-09 | Pawn at index 23, roll = 2 (overshoot center) | **NO valid move** - overshoot not allowed |
| TC-MOV-016 | US-12 | Gatti at index 22, roll = 3 (one pawn would overshoot) | **NO valid move** - entire group blocked |
| TC-MOV-017 | US-11 | All 4 pawns FINISHED, roll = any | **NO valid moves** - game should have ended |
| TC-MOV-018 | US-09 | Pawn ON_TRACK, roll = 0 (impossible but test) | **NO valid move** - invalid score |

#### Scale/Boundary Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-MOV-019 | US-09 | Validate all 25 path positions × scores 1-8 (5×5) | 200 combinations, all correct |
| TC-MOV-020 | US-09 | Validate all 49 path positions × scores 1-12 (7×7) | 588 combinations, all correct |
| TC-MOV-021 | US-12 | Gatti of size 4 (all pawns grouped) at various positions | Group moves as unit, no split |
| TC-MOV-022 | US-09 | Rapid validation calls (10,000/sec) | No performance degradation, <1ms avg |

---

### 1.3 Gatti Logic (`gatti_logic_test.kt`)

#### Positive Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-GAT-001 | US-16 | Two pawns land on same cell via same move | Gatti formed, isGattiGroup = true |
| TC-GAT-002 | US-16 | Two pawns land on same cell via different moves (sequential) | Gatti formed on second arrival |
| TC-GAT-003 | US-16 | Three pawns on same cell | Gatti of size 3 |
| TC-GAT-004 | US-16 | Gatti on safe square (corner/home) | Gatti formed + safe square protection |
| TC-GAT-005 | US-12 | Gatti moves as single unit | All pawns in group advance together |
| TC-GAT-006 | US-16 | Gatti captures single opponent pawn | Capture succeeds, extra turn granted |
| TC-GAT-007 | US-17 | Gatti formation logs "🔗 GATTI!" message | Log contains Gatti message |
| TC-GAT-008 | US-19 | Gatti forms on winning move (last pawn joins at center) | Gatti message + Victory message both shown |

#### Negative Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-GAT-009 | US-16 | Opponent single pawn attempts to capture Gatti | Move INVALID - not in validMoves |
| TC-GAT-010 | US-16 | Opponent Gatti attempts to capture Gatti | Move INVALID - not in validMoves |
| TC-GAT-011 | US-12 | Attempt to move only PART of a Gatti | Not possible - UI only offers whole group |
| TC-GAT-012 | US-12 | Gatti at index 23, roll = 2 (overshoot) | Move INVALID - entire group blocked |
| TC-GAT-013 | US-16 | Gatti on unsafe square, opponent single lands there | Opponent move INVALID (Gatti immune) |

#### Scale/Boundary Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-GAT-014 | US-16 | Form/break Gatti 1000 times rapidly | No memory leaks, state consistent |
| TC-GAT-015 | US-16 | Maximum Gatti size (4 pawns) at all path positions | All valid moves computed correctly |
| TC-GAT-016 | US-16 | Concurrent Gatti formations by multiple players | Each player's Gatti independent |
| TC-GAT-017 | EC-21 | Pawn reaches center home **while in a Gatti** | That pawn → FINISHED; remaining pawns continue as a **smaller Gatti** (no invalid/impossible state) |

---

### 1.4 Capture Logic (`capture_logic_test.kt`)

#### Positive Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-CAP-001 | US-14 | Single pawn lands on opponent single (unsafe) | Capture: opponent → HOME_BASE, extra turn |
| TC-CAP-002 | US-14 | Gatti lands on opponent single (unsafe) | Capture: opponent → HOME_BASE, extra turn |
| TC-CAP-003 | US-14 | Capture on cell with 2 opponents (different colors) | BOTH captured → HOME_BASE |
| TC-CAP-004 | US-14 | Capture unlocks inner gate for capturer | hasCapturedOpponent = true immediately |
| TC-CAP-005 | US-14 | Capture on extra roll (Chowka/Baara) | Extra turn chains correctly |
| TC-CAP-006 | US-14 | Capture animation/log: "✂️ CUT!" | Log contains cut message |
| TC-CAP-007 | US-27 | Capture sound plays | Sound triggered — covered by `web/sound.test.js` capture event + app.js integration |

#### Negative Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-CAP-008 | US-15 | Land on opponent on a 7×7 **corner** safe square (e.g. (0,0)) | NO capture - coexist |
| TC-CAP-009 | US-15 | Land on opponent on player home square (safe) | NO capture - coexist |
| TC-CAP-010 | US-15 | Land on opponent on center home | NO capture - coexist |
| TC-CAP-011 | US-15 | Land on opponent on 7×7 inner diagonal safe (✕ pattern) | NO capture - coexist |
| TC-CAP-012 | US-16 | Attempt capture on opponent Gatti (2+ pawns) | Move INVALID - not in validMoves |
| TC-CAP-013 | US-16 | Attempt capture on opponent Gatti by another Gatti | Move INVALID - not in validMoves |
| TC-CAP-014 | US-14 | Capture pawn in HOME_BASE | IMPOSSIBLE - not on board |

#### Scale/Boundary Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-CAP-015 | US-14 | 100 consecutive captures in single game | All processed correctly, gate unlocks on first |
| TC-CAP-016 | US-14 | Capture with 3 opponents on same cell (3 colors) | All 3 captured |
| TC-CAP-017 | US-14 | Capture chain: capture → extra roll → capture → extra roll | All extra turns honored |

---

### 1.5 Gate Enforcement (`gate_enforcement_test.kt`)

#### Positive Tests

> **ID namespace:** This section uses `TC-GTE-*` (not `TC-GAT-*`) to avoid colliding with the Gatti-logic tests in §1.3.

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-GTE-001 | US-13 | No cut, pawn at index 15 (5×5), roll = 1 | NO valid move (target 16 = gate) |
| TC-GTE-002 | US-13 | No cut, pawn at index 14 (5×5), roll = 3 | NO valid move (target 17 > gate) |
| TC-GTE-003 | US-13 | HAS cut, pawn at index 15, roll = 1 | Valid move to index 16 (gate entry) |
| TC-GTE-004 | US-13 | HAS cut, pawn at index 15, roll = 2 | Valid move to index 17 (inner track) |
| TC-GTE-005 | US-13 | Gatti at index 14, HAS cut, roll = 2 | Valid move - entire group enters inner |
| TC-GTE-006 | US-13 | Capture on outer track → immediate gate unlock → extra roll → move into inner | Valid - gate unlocks mid-turn |
| TC-GTE-007 | US-13 | 7×7: gate at index 24, no cut blocks index ≥ 24 | Correctly blocked |

#### Negative Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-GTE-008 | US-13 | No cut, pawn at index 16 (already in inner) | IMPOSSIBLE - cannot reach inner without cut |
| TC-GTE-009 | US-13 | Fake cut state (hasCapturedOpponent = true but no actual capture) | Gate unlocked (state-based) |

#### Scale/Boundary Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-GTE-010 | US-13 | Toggle hasCapturedOpponent 10,000 times | No state corruption |
| TC-GTE-011 | US-13 | Verify gate index for both variants: 5×5=16, 7×7=24 | Constants correct |

---

### 1.6 Victory Detection (`victory_detection_test.kt`)

#### Positive Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-VIC-001 | US-18 | Player moves 4th pawn to center (index 24/48) | Victory detected, game ends |
| TC-VIC-002 | US-18 | Victory with all 4 pawns finishing on same roll (Gatti) | Victory detected |
| TC-VIC-003 | US-19 | Gatti forms on winning move (last pawn joins group at center) | Gatti message + Victory message |
| TC-VIC-004 | US-18 | 2-player game: Red wins | Green never gets another turn |
| TC-VIC-005 | US-18 | 4-player game: Yellow wins | Blue/Red/Green never get another turn |

#### Negative Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-VIC-006 | US-18 | 3 pawns finished, 1 pawn at index 23, roll = 1 | No victory yet |
| TC-VIC-007 | US-18 | Check victory after every move (not just on center arrival) | Only triggers on actual finish |

#### Scale/Boundary Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-VIC-008 | US-18 | Simulate 1000 games to completion | All end with exactly one winner |
| TC-VIC-009 | US-18 | Victory check called 10,000 times | <0.1ms per call |

---

### 1.7 Bot AI (`bot_ai_test.kt`)

#### Positive Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-BOT-001 | US-21 | Bot has capture available | Bot chooses capture (priority 1) |
| TC-BOT-002 | US-21 | Bot has pawn at index 23, roll = 1 | Bot chooses reach home (priority 2) |
| TC-BOT-003 | US-21 | Bot can move to safe square | Bot chooses safe square (priority 3) |
| TC-BOT-004 | US-21 | Bot can form/advance Gatti | Bot chooses Gatti (priority 4) |
| TC-BOT-005 | US-21 | Bot has multiple single pawns | Bot chooses furthest advanced (priority 5) |
| TC-BOT-006 | US-22 | Bot rolls Chowka, no valid moves | Bot re-rolls automatically |
| TC-BOT-007 | US-22 | Bot rolls Baara, no valid moves | Bot re-rolls automatically |
| TC-BOT-008 | US-23 | Bot never makes illegal move (gate, overshoot, Gatti capture) | All bot moves ∈ validMoves |
| TC-BOT-009 | US-21 | Bot delay 1-2 seconds before roll/move | Delay in range |

#### Negative Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-BOT-010 | US-23 | Bot with no valid moves (not extra roll) | Bot passes turn (advanceTurn) |
| TC-BOT-011 | US-23 | Bot tries to select invalid MoveOption | Never happens - only chooses from validMoves |

#### Scale/Boundary Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-BOT-012 | US-21 | 1000 bot games (bot vs bot) | All games complete, no illegal moves |
| TC-BOT-013 | US-21 | Bot decision time < 10ms | Performance acceptable |
| TC-BOT-014 | US-22 | Bot handles 50 chained extra rolls | No stack overflow, correct behavior |
| TC-BOT-015 | EC-32, US-21 | Bot has multiple valid moves with identical priority | Picks the **first** in priority order — selection is **deterministic/reproducible** (stable ordering) |

---

### 1.8 Track Builder (`track_builder_test.kt`)

#### Positive Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-TRK-001 | US-01 | 5×5 Red path length = 25 | Correct |
| TC-TRK-002 | US-01 | 5×5 Green path length = 25 | Correct |
| TC-TRK-003 | US-01 | 5×5 Yellow path length = 25 | Correct |
| TC-TRK-004 | US-01 | 5×5 Blue path length = 25 | Correct |
| TC-TRK-005 | US-01 | 7×7 all 4 paths length = 49 | Correct |
| TC-TRK-006 | US-01 | 5×5 Red path[0] = (4,2) home square | Correct start |
| TC-TRK-007 | US-01 | 5×5 Red path[16] = gate entry (inner track start) | Correct gate |
| TC-TRK-008 | US-01 | 5×5 Red path[24] = (2,2) center home | Correct end |
| TC-TRK-009 | US-01 | 7×7 inner safe squares = (1,1), (1,5), (5,1), (5,5) | **✕ pattern** |
| TC-TRK-010 | US-01 | 7×7 inner safe squares NOT at (1,3), (3,1), (3,5), (5,3) | **NOT + pattern** |
| TC-TRK-011 | US-01 | 5×5 safe squares: 4 homes + 1 center = 5 (**corners NOT safe**) | Correct count |
| TC-TRK-012 | US-01 | 7×7 safe squares: 4 homes, 4 corners, 4 diagonal, 1 center = 13 | Correct count |
| TC-TRK-013 | US-01 | All paths anti-clockwise on outer loop | Verified |
| TC-TRK-014 | US-01 | Path continuity: each step adjacent (orthogonal) | No jumps |

#### Negative Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-TRK-015 | US-01 | Invalid grid size | Throw IllegalArgumentException |
| TC-TRK-016 | US-01 | Invalid player index (>3) | Throw IndexOutOfBoundsException |

#### Scale/Boundary Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-TRK-017 | US-01 | Generate all paths 10,000 times | Consistent results, no allocation issues |
| TC-TRK-018 | EC-38, US-01 | Inner loop continues **anti-clockwise** from the gate (both boards) | Direction verified contiguous & anti-clockwise — never reverses |

### 1.9 Sound Feedback (`sound.js` / `GameAudio`) — US-27

Pure layer is fully automated in `web/sound.test.js`; the actual audio device is never
touched in automated tests (stub sink / injected fake `AudioContext`).

#### Positive Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-SND-001 | US-27 | `resolveSound('roll')` | Returns roll descriptor (tone 523) |
| TC-SND-002 | US-27 | `play('roll')` unmuted with stub sink | Sink invoked, returns `true` |
| TC-SND-003 | US-27 | `play('victory')` | Returns `true`, victory tone (988) |
| TC-SND-004 | US-27 | `toggleMute()` / `setMuted()` | Flag flips; `isMuted()` reflects state |
| TC-SND-005 | US-27 | WebAudio sink with fake `AudioContext` | Oscillator/gain created, start/stop called, returns `true` |
| TC-SND-006 | US-27 | `webkitAudioContext` fallback when `AudioContext` absent | Still plays (returns `true`) |
| TC-SND-007 | US-27 | app.js emits `roll` on `handleRoll`, `capture` on capture, `victory` on win, `game_start` on start | Sound event fired at each action point |

#### Negative Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-SND-008 | US-27 | `play(...)` while muted | Returns `false`, sink NOT invoked |
| TC-SND-009 | US-27 | `play('unknown_event')` | Returns `false`, no sound |
| TC-SND-010 | US-27 | No sink provided to `createSoundController` | Falls back to no-op sink, `play` returns `false` |
| TC-SND-011 | US-27 | No `AudioContext` on platform | `createWebAudioSink` returns no-op sink |
| TC-SND-012 | US-27 | AudioContext constructor throws | `play` returns `false` without crashing |

---

## 2. INTEGRATION TESTS

### 2.1 Game Flow (`game_flow_test.kt`)

#### Positive Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-INT-001 | US-01 to US-20 | Complete 5×5 game: Red vs Green (Pass-and-Play) | Game ends with winner |
| TC-INT-002 | US-01 to US-20 | Complete 7×7 game: 4 players | Game ends with winner |
| TC-INT-003 | US-05 to US-08 | Roll → move → capture → extra roll → move → turn passes | Full turn cycle |
| TC-INT-004 | US-07, US-08 | Chowka roll → move → Chowka again → move → normal roll → turn passes | Chained extra rolls |
| TC-INT-005 | US-13, US-14 | No cut → capture on outer → gate unlocks → extra roll → enter inner | Mid-turn gate unlock |
| TC-INT-006 | US-12, US-16 | Form Gatti → move Gatti → Gatti captures → extra roll | Gatti full lifecycle |
| TC-INT-007 | US-11 | All 4 pawns enter board individually across turns | 4 separate entry moves |
| TC-INT-008 | US-20 | Victory → New Game → fresh state | Clean reset |

#### Negative Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-INT-009 | US-08 | Extra roll, no valid moves | Extra roll consumed; **same player re-rolls** (turn NOT passed) |
| TC-INT-010 | US-08 | Extra roll, no moves → re-roll (extra) → no moves | Both extras consumed; same player continues re-rolling (no turn advance) |
| TC-INT-011 | US-13 | Attempt move past gate without cut | Move rejected, no state change |

#### Scale/Boundary Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-INT-012 | All | 100 complete games (various configs) | All terminate correctly |
| TC-INT-013 | All | Game with maximum turns (stalling) | Eventually ends (probability) |

---

### 2.2 Extra Roll Chain (`extra_roll_chain_test.kt`)

#### Positive Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-EXT-001 | US-07 | Single Chowka → move → normal roll | Extra roll consumed |
| TC-EXT-002 | US-07 | Chowka → Chowka → 3 → move → normal | Two extra rolls chained |
| TC-EXT-003 | US-07 | Baara → capture → Chowka → move → normal | Mixed extra types |
| TC-EXT-004 | US-07 | 5×5: 10 chained Chowkas | All honored |
| TC-EXT-005 | US-07 | 7×7: 10 chained Baaras | All honored |

#### Negative Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-EXT-006 | US-08 | Chowka → no valid moves | Extra roll **consumed**; same player **re-rolls** (roll enabled, turn NOT advanced) |
| TC-EXT-007 | US-08 | Chowka → no moves → re-roll (extra) → no moves | Both extra rolls consumed; same player re-rolls (no turn advance) |
| TC-EXT-008 | US-08 | Chowka → move → Chowka → no moves | Second extra roll consumed; same player re-rolls (no turn advance) |

#### Scale/Boundary Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-EXT-009 | US-07 | 1000 chained extra rolls in one turn | No stack overflow, correct state |

---

### 2.3 Turn Management (`turn_management_test.kt`)

#### Positive Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-TRN-001 | US-24 | 2-player: Red → Green → Red | Correct alternation |
| TC-TRN-002 | US-24 | 3-player: Red → Green → Yellow → Red | Correct rotation |
| TC-TRN-003 | US-24 | 4-player: Red → Green → Yellow → Blue → Red | Correct rotation |
| TC-TRN-004 | US-24 | Capture grants extra turn → same player rolls again | Turn not advanced |
| TC-TRN-005 | US-24 | Chowka grants extra turn → same player rolls again | Turn not advanced |
| TC-TRN-006 | US-24 | Normal move (no capture, no extra) → turn advances | Next player |

#### Negative Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-TRN-007 | US-24 | Turn advance when game already won | No-op (game ended) |

#### Scale/Boundary Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-TRN-008 | US-24 | 10,000 turn advances | No off-by-one errors |

---

### 2.4 State Persistence (`state_persistence_test.kt`)

#### Positive Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-STA-001 | US-33 | Save game mid-turn, restore | All state restored (turn, roll, positions) |
| TC-STA-002 | US-33 | Save during extra roll chain, restore | Extra roll state preserved |
| TC-STA-003 | US-39 | Rotate device mid-game (Android) | UI re-renders, state intact |

#### Negative Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-STA-004 | US-33 | Corrupted save file | Graceful fallback to new game |

---

## 3. UI TESTS

### 3.1 Board Rendering (`board_rendering_test.kt`)

#### Positive Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-UI-001 | US-26 | 5×5 board renders all 25 cells | Grid visible |
| TC-UI-002 | US-26 | 7×7 board renders all 49 cells | Grid visible |
| TC-UI-003 | US-26 | Safe squares visually distinct (corner/home/center) | Different styling |
| TC-UI-004 | US-26 | 7×7 inner diagonal safes at ✕ positions | Correct positions highlighted |
| TC-UI-005 | US-09 | Valid move highlights after roll | Destination cells highlighted |
| TC-UI-006 | US-09 | Movable pawns show indicator | Pawn highlight/pulse |
| TC-UI-007 | US-17 | Gatti shows stacked/bundled visual | Multiple pawns on one cell |

#### Scale/Boundary Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-UI-008 | US-26 | Render on 320dp width (small phone) | Board scales, no overflow |
| TC-UI-009 | US-26 | Render on 1200dp width (tablet) | Board scales, centered |
| TC-UI-010 | US-26 | Rapid re-renders (100/sec) | No flicker, 60fps |

---

### 3.2 Pawn Selection (`pawn_selection_test.kt`)

#### Positive Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-UI-011 | US-10 | Tap valid pawn → selects it | Pawn highlighted |
| TC-UI-012 | US-10 | Tap destination → moves selected pawn | Move executed |
| TC-UI-013 | US-10 | Tap invalid cell with pawn selected | No action |
| TC-UI-014 | US-10 | Tap another valid pawn → changes selection | Selection updated |
| TC-UI-015 | US-12 | Tap Gatti member → selects entire group | Group highlighted |
| TC-UI-016 | US-10 | Deselect by tapping selected pawn | Selection cleared |

#### Negative Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-UI-017 | US-10 | Tap pawn with no valid moves | No selection |
| TC-UI-018 | US-40 | Tap opponent pawn | No selection |
| TC-UI-019 | US-41 | Tap own pawn not in valid moves | No selection |

---

### 3.3 Quick Select Bar (`quick_select_bar_test.kt`)

#### Positive Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-UI-020 | US-10 | Multiple valid pawns → bar shows all | Each as separate entry |
| TC-UI-021 | US-10 | Gatti group → bar shows single entry with count | "🔗×2" indicator |
| TC-UI-022 | US-11 | Pawn in HOME_BASE eligible → appears in bar | Shows "Enter" label |
| TC-UI-023 | US-10 | Tap bar entry → selects that pawn/group | Selection updated |

#### Scale/Boundary Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-UI-024 | US-10 | 4 separate valid pawns + 1 Gatti = 5 entries | All fit, scrollable if needed |

---

### 3.4 Game Log (`game_log_test.kt`)

#### Positive Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-UI-025 | US-25 | Roll → log shows "Red rolled CHOWKA (4)" | Entry added |
| TC-UI-026 | US-25 | Move → log shows "Red moved pawn 1 to (2,3)" | Entry added |
| TC-UI-027 | US-25 | Capture → log shows "✂️ Red CUT Green pawn!" | Entry added |
| TC-UI-028 | US-25 | Gatti → log shows "🔗 Red GATTI formed!" | Entry added |
| TC-UI-029 | US-19 | Gatti on winning move → both messages | Two entries |
| TC-UI-030 | US-25 | Log scrolls, keeps last 20 entries | Old entries dropped |

---

### 3.5 Responsive Layout (`responsive_layout_test.kt`)

#### Scale Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-UI-031 | US-26 | Phone portrait (360×640) | Board fits, tap targets ≥48dp |
| TC-UI-032 | US-26 | Phone landscape (640×360) | Board fits, log visible |
| TC-UI-033 | US-26 | Tablet (800×1280) | Board centered, larger pawns |
| TC-UI-034 | US-26 | Foldable unfolded (1200×1600) | Two-pane? (if implemented) |
| TC-UI-035 | US-26 | Web: Chrome DevTools device toolbar all presets | No horizontal scroll |

---

### 3.6 Turn Indication & Colors (`turn_indication_ui`) — US-04 / US-06 / US-24 / US-15

Implemented in the web UI: player names/colors legend strip (`#player-strip`, active chip),
roll-button colored by current player, extra-roll score highlight, and safe-square
coexistence rendering. Browser coverage in `web/e2e/smoke.spec.js` (legend + roll-button
colour assertions); engine/coexistence rules are unit-tested in `web/game-engine.test.js`.

#### Positive Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-UI-036 | US-24 | Turn banner + legend strip colored for current player | Current `player-chip.active` = current player; banner bg = player color |
| TC-UI-037 | US-24 | Roll button colored for current player (actionable turn) | `#btn-roll` background = current player color |
| TC-UI-038 | US-04 | Player names/colors shown for each participating player | Contributing players appear in `#player-strip` with name + color chip |
| TC-UI-039 | US-24 | Log shows "Player X's turn! Roll cowries." on turn advance | Log updated |
| TC-UI-040 | US-06 | Chowka/Baara roll displays score with extra-roll highlight | `#roll-score-display` has `.is-extra` class |
| TC-UI-041 | US-15 | Opponents coexist on a safe square | Multiple pawns rendered on the same safe cell, no captures |

#### Negative Tests

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-UI-042 | US-24 | Roll button during bot/disabled turn | `.btn-roll:disabled` styling, not recolored |

---

## 4. END-TO-END TESTS

### 4.1 Full Game 5×5 (`full_game_5x5_test.kt`)

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-E2E-001 | All | 2-player Pass-and-Play 5×5 to completion | Winner declared |
| TC-E2E-002 | All | 4-player Pass-and-Play 5×5 to completion | Winner declared |
| TC-E2E-003 | All | VS Bot 5×5 (Human vs 1 Bot) | Human can win/lose |
| TC-E2E-004 | All | VS Bot 5×5 (Human vs 3 Bots) | Human can win/lose |
| TC-E2E-005 | US-13, US-14 | Game where cut happens late (turn 30+) | Gate unlocks, inner track used |
| TC-E2E-006 | US-16 | Game with multiple Gatti formations | All work correctly |

### 4.2 Full Game 7×7 (`full_game_7x7_test.kt`)

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-E2E-007 | All | 2-player Pass-and-Play 7×7 to completion | Winner declared |
| TC-E2E-008 | All | 4-player Pass-and-Play 7×7 to completion | Winner declared |
| TC-E2E-009 | US-01, US-35 | Verify 7×7 inner safes at ✕ pattern positions | No + pattern safes |

### 4.3 Pass-and-Play (`pass_and_play_test.kt`)

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-E2E-010 | US-03, US-39 | Pass device between players | Turn indicator updates |
| TC-E2E-011 | US-39 | Rotate device mid-game | Board orientation stable |
| TC-E2E-012 | US-40, US-41 | Invalid taps ignored | No crashes |

### 4.4 VS Bot (`vs_bot_test.kt`)

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|----------|
| TC-E2E-013 | US-21, US-22, US-23 | Human vs Bot (all difficulties if any) | Bot plays legally |
| TC-E2E-014 | US-22 | Bot gets Chowka with no moves | Bot re-rolls |
| TC-E2E-015 | US-23 | Bot never makes illegal move | Verified by engine |

### 4.5 Victory Flow (`victory_flow_test.kt`)

| Test ID | User Story | Scenario | Expected |
|---------|------------|----------|--------|
| TC-E2E-016 | US-18, US-19, US-20 | Victory screen shows winner, New Game button works | Clean restart |
| TC-E2E-017 | US-19 | Victory with Gatti on final move | Both messages shown |

---

## 5. SCALE / STRESS TESTS

| Test ID | Category | Scenario | Expected |
|---------|----------|----------|----------|
| TC-SCA-001 | Rapid Input | 100 taps/second on board for 30 seconds | No ANR, no crashes, state consistent |
| TC-SCA-002 | Long Game | Simulate 500-turn game (stalling) | Memory stable, no leaks |
| TC-SCA-003 | Max Extra Rolls | Force 100 chained Chowkas (mock RNG) | Stack safe, all processed |
| TC-SCA-004 | Memory | Play 100 games sequentially | Heap returns to baseline |
| TC-SCA-005 | Concurrency | Multiple rapid roll buttons taps | Only one roll processed |
| TC-SCA-006 | Web Performance | 1000 games in headless Playwright | All complete < 5 min |
| TC-SCA-007 | Android UI | Espresso: 500 UI interactions | < 2 min, no flakes |
| TC-SCA-008 | Battery | 30 min continuous play | No excessive drain |

> **Phase 4 (performance) status:** Web engine hot path optimized — `getPlayerPath`
> results are memoized (`_pathCache`, exposed via `resetPathCache`) so the
> `getPawnsAtCoords → getPawnCoords → getPlayerPath` chain never rebuilds path
> arrays per call. Automated in `web/game-engine.test.js` ("PHASE 4 - PERFORMANCE"):
> cached-reference identity, `resetPathCache` rebuild equivalence, and a 2,000-iteration
> 7×7 computation stability run (covers TC-SCA-002/-006 at the engine level).
> **Phase 5 (Playwright, implemented):** browser-level TC-SCA-006 (headless Playwright
> under 5 min) is now covered by the live E2E suite `web/e2e/smoke.spec.js` (boot,
> board + player-legend render, roll interaction, rules modal, fit-to-viewport) plus
> `web/e2e/a11y.spec.js` (axe-core: 0 critical/serious on home + in-game screens). Run
> with `npm run e2e` (Chromium via `npm run e2e:install`); wired into CI as the
> `web-e2e` job.
> **Phase 6 (Integration / E2E / Scale, implemented):** `web/integration.test.js` hosts
> deterministic integration + scale runs (17 cases: victory drives for every winner index
> across 5×5/7×7 × 2/4 players, TC-EXT-004 extra-roll chain, TC-TRN-008 @10k turn advances,
> gate-unlock→inner, TC-INT-008 fresh reset). `web/e2e/robustness.spec.js` covers TC-SCA-005
> (a burst of rapid roll taps collapses to a single processed roll via the `currentRoll !==
> null` guard + disabled button) and TC-E2E-012 (invalid board taps are a safe no-op). All
> wired into CI `web-tests` (node --check list) and run by `web-e2e`.
> **Phase 7 (CI hardening + backend trace, implemented):** CI hardened — workflow scope
> locked to `permissions: contents: read`, a single coverage run (text+lcov+json, no double
> jest), `timeout-minutes` on every job, 7-day artifact retention. A dedicated `web-trace`
> job validates the structured OpenTelemetry-style trace emission headlessly (startSpan →
> nested span.end with duration → NDJSON-serializable records) and is wired into the status
> gate. `web/telemetry.test.js` gives Jest-level coverage of the same backend (`record
> schema, nesting, level gating, buffer cap, JSON round-trip).
> **Phase 8 (pure-JVM engine module + SDK-free CI, implemented):** the Kotlin engine
> (`GameEngine.kt`, `GameModels.kt`, `TrackBuilder.kt`) and `Telemetry.kt` were split out
> of the Android app into a **pure-JVM `:engine` Gradle module**
> (`engine/src/main/kotlin/...`, tests under `engine/src/test/kotlin/...`) with no Android
> dependency. The Android app now depends on it via `implementation(project(":engine"))`.
> The Gradle root automatically skips `:app` when the env var **`CB_ENGINE_ONLY=1`** is
> set, so the engine can be compiled + tested with only a JDK (no Android SDK/AGP). All
> 4 JVM suites run green locally: **63 tests total, 0 failures**. A dedicated **`engine-jvm-test`**
> GitHub Actions job (JDK 17 + `CB_ENGINE_ONLY=1`) runs `./gradlew :engine:test` and is
> wired into the CI status gate. Run locally with `CB_ENGINE_ONLY=1 ./gradlew :engine:test`
> (requires JDK 17+ only).

---

## 6. NEGATIVE / ERROR CASE TESTS

### 6.1 Invalid Moves (`invalid_moves_test.kt`)

| Test ID | Edge Case | Scenario | Expected |
|---------|-----------|----------|----------|
| TC-NEG-001 | EC-11 | Move to gate without cut | Rejected |
| TC-NEG-002 | EC-12 | Move past gate without cut | Rejected |
| TC-NEG-003 | EC-13 | Gatti move past gate without cut | Rejected |
| TC-NEG-004 | EC-04 | Overshoot center | Rejected |
| TC-NEG-005 | EC-05 | Only pawn left, roll overshoots | No valid moves |
| TC-NEG-006 | EC-18 | Capture Gatti by single | Rejected |
| TC-NEG-007 | EC-19 | Capture Gatti by Gatti | Rejected |
| TC-NEG-008 | EC-23 | Capture on safe square | Rejected |
| TC-NEG-009 | EC-24 | Capture on center | Rejected |
| TC-NEG-010 | EC-28 | Capture opponent Gatti | Rejected |
| TC-NEG-011 | EC-22 | Partial Gatti move | Rejected |

### 6.2 Illegal State (`illegal_state_test.kt`)

| Test ID | Scenario | Expected |
|---------|----------|----------|
| TC-NEG-012 | Call executeMove with MoveOption not in validMoves | Throw IllegalStateException |
| TC-NEG-013 | Call rollCowries when not current player's turn | Ignored / Throw |
| TC-NEG-014 | Call advanceTurn when game won | No-op |
| TC-NEG-015 | Pawn pathIndex out of bounds [-1, path.length-1] | Throw / Clamp |
| TC-NEG-016 | Duplicate pawn IDs | Throw on init |

### 6.3 Malformed Input (`malformed_input_test.kt`)

| Test ID | Scenario | Expected |
|---------|----------|----------|
| TC-NEG-017 | Null GridSize to engine | Throw NPE/IAE |
| TC-NEG-018 | Negative player count | Throw IAE |
| TC-NEG-019 | Player count > 4 | Throw IAE |
| TC-NEG-020 | Invalid PlayerColor index | Throw IOOBE |

### 6.4 Boundary Violation (`boundary_violation_test.kt`)

| Test ID | Edge Case | Scenario | Expected |
|---------|-----------|----------|----------|
| TC-NEG-021 | EC-35 | 7×7 inner safe at + pattern positions | NOT safe (isSafeCell = false) |
| TC-NEG-022 | EC-09 | Home base pawn entry past gate without cut | Rejected |
| TC-NEG-023 | EC-06 | Roll 1 on home square (index 0) | Valid (stays) |
| TC-NEG-024 | Path index = path.length (past center) | Rejected |

---

## 7. TRACEABILITY MATRIX

| User Story | Unit Tests | Integration | UI | E2E | Scale | Negative |
|------------|------------|-------------|-----|-----|-------|----------|
| US-01 | TC-TRK-001-014 | TC-INT-001,002 | TC-UI-001,002 | TC-E2E-001-009 | - | - |
| US-02 | - | TC-INT-001,002 | - | TC-E2E-001,002 | - | TC-NEG-018,019 |
| US-03 | - | TC-INT-001 | - | TC-E2E-010-012 | - | - |
| US-04 | - | - | TC-UI-001,038 | - | - | - |
| US-05 | TC-COW-001-007 | TC-INT-003 | TC-UI-025 | - | TC-COW-012-014 | TC-COW-008-011 |
| US-06 | TC-COW-001-007 | - | TC-UI-025,040 | - | - | - |
| US-07 | TC-COW-002-005 | TC-EXT-001-005 | TC-UI-025 | - | TC-EXT-009, TC-COW-013 | TC-EXT-006-008 |
| US-08 | TC-COW-001 | TC-EXT-006-008, TC-INT-009,010 | - | - | - | - |
| US-09 | TC-MOV-001-010 | TC-INT-003 | TC-UI-005,006,011-016 | - | TC-MOV-019-022 | TC-MOV-011-018 |
| US-10 | - | - | TC-UI-011-016,020-023 | - | TC-UI-024 | TC-UI-017-019 |
| US-11 | TC-MOV-001-004,010 | TC-INT-007 | TC-UI-022 | - | - | - |
| US-12 | TC-MOV-008,009, TC-GAT-005 | TC-INT-006 | TC-UI-015,021 | - | TC-GAT-014-016 | TC-GAT-011-013 |
| US-13 | TC-GTE-001-007 | TC-INT-005 | TC-UI-005 | - | TC-GTE-010-011 | TC-GTE-008-009, TC-NEG-001-003,022 |
| US-14 | TC-CAP-001-007 | TC-INT-003,005 | TC-UI-027 | - | TC-CAP-015-017 | TC-NEG-008-010 |
| US-15 | - | TC-INT-003 | - | - | - | TC-NEG-008-010 |
| US-16 | TC-CAP-006, TC-GAT-001-008, TC-GAT-017 | TC-INT-006 | TC-UI-015,017,021 | - | TC-GAT-014-016 | TC-NEG-006,007, TC-GAT-009-013 |
| US-17 | TC-GAT-007 | - | TC-UI-007,028 | - | - | - |
| US-18 | TC-VIC-001-005 | TC-INT-001,002 | - | TC-E2E-001-009, TC-E2E-016 | TC-VIC-008-009 | - |
| US-19 | TC-VIC-003 | - | TC-UI-029 | TC-E2E-017 | - | - |
| US-20 | - | TC-INT-008 | - | TC-E2E-016 | - | - |
| US-21 | TC-BOT-001-005,008,015 | - | - | TC-E2E-013 | TC-BOT-012-013 | - |
| US-22 | TC-BOT-006,007 | - | - | TC-E2E-014 | TC-BOT-014 | - |
| US-23 | TC-BOT-008 | - | - | TC-E2E-015 | - | - |
| US-24 | TC-TRN-001-006 | TC-INT-003,004,005 | TC-UI-001,036,037,039 | - | TC-TRN-008 | - |
| US-25 | - | - | TC-UI-025-030 | - | - | - |
| US-26 | - | - | TC-UI-001-004,008-010,031-035 | - | TC-SCA-007 | - |
| US-27 | - | - | - | - | - | - |

---

## 8. TEST EXECUTION STRATEGY

### 8.1 CI/CD Pipeline Stages

```yaml
stages:
  - static_analysis:     # ktlint, detekt, ESLint
  - unit_tests:          # All unit tests (target: 90%+ coverage)
  - integration_tests:   # Engine + state tests
  - ui_tests:            # Compose UI tests (Android) + Playwright (Web)
  - e2e_tests:           # Full game scenarios
  - scale_tests:         # Nightly only (time-consuming)
  - negative_tests:      # Every PR
```

### 8.2 Coverage Targets

| Layer | Target |
|-------|--------|
| GameEngine.kt | 95% |
| TrackBuilder.kt | 100% |
| GameModels.kt | 90% |
| Bot AI | 85% |
| UI Components | 70% (Compose testing limitations) |

### 8.3 Test Data Management

```kotlin
// Test fixtures for deterministic testing
object TestFixtures {
    val ROLL_CHOWKA_5x5 = CowryResult(shells = [true,true,true,true], score=4, isExtraRoll=true)
    val ROLL_BAARA_5x5 = CowryResult(shells = [false,false,false,false], score=8, isExtraRoll=true)
    val ROLL_CHOWKA_7x7 = CowryResult(shells = [true]*6, score=6, isExtraRoll=true)
    val ROLL_BAARA_7x7 = CowryResult(shells = [false]*6, score=12, isExtraRoll=true)
    
    // Pre-configured game states for specific scenarios
    fun gameStateWithGateLocked(): GameState
    fun gameStateWithGateUnlocked(): GameState
    fun gameStateWithGattiAt(index: Int): GameState
    fun gameStateNearVictory(): GameState
}
```

### 8.4 Mocking Strategy

| Component | Mock Approach |
|-----------|---------------|
| Random (cowry rolls) | Fixed seed / predefined sequence |
| Time (bot delays) | Virtual time / TestCoroutineDispatcher |
| Sound/Animation | Web `sound.js` core unit-tested with a stub sink; WebAudio adapter injected as fake `AudioContext` in Jest. Android `GameAudio` sink mock interface. |
| Platform APIs (Vibration, Haptics) | Mock interfaces |

---

## 9. DEFECT CLASSIFICATION

| Severity | Definition | SLA |
|----------|------------|-----|
| P0 - Critical | Game unplayable, data loss, crash | Fix in 24h |
| P1 - High | Core rule violation (gate, Gatti, capture) | Fix in 3 days |
| P2 - Medium | UI glitch, minor rule edge case | Fix in 1 sprint |
| P3 - Low | Cosmetic, enhancement | Backlog |

---

## 10. AUTOMATION PRIORITIES

1. **Must Automate (P0)**: All unit tests, integration tests, negative tests
2. **Should Automate (P1)**: E2E happy paths, key UI flows
3. **Nice to Automate (P2)**: Scale tests, visual regression
4. **Manual Only**: Exploratory testing, usability, sound quality

---

## 11. TEST ENVIRONMENTS

| Environment | Purpose | Config |
|-------------|---------|--------|
| Local Dev | Unit/Integration | JDK 17, Node 20, Android SDK 34 |
| Local Dev (engine only) | JVM unit tests, **no Android SDK needed** | `CB_ENGINE_ONLY=1 ./gradlew :engine:test` (JDK 17+) |
| CI (GitHub Actions) | Full pipeline | Ubuntu-latest, macOS-latest (iOS if applicable); `engine-jvm-test` job runs the JVM engine on a bare JDK |
| Device Farm | Real device UI | Firebase Test Lab / BrowserStack |
| Nightly | Scale/Stress | Dedicated runners |

---

## 12. RELEASE CRITERIA

- [ ] All P0/P1 tests pass
- [ ] Unit coverage ≥ 90% (engine), 80% (overall)
- [ ] 0 known P0/P1 bugs
- [ ] 3+ successful nightly scale runs
- [ ] E2E: 5×5, 7×7, 2/3/4 players, Pass-and-Play, VS Bot all pass
- [ ] Accessibility scan: 0 violations (WCAG 2.1 AA)
- [ ] Performance: 60fps UI, <100ms roll-to-move latency

---

## 13. ANDROID ENGINE MODULE (`:engine`) AND SDK-FREE TESTING

The core game logic is extracted into a **pure-JVM Gradle module** so it can be compiled
and unit-tested without the Android SDK or the Android Gradle Plugin:

### Module layout

```
engine/build.gradle.kts                       # kotlin.jvm, Java/Kotlin 1.8, JUnit 4
engine/src/main/kotlin/com/chokabarah/game/
  ├── engine/   GameEngine.kt · GameModels.kt · TrackBuilder.kt
  └── telemetry/ Telemetry.kt                  # Android-free (system-prop/env enabled)
engine/src/test/kotlin/com/example/chokabara/
  GameEngineTest.kt · GameModelsTest.kt · TrackBuilderTest.kt · TelemetryTest.kt
```

The Android `:app` module depends on it: `implementation(project(":engine"))`. App-only
things stay in `:app` (Compose UI, `MainActivity`, instrumented tests).

### `CB_ENGINE_ONLY=1`

`settings.gradle.kts` conditionally includes `:app`; setting the env var
`CB_ENGINE_ONLY=1` skips it. This lets a JDK-only machine/CI job run
`./gradlew :engine:test` without AGP/Android SDK ever loading.

```sh
# Windows (PowerShell)
$env:CB_ENGINE_ONLY="1"; .\gradlew.bat :engine:test
# macOS / Linux
CB_ENGINE_ONLY=1 ./gradlew :engine:test
```

Defaults: without `CB_ENGINE_ONLY`, the normal multi-module build (including `:app`)
runs as usual.

### CI job: `engine-jvm-test`

`.github/workflows/ci.yml` includes `engine-jvm-test` (JDK 17, `CB_ENGINE_ONLY=1`) which
runs `./gradlew :engine:test`. It is included in the `summary` status gate; its result is
reported alongside the web and Android jobs, and the gate fails if it reports `failure`
(an `android-instrumented` result of `skipped` on pull requests is accepted).

### Telemetry enablement (Android-free)

`Telemetry.enabled` is now resolved at runtime from the system property
`cb.telemetry.enabled`, then the env var `CB_TELEMETRY_ENABLED`, and defaults to `false`.
On Android, callers can drive it explicitly via `Telemetry.setEnabled(...)` (e.g. from a
build-time flag) so the engine module has no `BuildConfig`/Android dependency.

---

*Document Version: 1.0*  
*Generated from: CHOWKA_BARA_RULES_DOCUMENTATION.md*  
*Total Test Cases: 200+ across all categories*  
*Platforms: Android (Kotlin/JUnit/Compose Test/Espresso) + Web (Jest/Playwright)*