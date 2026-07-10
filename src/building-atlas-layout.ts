export const BUILDING_ATLAS_SIZE = 1024;
export const BUILDING_ATLAS_TILES_PER_ROW = 4;
export const BUILDING_ATLAS_TILE_SIZE =
  BUILDING_ATLAS_SIZE / BUILDING_ATLAS_TILES_PER_ROW;

const ATLAS_TILES: Readonly<Record<string, { row: number; cols: readonly number[] }>> = {
  residential: { row: 0, cols: [0, 1, 2, 3] },
  commercial: { row: 1, cols: [0, 1, 2, 3] },
  industrial: { row: 2, cols: [0, 1] },
  civic: { row: 2, cols: [2, 3] },
  religious: { row: 3, cols: [0, 1] },
  education: { row: 2, cols: [2, 3] },
  medical: { row: 1, cols: [2, 3] },
  agricultural: { row: 2, cols: [0, 1] },
  entertainment: { row: 1, cols: [0, 1] },
  military: { row: 2, cols: [0, 1] },
  outbuilding: { row: 2, cols: [0, 1] },
  service: { row: 1, cols: [2, 3] },
  transportation: { row: 1, cols: [2, 3] },
};

const DEFAULT_TILE = { row: 1, cols: [2] } as const;

export interface AtlasUVs {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * Resolve an atlas tile with a one-texel inset. The inset prevents linear and
 * mipmapped sampling from pulling colors from an adjacent facade tile.
 */
export function getBuildingAtlasUVs(category: string, variant: number = 0): AtlasUVs {
  const tile = ATLAS_TILES[category] ?? DEFAULT_TILE;
  const normalizedVariant = Math.abs(Math.trunc(variant));
  const col = tile.cols[normalizedVariant % tile.cols.length];
  const tileNorm = 1 / BUILDING_ATLAS_TILES_PER_ROW;
  const inset = 1 / BUILDING_ATLAS_SIZE;

  return {
    u0: col * tileNorm + inset,
    v0: 1 - (tile.row + 1) * tileNorm + inset,
    u1: (col + 1) * tileNorm - inset,
    v1: 1 - tile.row * tileNorm - inset,
  };
}
