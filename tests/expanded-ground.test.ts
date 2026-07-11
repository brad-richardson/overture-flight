import { describe, expect, it } from 'vitest';
import { getExpandedTilesToLoad } from '../src/ground-texture/expanded-ground-layer.js';
import { EXPANDED_TERRAIN } from '../src/constants.js';

describe('expanded terrain antimeridian ring', () => {
  it('wraps outer-ring X coordinates and honors canonical core keys', () => {
    const excludedCoreKey = '14/16382/8192';
    const tiles = getExpandedTilesToLoad(-180, 0, new Set([excludedCoreKey]));

    const { TILE_RADIUS, CORE_RADIUS } = EXPANDED_TERRAIN;
    const ringSize = (2 * TILE_RADIUS + 1) ** 2 - (2 * CORE_RADIUS + 1) ** 2;
    // The excluded core key sits two tiles west of center, inside the ring.
    expect(tiles).toHaveLength(ringSize - 1);
    expect(tiles.every(tile => tile.x >= 0 && tile.x < 2 ** 14)).toBe(true);
    expect(tiles.some(tile => tile.x === 16383)).toBe(true);
    expect(tiles.some(tile => tile.x === 16382)).toBe(true);
    expect(tiles.some(tile => tile.key === `expanded-${excludedCoreKey}`)).toBe(false);
    expect(new Set(tiles.map(tile => tile.key)).size).toBe(tiles.length);
  });
});
