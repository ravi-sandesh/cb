'use strict';
const { openDb, makeStore } = require('./online-db.js');
const auth = require('./auth.js');

function freshStore() { return makeStore(openDb(':memory:')); }

describe('auth hashing', () => {
  test('verifyPassword round-trips and rejects wrong input', () => {
    const hash = auth.hashPassword('correct horse');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(auth.verifyPassword('correct horse', hash)).toBe(true);
    expect(auth.verifyPassword('battery staple', hash)).toBe(false);
  });

  test('salts are unique so equal passwords hash differently', () => {
    expect(auth.hashPassword('same')).not.toBe(auth.hashPassword('same'));
  });
});

describe('auth register / login / logout', () => {
  test('register returns a user + usable session token', () => {
    const out = auth.registerUser(freshStore(), 'alice', 'secret123');
    expect(out.ok).toBe(true);
    expect(out.user.username).toBe('alice');
    expect(out.token).toMatch(/^[0-9a-f]{64}$/);
    expect(auth.authenticateToken(freshStore(), out.token).ok).toBe(false); // token tied to its store's db
  });

  test('register validates inputs', () => {
    const db = freshStore();
    expect(auth.registerUser(db, '', 'secret123').error).toBe('username-required');
    expect(auth.registerUser(db, 'ab', 'secret123').error).toBe('username-length');
    expect(auth.registerUser(db, 'ok user!', 'secret123').error).toBe('username-invalid');
    expect(auth.registerUser(db, 'okuser', '').error).toBe('password-required');
    expect(auth.registerUser(db, 'okuser', 'short').error).toBe('password-length');
  });

  test('duplicate username is rejected', () => {
    const db = freshStore();
    expect(auth.registerUser(db, 'taken', 'secret123').ok).toBe(true);
    expect(auth.registerUser(db, 'taken', 'secret123').error).toBe('username-taken');
  });

  test('login with credentials issues a token that authenticates', () => {
    const db = freshStore();
    auth.registerUser(db, 'bob', 'secret123');
    const lg = auth.loginUser(db, 'bob', 'secret123');
    expect(lg.ok).toBe(true);
    const authd = auth.authenticateToken(db, lg.token);
    expect(authd.ok).toBe(true);
    expect(authd.user.id).toBe(lg.user.id);
    // Re-login rotates: old token dies, new one works.
    const lg2 = auth.loginUser(db, 'bob', 'secret123');
    expect(auth.authenticateToken(db, lg.token).ok).toBe(false);
    expect(auth.authenticateToken(db, lg2.token).ok).toBe(true);
  });

  test('login rejects bad password and unknown user', () => {
    const db = freshStore();
    auth.registerUser(db, 'bob', 'secret123');
    expect(auth.loginUser(db, 'bob', 'nope').error).toBe('credentials');
    expect(auth.loginUser(db, 'nobody', 'secret123').error).toBe('credentials');
  });

  test('logout invalidates the token', () => {
    const db = freshStore();
    auth.registerUser(db, 'carol', 'secret123');
    const lg = auth.loginUser(db, 'carol', 'secret123');
    auth.logoutUser(db, lg.token);
    expect(auth.authenticateToken(db, lg.token).ok).toBe(false);
  });

  test('expired sessions are rejected and cleaned up', () => {
    const db = freshStore();
    const u = db.createUser('xo', 'h');
    db.insertSession('deadtoken', u.id, '2000-01-01T00:00:00Z');
    expect(auth.authenticateToken(db, 'deadtoken').ok).toBe(false);
    expect(db.getSession('deadtoken')).toBeUndefined();
  });
});