export interface ElevationRange {
  readonly min: number;
  readonly max: number;
}

const halfFloatDataCache = new WeakMap<Float32Array, Uint16Array>();
const elevationRangeCache = new WeakMap<Float32Array, ElevationRange>();

/**
 * Convert the raw bits of a float32 value to the terrain WebGPU half-float
 * representation. This intentionally truncates normal mantissas and flushes
 * float32 denormals and half-float underflow to signed zero.
 */
export function toHalfBits(bits: number): number {
  const sign = (bits >> 31) & 0x1;
  let exponent = (bits >> 23) & 0xff;
  let mantissa = bits & 0x7fffff;

  if (exponent === 0xff) {
    return (sign << 15) | 0x7c00 | (mantissa ? 0x200 : 0);
  }

  if (exponent === 0) {
    return sign << 15;
  }

  exponent = exponent - 127 + 15;

  if (exponent >= 31) {
    return (sign << 15) | 0x7c00;
  }

  if (exponent <= 0) {
    return sign << 15;
  }

  mantissa >>= 13;
  return (sign << 15) | (exponent << 10) | mantissa;
}

/**
 * Return the cached half-float representation for this exact heights view.
 */
export function getHalfFloatElevationData(heights: Float32Array): Uint16Array {
  const cached = halfFloatDataCache.get(heights);
  if (cached) return cached;

  const sourceBits = new Int32Array(heights.buffer, heights.byteOffset, heights.length);
  const halfFloatData = new Uint16Array(heights.length);
  for (let i = 0; i < sourceBits.length; i++) {
    halfFloatData[i] = toHalfBits(sourceBits[i]);
  }

  halfFloatDataCache.set(heights, halfFloatData);
  return halfFloatData;
}

/**
 * Return the elevation range, skipping NaNs. Preserve the existing flat-terrain
 * fallback for empty/all-NaN and single-sided-infinity views.
 */
export function getElevationRange(heights: Float32Array): ElevationRange {
  const cached = elevationRangeCache.get(heights);
  if (cached) return cached;

  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < heights.length; i++) {
    const height = heights[i];
    if (Number.isNaN(height)) continue;

    if (height < min) min = height;
    if (height > max) max = height;
  }

  const range = min === Infinity || max === -Infinity ? { min: 0, max: 0 } : { min, max };
  elevationRangeCache.set(heights, range);
  return range;
}
