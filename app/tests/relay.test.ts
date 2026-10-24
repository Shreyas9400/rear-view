import { describe, expect, it } from 'vitest';
import { ACK_TIMEOUT_MS, FrameRelay, ViewerChannel } from '../src/server/relay';
import { encodeFrame, FrameFormatError } from '../src/stream/frameCodec';
import { fakeJpeg, frameMeta } from './helpers';

const frame = (seq: number) => encodeFrame(frameMeta(seq), fakeJpeg());

function viewer() {
  const sent: Uint8Array[] = [];
  return { sent, ch: new ViewerChannel((b) => sent.push(b)) };
}

describe('ViewerChannel', () => {
  it('sends immediately while credit is available, up to 2 unacked', () => {
    const { sent, ch } = viewer();
    ch.offer(frame(1), 1, 0);
    ch.offer(frame(2), 2, 10);
    ch.offer(frame(3), 3, 20);
    expect(sent).toHaveLength(2);
    expect(ch.unacked()).toBe(2);
    expect(ch.hasPending()).toBe(true);
  });

  it('keeps only the newest unsent frame and sends it when an ack frees credit', () => {
    const { sent, ch } = viewer();
    ch.offer(frame(1), 1, 0);
    ch.offer(frame(2), 2, 0);
    ch.offer(frame(3), 3, 0);
    ch.offer(frame(4), 4, 0);
    ch.offer(frame(5), 5, 0);
    expect(ch.replaced).toBe(2); // 3 and 4 were replaced by 5
    ch.ack(1, 100);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual(frame(5));
    expect(ch.hasPending()).toBe(false);
  });

  it('an ack for a later seq releases every earlier outstanding frame', () => {
    const { ch } = viewer();
    ch.offer(frame(1), 1, 0);
    ch.offer(frame(2), 2, 0);
    ch.ack(2, 50);
    expect(ch.unacked()).toBe(0);
  });

  it('ignores acks for frames it never sent', () => {
    const { ch } = viewer();
    ch.offer(frame(5), 5, 0);
    ch.ack(2, 10);
    expect(ch.unacked()).toBe(1);
  });

  it('never grows a queue when the viewer is slow: memory is bounded by one slot', () => {
    const { sent, ch } = viewer();
    for (let i = 1; i <= 1000; i++) ch.offer(frame(i), i, i);
    expect(sent).toHaveLength(2);
    expect(ch.replaced).toBe(997);
  });

  it('flags a viewer that stops acking for more than 5 s', () => {
    const { ch } = viewer();
    ch.offer(frame(1), 1, 1000);
    expect(ch.isStalled(1000 + ACK_TIMEOUT_MS)).toBe(false);
    expect(ch.isStalled(1000 + ACK_TIMEOUT_MS + 1)).toBe(true);
    ch.ack(1, 6000);
    expect(ch.isStalled(20_000)).toBe(false); // nothing outstanding
  });

  it('an ack counts as progress for the timeout', () => {
    const { ch } = viewer();
    ch.offer(frame(1), 1, 0);
    ch.offer(frame(2), 2, 0);
    ch.ack(1, 4000);
    expect(ch.isStalled(8000)).toBe(false);
    expect(ch.isStalled(9001)).toBe(true);
  });
});

describe('FrameRelay', () => {
  it('forwards valid frames unchanged to every viewer and tracks frame age', () => {
    const relay = new FrameRelay();
    const a = viewer();
    const b = viewer();
    relay.addViewer(a.ch);
    relay.addViewer(b.ch);
    expect(relay.lastFrameAgeMs(0)).toBeNull();

    const bytes = frame(7);
    relay.onIngestFrame(bytes, 1000);
    expect(a.sent[0]).toBe(bytes);
    expect(b.sent[0]).toBe(bytes);
    expect(relay.lastFrameAgeMs(1250)).toBe(250);

    relay.removeViewer(b.ch);
    expect(relay.viewerCount()).toBe(1);
  });

  it('rejects an invalid frame without forwarding it or refreshing the frame age', () => {
    const relay = new FrameRelay();
    const v = viewer();
    relay.addViewer(v.ch);
    relay.onIngestFrame(frame(1), 0);
    expect(() => relay.onIngestFrame(new Uint8Array(20), 500)).toThrow(FrameFormatError);
    expect(v.sent).toHaveLength(1);
    expect(relay.lastFrameAgeMs(900)).toBe(900);
  });
});
