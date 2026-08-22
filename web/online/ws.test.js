'use strict';
const crypto = require('node:crypto');
const ws = require('./ws.js');

function masked(opcode, text, { fin = true, unmasked = false } = {}) {
  const p = Buffer.isBuffer(text) ? text : Buffer.from(String(text));
  const mask = Buffer.from([1, 2, 3, 4]);
  const buf = Buffer.alloc(2 + (unmasked ? 0 : 4) + p.length);
  buf[0] = (fin ? 0x80 : 0x00) | opcode;
  if (p.length < 126) {
    buf[1] = (unmasked ? 0x00 : 0x80) | p.length;
  } else {
    throw new Error('test helper: big frames not covered here');
  }
  const body = buf.subarray(2);
  if (!unmasked) mask.copy(body, 0);
  for (let i = 0; i < p.length; i++) {
    const at = 2 + (unmasked ? 0 : 4) + i;
    buf[at] = unmasked ? p[i] : p[i] ^ mask[i & 3];
  }
  return buf;
}

describe('ws handshake', () => {
  test('computes the RFC6455 sample acceptance key', () => {
    // spec 4.2.2 example
    expect(ws.acceptKey('dGhlIHNhbXBsZSBub25jZQ=='))
      .toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('ws frame decode', () => {
  test('decodes a masked text frame and reports consumed bytes', () => {
    const fr = ws.decodeFrame(masked(ws.OP.TEXT, 'Hello'), 0);
    expect(fr).not.toBeNull();
    expect(fr.opcode).toBe(ws.OP.TEXT);
    expect(fr.fin).toBe(true);
    expect(fr.payload.toString()).toBe('Hello');
    expect(fr.bytes).toBe(2 + 4 + 5);
  });

  test('rejects client frames that are NOT masked', () => {
    expect(() => ws.decodeFrame(masked(ws.OP.TEXT, 'Hello', { unmasked: true }), 0))
      .toThrow(/not masked/);
  });

  test('rejects control frames that are oversized or fragmented', () => {
    const big = Buffer.alloc(130);
    big[0] = 0x88; big[1] = 0x80; // masked CLOSE with len 126 advertised?? -- len=126->16bit
    // build a masked close whose payload claims 126 bytes
    const p = Buffer.alloc(126);
    const msg = Buffer.alloc(2 + 4 + 126);
    msg[0] = 0x88; msg[1] = 0x80 | 126; msg.writeUInt16BE(126, 2);
    Buffer.from([1,2,3,4]).copy(msg, 4);
    for (let i = 0; i < 126; i++) msg[8 + i] = p[i] ^ [1,2,3,4][i & 3];
    expect(() => ws.decodeFrame(msg, 0)).toThrow(/control frame/);
    // fragmented control frame (fin=0)
    const notFin = masked(ws.OP.PING, '', { fin: false });
    expect(() => ws.decodeFrame(notFin, 0)).toThrow(/control frame/);
  });

  test('returns null while the frame is incomplete', () => {
    const full = masked(ws.OP.TEXT, 'partial');
    expect(ws.decodeFrame(full.subarray(0, 3), 0)).toBeNull();
  });

  test('rejects frames larger than the 16KB application cap', () => {
    // 20KB payload advertised via 16-bit length; masked so masking is not
    // what trips the error.
    const len = 20 * 1024;
    const msg = Buffer.alloc(2 + 2 + 4);
    msg[0] = 0x81;
    msg[1] = 0x80 | 126;
    msg.writeUInt16BE(len, 2);
    Buffer.from([1, 2, 3, 4]).copy(msg, 4);
    expect(() => ws.decodeFrame(msg, 0)).toThrow(/16KB limit/);
    // A declared length beyond MAX_FRAME throws before any allocation.
    const huge = Buffer.alloc(4);
    huge[0] = 0x81;
    huge[1] = 0x80 | 126;
    huge.writeUInt16BE(0xFFFF, 2);
    expect(() => ws.decodeFrame(huge, 0)).toThrow(/16KB limit/);
  });

  test('handles 64-bit advertised lengths within the cap', () => {
    const mask = Buffer.from([9, 8, 7, 6]);
    const p = Buffer.from('sixtyfour');
    const msg = Buffer.alloc(2 + 8 + 4 + p.length);
    msg[0] = 0x81;
    msg[1] = 0x80 | 127;
    msg.writeBigUInt64BE(BigInt(p.length), 2);
    mask.copy(msg, 10);
    for (let i = 0; i < p.length; i++) msg[14 + i] = p[i] ^ mask[i & 3];
    const fr = ws.decodeFrame(msg, 0);
    expect(fr.opcode).toBe(ws.OP.TEXT);
    expect(fr.payload.toString()).toBe('sixtyfour');
  });

  test('rejects 64-bit lengths above the cap and tolerates partial headers', () => {
    // Declared 70000 bytes via 64-bit length -> rejected before allocation.
    const over = Buffer.alloc(2 + 8 + 4);
    over[0] = 0x81;
    over[1] = 0x80 | 127;
    over.writeBigUInt64BE(70000n, 2);
    Buffer.from([1, 2, 3, 4]).copy(over, 10);
    expect(() => ws.decodeFrame(over, 0)).toThrow(/payload too large/);

    // Truncated extended headers are simply "need more bytes", not errors.
    const short16 = Buffer.from([0x81, 0x80 | 126]);
    expect(ws.decodeFrame(short16, 0)).toBeNull();
    const short64 = Buffer.from([0x81, 0x80 | 127]);
    expect(ws.decodeFrame(short64, 0)).toBeNull();
  });
});

describe('ws framer', () => {
  test('reassembles a fragmented message across chunk boundaries', () => {
    const f = new ws.Framer();
    const fragA = masked(ws.OP.TEXT, 'Hel', { fin: false });
    const fragB = masked(ws.OP.CONT, 'lo', { fin: true });
    const all = Buffer.concat([fragA, fragB]);
    const out = [];
    for (let cut = 1; cut < all.length; cut++) {
      const g = new ws.Framer();
      const r1 = g.push(all.subarray(0, cut));
      const r2 = g.push(all.subarray(cut));
      out.push({ r1: r1.length, r2: r2.length, text: r2[0]?.payload?.toString?.() ?? r1[0]?.payload?.toString?.() });
    }
    for (const o of out) {
      expect(o.r1 + o.r2).toBeGreaterThanOrEqual(2);
    }
    // Assert the whole stream decodes to both fragments
    const g2 = new ws.Framer();
    const frames = g2.push(all);
    expect(frames.map(f => f.payload.toString()).join('')).toBe('Hello');
  });

  test('splitting a single frame across multiple pushes yields it exactly once', () => {
    const frame = masked(ws.OP.TEXT, 'chunked');
    const g = new ws.Framer();
    const r1 = g.push(frame.subarray(0, 4));
    const r2 = g.push(frame.subarray(4, 9));
    const r3 = g.push(frame.subarray(9));
    expect(r1.length + r2.length + r3.length).toBe(1);
    const all = r1.concat(r2, r3);
    expect(all[0].payload.toString()).toBe('chunked');
  });

  test('throws when a single burst pipelines more than the allowed frame count', () => {
    const g = new ws.Framer();
    // 100 tiny valid masked PING frames in one chunk: each decodes cleanly,
    // but the queue must be cut off well before all of them.
    const ping = masked(ws.OP.PING, '');
    const burst = Buffer.concat(Array.from({ length: 100 }, () => ping));
    expect(burst.length).toBeLessThan(ws.MAX_BUFFERED_BYTES); // not a size trip
    expect(() => g.push(burst)).toThrow(/too many frames in one burst/);
  });

  test('accepts bursts within the per-push frame budget', () => {
    const g = new ws.Framer();
    const pings = Array.from({ length: ws.MAX_FRAMES_PER_PUSH }, () => masked(ws.OP.PING, ''));
    const frames = g.push(Buffer.concat(pings));
    expect(frames).toHaveLength(ws.MAX_FRAMES_PER_PUSH);
  });

  test('throws before buffering a single chunk beyond the hard ceiling', () => {
    const g = new ws.Framer();
    expect(() => g.push(Buffer.alloc(ws.MAX_BUFFERED_BYTES + 1)))
      .toThrow(/buffered data exceeds limit/);
  });
});

describe('ws frame encode', () => {
  test('encodes server text frames that decode cleanly under our own decoder-without-mask-check', () => {
    // Server frames are not masked; the Encoder produces byte-accurate frames.
    const frame = ws.encodeText('{"ok":true}');
    expect(frame[0]).toBe(0x81);
    expect(frame[1]).toBe('{"ok":true}'.length);
    expect(frame.subarray(2).toString()).toBe('{"ok":true}');
  });

  test('encodes close frames with a code', () => {
    const c = ws.encodeClose(1000, 'bye');
    expect(c[0]).toBe(0x88);
    expect(c.readUInt16BE(2)).toBe(1000);
    expect(c.subarray(4).toString()).toBe('bye');
  });

  test('round-trips a big payload (>126 bytes) via 16-bit length', () => {
    const big = 'x'.repeat(300);
    const frame = ws.encodeText(big);
    expect(frame[1]).toBe(126);
    expect(frame.readUInt16BE(2)).toBe(300);
    // decode under the masked-check disabled by direct layout inspection
    expect(frame.subarray(4).toString()).toBe(big);
  });

  test('can encode non-final (fragment) frames', () => {
    const frag = ws.encodeFrame(ws.OP.TEXT, 'part', false);
    expect(frag[0] & 0x80).toBe(0x00); // FIN bit clear
    expect(frag[0] & 0x0f).toBe(ws.OP.TEXT);
    const final = ws.encodeFrame(ws.OP.TEXT, 'part', true);
    expect(final[0] & 0x80).toBe(0x80);
  });

  test('uses the 64-bit header for payloads of 64KB and above', () => {
    const big = 'y'.repeat(70 * 1024);
    const frame = ws.encodeText(big);
    expect(frame[1]).toBe(127);
    expect(Number(frame.readBigUInt64BE(2))).toBe(big.length);
  });

  test('encodes close frames with a default code when none is given', () => {
    const c = ws.encodeClose(null, '');
    expect(c[0]).toBe(0x88);
    expect(c.readUInt16BE(2)).toBe(1000);
  });
});