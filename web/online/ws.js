// ============================================================
// CHOKA BARAH – Dependency-free RFC6455 WebSocket server
// ------------------------------------------------------------
// A minimal but spec-correct WebSocket implementation for Node's
// `http.Server` 'upgrade' events. Supports the text/close/ping/
// pong opcodes (the subset an online board game needs), server-side
// masking rules (client frames MUST be masked, server frames are
// NOT), and the standard Sec-WebSocket-Accept handshake. No `ws`
// dependency keeps the online backend fully self-contained.
// ============================================================
'use strict';

const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

// Protocol limits sized for this application: every legal message is a small
// JSON document (<1KB). Anything larger is a resource-exhaustion attempt, so
// the caps are tight — a hostile frame can never make the process allocate
// tens of megabytes from a single socket.
const MAX_FRAME = 16 * 1024;              // largest single allowed frame
const MAX_BUFFERED_BYTES = 64 * 1024;     // hard ceiling (defense-in-depth)
const MAX_FRAMES_PER_PUSH = 64;           // anti-burst: pipelined tiny frames

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

// ---- Frame decode (client -> server; MUST be masked) ----
// Returns { fin, opcode, payload, bytes } for a single complete frame, or
// null if more bytes are needed. Throws on protocol violations.
function decodeFrame(buf, offset) {
  if (buf.length < offset + 2) return null;
  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let cursor = offset + 2;

  if (len === 126) {
    if (buf.length < cursor + 2) return null;
    len = buf.readUInt16BE(cursor);
    cursor += 2;
  } else if (len === 127) {
    if (buf.length < cursor + 8) return null;
    const big = buf.readBigUInt64BE(cursor);
    if (big > BigInt(MAX_FRAME)) throw new Error('ws: payload too large');
    len = Number(big);
    cursor += 8;
  }
  if (len > MAX_FRAME) throw new Error('ws: frame exceeds 16KB limit');

  const isControl = opcode >= 0x8;
  if (isControl && (len > 125 || !fin)) throw new Error('ws: malformed control frame');
  if (!masked) throw new Error('ws: client frame not masked');

  if (buf.length < cursor + 4) return null;
  const mask = buf.subarray(cursor, cursor + 4);
  cursor += 4;
  if (buf.length < cursor + len) return null;

  const payload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) payload[i] = buf[cursor + i] ^ mask[i & 3];
  return { fin, opcode, payload, bytes: cursor + len - offset };
}

// ---- Frame encode (server -> client; never masked) ----
function encodeFrame(opcode, payload, fin) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const first = (fin === false ? 0x00 : 0x80) | opcode;
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([first, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function encodeText(text) { return encodeFrame(OP.TEXT, text, true); }
function encodePing() { return encodeFrame(OP.PING, Buffer.alloc(0), true); }
function encodePong() { return encodeFrame(OP.PONG, Buffer.alloc(0), true); }
function encodeClose(code, reason) {
  const reasonBuf = Buffer.from(reason || '', 'utf8');
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code == null ? 1000 : code, 0);
  reasonBuf.copy(payload, 2);
  return encodeFrame(OP.CLOSE, payload, true);
}

// Accumulates raw socket bytes and yields complete frames.
class Framer {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.frames = [];
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    // Hard ceiling on buffered bytes (belt-and-braces: a single frame is
    // capped well below this by MAX_FRAME).
    if (this.buf.length > MAX_BUFFERED_BYTES) {
      throw new Error('ws: buffered data exceeds limit');
    }
    const out = [];
    for (;;) {
      const frame = decodeFrame(this.buf, 0);
      if (!frame) break;
      out.push(frame);
      // A flood of tiny pipelined valid frames must not balloon the decoded
      // queue (and the handler work it triggers) from a single socket read.
      if (out.length > MAX_FRAMES_PER_PUSH) {
        throw new Error('ws: too many frames in one burst');
      }
      this.buf = this.buf.subarray(frame.bytes);
    }
    return out;
  }
}

module.exports = {
  GUID, OP, MAX_FRAME, MAX_BUFFERED_BYTES, MAX_FRAMES_PER_PUSH,
  acceptKey, decodeFrame, encodeFrame, encodeText, encodePing, encodePong, encodeClose, Framer
};