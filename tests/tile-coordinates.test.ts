import { describe, expect, it } from 'vitest';
import {
  getWrappedTileNeighborhood,
  getWrappedTileRing,
  isValidTileY,
  wrapTileX,
  wrappedTileChebyshevDistance,
  wrappedTileXDistance,
} from '../src/tile-coordinates.js';

describe('wrapped Web Mercator tile coordinates', () => {
  it('wraps X columns and measures the short distance across the antimeridian', () => {
    expect(wrapTileX(-1, 3)).toBe(7);
    expect(wrapTileX(8, 3)).toBe(0);
    expect(wrappedTileXDistance(7, 0, 3)).toBe(1);
    expect(wrappedTileChebyshevDistance(
      { x: 7, y: 4 },
      { x: 0, y: 5 },
      3
    )).toBe(1);
  });

  it('builds a deterministic antimeridian neighborhood', () => {
    const tiles = getWrappedTileNeighborhood(0, 4, 3, 1);
    expect(tiles).toHaveLength(9);
    expect(new Set(tiles.map(tile => tile.x))).toEqual(new Set([7, 0, 1]));
    expect(new Set(tiles.map(tile => tile.y))).toEqual(new Set([3, 4, 5]));
    expect(tiles.every(tile => tile.x >= 0 && tile.x < 8)).toBe(true);
  });

  it('builds an outer ring across wrapped columns without duplicates', () => {
    const ring = getWrappedTileRing(0, 4, 3, 2, 1);
    expect(ring).toHaveLength(16);
    expect(new Set(ring.map(tile => `${tile.x}/${tile.y}`)).size).toBe(16);
    expect(ring.some(tile => tile.x === 7)).toBe(true);
    expect(ring.some(tile => tile.x === 6)).toBe(true);
  });

  it('rejects Y neighbors beyond either polar edge', () => {
    expect(isValidTileY(-1, 3)).toBe(false);
    expect(isValidTileY(8, 3)).toBe(false);

    const north = getWrappedTileNeighborhood(0, 0, 3, 1);
    expect(north).toHaveLength(6);
    expect(north.every(tile => tile.y === 0 || tile.y === 1)).toBe(true);

    const south = getWrappedTileNeighborhood(0, 7, 3, 1);
    expect(south).toHaveLength(6);
    expect(south.every(tile => tile.y === 6 || tile.y === 7)).toBe(true);
  });
});
