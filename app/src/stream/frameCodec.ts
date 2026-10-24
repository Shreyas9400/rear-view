// Binary frame format "RVF1" (docs/PROTOCOL_SPEC.md §7): magic(4) | metaLen u32 BE | meta JSON | JPEG.

import { CLOSE, FRAME_MAGIC, LIMITS, PROTOCOL_VERSION } from '../shared/protocol';
import type { FrameMeta } from '../shared/types';

/** Carries the WebSocket close code the receiver should use. */
export class FrameFormatError extends Error {
  constructor(message: string, readonly closeCode: number) {
    super(message);
    this.name = 'FrameFormatError';
  }
}

const HEADER = 8;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

function hasJpegSoi(b: Uint8Array): boolean {
  return b.length >= 2 && b[0] === 0xff && b[1] === 0xd8;
}

export function encodeFrame(meta: FrameMeta, jpeg: Uint8Array): Uint8Array {
  const metaBytes = enc.encode(JSON.stringify(meta));
  if (metaBytes.length > LIMITS.metaBytes) throw new FrameFormatError('meta too large', CLOSE.messageTooBig);
  if (jpeg.length > LIMITS.jpegBytes) throw new FrameFormatError('jpeg too large', CLOSE.messageTooBig);
  const out = new Uint8Array(HEADER + metaBytes.length + jpeg.length);
  out.set(enc.encode(FRAME_MAGIC), 0);
  new DataView(out.buffer).setUint32(4, metaBytes.length, false);
  out.set(metaBytes, HEADER);
  out.set(jpeg, HEADER + metaBytes.length);
  return out;
}

export interface DecodedFrame {
  meta: FrameMeta;
  /** View into the input; the server forwards the original bytes unchanged. */
  jpeg: Uint8Array;
}

/** Validates and parses one binary message. Throws FrameFormatError with the close code to use. */
export function decodeFrame(buf: Uint8Array): DecodedFrame {
  if (buf.length > LIMITS.frameMessageBytes) throw new FrameFormatError('message too large', CLOSE.messageTooBig);
  if (buf.length < HEADER) throw new FrameFormatError('truncated header', CLOSE.malformed);
  for (let i = 0; i < 4; i++) {
    if (buf[i] !== FRAME_MAGIC.charCodeAt(i)) throw new FrameFormatError('bad magic', CLOSE.malformed);
  }
  const metaLen = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(4, false);
  if (metaLen === 0 || metaLen > LIMITS.metaBytes) throw new FrameFormatError('bad metaLen', CLOSE.malformed);
  if (HEADER + metaLen >= buf.length) throw new FrameFormatError('no jpeg payload', CLOSE.malformed);

  let meta: unknown;
  try {
    meta = JSON.parse(dec.decode(buf.subarray(HEADER, HEADER + metaLen)));
  } catch {
    throw new FrameFormatError('meta is not valid JSON', CLOSE.malformed);
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new FrameFormatError('meta is not an object', CLOSE.malformed);
  }
  const m = meta as Partial<FrameMeta>;
  if (m.v !== PROTOCOL_VERSION) throw new FrameFormatError('unsupported meta version', CLOSE.malformed);
  if (!Number.isInteger(m.seq) || (m.seq as number) < 0 || (m.seq as number) > 0xffffffff) {
    throw new FrameFormatError('bad seq', CLOSE.malformed);
  }

  const jpeg = buf.subarray(HEADER + metaLen);
  if (jpeg.length > LIMITS.jpegBytes) throw new FrameFormatError('jpeg too large', CLOSE.messageTooBig);
  if (!hasJpegSoi(jpeg)) throw new FrameFormatError('payload is not a JPEG', CLOSE.malformed);
  return { meta: m as FrameMeta, jpeg };
}
