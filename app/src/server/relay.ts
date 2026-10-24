// Newest-frame-wins relay (docs/PROTOCOL_SPEC.md §8). A slow viewer lowers frame rate; it never grows a queue.
// Memory held per viewer: one unsent frame. seq comparisons ignore uint32 wrap (~13 years at 10 fps).

import { LIMITS } from '../shared/protocol';
import { decodeFrame } from '../stream/frameCodec';

export const ACK_TIMEOUT_MS = 5000;

export class ViewerChannel {
  private slot: { bytes: Uint8Array; seq: number } | null = null;
  private outstanding: number[] = [];
  private progressAtMs = 0;
  replaced = 0;
  sent = 0;

  /** `send` must transmit immediately (the relay does the buffering). */
  constructor(private readonly send: (frame: Uint8Array) => void) {}

  /** Offer the newest frame; replaces an unsent older one. */
  offer(bytes: Uint8Array, seq: number, nowMs: number): void {
    if (this.slot) this.replaced++;
    this.slot = { bytes, seq };
    this.flush(nowMs);
  }

  /** Viewer acks the last frame it drew; every outstanding frame up to `seq` is released. */
  ack(seq: number, nowMs: number): void {
    const before = this.outstanding.length;
    this.outstanding = this.outstanding.filter((s) => s > seq);
    if (this.outstanding.length < before) this.progressAtMs = nowMs;
    this.flush(nowMs);
  }

  /** True if the viewer has stopped acking and should be closed with CLOSE.slowViewer. */
  isStalled(nowMs: number): boolean {
    return this.outstanding.length > 0 && nowMs - this.progressAtMs > ACK_TIMEOUT_MS;
  }

  unacked(): number {
    return this.outstanding.length;
  }

  hasPending(): boolean {
    return this.slot !== null;
  }

  private flush(nowMs: number): void {
    if (!this.slot || this.outstanding.length >= LIMITS.ackCredit) return;
    const { bytes, seq } = this.slot;
    this.slot = null;
    if (this.outstanding.length === 0) this.progressAtMs = nowMs;
    this.outstanding.push(seq);
    this.sent++;
    this.send(bytes);
  }
}

/** Ingest side: validate each frame, remember how old the newest is, fan out to viewers. */
export class FrameRelay {
  private channels = new Set<ViewerChannel>();
  private lastFrameAtMs: number | null = null;

  addViewer(c: ViewerChannel): void {
    this.channels.add(c);
  }

  removeViewer(c: ViewerChannel): void {
    this.channels.delete(c);
  }

  viewerCount(): number {
    return this.channels.size;
  }

  /** Throws FrameFormatError (with the close code) for an invalid frame; valid bytes are forwarded unchanged. */
  onIngestFrame(bytes: Uint8Array, nowMs: number): void {
    const { meta } = decodeFrame(bytes);
    this.lastFrameAtMs = nowMs;
    for (const c of this.channels) c.offer(bytes, meta.seq, nowMs);
  }

  /** `lastFrameAgeMs` for the 1 Hz `status`; null if no frame has arrived yet. */
  lastFrameAgeMs(nowMs: number): number | null {
    return this.lastFrameAtMs === null ? null : nowMs - this.lastFrameAtMs;
  }
}
