// Time-windowed sample statistics for the pipeline (latency percentiles, rates). Pure; time is passed in.

export class RollingWindow {
  private s: { t: number; v: number }[] = [];

  constructor(
    private readonly windowMs: number,
    private readonly maxSamples = 512,
  ) {}

  add(nowMs: number, v: number): void {
    this.s.push({ t: nowMs, v });
    this.prune(nowMs);
  }

  clear(): void {
    this.s = [];
  }

  /** Samples inside the window ending at `nowMs`, oldest first. */
  values(nowMs: number): number[] {
    this.prune(nowMs);
    return this.s.map((x) => x.v);
  }

  count(nowMs: number): number {
    this.prune(nowMs);
    return this.s.length;
  }

  median(nowMs: number): number {
    return this.percentile(nowMs, 50);
  }

  p95(nowMs: number): number {
    return this.percentile(nowMs, 95);
  }

  /** NaN when empty. */
  percentile(nowMs: number, p: number): number {
    const v = this.values(nowMs);
    if (!v.length) return NaN;
    const sorted = [...v].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  }

  /** Samples per second between the first and last sample in the window; 0 with fewer than two samples. */
  ratePerSec(nowMs: number): number {
    this.prune(nowMs);
    if (this.s.length < 2) return 0;
    const span = this.s[this.s.length - 1]!.t - this.s[0]!.t;
    return span > 0 ? ((this.s.length - 1) * 1000) / span : 0;
  }

  private prune(nowMs: number): void {
    const cut = nowMs - this.windowMs;
    let i = 0;
    while (i < this.s.length && this.s[i]!.t < cut) i++;
    if (i > 0) this.s.splice(0, i);
    if (this.s.length > this.maxSamples) this.s.splice(0, this.s.length - this.maxSamples);
  }
}
