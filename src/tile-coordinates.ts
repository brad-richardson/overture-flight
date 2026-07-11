export interface TileCoordinates {
  x: number;
  y: number;
  z: number;
}

export interface OffsetTileCoordinates extends TileCoordinates {
  dx: number;
  dy: number;
}

function tileCount(zoom: number): number {
  return Number.isInteger(zoom) && zoom >= 0 ? Math.pow(2, zoom) : 0;
}

/** Web Mercator wraps east/west. */
export function wrapTileX(x: number, zoom: number): number {
  const count = tileCount(zoom);
  if (count === 0 || !Number.isInteger(x)) return 0;
  return ((x % count) + count) % count;
}

/** Web Mercator ends at its north/south rows rather than wrapping them. */
export function isValidTileY(y: number, zoom: number): boolean {
  const count = tileCount(zoom);
  return count > 0 && Number.isInteger(y) && y >= 0 && y < count;
}

export function wrappedTileXDistance(a: number, b: number, zoom: number): number {
  const count = tileCount(zoom);
  if (count === 0) return Number.POSITIVE_INFINITY;
  const direct = Math.abs(wrapTileX(a, zoom) - wrapTileX(b, zoom));
  return Math.min(direct, count - direct);
}

export function wrappedTileChebyshevDistance(
  a: Pick<TileCoordinates, 'x' | 'y'>,
  b: Pick<TileCoordinates, 'x' | 'y'>,
  zoom: number
): number {
  return Math.max(wrappedTileXDistance(a.x, b.x, zoom), Math.abs(a.y - b.y));
}

export function getWrappedTileNeighbor(
  centerX: number,
  centerY: number,
  zoom: number,
  dx: number,
  dy: number
): OffsetTileCoordinates | null {
  if (![centerX, centerY, dx, dy].every(Number.isInteger)) return null;
  const y = centerY + dy;
  if (!isValidTileY(y, zoom)) return null;
  return { x: wrapTileX(centerX + dx, zoom), y, z: zoom, dx, dy };
}

/** Square neighborhood with wrapped X columns and rejected polar Y rows. */
export function getWrappedTileNeighborhood(
  centerX: number,
  centerY: number,
  zoom: number,
  radius: number
): OffsetTileCoordinates[] {
  if (!Number.isInteger(radius) || radius < 0) return [];

  const tiles: OffsetTileCoordinates[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const tile = getWrappedTileNeighbor(centerX, centerY, zoom, dx, dy);
      if (tile) tiles.push(tile);
    }
  }
  return tiles;
}

/** Chebyshev ring, excluding coordinates at or inside `innerRadius`. */
export function getWrappedTileRing(
  centerX: number,
  centerY: number,
  zoom: number,
  outerRadius: number,
  innerRadius: number
): OffsetTileCoordinates[] {
  return getWrappedTileNeighborhood(centerX, centerY, zoom, outerRadius).filter(
    ({ dx, dy }) => Math.max(Math.abs(dx), Math.abs(dy)) > innerRadius
  );
}
