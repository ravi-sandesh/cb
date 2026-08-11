// ============================================================
// CHOKA BARAH – Server-authoritative game driver
// ------------------------------------------------------------
// The online server must NEVER trust a client's board. This module
// owns the ONLY game state that counts: it seeds a fresh game,
// rolls cowries server-side (injectable RNG for tests), recomputes
// valid moves with the shared engine, and applies moves only when
// they (a) come from the correct player, (b) target a cell reachable
// by the current roll — verified by re-deriving validMoves from the
// authoritative state. The engine (game-engine.js) is the same pure
// module shipped to both clients, so validation is byte-identical.
// ============================================================
'use strict';

const EG = require('../game-engine.js');

// A move candidate from a client is matched against the authoritative move
// set by (player, pawn id set, target cell). The engine computes full move
// structs (with computed flags); a client may only ever SEND a minimal
// {pawnIds, targetCoords} — the server derives isCapture/reachesHome/etc
// itself, so a forged flag can never buy an illegal capture or a fake win.
function matchMove(validMove, candidate) {
  if (!candidate || !Array.isArray(candidate.targetCoords) || candidate.targetCoords.length !== 2) return null;
  const ids = (candidate.pawnIds || []).map(Number);
  if (ids.length !== validMove.grpPawns.length) return null;
  const validIds = validMove.grpPawns.map(p => p.id).sort((a, b) => a - b);
  const sorted = ids.slice().sort((a, b) => a - b);
  if (sorted.some((id, i) => id !== validIds[i])) return null;
  if (candidate.targetCoords[0] !== validMove.targetCoords[0]) return null;
  if (candidate.targetCoords[1] !== validMove.targetCoords[1]) return null;
  return validMove;
}

function newGame({ gridSize, playerNum, rng }) {
  const gs = gridSize === 7 || gridSize === 5 ? gridSize : 5;
  const num = (playerNum && playerNum >= 2 && playerNum <= 4) ? playerNum : 2;
  const state = EG.createInitialState(gs, num);
  return {
    gridSize: gs,
    playerNum: num,
    pawns: state.pawns,
    hasCapturedOpponent: state.hasCapturedOpponent,
    currentPlayerIndex: 0,
    currentRoll: null,
    validMoves: [],
    winner: null,
    rng: rng || Math.random,
    log: []
  };
}

function serializeBoard(state) {
  return {
    gridSize: state.gridSize,
    playerNum: state.playerNum,
    pawns: state.pawns,
    hasCapturedOpponent: state.hasCapturedOpponent,
    currentPlayerIndex: state.currentPlayerIndex,
    currentRoll: state.currentRoll,
    validMoves: state.validMoves.map(m => ({
      pawnIds: m.grpPawns.map(p => p.id),
      targetCoords: m.targetCoords,
      isCapture: m.isCapture,
      reachesHome: m.reachesHome,
      isGattiGroup: !!m.isGattiGroup
    })),
    winner: state.winner
  };
}

function pushEvent(state, msg) {
  state.log.push(msg);
  if (state.log.length > 50) state.log.splice(0, state.log.length - 50);
  return msg;
}

// Roll for the CURRENT player. Returns null on error (out of turn / already
// rolled / game over). On success updates state in place and returns a log line.
function doRoll(state) {
  if (state.winner !== null) return { ok: false, reason: 'game-over' };
  if (state.currentRoll !== null) return { ok: false, reason: 'already-rolled' };

  const n = state.gridSize === 5 ? 4 : 6;
  const shells = Array.from({ length: n }, () => state.rng() > 0.5);
  const { score, scoreText, isExtraRoll } = EG.scoreCowryRoll(state.gridSize, shells);
  state.currentRoll = { shells, score, isExtraRoll, scoreText };
  state.validMoves = EG.calculateValidMoves(
    state.gridSize, state.pawns, state.currentPlayerIndex, state.hasCapturedOpponent, score
  );

  if (state.validMoves.length === 0) {
    state.currentRoll = null;
    if (isExtraRoll) {
      // Extra roll (Chowka/Baara) that found no moves: same player re-rolls.
      return { ok: true, result: 'reroll', score, scoreText, isExtraRoll };
    }
    // Dead roll: turn passes with no move (mirrors the app's auto-advance).
    const from = state.currentPlayerIndex;
    state.currentPlayerIndex = EG.advanceTurn(state.playerNum, state.currentPlayerIndex);
    return { ok: true, result: 'no-moves', score, scoreText, from, to: state.currentPlayerIndex };
  }

  return { ok: true, result: 'rolled', score, scoreText, isExtraRoll, moveCount: state.validMoves.length };
}

// Apply a move for the CURRENT player. The candidate is normalized + matched
// against the authoritative validMoves; anything else is rejected.
function doMove(state, candidate) {
  if (state.winner !== null) return { ok: false, reason: 'game-over' };
  if (!state.currentRoll) return { ok: false, reason: 'no-roll' };
  if (state.validMoves.length === 0) return { ok: false, reason: 'no-moves' };

  const matched = state.validMoves.map(m => matchMove(m, candidate)).find(Boolean);
  if (!matched) return { ok: false, reason: 'illegal-move' };

  const res = EG.executeMove(
    state.gridSize,
    state.pawns,
    state.hasCapturedOpponent,
    state.currentPlayerIndex,
    matched,
    state.currentRoll
  );
  if (res.error) return { ok: false, reason: 'engine-rejected' };

  state.pawns = res.pawns;
  state.hasCapturedOpponent = res.hasCapturedOpponent;
  state.currentRoll = null;
  state.validMoves = [];
  state.winner = res.winner;

  const event = {
    ok: true,
    capturedCount: res.capturedCount,
    gattiFormed: res.gattiFormed,
    extraTurn: res.extraTurn,
    winner: res.winner
  };

  if (res.winner !== null) {
    pushEvent(state, `Player ${state.currentPlayerIndex} won`);
    return event;
  }
  if (res.extraTurn) {
    // Extra turn: same player rolls again.
    return event;
  }
  state.currentPlayerIndex = EG.advanceTurn(state.playerNum, state.currentPlayerIndex);
  return event;
}

module.exports = {
  newGame, doRoll, doMove, serializeBoard, matchMove, pushEvent
};