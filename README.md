# Choka Barah (Chowka Bara / Ashta Chamma)

Choka Barah is a modern implementation of the traditional Indian race strategy
board game. It ships as a native **Android (Jetpack Compose)** app backed by a
pure-JVM **Kotlin rules engine**, plus a **web** version (HTML/CSS/JS).

| Variant | Board   | Cowries | Pawns/Player |
|---------|---------|---------|--------------|
| 5-House | 5×5     | 4       | 4            |
| 7-House | 7×7     | 6       | 4            |

## Repository Layout

```
app/                 Android app (Jetpack Compose UI, instrumentation tests)
engine/              Pure-JVM Kotlin rules engine (+ 63 unit tests)
web/                 Web implementation (vanilla JS + Playwright E2E)
.github/workflows/   CI - web tests, engine tests, Android build & emulator tests
CHOWKA_BARA_RULES_DOCUMENTATION.md   Complete rules spec (source of truth)
CHOWKA_BARA_TEST_CASES.md            Documented test cases per rule
```

## The Rules Engine (`:engine`)

The engine is the single source of truth for gameplay on both platforms. It is
instrumented with structured telemetry (`Telemetry`) covering rolls, moves,
captures, and victory.

Key behaviour (verified against the rules doc):

- Cowry scoring: 1/2/3/4, plus 4 (Chauka) and 0 (Bara = 8) awarding an extra roll
- Gate (index 16 on 7×7 / 24 on 5×5): inner-track entry is **locked** until the
  player captures ("cuts") at least one opponent pawn
- Gatti (stack) immunity: an opponent's stacked Gatti cannot be captured
- Safe squares (`X`): pawns resting there cannot be captured and may share the cell
- Extra turn on capture; extra roll on Chauka/Bara
- Bot AI priority: capture → return home → safe square → Gatti → furthest pawn

## Android App

- Jetpack Compose, Material 3, min SDK 24, target/compile SDK 34
- Screens: Home (board size / players / game mode), Game (board, cowry roll,
  quick-pawn-select, pause + victory dialogs), Rules dialog
- Modes: Pass & Play (2–4 players) and vs Bot (AI)

### Build & Run

```sh
# requires JDK 17 + Android SDK (set ANDROID_HOME, or add local.properties)
./gradlew :app:assembleDebug
./gradlew connectedDebugAndroidTest   # instrumented tests on a connected device/emulator
```

Telemetry is off by default; enable at compile time:

```sh
./gradlew :app:assembleDebug -PtelemetryEnabled=true
```

### Engine Tests (no Android SDK required)

```sh
CB_ENGINE_ONLY=1 ./gradlew :engine:test
```

## Web App

```sh
cd web
npm install
npm run serve       # local static server on http://localhost:3111
npm test            # Jest unit tests + coverage
npm run e2e         # Playwright E2E + axe-core accessibility
```

## CI

`.github/workflows/ci.yml` runs, on push/PR: web unit tests + coverage threshold
(≥95% statements, ≥90% branches), telemetry trace smoke, Playwright E2E,
engine JVM tests, and Android lint/build/unit instrumented emulator tests.

## Notes

- The Android UI was recovered from compiled bytecode (see commit history) — a
  dedicated decompilation recovery process; the restored sources are verified by
  the instrumented Compose tests.