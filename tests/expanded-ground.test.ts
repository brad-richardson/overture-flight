import { describe, expect, it } from 'vitest';
import { getExpandedTilesToLoad } from '../src/ground-texture/expanded-ground-layer.js';

describe('expanded terrain antimeridian ring', () => {
  it('wraps outer-ring X coordinates and honors canonical core keys', () => {
    const excludedCoreKey = '14/16382/8192';
    const tiles = getExpandedTilesToLoad(-180, 0, new Set([excludedCoreKey]));

    expect(tiles).toHaveLength(71);
    expect(tiles.every(tile => tile.x >= 0 && tile.x < 2 ** 14)).toBe(true);
    expect(tiles.some(tile => tile.x === 16383)).toBe(true);
    expect(tiles.some(tile => tile.x === 16382)).toBe(true);
    expect(tiles.some(tile => tile.key === `expanded-${excludedCoreKey}`)).toBe(false);
    expect(new Set(tiles.map(tile => tile.key)).size).toBe(tiles.length);
  });
});
