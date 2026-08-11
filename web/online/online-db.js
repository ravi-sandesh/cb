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

// Schema v1. Room "lobby" matches have status: WAITING (host only),
// PLAYING (both seated), FINISHED (winner recorded). The `board` column
// holds the server-authoritative JSON serialization of the game state.
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
  return db;
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
  db.prepare('UPDATE matches SET guest_user_id = ?, status = ? WHERE id = ?')
    .run(guestUserId, 'PLAYING', matchId);
  return getMatchById(db, matchId);
}
function setMatchBoard(db, matchId, boardJson) {
  db.prepare('UPDATE matches SET board = ? WHERE id = ?').run(boardJson, matchId);
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
  openDb,
  makeStore,
  createUser, getUserByUsername, getUserById,
  insertSession, getSession, deleteSession, deleteUserSessions,
  createMatch, getMatchByCode, getMatchById, setMatchGuest, setMatchBoard, finishMatch,
  appendMove, countMoves, listMoves,
  resetDb
};