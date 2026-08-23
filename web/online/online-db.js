// ============================================================
// CHOKA BARAH – Online persistence layer (node:sqlite, no deps)
// ------------------------------------------------------------
// Stores user accounts, auth sessions, matches (room-code lobby +
// authoritative server-side state) and a numbered move ledger.
// Uses the built-in node:sqlite DatabaseSync driver so the whole
// online backend is dependency-free and works on Node 22.5+.
// ============================================================
'use strict';

const { DatabaseSync } = require('node:sqlite');

// Schema v2. Room "lobby" matches have status: WAITING (host only),
// PLAYING (both seated), FINISHED (winner recorded), ABANDONED (sweeper
// reaped a stale room; history preserved). The `board` column holds the
// server-authoritative JSON serialization of the game state. `updated_at`
// tracks last write so the sweeper can reap dead PLAYING rooms without
// touching live ones.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT UNIQUE NOT NULL,
  pass_hash   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT UNIQUE NOT NULL,
  grid_size      INTEGER NOT NULL,
  player_count   INTEGER NOT NULL,
  host_user_id   INTEGER NOT NULL REFERENCES users(id),
  guest_user_id  INTEGER REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'WAITING',
  board          TEXT NOT NULL DEFAULT '{}',
  winner_user_id INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at    TEXT
);
CREATE TABLE IF NOT EXISTS moves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  player_idx INTEGER NOT NULL,
  payload    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_matches_code ON matches(code);
CREATE INDEX IF NOT EXISTS idx_moves_match ON moves(match_id);
`;

function openDb(databasePath) {
  const db = new DatabaseSync(databasePath || ':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrateSchema(db);
  return db;
}

// ---- Schema migrations (v1 -> v2) ---------------------------------------
// Baseline SCHEMA above already creates fresh databases in v2 shape; this
// upgrades databases created before v2:
//  1. matches.updated_at column (added via guarded ALTER for legacy files)
//  2. UNIQUE(match_id, seq) on the move ledger — a mid-match restart used to
//     restart room.seq at 0 and silently duplicate ledger entries. Duplicate
//     rows are collapsed (lowest id wins) BEFORE the index can be created.
function migrateSchema(db) {
  const cols = db.prepare('PRAGMA table_info(matches)').all().map((c) => c.name);
  if (!cols.includes('updated_at')) {
    db.exec("ALTER TABLE matches ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE matches SET updated_at = COALESCE(created_at, datetime('now'))");
  }
  db.exec(
    'DELETE FROM moves WHERE id NOT IN (SELECT MIN(id) FROM moves GROUP BY match_id, seq)'
  );
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_moves_match_seq ON moves(match_id, seq)'
  );
}

// ---- Lifecycle sweeper ----------------------------------------------------
// Reaps rooms nobody will ever return to and sessions that have expired:
//   - WAITING matches older than 24h (host created a code, never played)
//   - PLAYING matches idle for more than 7 days (both players dropped)
// Matches are marked ABANDONED rather than deleted so game history (moves
// ledger, result) survives for auditing. Expired sessions are removed.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

// ABANDONED rows are kept for 30 days for auditing, then deleted outright.
// The moves ledger cascades (moves.match_id REFERENCES matches ON DELETE
// CASCADE, PRAGMA foreign_keys = ON).
const ABANDONED_RETENTION_DAYS = 30;

function sweepAbandoned(db) {
  const staleWaiting = db.prepare(
    "UPDATE matches SET status = 'ABANDONED' WHERE status = 'WAITING' AND created_at <= datetime('now', '-24 hours')"
  ).run();
  const stalePlaying = db.prepare(
    "UPDATE matches SET status = 'ABANDONED' WHERE status = 'PLAYING' AND updated_at <= datetime('now', '-7 days')"
  ).run();
  // expires_at values are JS ISO strings, so an ISO cutoff compares correctly.
  const deadSessions = db.prepare(
    'DELETE FROM sessions WHERE expires_at <= ?'
  ).run(new Date().toISOString());
  const pruned = db.prepare(
    "DELETE FROM matches WHERE status = 'ABANDONED' AND updated_at <= datetime('now', ? || ' days')"
  ).run(-ABANDONED_RETENTION_DAYS);
  return {
    abandonedWaiting: Number(staleWaiting.changes),
    abandonedPlaying: Number(stalePlaying.changes),
    deletedSessions: Number(deadSessions.changes),
    prunedMatches: Number(pruned.changes)
  };
}

// ---- Users ----
function createUser(db, username, passHash) {
  const info = db.prepare('INSERT INTO users (username, pass_hash) VALUES (?, ?)')
    .run(username, passHash);
  return db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(info.lastInsertRowid);
}
function getUserByUsername(db, username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}
function getUserById(db, id) {
  return db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(id);
}

// ---- Sessions ----
function insertSession(db, token, userId, expiresAtIso) {
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, expiresAtIso);
}
function getSession(db, token) {
  return db.prepare('SELECT s.*, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
}
function deleteSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
function deleteUserSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// ---- Matches ----
function createMatch(db, { code, gridSize, playerCount, hostUserId }) {
  const info = db.prepare(
    'INSERT INTO matches (code, grid_size, player_count, host_user_id) VALUES (?, ?, ?, ?)'
  ).run(code, gridSize, playerCount, hostUserId);
  return getMatchById(db, info.lastInsertRowid);
}
function getMatchByCode(db, code) {
  return db.prepare('SELECT * FROM matches WHERE code = ?').get(code);
}
function getMatchById(db, id) {
  return db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
}
function setMatchGuest(db, matchId, guestUserId) {
  db.prepare('UPDATE matches SET guest_user_id = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(guestUserId, 'PLAYING', matchId);
  return getMatchById(db, matchId);
}

// Record the INVITED guest at HTTP-join time WITHOUT flipping the match to
// PLAYING (status stays WAITING until the invitee actually attaches over the
// WebSocket). The relay uses this to refuse seat claims from anyone else,
// so knowing a room code alone is not enough to take a seat.
function setMatchInvited(db, matchId, userId) {
  db.prepare('UPDATE matches SET guest_user_id = ? WHERE id = ?').run(userId, matchId);
}
function setMatchBoard(db, matchId, boardJson) {
  db.prepare('UPDATE matches SET board = ?, updated_at = datetime(\'now\') WHERE id = ?').run(boardJson, matchId);
}
function finishMatch(db, matchId, winnerUserId) {
  db.prepare('UPDATE matches SET status = ?, winner_user_id = ?, finished_at = datetime(\'now\') WHERE id = ?')
    .run('FINISHED', winnerUserId, matchId);
  return getMatchById(db, matchId);
}

// ---- Move ledger ----
function appendMove(db, matchId, seq, playerIdx, payloadJson) {
  db.prepare('INSERT INTO moves (match_id, seq, player_idx, payload) VALUES (?, ?, ?, ?)')
    .run(matchId, seq, playerIdx, payloadJson);
}
function countMoves(db, matchId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM moves WHERE match_id = ?').get(matchId);
  return row.n;
}
function listMoves(db, matchId) {
  return db.prepare('SELECT seq, player_idx, payload FROM moves WHERE match_id = ? ORDER BY seq').all(matchId);
}

// Erase everything (test helper): closes the DB then reopens empty. Kept out
// of normal runtime paths; only used by tests to get a clean slate. Deletion
// order matters under PRAGMA foreign_keys=ON — children before parents.
function resetDb(db) {
  db.exec('DELETE FROM moves');
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM matches');
  db.exec('DELETE FROM users');
}

// Binds the raw handle to every CRUD function so callers (auth, game-server,
// relay) get one cohesive `store` object instead of threading `(db, ...args)`
// everywhere. `store.db` still exposes the raw handle for transactions.
function makeStore(rawDb) {
  const api = {
    db: rawDb,
    createUser: (username, passHash) => createUser(rawDb, username, passHash),
    getUserByUsername: (username) => getUserByUsername(rawDb, username),
    getUserById: (id) => getUserById(rawDb, id),
    insertSession: (token, userId, expiresAtIso) => insertSession(rawDb, token, userId, expiresAtIso),
    getSession: (token) => getSession(rawDb, token),
    deleteSession: (token) => deleteSession(rawDb, token),
    deleteUserSessions: (userId) => deleteUserSessions(rawDb, userId),
    createMatch: (m) => createMatch(rawDb, m),
    getMatchByCode: (code) => getMatchByCode(rawDb, code),
    getMatchById: (id) => getMatchById(rawDb, id),
    setMatchGuest: (matchId, guestUserId) => setMatchGuest(rawDb, matchId, guestUserId),
    setMatchInvited: (matchId, userId) => setMatchInvited(rawDb, matchId, userId),
    setMatchBoard: (matchId, boardJson) => setMatchBoard(rawDb, matchId, boardJson),
    finishMatch: (matchId, winnerUserId) => finishMatch(rawDb, matchId, winnerUserId),
    appendMove: (matchId, seq, playerIdx, payloadJson) => appendMove(rawDb, matchId, seq, playerIdx, payloadJson),
    countMoves: (matchId) => countMoves(rawDb, matchId),
    listMoves: (matchId) => listMoves(rawDb, matchId),
    resetDb: () => resetDb(rawDb)
  };
  return api;
}

module.exports = {
  openDb, migrateSchema, sweepAbandoned, SWEEP_INTERVAL_MS,
  makeStore,
  createUser, getUserByUsername, getUserById,
  insertSession, getSession, deleteSession, deleteUserSessions,
  createMatch, getMatchByCode, getMatchById, setMatchGuest, setMatchInvited, setMatchBoard, finishMatch,
  appendMove, countMoves, listMoves,
  resetDb
};