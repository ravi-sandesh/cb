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
let turnAdvanceLog = null; // "No valid moves" outcome preserved across the auto-advance (BUG-13)
let seniorMode = false;   // accessibility "Senior Mode" (bigger UI + relaxed pacing)

// ---- Online mode state (web/online-client.js transport) ----
let onlineSeat = -1;          // my server seat: 0 host / 1 guest, -1 until joined
let onlineMemberCount = 0;    // players currently seated in the room
let onlineLocked = false;     // a server move/roll is in flight; block local input
let onlineBoardReady = false; // at least one authoritative board has been applied

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
    document.getElementById('btn-mode-online').classList.toggle('active', m === 'online');
    const card = document.getElementById('online-card');
    if (card) card.classList.toggle('hidden', m !== 'online');
    if (m === 'online') refreshOnlineSections();
}
// ---- Rules modal (accessible dialog) ----
// Focus management: opening moves focus to the first focusable control,
// Tab/Shift+Tab cycle inside the dialog, Escape closes, and focus returns
// to the element that opened it.
let rulesOpener = null;
function modalFocusables(modal) {
    return Array.prototype.filter.call(
        modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
        el => el && !el.disabled
    );
}
function openRules()  {
    T.info('ui', 'rules.opened', 'Rules modal opened', {});
    const modal = document.getElementById('rules-modal');
    modal.classList.remove('hidden');
    rulesOpener = document.activeElement || null;
    const items = modalFocusables(modal);
    if (items.length) items[0].focus();
}
function closeRules() {
    T.info('ui', 'rules.closed', 'Rules modal closed', {});
    document.getElementById('rules-modal').classList.add('hidden');
    if (rulesOpener) rulesOpener.focus();
    rulesOpener = null;
}
function showHomeScreen() {
    T.info('ui', 'navigation.to_home', 'Navigated to home screen', { priorGameActive: gameActive });
    // BUG-02/BUG-03: leaving the board must not strand a pending timer — a bot
    // turn, the 1s no-move auto-advance, or the 200ms victory banner could
    // otherwise fire into the menu or a fresh game (see clearScheduledTimers).
    gameActive = false;
    clearScheduledTimers();
    boardCursor.row = -1; boardCursor.col = -1; // hide the keyboard cursor
    document.getElementById('home-screen').classList.add('active');
    document.getElementById('game-screen').classList.remove('active');
}
function startGame() {
    clearScheduledTimers();
    // Online: state is server-authoritative. If we aren't seated yet, direct
    // the player to the lobby; otherwise the board broadcast drives the screen.
    if (gameMode === 'online') {
        if (onlineSeat === -1) {
            setOnlineStatus('Create or join a room from the Online panel first.', true);
            return;
        }
        startOnlineGame();
        return;
    }
    // BUG-02/03/07 defense-in-depth: startGame can be reached without passing
    // through showHomeScreen (e.g. first cold-load of the page), so clear any
    // timers carried from a previous session before the fresh game begins. This
    // is cheap and idempotent — clearScheduledTimers() just Cancels registered
    // handles that may not exist.
    T.info('session', 'game.started', `Game started: ${currentGridSize}x${currentGridSize}, ${playerNum} players, mode=${gameMode}`,
        { gridSize: currentGridSize, playerNum, gameMode, sessionId: T.getSessionId ? T.getSessionId() : undefined });
    gameActive = true;
    document.getElementById('home-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');
    document.getElementById('board-title').innerText = `${currentGridSize}x${currentGridSize} CHOKA BARAH`;
    initGameState();
    renderBoard();
    Sound.play('game_start');
    // Keyboard play: focus the canvas so arrows work immediately.
    canvas.focus();
}
function restartGame() {
    T.info('ui', 'game.restarted', 'Game restarted by user', boardSnapshot());
    // Cancel any scheduled game timers (bot turn, no-move advance, victory
    // banner) so none can fire into the fresh game (BUG-02/BUG-03/BUG-07).
    clearScheduledTimers();
    // Online matches cannot be locally reset — the server owns the game state.
    if (gameMode === 'online') {
        setOnlineStatus(gameActive ? 'This online match cannot be restarted locally.' : '', true);
        return;
    }
    initGameState();
    renderBoard();
    canvas.focus();
}

// ---- Keyboard play ----
// The board is a canvas, which mice love and keyboards ignore. A movable
// cell cursor (arrow keys) plus Enter/Space gives the SAME actOnCell path a
// mouse click takes — one shared decision funnel for both input methods.
const boardCursor = { row: -1, col: -1 }; // negative = hidden

function handleBoardKeydown(e) {
    if (!gameActive || winner !== null) return;
    if (gameMode === 'bot' && currentPlayerIndex !== 0) return;
    if (gameMode === 'online' && currentPlayerIndex !== onlineSeat) return;
    const key = e.key;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(key)) return;
    e.preventDefault();

    if (key === 'Enter' || key === ' ') {
        if (boardCursor.row >= 0) actOnCell(boardCursor.row, boardCursor.col);
        return;
    }
    // Direction lookup: every key reaching this point is an arrow (the
    // whitelist above filtered everything else), so the map hit is total.
    const dir = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[key];
    if (boardCursor.row < 0) {
        const start = getPlayerPath(currentGridSize, currentPlayerIndex)[0];
        boardCursor.row = start[0];
        boardCursor.col = start[1];
    }
    boardCursor.row = Math.min(currentGridSize - 1, Math.max(0, boardCursor.row + dir[0]));
    boardCursor.col = Math.min(currentGridSize - 1, Math.max(0, boardCursor.col + dir[1]));
    renderBoard();
}

// Shared click/keyboard decision funnel for the board.
function actOnCell(row, col) {
    if (!gameActive || winner !== null) return;
    if (gameMode === 'bot' && currentPlayerIndex !== 0) return;
    if (gameMode === 'online' && currentPlayerIndex !== onlineSeat) return;

    if (validMoves.length === 0) {
        T.trace('input', 'board.tapped_none', `Tapped cell (${row},${col}) with no valid moves`, { row, col, gridSize: currentGridSize });
        return;
    }

    const move = validMoves.find(m => m.targetCoords[0] === row && m.targetCoords[1] === col);
    T.debug('input', 'board.tapped', `User tapped cell (${row},${col})`, { row, col, matchedMove: !!move, gridSize: currentGridSize, playerIndex: currentPlayerIndex });
    if (move) executeMove(move);
}

canvas.addEventListener('click', e => {
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    const x      = (e.clientX - rect.left) * scaleX;
    const y      = (e.clientY - rect.top)  * scaleY;
    const cs     = canvas.width / currentGridSize;

    const col = Math.min(Math.floor(x / cs), currentGridSize - 1);
    const row = Math.min(Math.floor(y / cs), currentGridSize - 1);
    actOnCell(row, col);
});
canvas.addEventListener('keydown', handleBoardKeydown);

// Modal keyboard support: Escape closes; Tab is trapped inside the dialog.
// Guarded so the degraded-DOM boot paths (tests / exotic embeds) still load.
if (typeof document.addEventListener === 'function') {
    document.addEventListener('keydown', e => {
        const modal = document.getElementById('rules-modal');
        if (!modal || modal.classList.contains('hidden')) return;
        if (e.key === 'Escape') { e.preventDefault(); closeRules(); return; }
        if (e.key !== 'Tab') return;
        const items = modalFocusables(modal);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    });
}

// Mute preference persistence (survives reloads; senior mode uses the same
// localStorage pattern). Key mirrors the controller's on/off semantics.
const MUTED_KEY = 'cb_muted';

function restoreMutePreference() {
    try {
        if (typeof Sound !== 'undefined' && typeof localStorage !== 'undefined' && localStorage.getItem(MUTED_KEY) === '1') {
            Sound.setMuted(true);
        }
    } catch (e) { /* storage unavailable (private mode) */ }
}

// Toggle sound mute (US-27). Reflects state in the mute button label and
// persists the choice so a reload keeps the player's preference.
function toggleMute() {
    const muted = Sound.toggleMute();
    const btn = document.getElementById('btn-mute');
    if (btn) btn.innerText = muted ? '🔇' : '🔊';
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
    } catch (e) { /* storage unavailable */ }
    T.info('ui', 'sound.toggled', `Sound ${muted ? 'muted' : 'unmuted'}`, { muted });
    return muted;
}

// ============================================================
// ONLINE MODE (auth + lobby + server-authoritative play)
// ------------------------------------------------------------
// Transport lives in web/online-client.js (window.OnlineClient).
// The app delegates every ROLL / MOVE to the server relay; the
// authoritative board is applied back through applyServerBoard().
// Local game-state mutations (initGameState / local roll / local
// executeMove) are bypassed while online so the two clients can
// never diverge. Telemetry events still fire for analytics.
// ============================================================

function onlineClient() {
    return (typeof window !== 'undefined' && window.OnlineClient) || null;
}

function setOnlineStatus(msg, isError) {
    const el = document.getElementById('online-status');
    if (el) {
        el.innerText = String(msg);
        el.classList.toggle('error', !!isError);
    }
}

async function refreshOnlineSections() {
    const oc = onlineClient();
    let authed = !!oc && !!oc.authed;
    try { authed = !!(oc && (await oc.whoami())); } catch (e) { /* offline: fall back to cached flag */ }
    const show = (id, on) => { const el = document.getElementById(id); if (el) el.classList.toggle('hidden', !on); };
    show('online-auth', !authed);
    show('online-authed', authed && onlineSeat !== 1);
    show('online-guest', authed && onlineSeat === 1);
}

function showOnlineWaiting(on) {
    const el = document.getElementById('online-waiting');
    if (el) el.classList.toggle('hidden', !on);
    if (on) {
        const oc = onlineClient();
        const codeEl = document.getElementById('online-room-code-display');
        if (codeEl && oc) codeEl.innerText = oc.code || '??????';
    }
}

async function onlineLogin() {
    const oc = onlineClient();
    if (!oc) { setOnlineStatus('Online is unavailable.', true); return; }
    const u = document.getElementById('online-username');
    const p = document.getElementById('online-password');
    const ok = await oc.login(u ? u.value : '', p ? p.value : '');
    if (ok) refreshOnlineSections();
}

async function onlineRegister() {
    const oc = onlineClient();
    if (!oc) { setOnlineStatus('Online is unavailable.', true); return; }
    const u = document.getElementById('online-username');
    const p = document.getElementById('online-password');
    const ok = await oc.register(u ? u.value : '', p ? p.value : '');
    if (ok) refreshOnlineSections();
}

async function onlineLogout() {
    const oc = onlineClient();
    if (oc) await oc.logout();
    onlineSeat = -1;
    onlineMemberCount = 0;
    // If we were mid-game, properly exit to home so the player isn't left
    // staring at a dead board with no opponent and a disconnected socket.
    if (gameActive) showHomeScreen();
    refreshOnlineSections();
}

async function onlineCreateRoom() {
    const oc = onlineClient();
    if (!oc) { setOnlineStatus('Online is unavailable.', true); return; }
    const code = await oc.createRoom(currentGridSize);
    if (code) showOnlineWaiting(true);
}

async function onlineJoinRoom() {
    const oc = onlineClient();
    if (!oc) { setOnlineStatus('Online is unavailable.', true); return; }
    const input = document.getElementById('online-room-code');
    await oc.joinRoom(input ? input.value : '');
}

// Flip to the game screen once both players are seated.
function startOnlineGame() {
    if (onlineSeat === -1) return;
    onlineMemberCount = 2; // both seated; relay confirmed
    gameActive = true;
    clearScheduledTimers();
    document.getElementById('home-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');
    document.getElementById('board-title').innerText = `${currentGridSize}x${currentGridSize} CHOKA BARAH — ONLINE`;
    Sound.play('game_start');
    renderBoard();
    updateUI();
}

// Apply a server-authoritative board to the local view. No game rules are
// run here — the relay already rolled/moved and the result is trusted.
function applyServerBoard(board) {
    if (!board) return;
    onlineBoardReady = true;
    // Hostile/buggy relay hardening: never trust numeric fields. A bad value
    // here used to crash the tab (undefined .hex) or hang the renderer.
    currentGridSize = (board.gridSize === 5 || board.gridSize === 7) ? board.gridSize : currentGridSize;
    playerNum = (board.playerNum === 2 || board.playerNum === 3 || board.playerNum === 4) ? board.playerNum : 2;
    pawns = (board.pawns || []).map(p => Object.assign({}, p));
    hasCapturedOpponent = Object.assign({}, board.hasCapturedOpponent || {});
    currentPlayerIndex = (board.currentPlayerIndex === undefined) ? 0 : board.currentPlayerIndex;
    if (!Number.isInteger(currentPlayerIndex) || currentPlayerIndex < 0 || currentPlayerIndex >= playerColors.length) {
        currentPlayerIndex = 0;
    }
    const scText = board.currentRoll ? (board.currentRoll.scoreText || board.currentRoll.score) : '';
    currentRoll = board.currentRoll ? {
        shells: board.currentRoll.shells || [],
        score: board.currentRoll.score,
        isExtraRoll: !!board.currentRoll.isExtraRoll,
        scoreText: scText
    } : null;
    validMoves = (board.validMoves || []).map(m => ({
        grpPawns: (m.pawnIds || []).map(id => pawns.find(p => p.id === id)).filter(Boolean),
        targetCoords: m.targetCoords,
        isCapture: m.isCapture,
        reachesHome: m.reachesHome,
        isGattiGroup: !!m.isGattiGroup
    }));
    // Guard the seat index: a hostile/buggy relay could broadcast an
    // out-of-range winner, which must degrade to a placeholder — never throw.
    const rawWinner = (board.winner === null || board.winner === undefined)
        ? null : playerColors[board.winner];
    winner = rawWinner || (board.winner == null ? null : { name: 'Unknown', hexColor: 0xFFFFB74D });

    if (winner !== null) {
        currentRoll = null;
        validMoves = [];
        clearRollDisplay();
        document.getElementById('btn-roll').disabled = true;
    } else {
        // Roll stays gated: only the seated player, on their turn, BEFORE a
        // roll exists, may roll. When a roll is pending they must move instead.
        const canRoll = (onlineSeat === currentPlayerIndex && currentRoll === null);
        document.getElementById('btn-roll').disabled = !canRoll;
        if (currentRoll !== null) {
            renderCowryShells(currentRoll.shells);
            const sd = document.getElementById('roll-score-display');
            sd.innerText = String(currentRoll.scoreText);
            sd.classList.toggle('is-extra', !!currentRoll.isExtraRoll);
        } else {
            renderCowryShells(null);
            clearRollDisplay();
        }
    }

    renderBoard();
    updateUI();

    const myTurn = (onlineSeat === currentPlayerIndex && winner === null);
    if (winner !== null) {
        setLog(`🎉 VICTORY! ${winner.name} has moved all 4 pawns to Center Home!`);
    } else if (myTurn) {
        setLog(currentRoll !== null ? `Rolled ${currentRoll.scoreText}! Select a pawn to move.` : `Your turn! Roll cowries!`);
    } else {
        setLog(`${playerColors[currentPlayerIndex].name}'s turn. Waiting for the opponent…`);
    }
}

// ---- OnlineClient delegate registration (idempotent at boot) ----
function setupOnlineClient() {
    const oc = onlineClient();
    if (!oc) return;

    oc.onStatus((msg, isErr) => setOnlineStatus(msg, isErr));
    oc.onJoined(({ playerIndex, gridSize }) => {
        onlineSeat = playerIndex;
        if (gridSize) currentGridSize = gridSize;
        refreshOnlineSections();
        if (playerIndex === 0) {
            showOnlineWaiting(true);
            setOnlineStatus('Room created! Share the code above — waiting for an opponent…');
        } else {
            showOnlineWaiting(false);
            setOnlineStatus('Joined the room! Waiting for the host…');
        }
    });
    oc.onPeerCount(({ count, playerNum }) => {
        onlineMemberCount = count;
        if (count >= (playerNum || 2)) startOnlineGame();
    });
    oc.onBoard(board => applyServerBoard(board));
    oc.onError(() => { /* status is already surfaced via onStatus */ });
    oc.onPeerLeft(() => {
        setOnlineStatus(gameActive ? 'Opponent left the game.' : 'Opponent left the lobby.', true);
        if (gameActive) showHomeScreen();
    });
    oc.onGameOver(() => { /* victory is rendered from the final board */ });
    oc.onClosed(() => {
        setOnlineStatus(gameActive ? 'Disconnected from the match.' : 'Disconnected.', true);
        refreshOnlineSections();
    });
}

setupOnlineClient();
refreshOnlineSections();

// ============================================================
// SENIOR MODE (accessibility)
// ------------------------------------------------------------
// A global "easier reading" toggle for senior players:
//   - Bigger text/buttons AND bigger board cells (CSS `body.senior-mode`
//     override + a wider .app-container in styles.css).
//   - Higher contrast text and a stronger disabled-button style.
//   - Reduced motion (CSS kills animations/transitions).
//   - Relaxed pacing: relaxedDelay() stretches every game-flow timeout
//     (bot turns, the no-move auto-advance, the victory banner) so a slower
//     reader is never rushed off the screen.
// Value is persisted in localStorage and re-applied at boot.
// ============================================================
const SENIOR_MODE_KEY = 'cb_senior_mode';

// STYLE/FONT details live in styles.css under `body.senior-mode ...`.
// relaxedDelay(NO_MULT) is only about timing; the 2.5x factor above still
// leaves the UI responsive while giving about 2x the human reaction window.
function relaxedDelay(ms) {
    return seniorMode ? Math.round(ms * 2.5) : ms;
}

function loadSeniorMode() {
    let saved = null;
    try {
        if (typeof localStorage !== 'undefined') {
            saved = localStorage.getItem(SENIOR_MODE_KEY);
        }
    } catch (e) { /* storage unavailable (SSR/CI) — default off */ }
    return saved === '1';
}

function saveSeniorMode() {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(SENIOR_MODE_KEY, seniorMode ? '1' : '0');
        }
    } catch (e) { /* ignore storage failures */ }
}

// Reflect seniorMode on the DOM: the body class drives every CSS override,
// and the home-screen toggle button mirrors the state (active chip + text).
function applySeniorModeVisuals() {
    const bodyEl = (typeof document !== 'undefined') ? document.body : null;
    if (bodyEl) bodyEl.classList.toggle('senior-mode', seniorMode);
    const btn = document.getElementById('btn-senior');
    if (btn) btn.classList.toggle('active', seniorMode);
    const title = document.getElementById('senior-title');
    if (title) title.innerText = seniorMode ? 'Senior Mode: ON' : 'Senior Mode: OFF';
    const sub = document.getElementById('senior-sub');
    if (sub) sub.innerText = seniorMode ? 'Bigger text & bigger buttons' : 'Tap to turn ON';
}

function setSeniorMode(flag) {
    seniorMode = !!flag;
    saveSeniorMode();
    applySeniorModeVisuals();
    T.info('ui', 'config.senior_mode_changed', `Senior mode ${seniorMode ? 'enabled' : 'disabled'}`, { seniorMode });
    // The player may toggle it mid-game; a pending paced action should keep the
    // new pace (re-render so the board uses the thicker senior strokes).
    if (gameActive) {
        renderBoard();
        updateUI();
    }
}

function toggleSeniorMode() {
    setSeniorMode(!seniorMode);
    return seniorMode;
}

// Boot: restore the persistent setting and apply it to the DOM immediately.
seniorMode = loadSeniorMode();
applySeniorModeVisuals();

// Schedule the bot turn coalescing overlapping timers. Only ever called for a
// bot-controlled player (currentPlayerIndex !== 0 in 'bot' mode) and only while
// a game is actually active. The pre-existing timer (if any) is cleared first,
// so a rapid extra-turn chain can never stack two bot callbacks for the same
// turn — a stale handle would double-advance the board.
function scheduleBotTurn(ms) {
    if (!gameActive || gameMode !== 'bot' || winner !== null) return;
    clearTimeout(botTimer);
    botTimer = setTimeout(() => {
        botTimer = null;
        if (gameActive) handleBotTurn();
    }, relaxedDelay(ms)); // senior mode stretches the bot's "thinking" time
}

// ---------------------------------------------------------------
// TRACKED TIMER HELPERS (BUG-02 / BUG-03 / BUG-07)
// ---------------------------------------------------------------
// Every game-flow timeout is created THE SAME WAY and stored in a module-level
// handle so that ONE function (clearScheduledTimers) can cancel every pending
// timer, no matter which path scheduled it. clearScheduledTimers runs from:
//   - showHomeScreen()  — leaving the board mid-game
//   - restartGame()     — "Restart" button (BUG-07)
//   - startGame()       — defensive, cold-load safety
// The alternative — ad-hoc raw timer calls scattered across handlers (e.g. the
// no-move 1s auto-advance) — leaks handles: a player pressing Restart inside
// that window would still advance a turn of the game they just discarded.
// Timer handles are nulled both at schedule time (so a cancelled handle is
// never double-adjusted by an already-firing callback) and inside the callback
// before the action runs.
function scheduleTurnTimer(ms) {
    clearTimeout(turnTimer);
    turnTimer = setTimeout(() => {
        turnTimer = null;
        advanceTurn();
    }, relaxedDelay(ms)); // senior mode slows the no-move auto-advance pause
}
function scheduleVictoryBanner(ms) {
    clearTimeout(victoryTimer);
    victoryTimer = setTimeout(() => {
        victoryTimer = null;
        showVictoryBanner();
    }, relaxedDelay(ms)); // senior mode keeps the victory banner on screen longer
}
function clearScheduledTimers() {
    if (botTimer)    { clearTimeout(botTimer);     botTimer = null; }
    if (turnTimer)   { clearTimeout(turnTimer);    turnTimer = null; }
    if (victoryTimer){ clearTimeout(victoryTimer); victoryTimer = null; }
}

// BUG-17: the roll-score display is a transient readout of the LAST roll. Any
// stale text or the "is-extra" highlight must be wiped the moment a fresh roll
// becomes implied — i.e. (1) advanced to a new player, (2) a move completed
// (extra turn or not), (3) the game was won, or (4) a reset/start. If any path
// forgets, the previous player's "CHOWKA (4) — EXTRA ROLL!" text + green
// highlight bleeds onto the next roll's area.
// Note: this intentionally does NOT clear the text during the extra-roll-no-
// moves re-roll window — there the player is about to REROLL an extra, so the
// highlighted "EXTRA ROLL" readout is still semantically current.
function clearRollDisplay() {
    const scoreDisplay = document.getElementById('roll-score-display');
    if (scoreDisplay) {
        scoreDisplay.innerText = '';
        scoreDisplay.classList.remove('is-extra');
    }
}

// US-xx / BUG-06: in vs-bot mode player index 0 is ALWAYS the human; every
// other index is bot-controlled. The roll button must never be actionable for a
// bot turn because the bot's roll is dispatched by scheduleBotTurn(), and an
// enabled button would let the human roll FOR the bot (double-consume a turn).
// Before this fix, advanceTurn() unconditionally re-enabled the button, which
// exposed it during every bot turn.
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
    boardCursor.row = -1; boardCursor.col = -1; // keyboard cursor hidden on fresh games
    // BUG-13: a freshly started game must not inherit the previous game's
    // "No valid moves (Player X)" banner — that reason belonged to a finished
    // game and would contradict the new "Game Started!" log.
    turnAdvanceLog     = null;

    // Re-enable the roll button on every fresh game (BUG-06): a previous
    // victory banner disabled it, and reset must undo that for a new game.
    // Do this BEFORE updateUI so the button is styled as actionable for P0.
    const rollBtn = document.getElementById('btn-roll');
    if (rollBtn) rollBtn.disabled = false;

    T.debug('engine', 'state.initialized', 'Game state initialized', boardSnapshot());

    updateUI();
    setLog(`Game Started! Player ${playerColors[0].name}'s turn. Roll cowries!`);
    // BUG-17: a reset/start must also blank the roll-score readout so the very
    // first roll of the new game does not inherit the previous game's text.
    clearRollDisplay();

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
    if (gameMode === 'online') {
        // The relay owns the dice; we only surface intent and wait for the board.
        const oc = onlineClient();
        if (!oc) return;
        oc.roll();
        if (spanId && T.endSpan) T.endSpan(spanId, { outcome: 'sent' });
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
            // BUG-06: an extra roll (Chowka/Baara grant) that found NO valid
            // moves resets the roll so the SAME player may roll again. Only the
            // human may do so via the button; the bot's next roll flows through
            // scheduleBotTurn() — hence isBotTurn() gates the button here. The
            // 300ms (vs 700ms elsewhere) keeps a re-rolling bot snappy.
            document.getElementById('btn-roll').disabled = isBotTurn();
            T.info('engine', 'roll.extra_no_moves_reset', 'Extra roll had no moves; roll reset for re-roll', { playerIndex: currentPlayerIndex });
            if (gameMode === 'bot' && currentPlayerIndex !== 0 && winner === null) {
                scheduleBotTurn(300);
            }
        } else {
            // BUG-02 / BUG-05: a NON-extra roll with no valid moves is a dead
            // env-roll that must pass the turn. We (a) pause 1s so the player can
            // SEE the "No valid moves" math, (b) disable the roll button for that
            // window so a hurried second tap cannot produce a phantom env-roll on
            // no state, and (c) auto-advance via the tracked scheduleTurnTimer
            // (not a raw setTimeout — restart/home must be able to cancel it).
            document.getElementById('btn-roll').disabled = true;
            // BUG-13: keep the "why the turn advanced" reason visible on the new
            // player's banner instead of advancing into a terse generic prompt.
            turnAdvanceLog = `Rolled ${scoreText} — No valid moves!`;
            setLog(turnAdvanceLog);
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
    if (gameMode === 'online') {
        // The relay validates and applies the move; the result returns as a
        // board broadcast. Nothing is mutated locally (server-authoritative).
        const oc = onlineClient();
        oc && oc.move(move);
        return;
    }
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
        // BUG-01 (caller-side): engine executes multi-roll-tolerant; hand it an
        // explicit non-extra roll instead of letting `undefined` crash it.
        currentRoll || { isExtraRoll: false }
    );

    pawns               = result.pawns;
    // BUG-17: executeMove is now pure — it returns a NEW hasCapturedOpponent map
    // (a capture flips the flag on the copy). We MUST take the returned object:
    // the pre-fix engine mutated our map in place, making this line a no-op.
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
        // BUG-17: the victory block is TERMINAL — no further roll, move, or
        // highlight may be presented on top of the finished board. So purge the
        // consumed roll and its move options BEFORE re-rendering, and blank the
        // roll-score readout + its "is-extra" highlight. Left uncleaned, the
        // renderer would keep drawing the winning move's green target circle and
        // the stale "EXTRA ROLL" text over the victory screen.
        currentRoll = null;
        validMoves  = [];
        clearRollDisplay();
        renderBoard();
        updateUI();
        // BUG-04: disable the roll button on EVERY victory path — previously the
        // victory shortcuts left it ENABLED when the winning move formed a Gatti
        // (the engine can't form a Gatti AND finish the last pawn in one move, so
        // that old branch was dead code hiding the unguarded button). The roll
        // button is dead from here on; restart/home re-enables it via initGameState().
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
        // BUG-17: the extra turn starts with the SAME player but a NEW roll — the
        // score just consumed by the move is stale here, so wipe the readout (text
        // + highlight). The "🎲 Extra roll!" game-log carries the context instead.
        clearRollDisplay();
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
    // BUG-01 (UI-side): the banner is DELAYED by scheduleVictoryBanner(200) —
    // a full frame for the renderer + player ephemera. If the user hits
    // Restart/Home inside that 200ms window, resetGame clears `winner` but the
    // pending callback still runs afterwards. Guarding on `winner` (and reading
    // `.name` only after the check) both (a) prevents rendering a stale victory
    // line onto the fresh board and (b) prevents a TypeError on a null winner.
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
    currentRoll        = null;  // the previous roll is spent once the turn passes
    validMoves         = [];    // its move options are meaningless for a new player
    // BUG-06: keep the roll button non-actionable while it is a bot's turn;
    // only the human player (a botGame turn index 0) may interact with it.
    document.getElementById('btn-roll').disabled = isBotTurn();
    // BUG-17: the readout belongs to the previous player's roll — blank it
    // (text + highlight) so the next player starts with a clean roll area.
    clearRollDisplay();

    T.info('engine', 'turn.advanced', `Turn advanced from player ${from} to player ${currentPlayerIndex}`, { from, to: currentPlayerIndex, playerNum });

    updateUI();
    if (turnAdvanceLog !== null) {
        // BUG-13: handleRoll() stashed the previous player's "No valid moves"
        // reason here; consume it into the new banner so the turn transfer still
        // EXPLAINS ITSELF, then clear the latch. Without this the auto-advance
        // would replace "Rolled 3 — No valid moves!" with a terse generic prompt.
        setLog(`Player ${playerColors[currentPlayerIndex].name}'s turn. ${turnAdvanceLog}`);
        turnAdvanceLog = null;
    } else {
        setLog(`Player ${playerColors[currentPlayerIndex].name}'s turn. Roll cowries!`);
    }
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

    // In online mode buttons render only for the seated player's turn — the
    // authoritative validMoves belong to whoever the relay says is moving.
    const onlineMyTurn = (gameMode === 'online') ? (currentPlayerIndex === onlineSeat) : true;

    if (validMoves.length > 0 && !isBot && winner === null && onlineMyTurn) {
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
            ctx.lineWidth   = seniorMode ? 3 : 2; // senior mode: bolder grid lines
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
        if (pawn.playerIndex < 0 || pawn.playerIndex >= playerColors.length) return; // hostile board guard
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
        const pr  = cs * (seniorMode ? 0.20 : 0.17); // senior mode: chunkier pawns
        const pw  = seniorMode ? 4 : 3;              // and bolder pawn outlines

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
                // Even circular distribution: every pawn in a 4+ stack gets a
                // DISTINCT angle (the old idx % 4 table wrapped and drew the
                // 5th+ pawns exactly on top of the first four).
                const angle = (Math.PI * 2 * idx) / list.length - Math.PI / 4;
                ox = Math.cos(angle) * pr * 0.9;
                oy = Math.sin(angle) * pr * 0.9;
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
            ctx.lineWidth   = pw;
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

    // 5. Keyboard cursor overlay (dashed gold ring on the cursor cell).
    if (boardCursor.row >= 0 && boardCursor.col >= 0) {
        ctx.save();
        ctx.strokeStyle = '#FFD54F';
        ctx.lineWidth   = seniorMode ? 5 : 3;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(
            boardCursor.col * cs + 2,
            boardCursor.row * cs + 2,
            cs - 4, cs - 4
        );
        ctx.restore();
    }
}

// ============================================================
// BOARD INPUT
// ============================================================
// Mouse clicks and keyboard input both funnel through actOnCell() above;
// the listeners are registered next to the keyboard-cursor code so the two
// input paths stay in lockstep.

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
window.setSeniorMode  = setSeniorMode;
window.toggleSeniorMode = toggleSeniorMode;
// Online lobby (auth + rooms). Transport is window.OnlineClient (online-client.js).
window.onlineLogin     = onlineLogin;
window.onlineRegister  = onlineRegister;
window.onlineLogout    = onlineLogout;
window.onlineCreateRoom = onlineCreateRoom;
window.onlineJoinRoom  = onlineJoinRoom;

// ---- Delegated click wiring (CSP: no inline event handlers) ----
// One document-level listener routes clicks by element id to the exported
// window handler, using a data table (no per-id wrapper functions).
const CLICK_ACTIONS = {
    'btn-grid-5':         ['setGridSize', [5]],
    'btn-grid-7':         ['setGridSize', [7]],
    'btn-p2':             ['setPlayers', [2]],
    'btn-p3':             ['setPlayers', [3]],
    'btn-p4':             ['setPlayers', [4]],
    'btn-mode-pnp':       ['setGameMode', ['pnp']],
    'btn-mode-bot':       ['setGameMode', ['bot']],
    'btn-mode-online':    ['setGameMode', ['online']],
    'btn-create-room':    ['onlineCreateRoom', []],
    'btn-logout':         ['onlineLogout', []],
    'btn-join-room':      ['onlineJoinRoom', []],
    'btn-login':          ['onlineLogin', []],
    'btn-register':       ['onlineRegister', []],
    'btn-senior':         ['toggleSeniorMode', []],
    'btn-start':          ['startGame', []],
    'btn-rules':          ['openRules', []],
    'btn-rules-close':    ['closeRules', []],
    'btn-mute':           ['toggleMute', []],
    'btn-roll':           ['handleRoll', []],
    'btn-menu':           ['showHomeScreen', []],
    'btn-restart-header': ['restartGame', []]
};

window.__cbClick = dispatchClickById;
window.__cbFindTarget = findClickTarget;

function dispatchClickById(id) {
    const action = CLICK_ACTIONS[id];
    if (action && typeof window[action[0]] === 'function') {
        window[action[0]](...action[1]);
        return true;
    }
    return false;
}

// Nearest actionable ancestor (or null): pure walk, unit-testable.
function findClickTarget(target) {
    let t = target;
    while (t) {
        if (t.id && CLICK_ACTIONS[t.id]) return t;
        t = t.parentElement || null;
    }
    return null;
}

if (typeof document.addEventListener === 'function') {
    document.addEventListener('click', (e) => {
        const el = findClickTarget(e.target);
        if (el) dispatchClickById(el.id);
    });
}

// Boot: restore persisted user preferences.
restoreMutePreference();

})();
