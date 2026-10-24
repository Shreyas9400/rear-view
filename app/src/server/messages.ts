// Inbound JSON message validation (docs/PROTOCOL_SPEC.md §5). Unknown fields are ignored (forward compatible).

import { CLOSE, LIMITS, PROTOCOL_VERSION } from '../shared/protocol';
import type { AlertLevel, HealthFlags } from '../shared/types';

export interface HelloMsg { type: 'hello'; token: string; clientId: string }
export interface AckMsg { type: 'ack'; seq: number }
export interface PingMsg { type: 'ping'; tClientMs: number }
export type ViewerMessage = HelloMsg | AckMsg | PingMsg;

export interface IngestHelloMsg { type: 'ingest_hello'; token: string }
export interface RearStatusMsg {
  type: 'rear_status';
  tEpochMs: number;
  alertLevel: AlertLevel;
  health: HealthFlags;
  captureFps: number;
  inferFps: number;
  inferP95Ms: number;
  droppedCapture: number;
  droppedBackpressure: number;
  /** The full original object, for relaying `alert` unchanged in `status`. */
  raw: Record<string, unknown>;
}
export type IngestMessage = IngestHelloMsg | RearStatusMsg;

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; code: number; reason: string };

const MAX_TOKEN_CHARS = 64;
const MAX_CLIENT_ID_CHARS = 64;
const LEVELS: readonly string[] = ['NORMAL', 'VEHICLE_NEARBY', 'POSSIBLE_APPROACH', 'UNAVAILABLE'];
const HEALTH_VALUES = {
  camera: ['ok', 'stalled', 'denied', 'error'],
  detector: ['ok', 'slow', 'failed'],
  sensors: ['ok', 'missing', 'off'],
  thermal: ['ok', 'warm', 'hot', 'unknown'],
} as const;

const bad = (reason: string): { ok: false; code: number; reason: string } => ({ ok: false, code: CLOSE.malformed, reason });
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function envelope(text: string): ParseResult<Record<string, unknown> & { type: string }> {
  if (new TextEncoder().encode(text).length > LIMITS.textMessageBytes) {
    return { ok: false, code: CLOSE.messageTooBig, reason: 'text message too large' };
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return bad('not valid JSON');
  }
  if (!isObj(v)) return bad('not an object');
  if (v.v !== PROTOCOL_VERSION) {
    return isNum(v.v)
      ? { ok: false, code: CLOSE.badVersion, reason: 'unsupported protocol version' }
      : bad('missing protocol version');
  }
  if (typeof v.type !== 'string') return bad('missing type');
  return { ok: true, msg: v as Record<string, unknown> & { type: string } };
}

export function parseViewerMessage(text: string): ParseResult<ViewerMessage> {
  const e = envelope(text);
  if (!e.ok) return e;
  const m = e.msg;
  switch (m.type) {
    case 'hello':
      if (typeof m.token !== 'string' || m.token.length === 0 || m.token.length > MAX_TOKEN_CHARS) return bad('bad token field');
      if (typeof m.clientId !== 'string' || m.clientId.length === 0 || m.clientId.length > MAX_CLIENT_ID_CHARS) return bad('bad clientId');
      return { ok: true, msg: { type: 'hello', token: m.token, clientId: m.clientId } };
    case 'ack':
      if (!Number.isInteger(m.seq) || (m.seq as number) < 0 || (m.seq as number) > 0xffffffff) return bad('bad seq');
      return { ok: true, msg: { type: 'ack', seq: m.seq as number } };
    case 'ping':
      if (!isNum(m.tClientMs)) return bad('bad tClientMs');
      return { ok: true, msg: { type: 'ping', tClientMs: m.tClientMs } };
    default:
      return bad('unknown message type');
  }
}

function parseHealth(h: unknown): HealthFlags | null {
  if (!isObj(h)) return null;
  for (const [k, allowed] of Object.entries(HEALTH_VALUES)) {
    if (!(allowed as readonly unknown[]).includes(h[k])) return null;
  }
  return h as unknown as HealthFlags;
}

export function parseIngestMessage(text: string): ParseResult<IngestMessage> {
  const e = envelope(text);
  if (!e.ok) return e;
  const m = e.msg;
  switch (m.type) {
    case 'ingest_hello':
      if (typeof m.token !== 'string' || m.token.length === 0 || m.token.length > MAX_TOKEN_CHARS) return bad('bad token field');
      return { ok: true, msg: { type: 'ingest_hello', token: m.token } };
    case 'rear_status': {
      const health = parseHealth(m.health);
      if (!health) return bad('bad health');
      if (!isObj(m.alert) || typeof m.alert.level !== 'string' || !LEVELS.includes(m.alert.level)) return bad('bad alert');
      for (const k of ['tEpochMs', 'captureFps', 'inferFps', 'inferP95Ms', 'droppedCapture', 'droppedBackpressure'] as const) {
        if (!isNum(m[k])) return bad(`bad ${k}`);
      }
      return {
        ok: true,
        msg: {
          type: 'rear_status',
          tEpochMs: m.tEpochMs as number,
          alertLevel: m.alert.level as AlertLevel,
          health,
          captureFps: m.captureFps as number,
          inferFps: m.inferFps as number,
          inferP95Ms: m.inferP95Ms as number,
          droppedCapture: m.droppedCapture as number,
          droppedBackpressure: m.droppedBackpressure as number,
          raw: m,
        },
      };
    }
    default:
      return bad('unknown message type');
  }
}
