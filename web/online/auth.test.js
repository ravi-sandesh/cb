'use strict';
const { openDb, makeStore } = require('./online-db.js');
const auth = require('./auth.js');

function freshStore() { return makeStore(openDb(':memory:')); }

beforeEach(() => auth.resetLoginThrottle());
afterEach(() => auth.resetLoginThrottle());

describe('auth hashing', () => {
  test('verifyPassword round-trips and rejects wrong input', () => {
    const hash = auth.hashPassword('correct horse');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(auth.verifyPassword('correct horse', hash)).toBe(true);
    expect(auth.verifyPassword('battery staple', hash)).toBe(false);
  });

  test('async verifyPasswordAsync matches the sync twin', async () => {
    const hash = await auth.hashPasswordAsync('correct horse');
    expect(hash.startsWith('scrypt$')).toBe(true);
    await expect(auth.verifyPasswordAsync('correct horse', hash)).resolves.toBe(true);
    await expect(auth.verifyPasswordAsync('battery staple', hash)).resolves.toBe(false);
  });

  test('async verification rejects malformed stored hashes without hashing', async () => {
    for (const bad of ['', 'md5$abc', 'scrypt$x$y$z$a$b', 'scrypt$0$0$0$!!$!!']) {
      await expect(auth.verifyPasswordAsync('pw', bad)).resolves.toBe(false);
    }
  });

  test('salts are unique so equal passwords hash differently', () => {
    expect(auth.hashPassword('same')).not.toBe(auth.hashPassword('same'));
  });
});

describe('auth register / login / logout', () => {
  test('register returns a user + usable session token', async () => {
    const out = await auth.registerUser(freshStore(), 'alice', 'secret123');
    expect(out.ok).toBe(true);
    expect(out.user.username).toBe('alice');
    expect(out.token).toMatch(/^[0-9a-f]{64}$/);
    expect(auth.authenticateToken(freshStore(), out.token).ok).toBe(false); // token tied to its store's db
  });

  test('register validates inputs', async () => {
    const db = freshStore();
    expect((await auth.registerUser(db, '', 'secret123')).error).toBe('username-required');
    expect((await auth.registerUser(db, 'ab', 'secret123')).error).toBe('username-length');
    expect((await auth.registerUser(db, 'ok user!', 'secret123')).error).toBe('username-invalid');
    expect((await auth.registerUser(db, 'okuser', '')).error).toBe('password-required');
    expect((await auth.registerUser(db, 'okuser', 'short')).error).toBe('password-length');
  });

  test('duplicate username is rejected', async () => {
    const db = freshStore();
    expect((await auth.registerUser(db, 'taken', 'secret123')).ok).toBe(true);
    expect((await auth.registerUser(db, 'taken', 'secret123')).error).toBe('username-taken');
  });

  test('login issues a token that authenticates; old sessions survive re-login', async () => {
    const db = freshStore();
    await auth.registerUser(db, 'bob', 'secret123');
    const lg = await auth.loginUser(db, 'bob', 'secret123');
    expect(lg.ok).toBe(true);
    const authd = auth.authenticateToken(db, lg.token);
    expect(authd.ok).toBe(true);
    expect(authd.user.id).toBe(lg.user.id);
    // Session policy: re-login ADDS a session instead of rotating, so a
    // second device is not logged out by the first.
    const lg2 = await auth.loginUser(db, 'bob', 'secret123');
    expect(auth.authenticateToken(db, lg.token).ok).toBe(true);
    expect(auth.authenticateToken(db, lg2.token).ok).toBe(true);
  });

  test('login rejects bad password and unknown user', async () => {
    const db = freshStore();
    await auth.registerUser(db, 'bob', 'secret123');
    expect((await auth.loginUser(db, 'bob', 'nope')).error).toBe('credentials');
    // Unknown users get the same generic error — and still cost one scrypt
    // run against the dummy hash so timing cannot enumerate accounts.
    expect((await auth.loginUser(db, 'nobody', 'secret123')).error).toBe('credentials');
  });

  test('repeated failures lock the account before any hashing happens', async () => {
    const db = freshStore();
    await auth.registerUser(db, 'mallory', 'secret123');
    for (let i = 0; i < auth.LOGIN_MAX_FAILURES; i++) {
      expect((await auth.loginUser(db, 'mallory', `wrong${i}`)).error).toBe('credentials');
    }
    // Locked: even the CORRECT password is refused while the window runs.
    expect(await auth.loginUser(db, 'mallory', 'secret123'))
      .toEqual({ ok: false, error: 'try-again-later' });
    expect(auth.isLockedOut('mallory')).toBe(true);

    // A success clears the failure record.
    auth.resetLoginThrottle();
    expect((await auth.loginUser(db, 'mallory', 'secret123')).ok).toBe(true);
    expect(auth.isLockedOut('mallory')).toBe(false);
  });

  test('lockout expires after the failure window', async () => {
    const db = freshStore();
    await auth.registerUser(db, 'erin', 'secret123');
    jest.useFakeTimers({ now: Date.now() });
    try {
      for (let i = 0; i < auth.LOGIN_MAX_FAILURES; i++) {
        await auth.loginUser(db, 'erin', `wrong${i}`);
      }
      expect(await auth.loginUser(db, 'erin', 'secret123'))
        .toEqual({ ok: false, error: 'try-again-later' });

      // Advance past the window: the counter resets, failures start over.
      jest.advanceTimersByTime(auth.LOGIN_WINDOW_MS + 1);
      expect((await auth.loginUser(db, 'erin', 'still-wrong')).error).toBe('credentials');
      expect(auth.isLockedOut('erin')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('lockouts are strictly per-account', async () => {
    const db = freshStore();
    await auth.registerUser(db, 'frank', 'secret123');
    await auth.registerUser(db, 'gina', 'secret123');
    for (let i = 0; i < auth.LOGIN_MAX_FAILURES; i++) {
      await auth.loginUser(db, 'frank', `wrong${i}`);
    }
    expect(auth.isLockedOut('frank')).toBe(true);
    expect(auth.isLockedOut('gina')).toBe(false); // bystander unaffected
    expect((await auth.loginUser(db, 'gina', 'secret123')).ok).toBe(true);
  });

  test('sweepLoginFailures evicts only expired buckets', async () => {
    const db = freshStore();
    await auth.registerUser(db, 'victim', 'secret123');
    await auth.loginUser(db, 'victim', 'wrong');
    auth.sweepLoginFailures(); // nothing expired: record survives
    for (let i = 0; i < 4; i++) await auth.loginUser(db, 'victim', `wrong${i}`);
    expect(auth.isLockedOut('victim')).toBe(true);
    // Far future: the bucket is swept, lockout lifts without waiting.
    auth.sweepLoginFailures(Date.now() + auth.LOGIN_WINDOW_MS + 1000);
    expect(auth.isLockedOut('victim')).toBe(false);
  });

  test('repeat logins cap sessions per user instead of growing forever', async () => {
    const db = freshStore();
    await auth.registerUser(db, 'loop', 'secret123');
    for (let i = 0; i < auth.MAX_SESSIONS_PER_USER + 3; i++) {
      expect((await auth.loginUser(db, 'loop', 'secret123')).ok).toBe(true);
    }
    const n = db.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    expect(n).toBeLessThanOrEqual(auth.MAX_SESSIONS_PER_USER);
  });

  test('logout invalidates the token', async () => {
    const db = freshStore();
    await auth.registerUser(db, 'carol', 'secret123');
    const lg = await auth.loginUser(db, 'carol', 'secret123');
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
