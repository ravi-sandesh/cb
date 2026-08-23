'use strict';
const { DatabaseSync } = require('node:sqlite');
const { openDb, makeStore, migrateSchema, sweepAbandoned } = require('./online-db.js');

let store;
beforeEach(() => { store = makeStore(openDb(':memory:')); });

describe('online-db users & sessions', () => {
  test('registers a user and looks them up by name/id', () => {
    const u = store.createUser('alice', 'hashX');
    expect(u.id).toBeTruthy();
    expect(u.username).toBe('alice');
    expect(store.getUserByUsername('alice').id).toBe(u.id);
    expect(store.getUserById(u.id).username).toBe('alice');
  });

  test('rejects a duplicate username at the DB level', () => {
    store.createUser('bob', 'h');
    expect(() => store.createUser('bob', 'h2')).toThrow();
  });

  test('session insert, fetch with username join, delete', () => {
    const u = store.createUser('carol', 'h');
    store.insertSession('tok1', u.id, '2026-12-31T00:00:00Z');
    const s = store.getSession('tok1');
    expect(s.token).toBe('tok1');
    expect(s.username).toBe('carol');
    store.deleteSession('tok1');
    expect(store.getSession('tok1')).toBeUndefined();
  });

  test('deleteUserSessions kills every token for a user', () => {
    const u = store.createUser('dave', 'h');
    store.insertSession('a', u.id, '2026-12-31T00:00:00Z');
    store.insertSession('b', u.id, '2026-12-31T00:00:00Z');
    store.deleteUserSessions(u.id);
    expect(store.getSession('a')).toBeUndefined();
    expect(store.getSession('b')).toBeUndefined();
  });
});

describe('online-db matches & moves', () => {
  test('creates a WAITING match with host and unique code', () => {
    const u = store.createUser('host', 'h');
    const m = store.createMatch({ code: 'ABC123', gridSize: 5, playerCount: 2, hostUserId: u.id });
    expect(m.status).toBe('WAITING');
    expect(m.code).toBe('ABC123');
    expect(store.getMatchById(m.id).id).toBe(m.id);
    expect(store.getMatchByCode('ABC123').id).toBe(m.id);
  });

  test('guest seat flips status to PLAYING; finish records winner', () => {
    const h = store.createUser('host', 'h');
    const g = store.createUser('guest', 'h');
    const m = store.createMatch({ code: 'ABC123', gridSize: 5, playerCount: 2, hostUserId: h.id });
    const playing = store.setMatchGuest(m.id, g.id);
    expect(playing.status).toBe('PLAYING');
    expect(playing.guest_user_id).toBe(g.id);
    const done = store.finishMatch(m.id, h.id);
    expect(done.status).toBe('FINISHED');
    expect(done.winner_user_id).toBe(h.id);
    expect(done.finished_at).toBeTruthy();
  });

  test('board round-trips through setMatchBoard', () => {
    const u = store.createUser('host', 'h');
    const m = store.createMatch({ code: 'ABC123', gridSize: 5, playerCount: 2, hostUserId: u.id });
    store.setMatchBoard(m.id, '{"a":1}');
    expect(store.getMatchById(m.id).board).toBe('{"a":1}');
  });

  test('move ledger numbers sequentially and lists in order', () => {
    const u = store.createUser('host', 'h');
    const m = store.createMatch({ code: 'ABC123', gridSize: 5, playerCount: 2, hostUserId: u.id });
    store.appendMove(m.id, 1, 0, '{"roll":4}');
    store.appendMove(m.id, 2, 1, '{"roll":3}');
    expect(store.countMoves(m.id)).toBe(2);
    const moves = store.listMoves(m.id);
    expect(moves[0].seq).toBe(1);
    expect(moves[1].player_idx).toBe(1);
  });
});

describe('online-db resetDb', () => {
  test('wipes users/sessions/matches/moves for a clean slate', () => {
    const u = store.createUser('alice', 'h');
    store.insertSession('tok1', u.id, '2026-12-31T00:00:00Z');
    store.createMatch({ code: 'ABC123', gridSize: 5, playerCount: 2, hostUserId: u.id });
    store.resetDb();
    expect(store.getUserByUsername('alice')).toBeUndefined();
    expect(store.getMatchByCode('ABC123')).toBeUndefined();
  });
});

describe('online-db schema v2 (move ledger integrity)', () => {
  test('openDb without a path opens an in-memory database', () => {
    const db = openDb();
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(0);
    db.close();
  });

  test('duplicate (match_id, seq) inserts are rejected by the unique index', () => {
    const u = store.createUser('host', 'h');
    const m = store.createMatch({ code: 'ABC123', gridSize: 5, playerCount: 2, hostUserId: u.id });
    store.appendMove(m.id, 1, 0, '{"first":true}');
    // A mid-match server restart used to restart room.seq at 0 and duplicate
    // entries; the unique index makes that impossible now.
    expect(() => store.appendMove(m.id, 1, 0, '{"dup":true}')).toThrow();
    expect(store.countMoves(m.id)).toBe(1);
  });

  test('migrateSchema upgrades a legacy v1 database in place', () => {
    // Hand-build a v1 database: no updated_at column, no unique index, and
    // one duplicated ledger row exactly like a pre-v2 restart would leave.
    const raw = new DatabaseSync(':memory:');
    raw.exec(`
      CREATE TABLE matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE moves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id INTEGER NOT NULL,
        seq INTEGER NOT NULL
      );
      INSERT INTO matches (code) VALUES ('LEGACY1');
      INSERT INTO moves (match_id, seq) VALUES (1, 1), (1, 1), (1, 2);
    `);

    migrateSchema(raw);

    const cols = raw.prepare('PRAGMA table_info(matches)').all().map((c) => c.name);
    expect(cols).toContain('updated_at');
    // Legacy rows got a usable updated_at backfill.
    const match = raw.prepare('SELECT updated_at FROM matches WHERE id = 1').get();
    expect(match.updated_at).not.toBe('');

    // Duplicates collapsed to the lowest id; seq=2 untouched.
    const seqs = raw.prepare('SELECT seq FROM moves ORDER BY id').all().map((r) => r.seq);
    expect(seqs).toEqual([1, 2]);
    // And the index now enforces uniqueness.
    expect(() => raw.prepare('INSERT INTO moves (match_id, seq) VALUES (1, 2)').run()).toThrow();
  });

  test('openDb on an existing v1 file migrates it transparently', () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const file = path.join(os.tmpdir(), `cb-legacy-${Date.now()}.db`);
    try {
      const raw = new DatabaseSync(file);
      raw.exec("CREATE TABLE matches (id INTEGER PRIMARY KEY, code TEXT UNIQUE, created_at TEXT DEFAULT (datetime('now')))");
      raw.exec('CREATE TABLE moves (id INTEGER PRIMARY KEY, match_id INTEGER, seq INTEGER)');
      raw.close();

      const db = openDb(file); // SCHEMA creates missing tables; migrate upgrades matches/moves
      expect(db.prepare('PRAGMA table_info(matches)').all().map((c) => c.name)).toContain('updated_at');
      db.close();
    } finally {
      fs.unlinkSync(file);
    }
  });
});

describe('online-db lifecycle sweeper', () => {
  function seedLifecycle() {
    const host = store.createUser('host', 'h');
    const guest = store.createUser('guest', 'h');
    const staleWaiting = store.createMatch({ code: 'WAIT01', gridSize: 5, playerCount: 2, hostUserId: host.id });
    const idlePlaying = store.createMatch({ code: 'IDLE01', gridSize: 5, playerCount: 2, hostUserId: host.id });
    store.setMatchGuest(idlePlaying.id, guest.id); // PLAYING + fresh updated_at
    const livePlaying = store.createMatch({ code: 'LIVE01', gridSize: 5, playerCount: 2, hostUserId: host.id });
    store.setMatchGuest(livePlaying.id, guest.id);
    // Age the rows via direct SQL so the sweeper's datetime windows trip.
    store.db.prepare("UPDATE matches SET created_at = datetime('now', '-3 days') WHERE code = 'WAIT01'").run();
    store.db.prepare("UPDATE matches SET updated_at = datetime('now', '-8 days') WHERE code = 'IDLE01'").run();
    // Sessions: one expired, one live.
    store.insertSession('dead-token', host.id, '2020-01-01T00:00:00Z');
    store.insertSession('live-token', guest.id, '2099-01-01T00:00:00Z');
    return { staleWaiting, idlePlaying, livePlaying };
  }

  test('reaps stale WAITING/PLAYING rooms and expired sessions, spares live ones', () => {
    seedLifecycle();
    const report = sweepAbandoned(store.db);
    expect(report.abandonedWaiting).toBe(1);
    expect(report.abandonedPlaying).toBe(1);
    expect(report.deletedSessions).toBe(1);

    expect(store.getMatchByCode('WAIT01').status).toBe('ABANDONED');
    expect(store.getMatchByCode('IDLE01').status).toBe('ABANDONED');
    expect(store.getMatchByCode('LIVE01').status).toBe('PLAYING'); // untouched
    expect(store.getSession('dead-token')).toBeUndefined();
    expect(store.getSession('live-token')).toBeDefined();
  });

  test('sweeping is idempotent — a second pass reaps nothing', () => {
    seedLifecycle();
    sweepAbandoned(store.db);
    const second = sweepAbandoned(store.db);
    expect(second).toEqual({ abandonedWaiting: 0, abandonedPlaying: 0, deletedSessions: 0, prunedMatches: 0 });
  });

  test('FINISHED matches are never swept regardless of age', () => {
    const h = store.createUser('host', 'h');
    const m = store.createMatch({ code: 'DONE01', gridSize: 5, playerCount: 2, hostUserId: h.id });
    store.finishMatch(m.id, h.id);
    store.db.prepare("UPDATE matches SET finished_at = datetime('now', '-30 days') WHERE code = 'DONE01'").run();
    sweepAbandoned(store.db);
    expect(store.getMatchByCode('DONE01').status).toBe('FINISHED');
  });

  test('long-dead ABANDONED rooms are pruned with their move ledger; recent ones survive', () => {
    const h = store.createUser('host', 'h');
    const ancient = store.createMatch({ code: 'OLD001', gridSize: 5, playerCount: 2, hostUserId: h.id });
    const fresh = store.createMatch({ code: 'NEW001', gridSize: 5, playerCount: 2, hostUserId: h.id });

    // Mark both ABANDONED; age only the ancient one past retention.
    store.db.prepare("UPDATE matches SET status = 'ABANDONED' WHERE code IN ('OLD001','NEW001')").run();
    store.db.prepare("UPDATE matches SET updated_at = datetime('now', '-31 days') WHERE code = 'OLD001'").run();
    store.appendMove(ancient.id, 1, 0, '{"historic":true}');

    const report = sweepAbandoned(store.db);
    expect(report.prunedMatches).toBe(1);
    expect(store.getMatchByCode('OLD001')).toBeUndefined();
    // Ledger cascaded away with its match.
    expect(store.countMoves(ancient.id)).toBe(0);
    expect(store.getMatchByCode('NEW001').status).toBe('ABANDONED'); // within retention
  });
});