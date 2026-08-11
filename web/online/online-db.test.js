'use strict';
const { openDb, makeStore } = require('./online-db.js');

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