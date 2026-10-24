// Minimal QR Code encoder (ISO/IEC 18004): byte mode, error correction L or M, versions 1-6 (up to 134 bytes at L). Pure, no
// dependencies, so it runs in Node tests. Enough for the viewer link (about 52 characters). Not a general-purpose encoder.

export type EcLevel = 'L' | 'M';

// per version (index 1..6): total codewords, then per level [ec codewords per block, block count]
const VERSIONS: { total: number; L: [number, number]; M: [number, number] }[] = [
  { total: 0, L: [0, 0], M: [0, 0] },
  { total: 26, L: [7, 1], M: [10, 1] },
  { total: 44, L: [10, 1], M: [16, 1] },
  { total: 70, L: [15, 1], M: [26, 1] },
  { total: 100, L: [20, 1], M: [18, 2] },
  { total: 134, L: [26, 1], M: [24, 2] },
  { total: 172, L: [18, 2], M: [16, 4] },
];
const ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

// GF(256) with the QR polynomial 0x11D
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

const gmul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

/** Generator polynomial coefficients (highest degree first, leading 1 omitted is NOT done: full length n+1). */
export function rsGenerator(n: number): number[] {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] = next[j]! ^ g[j]!;
      next[j + 1] = next[j + 1]! ^ gmul(g[j]!, EXP[i]!);
    }
    g = next;
  }
  return g;
}

export function rsEncode(data: number[], ecLen: number): number[] {
  const g = rsGenerator(ecLen);
  const res = new Array<number>(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ res[0]!;
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i++) res[i] = res[i]! ^ gmul(g[i + 1]!, factor);
  }
  return res;
}

/** 15-bit format information for (level, mask), BCH protected and XOR-masked (ISO 18004 section 7.9). */
export function formatBits(level: EcLevel, mask: number): number {
  const data = ((level === 'L' ? 1 : 0) << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}

function dataCapacityBytes(version: number, level: EcLevel): number {
  const v = VERSIONS[version]!;
  const [ecPerBlock, blocks] = v[level];
  return v.total - ecPerBlock * blocks;
}

function pickVersion(len: number, level: EcLevel): number {
  for (let v = 1; v <= 6; v++) if (len + 2 <= dataCapacityBytes(v, level)) return v; // 4-bit mode + 8-bit count + data (+ terminator) fit in len+2 bytes
  throw new Error(`QR: ${len} bytes do not fit versions 1-6`);
}

function buildCodewords(bytes: number[], version: number, level: EcLevel): number[] {
  const cap = dataCapacityBytes(version, level);
  const bits: number[] = [];
  const push = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, cap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    data.push(b);
  }
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);

  const [ecLen, blockCount] = VERSIONS[version]![level];
  const shortLen = Math.floor(cap / blockCount); // all blocks equal for versions 1-6 at these levels
  const blocks: { d: number[]; e: number[] }[] = [];
  for (let b = 0; b < blockCount; b++) {
    const d = data.slice(b * shortLen, (b + 1) * shortLen);
    blocks.push({ d, e: rsEncode(d, ecLen) });
  }
  const out: number[] = [];
  for (let i = 0; i < shortLen; i++) for (const b of blocks) out.push(b.d[i]!);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]!);
  return out;
}

class Matrix {
  readonly n: number;
  readonly m: number[][];
  readonly fn: boolean[][];
  constructor(version: number) {
    this.n = 17 + 4 * version;
    this.m = Array.from({ length: this.n }, () => new Array<number>(this.n).fill(0));
    this.fn = Array.from({ length: this.n }, () => new Array<boolean>(this.n).fill(false));
  }
  set(r: number, c: number, v: number, fn = true): void {
    this.m[r]![c] = v;
    if (fn) this.fn[r]![c] = true;
  }
}

function drawFunctionPatterns(mx: Matrix, version: number): void {
  const n = mx.n;
  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6);
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        mx.set(rr, cc, inRing || inCore ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) {
    mx.set(6, i, i % 2 === 0 ? 1 : 0);
    mx.set(i, 6, i % 2 === 0 ? 1 : 0);
  }
  const pos = ALIGN[version]!;
  for (const r of pos) {
    for (const c of pos) {
      if ((r === 6 && c === 6) || (r === 6 && c === pos[pos.length - 1]) || (r === pos[pos.length - 1] && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mx.set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) === 1 ? 0 : 1);
    }
  }
  // reserve format areas (written later) and the dark module
  for (let i = 0; i < 9; i++) {
    mx.fn[8]![i] = true;
    mx.fn[i]![8] = true;
  }
  for (let i = 0; i < 8; i++) {
    mx.fn[8]![n - 1 - i] = true;
    mx.fn[n - 1 - i]![8] = true;
  }
  mx.set(n - 8, 8, 1);
}

function placeData(mx: Matrix, codewords: number[]): void {
  const n = mx.n;
  let bit = 0;
  const total = codewords.length * 8;
  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < n; i++) {
      const r = up ? n - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (mx.fn[r]![c]) continue;
        const v = bit < total ? (codewords[bit >> 3]! >> (7 - (bit & 7))) & 1 : 0;
        mx.set(r, c, v, false);
        bit++;
      }
    }
    up = !up;
  }
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(mx: Matrix, mask: number): number[][] {
  const out = mx.m.map((row) => row.slice());
  for (let r = 0; r < mx.n; r++) for (let c = 0; c < mx.n; c++) if (!mx.fn[r]![c] && MASKS[mask]!(r, c)) out[r]![c] = out[r]![c]! ^ 1;
  return out;
}

function writeFormat(m: number[][], level: EcLevel, mask: number): void {
  const n = m.length;
  const bits = formatBits(level, mask);
  const b = (i: number) => (bits >> i) & 1;
  for (let i = 0; i <= 5; i++) m[i]![8] = b(i);
  m[7]![8] = b(6);
  m[8]![8] = b(7);
  m[8]![7] = b(8);
  for (let i = 9; i < 15; i++) m[8]![14 - i] = b(i);
  for (let i = 0; i < 8; i++) m[8]![n - 1 - i] = b(i);
  for (let i = 8; i < 15; i++) m[n - 15 + i]![8] = b(i);
  m[n - 8]![8] = 1;
}

function penalty(m: number[][]): number {
  const n = m.length;
  let p = 0;
  const line = (get: (i: number) => number) => {
    let run = 1;
    for (let i = 1; i < n; i++) {
      if (get(i) === get(i - 1)) {
        run++;
        if (run === 5) p += 3;
        else if (run > 5) p += 1;
      } else run = 1;
    }
    const s = Array.from({ length: n }, (_, i) => get(i)).join('');
    for (const pat of ['10111010000', '00001011101']) {
      let at = s.indexOf(pat);
      while (at >= 0) {
        p += 40;
        at = s.indexOf(pat, at + 1);
      }
    }
  };
  for (let r = 0; r < n; r++) line((i) => m[r]![i]!);
  for (let c = 0; c < n; c++) line((i) => m[i]![c]!);
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (m[r]![c] === m[r]![c + 1] && m[r]![c] === m[r + 1]![c] && m[r]![c] === m[r + 1]![c + 1]) p += 3;
  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return p;
}

/** Encodes text (UTF-8) as a QR module matrix: rows of 0/1, no quiet zone. */
export function encodeQr(text: string, level: EcLevel = 'M'): number[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = pickVersion(bytes.length, level);
  const cw = buildCodewords(bytes, version, level);
  const mx = new Matrix(version);
  drawFunctionPatterns(mx, version);
  placeData(mx, cw);
  let best: number[][] | null = null;
  let bestP = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = applyMask(mx, mask);
    writeFormat(m, level, mask);
    const p = penalty(m);
    if (p < bestP) {
      bestP = p;
      best = m;
    }
  }
  return best!;
}

/** Draws the matrix on a 2D canvas with a 4-module quiet zone (black on white; scanners need that contrast). */
export function drawQr(ctx: { fillStyle: string | CanvasGradient | CanvasPattern; fillRect(x: number, y: number, w: number, h: number): void; canvas: { width: number; height: number } }, m: number[][], modulePx: number): void {
  const quiet = 4;
  const size = (m.length + quiet * 2) * modulePx;
  ctx.canvas.width = size;
  ctx.canvas.height = size;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  for (let r = 0; r < m.length; r++) for (let c = 0; c < m.length; c++) if (m[r]![c]) ctx.fillRect((c + quiet) * modulePx, (r + quiet) * modulePx, modulePx, modulePx);
}
