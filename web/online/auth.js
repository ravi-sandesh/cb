// ============================================================
// CHOKA BARAH – Authentication (scrypt + bearer tokens, no deps)
// ------------------------------------------------------------
// Password storage uses node:crypto scrypt with a per-user random
// salt (format "scrypt$N$r$p$saltBase64$hashBase64"). Sessions are
// opaque random bearer tokens stored in the DB with an expiry;
// authenticateUser(token) validates liveness + expiry on every call.
//
// Hardening notes:
//  - hashing runs on the ASYNC crypto.scrypt thread pool so login
//    storms cannot pin the single-threaded event loop;
//  - unknown usernames still burn one scrypt verification against a
//    module-level dummy hash, so response timing does not reveal
//    which accounts exist;
//  - repeated failed logins for the same username are throttled in
//    memory (fixed window) and rejected before any hashing happens.
// ============================================================
'use strict';

const crypto = require('node:crypto');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

function scryptAsync(password, salt, keylen, params = {}) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, {
      N: params.N || SCRYPT_N,
      r: params.r || SCRYPT_R,
      p: params.p || SCRYPT_P
    }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// Sync variant kept for the startup-time dummy hash and legacy callers.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function parseStoredHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (![N, r, p].every(Number.isInteger) || N <= 0 || r <= 0 || p <= 0) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (!salt.length || !expected.length) return null;
  return { salt, expected, N, r, p };
}

async function verifyPasswordAsync(password, stored) {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const actual = await scryptAsync(password, parsed.salt, parsed.expected.length, parsed);
  return crypto.timingSafeEqual(actual, parsed.expected);
}

// Sync twin of verifyPasswordAsync; retained for tooling/tests.
function verifyPassword(password, stored) {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const actual = crypto.scryptSync(password, parsed.salt, parsed.expected.length, parsed);
  return crypto.timingSafeEqual(actual, parsed.expected);
}

// Burned when a login targets a nonexistent user so both branches do the
// same expensive work. Computed once at module load.
const DUMMY_HASH = hashPassword('!dummy-password-against-timing-enumeration!');

// ---- Login throttle (per-username fixed window, in-memory) ----
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const loginFailures = new Map(); // username -> { count, firstAt }

function isLockedOut(username) {
  const rec = loginFailures.get(username);
  if (!rec) return false;
  if (Date.now() - rec.firstAt >= LOGIN_WINDOW_MS) {
    loginFailures.delete(username); // window elapsed: start fresh
    return false;
  }
  return rec.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(username) {
  const now = Date.now();
  const rec = loginFailures.get(username);
  if (!rec || now - rec.firstAt >= LOGIN_WINDOW_MS) {
    loginFailures.set(username, { count: 1, firstAt: now });
  } else {
    rec.count += 1;
  }
}

function clearLoginFailures(username) { loginFailures.delete(username); }
function resetLoginThrottle() { loginFailures.clear(); }

function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isExpired(session) {
  if (!session || !session.expires_at) return true;
  return Date.now() >= Date.parse(session.expires_at);
}

// Result-style API so the HTTP handler maps errors to status codes without
// coupling auth to a web framework. Both functions are async because the
// expensive scrypt work must stay off the event loop.
async function registerUser(db, username, password) {
  if (!username || typeof username !== 'string') return { ok: false, error: 'username-required' };
  const uname = username.trim().toLowerCase();
  if (uname.length < 3 || uname.length > 24) return { ok: false, error: 'username-length' };
  if (!/^[a-z0-9_.-]+$/.test(uname)) return { ok: false, error: 'username-invalid' };
  if (!password || typeof password !== 'string') return { ok: false, error: 'password-required' };
  if (password.length < 6 || password.length > 128) return { ok: false, error: 'password-length' };

  if (db.getUserByUsername(uname)) return { ok: false, error: 'username-taken' };

  const user = db.createUser(uname, await hashPasswordAsync(password));
  const token = newSessionToken();
  db.insertSession(token, user.id, new Date(Date.now() + SESSION_TTL_MS).toISOString());
  clearLoginFailures(uname);
  return { ok: true, user: { id: user.id, username: user.username }, token };
}

async function loginUser(db, username, password) {
  if (!username || !password) return { ok: false, error: 'credentials' };
  const uname = String(username).trim().toLowerCase();

  // Throttled accounts are rejected BEFORE any hashing so a brute-force
  // loop costs the attacker nothing but also gains nothing.
  if (isLockedOut(uname)) return { ok: false, error: 'try-again-later' };

  const user = db.getUserByUsername(uname);
  // Unknown users burn the same scrypt work against the dummy hash so
  // timing cannot enumerate valid usernames.
  let ok = false;
  if (user) {
    ok = await verifyPasswordAsync(password, user.pass_hash);
  } else {
    await verifyPasswordAsync(password, DUMMY_HASH);
  }
  if (!ok) {
    recordLoginFailure(uname);
    return { ok: false, error: 'credentials' };
  }
  clearLoginFailures(uname);
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
  hashPassword, hashPasswordAsync, verifyPassword, verifyPasswordAsync,
  newSessionToken, isExpired,
  registerUser, loginUser, logoutUser, authenticateToken,
  isLockedOut, resetLoginThrottle,
  LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS,
  SESSION_TTL_MS
};
