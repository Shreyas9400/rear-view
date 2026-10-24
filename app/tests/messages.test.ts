import { describe, expect, it } from 'vitest';
import { parseIngestMessage, parseViewerMessage } from '../src/server/messages';
import { CLOSE, LIMITS } from '../src/shared/protocol';
import { OK } from './helpers';

const j = (o: unknown) => JSON.stringify(o);
const hello = { v: 1, type: 'hello', token: 'q3J0u8o2zY9mPpL1hT6VdA', clientId: 'c-7f31a9', caps: { jpeg: true } };
const status = {
  v: 1, type: 'rear_status', tEpochMs: 1, alert: { level: 'NORMAL', reasons: [], trackIds: [], tMs: 1, health: OK }, health: OK,
  captureFps: 14.8, inferFps: 4.6, inferP95Ms: 310, droppedCapture: 12, droppedBackpressure: 0,
};

describe('viewer messages', () => {
  it('parses the spec examples', () => {
    expect(parseViewerMessage(j(hello))).toEqual({ ok: true, msg: { type: 'hello', token: hello.token, clientId: 'c-7f31a9' } });
    expect(parseViewerMessage(j({ v: 1, type: 'ack', seq: 10432 }))).toMatchObject({ ok: true, msg: { type: 'ack', seq: 10432 } });
    expect(parseViewerMessage(j({ v: 1, type: 'ping', tClientMs: 1792670001000 }))).toMatchObject({ ok: true });
  });

  it('ignores unknown fields', () => {
    expect(parseViewerMessage(j({ ...hello, future: 1 }))).toMatchObject({ ok: true });
  });

  it('answers an unsupported version with 4426 and everything malformed with 4400', () => {
    expect(parseViewerMessage(j({ ...hello, v: 2 }))).toMatchObject({ ok: false, code: CLOSE.badVersion });
    for (const bad of ['{', '[]', '"x"', j({ type: 'hello' }), j({ v: 1 }), j({ v: 1, type: 'nope' }), j({ ...hello, token: 5 }), j({ ...hello, token: '' }), j({ ...hello, clientId: 'x'.repeat(65) })]) {
      expect(parseViewerMessage(bad)).toMatchObject({ ok: false, code: CLOSE.malformed });
    }
  });

  it('rejects bad ack and ping values', () => {
    for (const seq of [-1, 1.5, 2 ** 32, '3', null]) {
      expect(parseViewerMessage(j({ v: 1, type: 'ack', seq }))).toMatchObject({ ok: false, code: CLOSE.malformed });
    }
    expect(parseViewerMessage('{"v":1,"type":"ping","tClientMs":"x"}')).toMatchObject({ ok: false });
  });

  it('rejects oversize text with 1009 and does not accept the ingest-only types', () => {
    const big = j({ ...hello, clientId: 'c', pad: 'x'.repeat(LIMITS.textMessageBytes) });
    expect(parseViewerMessage(big)).toMatchObject({ ok: false, code: CLOSE.messageTooBig });
    expect(parseViewerMessage(j(status))).toMatchObject({ ok: false, code: CLOSE.malformed });
  });
});

describe('ingest messages', () => {
  it('parses ingest_hello and rear_status', () => {
    expect(parseIngestMessage(j({ v: 1, type: 'ingest_hello', token: 'T' }))).toMatchObject({ ok: true, msg: { type: 'ingest_hello' } });
    const r = parseIngestMessage(j(status));
    expect(r).toMatchObject({ ok: true, msg: { type: 'rear_status', alertLevel: 'NORMAL', inferFps: 4.6 } });
  });

  it('rejects a rear_status with unknown health or alert values or non-finite numbers', () => {
    expect(parseIngestMessage(j({ ...status, health: { ...OK, camera: 'great' } }))).toMatchObject({ ok: false });
    expect(parseIngestMessage(j({ ...status, health: undefined }))).toMatchObject({ ok: false });
    expect(parseIngestMessage(j({ ...status, alert: { level: 'ALL_CLEAR' } }))).toMatchObject({ ok: false });
    expect(parseIngestMessage(j({ ...status, inferFps: null }))).toMatchObject({ ok: false });
  });

  it('does not accept viewer messages', () => {
    expect(parseIngestMessage(j(hello))).toMatchObject({ ok: false, code: CLOSE.malformed });
  });
});
