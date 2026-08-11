// ============================================================
// CHOKA BARAH – Authentication (scrypt + bearer tokens, no deps)
// ------------------------------------------------------------
// Password storage uses node:crypto scrypt with a per-user random
// salt (format "scrypt$N$r$p$saltBase64$hashBase64"). Sessions are
// opaque random bearer tokens stored in the DB with an expiry;
// authenticateUser(token) validates liveness + expiry on every call.
// ============================================================
'use strict';

const crypto = require('node:crypto');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (![N, r, p].every(Number.isInteger) || N <= 0 || r <= 0 || p <= 0) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const actual = crypto.scryptSync(password, salt, expected.length, { N, r, p });
  return crypto.timingSafeEqual(actual, expected);
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isExpired(session) {
  if (!session || !session.expires_at) return true;
  return Date.now() >= Date.parse(session.expires_at);
}

// Result-style API so the HTTP handler maps errors to status codes without
// coupling auth to a web framework.
function registerUser(db, username, password) {
  if (!username || typeof username !== 'string') return { ok: false, error: 'username-required' };
  const uname = username.trim().toLowerCase();
  if (uname.length < 3 || uname.length > 24) return { ok: false, error: 'username-length' };
  if (!/^[a-z0-9_.-]+$/.test(uname)) return { ok: false, error: 'username-invalid' };
  if (!password || typeof password !== 'string') return { ok: false, error: 'password-required' };
  if (password.length < 6 || password.length > 128) return { ok: false, error: 'password-length' };

  if (db.getUserByUsername(uname)) return { ok: false, error: 'username-taken' };

  const user = db.createUser(uname, hashPassword(password));
  const token = newSessionToken();
  db.insertSession(token, user.id, new Date(Date.now() + SESSION_TTL_MS).toISOString());
  return { ok: true, user: { id: user.id, username: user.username }, token };
}

function loginUser(db, username, password) {
  if (!username || !password) return { ok: false, error: 'credentials' };
  const user = db.getUserByUsername(String(username).trim().toLowerCase());
  if (!user || !verifyPassword(password, user.pass_hash)) return { ok: false, error: 'credentials' };
  // Rotate: kill any older sessions for this user so a stolen token does not
  // outlive a legit re-login from the same account.
  db.deleteUserSessions(user.id);
  const token = newSessionToken();
  db.insertSession(token, user.id, new Date(Date.now() + SESSION_TTL_MS).toISOString());
  return { ok: true, user: { id: user.id, username: user.username }, token };
}

function logoutUser(db, token) {
  db.deleteSession(token);
  return { ok: true };
}

// Validates a bearer token; returns { ok, user, session } or { ok:false }.
function authenticateToken(db, token) {
  if (!token) return { ok: false };
  const session = db.getSession(token);
  if (!session) return { ok: false };
  if (isExpired(session)) {
    db.deleteSession(token);
    return { ok: false };
  }
  return { ok: true, user: { id: session.user_id, username: session.username }, session };
}

module.exports = {
  hashPassword, verifyPassword, newSessionToken, isExpired,
  registerUser, loginUser, logoutUser, authenticateToken,
  SESSION_TTL_MS
};