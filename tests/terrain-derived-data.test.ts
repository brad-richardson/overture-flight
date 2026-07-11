import { describe, expect, it } from 'vitest';
import {
  getElevationRange,
  getHalfFloatElevationData,
  toHalfBits,
} from '../src/ground-texture/terrain-derived-data.js';

function referenceToHalf(value: number): number {
  const floatView = new Float32Array(1);
  const int32View = new Int32Array(floatView.buffer);
  floatView[0] = value;
  const bits = int32View[0];

  const sign = (bits >> 31) & 0x1;
  let exponent = (bits >> 23) & 0xff;
  let mantissa = bits & 0x7fffff;

  if (exponent === 0xff) {
    return (sign << 15) | 0x7c00 | (mantissa ? 0x200 : 0);
  }
  if (exponent === 0) return sign << 15;

  exponent = exponent - 127 + 15;
  if (exponent >= 31) return (sign << 15) | 0x7c00;
  if (exponent <= 0) return sign << 15;

  mantissa >>= 13;
  return (sign << 15) | (exponent << 10) | mantissa;
}

function createRandomBits(length: number): Int32Array {
  const bits = new Int32Array(length);
  let state = 0x6d2b79f5;
  for (let i = 0; i < length; i++) {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    bits[i] = state ^ (state >>> 14);
  }
  return bits;
}

describe('terrain half-float derived data', () => {
  it('matches the allocation-heavy reference for randomized float32 bit patterns', () => {
    const randomBits = createRandomBits(65_536);
    const heights = new Float32Array(randomBits.buffer);
    const actual = getHalfFloatElevationData(heights);
    const expected = new Uint16Array(heights.length);

    for (let i = 0; i < heights.length; i++) {
      expected[i] = referenceToHalf(heights[i]);
    }

    expect(actual).toEqual(expected);
    expect(actual[12_345]).toBe(toHalfBits(randomBits[12_345]));
  });

  it('preserves truncation and special-value behavior', () => {
    const sourceBits = new Int32Array([
      0x00000000,
      -0x80000000,
      0x00000001,
      -0x7fffffff,
      0x33000000,
      -0x4d000000,
      0x38800000,
      0x3f801fff,
      0x7f800000,
      -0x00800000,
      0x7fc00001,
      -0x003fffff,
    ]);
    const heights = new Float32Array(sourceBits.buffer);

    expect(Array.from(getHalfFloatElevationData(heights))).toEqual(
      Array.from(heights, referenceToHalf)
    );
  });

  it('respects byte offsets and caches by Float32Array identity', () => {
    const buffer = new ArrayBuffer(24);
    new Int32Array(buffer).set([0x7f800000, 0x3f800000, 0xc0000000, 0x00000001, 0, 0]);
    const offsetView = new Float32Array(buffer, 4, 3);

    const first = getHalfFloatElevationData(offsetView);
    const second = getHalfFloatElevationData(offsetView);
    const equalButDistinct = getHalfFloatElevationData(new Float32Array(offsetView));

    expect(Array.from(first)).toEqual(Array.from(offsetView, referenceToHalf));
    expect(second).toBe(first);
    expect(equalButDistinct).not.toBe(first);
    expect(equalButDistinct).toEqual(first);
  });
});

describe('terrain elevation range derived data', () => {
  it('skips NaNs, falls back for all-NaN and empty arrays, and caches by identity', () => {
    const heights = new Float32Array([Number.NaN, 12, -4, Number.NaN, 7]);
    const first = getElevationRange(heights);

    expect(first).toEqual({ min: -4, max: 12 });
    expect(getElevationRange(heights)).toBe(first);
    expect(getElevationRange(new Float32Array(heights))).not.toBe(first);
    expect(getElevationRange(new Float32Array([Number.NaN, Number.NaN]))).toEqual({
      min: 0,
      max: 0,
    });
    expect(getElevationRange(new Float32Array())).toEqual({ min: 0, max: 0 });
    expect(
      getElevationRange(new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, Number.NaN]))
    ).toEqual({ min: 0, max: 0 });
    expect(
      getElevationRange(new Float32Array([Number.NaN, Number.NEGATIVE_INFINITY, Number.NaN]))
    ).toEqual({ min: 0, max: 0 });
  });

  it('retains signed zero, infinities, subnormals, and byte-offset boundaries', () => {
    const negativeZeroRange = getElevationRange(new Float32Array([-0, 0]));
    expect(Object.is(negativeZeroRange.min, -0)).toBe(true);
    expect(Object.is(negativeZeroRange.max, -0)).toBe(true);

    expect(
      getElevationRange(
        new Float32Array([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
      )
    ).toEqual({ min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY });

    const smallestFloat32 = 2 ** -149;
    expect(getElevationRange(new Float32Array([-smallestFloat32, smallestFloat32]))).toEqual({
      min: -smallestFloat32,
      max: smallestFloat32,
    });

    const buffer = new ArrayBuffer(20);
    new Float32Array(buffer).set([-1_000, 5, -3, 9, 1_000]);
    expect(getElevationRange(new Float32Array(buffer, 4, 3))).toEqual({ min: -3, max: 9 });
  });
});
