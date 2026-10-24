import { describe, expect, it } from 'vitest';
import { drawQr, encodeQr, formatBits, rsEncode, rsGenerator } from '../src/ui/qr';

describe('QR encoder building blocks (ISO 18004 reference values)', () => {
  it('format information matches the standard table', () => {
    const bin = (v: number) => v.toString(2).padStart(15, '0');
    expect(bin(formatBits('L', 0))).toBe('111011111000100');
    expect(bin(formatBits('L', 1))).toBe('111001011110011');
    expect(bin(formatBits('M', 0))).toBe('101010000010010');
    expect(bin(formatBits('M', 1))).toBe('101000100100101');
    expect(bin(formatBits('M', 2))).toBe('101111001111100');
  });

  it('Reed-Solomon generator for 7 error-correction codewords has the standard exponents', () => {
    // alpha^0, 87, 229, 146, 149, 238, 102, 21
    const alpha = (e: number) => {
      let x = 1;
      for (let i = 0; i < e; i++) {
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
      }
      return x;
    };
    expect(rsGenerator(7)).toEqual([0, 87, 229, 146, 149, 238, 102, 21].map(alpha));
  });

  it('Reed-Solomon codewords of the standard 1-M example "01234567" match the spec worked example', () => {
    // ISO 18004 Annex I: data codewords 16 32 12 86 97 128 236 17 236 17 236 17 236 17 236 17 -> EC 165 36 212 193 237 54 199 135 44 85
    const data = [16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17];
    expect(rsEncode(data, 10)).toEqual([165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
  });
});

describe('encodeQr', () => {
  const url = 'http://192.168.0.103:8080/#t=1MPBdj18ebaCbc4BAgppBg';

  it('makes a square matrix of the right version size with the three finder patterns', () => {
    const m = encodeQr(url, 'M');
    expect(url.length).toBe(51);
    expect(m.length).toBe(33); // version 4
    for (const row of m) expect(row).toHaveLength(33);
    for (const [r0, c0] of [[0, 0], [0, 26], [26, 0]] as const) {
      for (let i = 0; i < 7; i++) {
        expect(m[r0]![c0 + i]).toBe(1);
        expect(m[r0 + 6]![c0 + i]).toBe(1);
        expect(m[r0 + i]![c0]).toBe(1);
        expect(m[r0 + i]![c0 + 6]).toBe(1);
      }
      expect(m[r0 + 3]![c0 + 3]).toBe(1);
      expect(m[r0 + 1]![c0 + 1]).toBe(0);
    }
    expect(m[25]![8]).toBe(1); // dark module
    expect(m[6]![8]).toBe(1);
    expect(m[6]![9]).toBe(0); // timing pattern alternates
  });

  it('is deterministic and differs for different text', () => {
    expect(encodeQr(url)).toEqual(encodeQr(url));
    expect(encodeQr(url)).not.toEqual(encodeQr(url.replace('1MPB', '2MPB')));
  });

  it('picks the smallest version that fits and rejects text that is too long', () => {
    expect(encodeQr('hi', 'L').length).toBe(21);
    expect(encodeQr('x'.repeat(80), 'L').length).toBe(37); // version 5
    expect(() => encodeQr('x'.repeat(200), 'L')).toThrow();
  });

  it('draws black modules on a white quiet zone', () => {
    const calls: { fill: string; x: number; y: number; w: number }[] = [];
    const ctx = { fillStyle: '' as string, canvas: { width: 0, height: 0 }, fillRect(x: number, y: number, w: number) { calls.push({ fill: this.fillStyle, x, y, w }); } };
    const m = encodeQr('hi', 'L');
    drawQr(ctx, m, 5);
    expect(ctx.canvas.width).toBe((21 + 8) * 5);
    expect(calls[0]).toMatchObject({ fill: '#fff', x: 0, y: 0 });
    expect(calls.slice(1).every((c) => c.fill === '#000' && c.x >= 20 && c.y >= 20)).toBe(true);
  });
});
