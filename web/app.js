// ============================================================
// CHOKA BARAH – Complete Rules-Accurate Game Engine
// Rules source: rollthedice.in/pages/how-to-play-chowka-bara-*
// Instrumented with structured telemetry (see telemetry.js).
// ============================================================
(function () {
'use strict';

// ---- Telemetry (zero-cost when disabled) ----
// NOTE: `T` is a top-level const declared by game-engine.js (loaded first).
// Classic scripts share the global lexical environment, so app.js must NOT
// redeclare `const T` (that throws "Identifier 'T' has already been declared").
// game-engine.js sets T = window.Telemetry, falling back to a no-op shim.

// ---- Shared game engine (game-engine.js) ----
// All core game logic (paths, safe cells, cowry scoring, valid-move calculation,
// move execution, bot selection) lives in the unit-tested game-engine.js. app.js
// consumes the SAME code here so what ships == what is tested (no logic drift).
const EG = (typeof window !== 'undefined' && window.ChokaBarahEngine) || {};

// ---- Sound feedback (sound.js, US-27) ----
// No-op fallback so the game still runs if the sound module is unavailable.
const Sound = (typeof window !== 'undefined' && window.Sound) || {
    play() { return false; },
    isMuted() { return false; },
    setMuted() { return false; },
    toggleMute() { return false; }
};

// Helper to snapshot a pawn for telemetry (avoid logging object identity).
function pawnSnapshot(pawn) {
    return {
        id: pawn.id,
        playerIndex: pawn.playerIndex,
        state: pawn.state,
        pathIndex: pawn.pathIndex
    };
}

function boardSnapshot() {
    return {
        gridSize: currentGridSize,
        playerNum: playerNum,
        gameMode: gameMode,
        currentPlayerIndex: currentPlayerIndex,
        currentRoll: currentRoll ? { shells: (currentRoll.shells||[]).map(Boolean), score: currentRoll.score, isExtraRoll: !!currentRoll.isExtraRoll } : null,
        validMoveCount: validMoves.length,
        winner: winner ? (winner.name || winner) : null,
        gameActive: gameActive,
        hasCaptured: Object.assign({}, hasCapturedOpponent),
        pawns: pawns.map(pawnSnapshot)
    };
}

// ---- Config & State ----
let currentGridSize = 5;
let playerNum = 2;
let gameMode = 'pnp';

let currentPlayerIndex = 0;
let playerColors = [
    { name: 'Red (South)',   hex: '#C62828', textHex: '#FFFFFF', lightHex: '#FFCDD2' },
    { name: 'Green (North)', hex: '#2E7D32', textHex: '#FFFFFF', lightHex: '#C8E6C9' },
    { name: 'Yellow (East)', hex: '#FDD835', textHex: '#212121', lightHex: '#FFF9C4' },
    { name: 'Blue (West)',   hex: '#1565C0', textHex: '#FFFFFF', lightHex: '#BBDEFB' }
];

let pawns = [];
let hasCapturedOpponent = {};
let currentRoll = null;   // { shells:[], score, isExtraRoll }
let validMoves = [];
let winner = null;
let gameActive = true;    // false once we leave the game screen (stops bot timers)
let botTimer = null;      // handle of the scheduled bot turn
let turnTimer = null;     // 1s auto-advance after a no-valid-moves roll (BUG-02)
let victoryTimer = null;  // delayed victory banner after a win (BUG-03)

const canvas = document.getElementById('board-canvas');
const ctx    = canvas.getContext('2d');

// ---- Navigation helpers ----
function setGridSize(s) {
    T.info('ui', 'config.grid_size_changed', `Grid size set to ${s}x${s}`, { from: currentGridSize, to: s });
    currentGridSize = s;
    document.getElementById('btn-grid-5').classList.toggle('active', s === 5);
    document.getElementById('btn-grid-7').classList.toggle('active', s === 7);
}
function setPlayers(n) {
    T.info('ui', 'config.player_count_changed', `Player count set to ${n}`, { from: playerNum, to: n });
    playerNum = n;
    [2,3,4].forEach(v => document.getElementById(`btn-p${v}`).classList.toggle('active', n === v));
}
function setGameMode(m) {
    T.info('ui', 'config.game_mode_changed', `Game mode set to ${m}`, { from: gameMode, to: m });
    gameMode = m;
    document.getElementById('btn-mode-pnp').classList.toggle('active', m === 'pnp');
    document.getElementById('btn-mode-bot').classList.toggle('active', m === 'bot');
}
function openRules()  { T.info('ui', 'rules.opened', 'Rules modal opened', {}); document.getElementById('rules-modal').classList.remove('hidden'); }
function closeRules() { T.info('ui', 'rules.closed', 'Rules modal closed', {}); document.getElementById('rules-modal').classList.add('hidden'); }
function showHomeScreen() {
    T.info('ui', 'navigation.to_home', 'Navigated to home screen', { priorGameActive: gameActive });
    // Stop any pending game timers (bot turn, no-move auto-advance, victory
    // banner) so they don't leak onto the menu / next game (BUG-02/BUG-03).
    gameActive = false;
    clearScheduledTimers();
    document.getElementById('home-screen').classList.add('active');
    document.getElementById('game-screen').classList.remove('active');
}
function startGame() {
    T.info('session', 'game.started', `Game started: ${currentGridSize}x${currentGridSize}, ${playerNum} players, mode=${gameMode}`,
        { gridSize: currentGridSize, playerNum, gameMode, sessionId: T.getSessionId ? T.getSessionId() : undefined });
    gameActive = true;
    document.getElementById('home-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');
    document.getElementById('board-title').innerText = `${currentGridSize}x${currentGridSize} CHOKA BARAH`;
    initGameState();
    renderBoard();
    Sound.play('game_start');
}
function restartGame() {
    T.info('ui', 'game.restarted', 'Game restarted by user', boardSnapshot());
    // Cancel any scheduled game timers (bot turn, no-move advance, victory
    // banner) so none can fire into the fresh game (BUG-02/BUG-03/BUG-07).
    clearScheduledTimers();
    initGameState();
    renderBoard();
}

// Toggle sound mute (US-27). Reflects state in the mute button label.
function toggleMute() {
    const muted = Sound.toggleMute();
    const btn = document.getElementById('btn-mute');
    if (btn) btn.innerText = muted ? '🔇' : '🔊';
    T.info('ui', 'sound.toggled', `Sound ${muted ? 'muted' : 'unmuted'}`, { muted });
    return muted;
}

// Schedule the bot turn coalescing overlapping timers.
function scheduleBotTurn(ms) {
    if (!gameActive || gameMode !== 'bot' || winner !== null) return;
    clearTimeout(botTimer);
    botTimer = setTimeout(() => {
        botTimer = null;
        if (gameActive) handleBotTurn();
    }, ms);
}

// All auto-advance / victory-deferred timers are created exclusively through
// these helpers so a single cancel path (used by restart/home/init) can never
// miss one (BUG-02 / BUG-03 timer leaks).
function scheduleTurnTimer(ms) {
    clearTimeout(turnTimer);
    turnTimer = setTimeout(() => {
        turnTimer = null;
        advanceTurn();
    }, ms);
}
function scheduleVictoryBanner(ms) {
    clearTimeout(victoryTimer);
    victoryTimer = setTimeout(() => {
        victoryTimer = null;
        showVictoryBanner();
    }, ms);
}
function clearScheduledTimers() {
    if (botTimer)    { clearTimeout(botTimer);     botTimer = null; }
    if (turnTimer)   { clearTimeout(turnTimer);    turnTimer = null; }
    if (victoryTimer){ clearTimeout(victoryTimer); victoryTimer = null; }
}

// US-xx: the roll button must never be actionable for a bot turn. BUG-06:
// advanceTurn re-enabled the button unconditionally, which exposed it on
// bot-controlled players.
function isBotTurn() {
    return gameMode === 'bot' && currentPlayerIndex !== 0;
}

// ---- Init ----
function initGameState() {
    pawns = [];
    hasCapturedOpponent = {};
    for (let p = 0; p < playerNum; p++) {
        hasCapturedOpponent[p] = false;
        for (let id = 0; id < 4; id++) {
            pawns.push({ id: p*4+id, playerIndex: p, state: 'HOME_BASE', pathIndex: -1 });
        }
    }
    currentPlayerIndex = 0;
    currentRoll        = null;
    validMoves         = [];
    winner             = null;

    // Re-enable the roll button on every fresh game (BUG-06): a previous
    // victory banner disabled it, and reset must undo that for a new game.
    // Do this BEFORE updateUI so the button is styled as actionable for P0.
    const rollBtn = document.getElementById('btn-roll');
    if (rollBtn) rollBtn.disabled = false;

    T.debug('engine', 'state.initialized', 'Game state initialized', boardSnapshot());

    updateUI();
    setLog(`Game Started! Player ${playerColors[0].name}'s turn. Roll cowries!`);

    // Render correct number of cowry shells on first load
    renderCowryShells(null);
}

// ============================================================
// BOARD PATHS & SAFE CELLS
// Delegated to the shared, unit-tested engine (game-engine.js) so the
// shipped code is identical to the code exercised by the test suite.
// ============================================================

const getPlayerPath = (gridSize, pIndex) => EG.getPlayerPath(gridSize, pIndex);
const innerStartIndex = (gridSize) => EG.innerStartIndex(gridSize);

function isSafeCell(gridSize, r, c) { return EG.isSafeCell(gridSize, r, c); }

// app.js historically called numShells() relying on the global grid size.
function numShells(gs) {
    const resolved = (gs !== undefined) ? gs : currentGridSize;
    return EG.numShells(resolved);
}

function handleRoll() {
    const spanId = T.startSpan ? T.startSpan('roll', { player: currentPlayerIndex }) : null;
    if (currentRoll !== null || winner !== null) {
        T.warn('input', 'roll.ignored', 'Roll requested but not allowed', { currentRollPresent: currentRoll !== null, winnerPresent: winner !== null });
        if (spanId && T.endSpan) T.endSpan(spanId, { outcome: 'ignored' });
        return;
    }

    const n = numShells();
    const shells = Array.from({length: n}, () => Math.random() > 0.5);
    const mouthUp = shells.filter(s => s).length;

    // Scoring delegated to the shared, unit-tested engine (game-engine.js)
    const { score, scoreText, isExtraRoll } = EG.scoreCowryRoll(currentGridSize, shells);
    currentRoll = { shells, score, isExtraRoll };

    Sound.play('roll');

    T.info('dice', 'dice.rolled', `Player ${currentPlayerIndex} rolled score ${score} (${scoreText})`,
        { playerIndex: currentPlayerIndex, shells, mouthUp, score, isExtraRoll, gridSize: currentGridSize });

    renderCowryShells(shells);
    const scoreDisplay = document.getElementById('roll-score-display');
    scoreDisplay.innerText = scoreText;
    // US-06: highlight the roll when it grants an extra roll (Chowka/Baara).
    scoreDisplay.classList.toggle('is-extra', !!isExtraRoll);

    calculateValidMoves(score);

    T.debug('engine', 'moves.computed', `Computed ${validMoves.length} valid moves after roll`,
        { playerIndex: currentPlayerIndex, score, validMoveCount: validMoves.length,
          moveTargets: validMoves.map(m => ({ coords: m.targetCoords, capture: m.isCapture, home: m.reachesHome, gatti: m.isGattiGroup })) });

    if (validMoves.length === 0) {
        Sound.play('invalid');
        setLog(`Rolled ${scoreText} — No valid moves!`);
        T.info('engine', 'roll.no_valid_moves', `Player ${currentPlayerIndex} rolled ${score} with no valid moves`, { playerIndex: currentPlayerIndex, score, isExtraRoll });
        if (isExtraRoll) {
            currentRoll = null;
            // BUG-06: only a human is allowed to immediately re-roll; a bot's
            // next roll is dispatched through scheduleBotTurn instead.
            document.getElementById('btn-roll').disabled = isBotTurn();
            T.info('engine', 'roll.extra_no_moves_reset', 'Extra roll had no moves; roll reset for re-roll', { playerIndex: currentPlayerIndex });
            if (gameMode === 'bot' && currentPlayerIndex !== 0 && winner === null) {
                scheduleBotTurn(300);
            }
        } else {
            // A roll with no valid moves gives the interface a beat to show the
            // math BEFORE auto-advancing. The roll button is pressed during this
            // window is a dead env-roll (no state), so reflect that (BUG-05).
            document.getElementById('btn-roll').disabled = true;
            scheduleTurnTimer(1000);
        }
    } else {
        setLog(`Rolled ${scoreText}! Select a pawn to move.`);
        document.getElementById('btn-roll').disabled = true;
    }

    renderBoard();
    updateUI();
    if (spanId && T.endSpan) T.endSpan(spanId, { outcome: 'applied', score, validMoveCount: validMoves.length });
}

function renderCowryShells(shells) {
    const container = document.getElementById('cowry-shells');
    container.innerHTML = '';
    const n = shells ? shells.length : numShells();
    for (let i = 0; i < n; i++) {
        const isOpen = shells ? shells[i] : (i % 2 === 0);
        const div = document.createElement('div');
        div.className = `shell ${isOpen ? 'open' : 'closed'}`;
        container.appendChild(div);
    }
}

// ============================================================
// VALID MOVE CALCULATION
// Delegated entirely to the shared, unit-tested engine (game-engine.js)
// so the rules (gate, Gatti immunity, capture, overshoot) are exercised
// by the exact code that ships.
// ============================================================
function calculateValidMoves(score) {
    validMoves = EG.calculateValidMoves(
        currentGridSize,
        pawns,
        currentPlayerIndex,
        hasCapturedOpponent,
        score
    );
}

// ============================================================
// EXECUTE MOVE
// Applies the move via the shared, unit-tested engine (game-engine.js),
// then performs the UI/log/telemetry side-effects. This keeps the game
// rule engine identical to the code covered by the test suite.
// ============================================================
function executeMove(move) {
    const spanId = T.startSpan ? T.startSpan('move', { player: currentPlayerIndex, target: move.targetCoords }) : null;
    const [tr, tc] = move.targetCoords;

    T.debug('engine', 'move.start', `Executing move for ${move.grpPawns.length} pawn(s) to ${tr},${tc}`,
        { pawnIds: move.grpPawns.map(p=>p.id), targetPathIndex: move.targetPathIndex, targetCoords: move.targetCoords, isCapture: move.isCapture, reachesHome: move.reachesHome });

    const result = EG.executeMove(
        currentGridSize,
        pawns,
        hasCapturedOpponent,
        currentPlayerIndex,
        move,
        currentRoll || { isExtraRoll: false }
    );

    pawns               = result.pawns;
    hasCapturedOpponent = result.hasCapturedOpponent;
    const extraTurn     = result.extraTurn;
    const gattiFormed   = result.gattiFormed;
    const capturedCount = result.capturedCount;
    const winnerIdx     = result.winner;

    // Sound feedback: one distinct cue per move, victory has priority.
    if (winnerIdx !== null) Sound.play('victory');
    else if (capturedCount > 0) Sound.play('capture');
    else if (gattiFormed) Sound.play('gatti');
    else if (extraTurn) Sound.play('extra_roll');
    else Sound.play('move');

    if (capturedCount > 0) {
        T.info('engine', 'move.capture', `Player ${currentPlayerIndex} captured ${capturedCount} opponent pawns`, { byPlayer: currentPlayerIndex, targetCoords: move.targetCoords });
        setLog(`✂️ CUT! Captured opponent's pawn(s). Inner path unlocked! Extra turn!`);
    }

    if (gattiFormed) {
        T.info('engine', 'move.gatti_formed', `Player ${currentPlayerIndex} formed a Gatti at ${tr},${tc}`, { byPlayer: currentPlayerIndex, targetCoords: move.targetCoords, pawnIds: move.grpPawns.map(p=>p.id) });
        const prev = document.getElementById('game-log').innerText;
        setLog(prev + ` 🔗 GATTI! Your pawns are now toughened at this square!`);
    }

    if (winnerIdx !== null) {
        winner = playerColors[winnerIdx];
        T.info('game', 'game.victory', `Player ${currentPlayerIndex} (${winner.name}) won the game`, { winnerIndex: currentPlayerIndex, winnerName: winner.name, gridSize: currentGridSize, playerNum });
        renderBoard();
        updateUI();
        // BUG-04: disable the roll button on EVERY victory path. A Gatti cannot
        // coincide with this move (a Gatti needs a pawn to remain ON_TRACK while
        // a win finishes the last pawn), so there is only the single banner path.
        document.getElementById('btn-roll').disabled = true;
        scheduleVictoryBanner(200);
        if (spanId && T.endSpan) T.endSpan(spanId, { outcome: 'victory', reachesHome: true, gattiFormed });
        return;
    }

    currentRoll   = null;
    validMoves    = [];

    if (extraTurn) {
        const gl = document.getElementById('game-log');
        T.debug('engine', 'turn.extra', `Player ${currentPlayerIndex} gets an extra turn (${move.isCapture ? 'capture' : 'chowka/baara'})`, { playerIndex: currentPlayerIndex, reason: move.isCapture ? 'capture' : 'score' });
        setLog(`${gl.innerText} 🎲 Extra roll!`);
        // BUG-06: a bot granted an extra turn keeps the button inert.
        document.getElementById('btn-roll').disabled = isBotTurn();
        if (gameMode === 'bot' && currentPlayerIndex !== 0 && winner === null) {
            scheduleBotTurn(700);
        }
    } else {
        advanceTurn();
    }

    renderBoard();
    updateUI();
    if (spanId && T.endSpan) T.endSpan(spanId, { outcome: 'applied', extraTurn, gattiFormed });
}

function showVictoryBanner() {
    // BUG-01 (UI-side): a deferred banner must never render after the game was
    // reset (winner cleared) — guard against the stale-timer crash path.
    if (!winner || !winner.name) return;
    const name = winner.name;
    document.getElementById('game-log').innerText =
        `🎉 VICTORY! ${name} has moved all 4 pawns to Center Home! Play again ↻`;
    document.getElementById('btn-roll').disabled = true;
    T.debug('ui', 'ui.victory_banner_shown', 'Victory banner displayed', { winnerName: name });
}

// ============================================================
// TURN MANAGEMENT
// ============================================================
function advanceTurn() {
    const from = currentPlayerIndex;
    currentPlayerIndex = (currentPlayerIndex + 1) % playerNum;
    currentRoll        = null;
    validMoves         = [];
    // BUG-06: keep the roll button non-actionable while it is a bot's turn;
    // only the human player (a botGame turn index 0) may interact with it.
    document.getElementById('btn-roll').disabled = isBotTurn();
    document.getElementById('roll-score-display').innerText = '';

    T.info('engine', 'turn.advanced', `Turn advanced from player ${from} to player ${currentPlayerIndex}`, { from, to: currentPlayerIndex, playerNum });

    updateUI();
    setLog(`Player ${playerColors[currentPlayerIndex].name}'s turn. Roll cowries!`);
    renderCowryShells(null);
    renderBoard();

    if (gameMode === 'bot' && currentPlayerIndex !== 0 && winner === null) {
        scheduleBotTurn(700);
    }
}

// ============================================================
// BOT AI
// Priority: Capture > reach center > land safe > advance Gatti
//           > advance furthest pawn
// ============================================================
function handleBotTurn() {
    if (!gameActive || winner !== null) return;
    if (currentRoll === null) {
        T.debug('bot', 'bot.rolling', `Bot (player ${currentPlayerIndex}) rolling cowries`, { playerIndex: currentPlayerIndex });
        handleRoll();
        if (validMoves.length > 0) { scheduleBotTurn(700); }
        return;
    }
    if (validMoves.length === 0) return;

    let best = EG.selectBotMove(validMoves, currentGridSize);

    if (best) {
        T.debug('bot', 'bot.move_selected', `Bot selected move for ${best.grpPawns.map(p=>`#${(p.id%4)+1}`).join('+')} to ${best.targetCoords}`,
            { playerIndex: currentPlayerIndex, chosenMove: { pawnIds: best.grpPawns.map(p=>p.id), targetCoords: best.targetCoords, isCapture: best.isCapture, reachesHome: best.reachesHome, isGattiGroup: best.isGattiGroup }, candidateCount: validMoves.length });
        executeMove(best);
    }
}

// ============================================================
// UI UPDATES
// ============================================================

// US-04 / US-24: render the participating players' names/colors as a
// legend strip, highlighting whose turn it is.
// Active chip = full player colour + white/dark readable text (WCAG AA).
// Inactive chips drop to a dark neutral fill with the player colour as a
// left edge so identity is kept WITHOUT reducing text contrast (opacity
// dimming on the label would break WCAG colour-contrast AA).
function renderPlayerStrip() {
    const container = document.getElementById('player-strip');
    if (!container) return;
    container.innerHTML = '';
    for (let p = 0; p < playerNum; p++) {
        const chip = document.createElement('div');
        const isActive = (p === currentPlayerIndex && winner === null);
        chip.className = 'player-chip' + (isActive ? ' active' : '');
        if (isActive) {
            chip.style.backgroundColor = playerColors[p].hex;
            chip.style.color = playerColors[p].textHex;
        } else {
            chip.style.backgroundColor = '#1E1B18';
            chip.style.borderLeftColor = playerColors[p].hex;
            chip.style.color = '#FFFFFF';
        }
        chip.textContent = playerColors[p].name + (gameMode === 'bot' && p !== 0 ? ' 🤖' : '');
        container.appendChild(chip);
    }
}

function updateUI() {
    const pColor = playerColors[currentPlayerIndex];
    document.getElementById('turn-banner').style.backgroundColor = pColor.hex;

    const isBot = (gameMode === 'bot' && currentPlayerIndex !== 0);
    const turnText = document.getElementById('turn-text');
    turnText.innerText =
        `TURN: ${pColor.name}${isBot ? ' 🤖 (BOT)' : ''}`;
    turnText.style.color = pColor.textHex;

    // US-24: color the Roll button for the current player whenever it is
    // actionable; fall back to the disabled style otherwise.
    const rollBtn = document.getElementById('btn-roll');
    if (winner === null && !rollBtn.disabled) {
        rollBtn.style.background = pColor.hex;
        rollBtn.style.color = pColor.textHex;
        rollBtn.style.border = '2px solid #FFFFFF';
    } else {
        rollBtn.style.background = '';
        rollBtn.style.color = '';
        rollBtn.style.border = '';
    }

    renderPlayerStrip();

    const isUnlocked = hasCapturedOpponent[currentPlayerIndex];
    const badge = document.getElementById('cut-status-badge');
    badge.className = `badge ${isUnlocked ? 'unlocked' : 'locked'}`;
    badge.innerText = isUnlocked ? '🔓 INNER UNLOCKED' : '🔒 CUT REQUIRED';

    // Pawn buttons
    const selectBar    = document.getElementById('pawn-select-bar');
    const btnContainer = document.getElementById('pawn-buttons-container');
    btnContainer.innerHTML = '';

    if (validMoves.length > 0 && !isBot && winner === null) {
        selectBar.classList.remove('hidden');
        validMoves.forEach(move => {
            const btn = document.createElement('button');
            btn.className = 'pawn-btn';
            const pawn  = move.grpPawns[0];
            const label = pawn.state === 'HOME_BASE' ? 'Base' : `Pos #${pawn.pathIndex + 1}`;
            const gattiTag = move.isGattiGroup ? ' [GATTI]' : '';
            btn.innerText = `Pawn ${move.grpPawns.map(p=>`#${(p.id%4)+1}`).join('+')} (${label})${gattiTag}`;
            btn.onclick = () => {
                T.debug('input', 'pawn.selected', `User selected ${move.grpPawns.map(p=>`#${(p.id%4)+1}`).join('+')} via quick-list`,
                    { pawnIds: move.grpPawns.map(p=>p.id), targetCoords: move.targetCoords, isCapture: move.isCapture });
                executeMove(move);
            };
            btnContainer.appendChild(btn);
        });
    } else {
        selectBar.classList.add('hidden');
    }
}

function setLog(msg) {
    document.getElementById('game-log').innerText = msg;
}

// ============================================================
// BOARD RENDERER (Canvas 2D)
// ============================================================
function renderBoard() {
    const size     = canvas.width;
    const cs       = size / currentGridSize; // cell size
    const centerR  = Math.floor(currentGridSize / 2);
    const centerC  = Math.floor(currentGridSize / 2);

    ctx.clearRect(0, 0, size, size);

    // 1. Draw cells
    for (let r = 0; r < currentGridSize; r++) {
        for (let c = 0; c < currentGridSize; c++) {
            const safe   = isSafeCell(currentGridSize, r, c);
            const center = (r === centerR && c === centerC);

            ctx.fillStyle = center ? '#C62828' :
                            safe   ? '#FFF8E1' :
                            (r + c) % 2 === 0 ? '#F5E6CA' : '#E6D3B1';
            ctx.fillRect(c * cs, r * cs, cs, cs);

            ctx.strokeStyle = '#5D4037';
            ctx.lineWidth   = 2;
            ctx.strokeRect(c * cs, r * cs, cs, cs);

            if (safe && !center) {
                const margin = cs * 0.15;
                ctx.strokeStyle = '#8D6E63';
                ctx.lineWidth   = 3;
                ctx.beginPath();
                ctx.moveTo(c*cs + margin, r*cs + margin);
                ctx.lineTo((c+1)*cs - margin, (r+1)*cs - margin);
                ctx.moveTo((c+1)*cs - margin, r*cs + margin);
                ctx.lineTo(c*cs + margin, (r+1)*cs - margin);
                ctx.stroke();
            }

            if (center) {
                const cx = c * cs + cs / 2;
                const cy = r * cs + cs / 2;
                ctx.fillStyle = '#FFD54F';
                ctx.beginPath();
                ctx.arc(cx, cy, cs * 0.38, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#C62828';
                ctx.beginPath();
                ctx.moveTo(cx, cy - cs*0.22);
                ctx.lineTo(cx + cs*0.22, cy);
                ctx.lineTo(cx, cy + cs*0.22);
                ctx.lineTo(cx - cs*0.22, cy);
                ctx.closePath();
                ctx.fill();
            }
        }
    }

    // 2. Draw valid-move highlights
    validMoves.forEach(m => {
        const [r, c] = m.targetCoords;
        ctx.fillStyle = m.isCapture ? 'rgba(255,82,82,0.38)' : 'rgba(118,255,3,0.35)';
        ctx.beginPath();
        ctx.arc(c*cs + cs/2, r*cs + cs/2, cs * 0.40, 0, Math.PI*2);
        ctx.fill();
        ctx.strokeStyle = m.isCapture ? '#FF5252' : '#76FF03';
        ctx.lineWidth   = 3;
        ctx.stroke();
    });

    // 3. Group pawns by board cell. Only pawns still on the track are drawn;
    //    FINISHED pawns have reached center home and are removed from the board
    //    (BUG-10) — they must not be grouped into a gold 'G' Gatti bundle.
    const cellMap = {};
    pawns.forEach(pawn => {
        if (pawn.state === 'FINISHED') return;
        let coords;
        if (pawn.state === 'ON_TRACK') {
            coords = getPlayerPath(currentGridSize, pawn.playerIndex)[pawn.pathIndex];
        } else {
            coords = getPlayerPath(currentGridSize, pawn.playerIndex)[0];
        }
        if (coords) {
            const key = `${coords[0]},${coords[1]}`;
            if (!cellMap[key]) cellMap[key] = [];
            cellMap[key].push(pawn);
        }
    });

    // 4. Draw pawn groups
    Object.entries(cellMap).forEach(([key, list]) => {
        const [r, c] = key.split(',').map(Number);
        const cx0 = c * cs + cs / 2;
        const cy0 = r * cs + cs / 2;
        const pr  = cs * 0.17;

        const samePlayer = list.every(p => p.playerIndex === list[0].playerIndex);
        const isGattiCell = samePlayer && list.length >= 2;

        list.forEach((pawn, idx) => {
            let ox = 0, oy = 0;
            if (list.length === 2) {
                ox = (idx === 0 ? -1 : 1) * pr * 0.75;
                oy = (idx === 0 ? -1 : 1) * pr * 0.75;
            } else if (list.length === 3) {
                const angles = [-Math.PI/2, Math.PI/6, 5*Math.PI/6];
                ox = Math.cos(angles[idx]) * pr * 0.85;
                oy = Math.sin(angles[idx]) * pr * 0.85;
            } else if (list.length >= 4) {
                const angles = [-Math.PI/4, Math.PI/4, 3*Math.PI/4, -3*Math.PI/4];
                ox = Math.cos(angles[idx % 4]) * pr * 0.9;
                oy = Math.sin(angles[idx % 4]) * pr * 0.9;
            }

            const px = cx0 + ox;
            const py = cy0 + oy;

            if (isGattiCell) {
                ctx.strokeStyle = '#FFD54F';
                ctx.lineWidth   = 5;
                ctx.beginPath();
                ctx.arc(px, py, pr + 4, 0, Math.PI * 2);
                ctx.stroke();
            }

            ctx.fillStyle = playerColors[pawn.playerIndex].hex;
            ctx.beginPath();
            ctx.arc(px, py, pr, 0, Math.PI * 2);
            ctx.fill();

            ctx.strokeStyle = '#FFFFFF';
            ctx.lineWidth   = 3;
            ctx.stroke();

            ctx.fillStyle   = '#FFFFFF';
            ctx.font        = `bold ${Math.round(pr * 0.9)}px sans-serif`;
            ctx.textAlign   = 'center';
            ctx.textBaseline= 'middle';
            ctx.fillText(`${(pawn.id % 4) + 1}`, px, py);
        });

        if (isGattiCell) {
            ctx.fillStyle   = '#FFD54F';
            ctx.font        = `bold ${Math.round(pr * 0.7)}px sans-serif`;
            ctx.textAlign   = 'center';
            ctx.textBaseline= 'middle';
            ctx.fillText('G', cx0, cy0 + pr * 1.9);
        }
    });
}

// ============================================================
// BOARD CLICK
// ============================================================
canvas.addEventListener('click', e => {
    if (!gameActive || winner !== null) return;
    if (gameMode === 'bot' && currentPlayerIndex !== 0) return;

    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    const x      = (e.clientX - rect.left) * scaleX;
    const y      = (e.clientY - rect.top)  * scaleY;
    const cs     = canvas.width / currentGridSize;

    const col = Math.min(Math.floor(x / cs), currentGridSize - 1);
    const row = Math.min(Math.floor(y / cs), currentGridSize - 1);

    if (validMoves.length === 0) {
        T.trace('input', 'board.tapped_none', `Tapped cell (${row},${col}) with no valid moves`, { row, col, gridSize: currentGridSize });
        return;
    }

    const move = validMoves.find(m => m.targetCoords[0] === row && m.targetCoords[1] === col);
    T.debug('input', 'board.tapped', `User tapped cell (${row},${col})`, { row, col, matchedMove: !!move, gridSize: currentGridSize, playerIndex: currentPlayerIndex });
    if (move) executeMove(move);
});

// Expose ONLY the handlers referenced by inline onclick attributes on window.
// Everything else stays inside the IIFE so its top-level identifiers (e.g.
// getPlayerPath, executeMove, advanceTurn, isSafeCell...) cannot collide with the
// same-named top-level declarations in game-engine.js — classic scripts share the
// global lexical environment and a duplicate top-level const/function is a SyntaxError.
window.setGridSize    = setGridSize;
window.setPlayers     = setPlayers;
window.setGameMode    = setGameMode;
window.openRules      = openRules;
window.closeRules     = closeRules;
window.showHomeScreen = showHomeScreen;
window.startGame      = startGame;
window.restartGame    = restartGame;
window.toggleMute     = toggleMute;
window.handleRoll     = handleRoll;

})();
