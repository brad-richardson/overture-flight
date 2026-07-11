import { getTerrainHeight } from './elevation.js';
import { ELEVATION } from './constants.js';
import { geoToWorld } from './scene.js';
import type { PlaneState } from './plane.js';
import type { BuildingColliderBounds } from './workers/types.js';

export const BUILDING_COLLISION_ENABLED = true;

const BUILDING_COLLISION_CELL_SIZE = 250;
const SEGMENT_EPSILON = 1e-9;

export interface CollisionPoint {
  x: number;
  y: number;
  z: number;
}

interface IndexedBuildingCollider extends BuildingColliderBounds {
  id: number;
}

/**
 * Collision result interface
 */
export interface CollisionResult {
  collided: boolean;
  type?: 'ground' | 'terrain' | 'building';
  height?: number;
  buildingId?: number;
}

/**
 * Test a finite 3D segment against an axis-aligned box using the slab method.
 * Exported as a pure helper so the tunnelling behavior can be unit-tested.
 */
export function segmentIntersectsAABB(
  start: CollisionPoint,
  end: CollisionPoint,
  bounds: BuildingColliderBounds
): boolean {
  let tMin = 0;
  let tMax = 1;

  const axes: Array<{
    start: number;
    end: number;
    min: number;
    max: number;
  }> = [
    { start: start.x, end: end.x, min: bounds.minX, max: bounds.maxX },
    { start: start.y, end: end.y, min: bounds.minY, max: bounds.maxY },
    { start: start.z, end: end.z, min: bounds.minZ, max: bounds.maxZ },
  ];

  for (const axis of axes) {
    const delta = axis.end - axis.start;
    if (Math.abs(delta) < SEGMENT_EPSILON) {
      if (axis.start < axis.min || axis.start > axis.max) return false;
      continue;
    }

    let entry = (axis.min - axis.start) / delta;
    let exit = (axis.max - axis.start) / delta;
    if (entry > exit) {
      [entry, exit] = [exit, entry];
    }

    tMin = Math.max(tMin, entry);
    tMax = Math.min(tMax, exit);
    if (tMin > tMax) return false;
  }

  return true;
}

interface HorizontalPoint {
  x: number;
  z: number;
}

const FOOTPRINT_EPSILON = 1e-7;

function pointOnHorizontalSegment(
  point: HorizontalPoint,
  start: HorizontalPoint,
  end: HorizontalPoint
): boolean {
  const cross = (point.z - start.z) * (end.x - start.x)
    - (point.x - start.x) * (end.z - start.z);
  if (Math.abs(cross) > FOOTPRINT_EPSILON) return false;

  return point.x >= Math.min(start.x, end.x) - FOOTPRINT_EPSILON
    && point.x <= Math.max(start.x, end.x) + FOOTPRINT_EPSILON
    && point.z >= Math.min(start.z, end.z) - FOOTPRINT_EPSILON
    && point.z <= Math.max(start.z, end.z) + FOOTPRINT_EPSILON;
}

/** 0 = outside, 1 = inside, 2 = on a wall/edge. */
function classifyPointInRing(point: HorizontalPoint, ring: readonly number[]): 0 | 1 | 2 {
  const vertexCount = Math.floor(ring.length / 2);
  if (vertexCount < 3) return 0;

  let inside = false;
  for (let i = 0, j = vertexCount - 1; i < vertexCount; j = i++) {
    const current = { x: ring[i * 2], z: ring[i * 2 + 1] };
    const previous = { x: ring[j * 2], z: ring[j * 2 + 1] };

    if (pointOnHorizontalSegment(point, previous, current)) return 2;

    const crossesRay = (current.z > point.z) !== (previous.z > point.z);
    if (crossesRay) {
      const crossingX = previous.x
        + ((point.z - previous.z) * (current.x - previous.x))
          / (current.z - previous.z);
      if (crossingX > point.x) inside = !inside;
    }
  }

  return inside ? 1 : 0;
}

function pointInBuildingFootprint(
  point: HorizontalPoint,
  collider: BuildingColliderBounds
): boolean {
  const outerClassification = classifyPointInRing(point, collider.outerRing);
  if (outerClassification === 0) return false;
  if (outerClassification === 2) return true;

  for (const hole of collider.holes) {
    const holeClassification = classifyPointInRing(point, hole);
    if (holeClassification === 2) return true; // Inner walls are solid.
    if (holeClassification === 1) return false;
  }

  return true;
}

function orientation(a: HorizontalPoint, b: HorizontalPoint, c: HorizontalPoint): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function horizontalSegmentsIntersect(
  a: HorizontalPoint,
  b: HorizontalPoint,
  c: HorizontalPoint,
  d: HorizontalPoint
): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (
    ((o1 > FOOTPRINT_EPSILON && o2 < -FOOTPRINT_EPSILON)
      || (o1 < -FOOTPRINT_EPSILON && o2 > FOOTPRINT_EPSILON))
    && ((o3 > FOOTPRINT_EPSILON && o4 < -FOOTPRINT_EPSILON)
      || (o3 < -FOOTPRINT_EPSILON && o4 > FOOTPRINT_EPSILON))
  ) {
    return true;
  }

  if (Math.abs(o1) <= FOOTPRINT_EPSILON && pointOnHorizontalSegment(c, a, b)) return true;
  if (Math.abs(o2) <= FOOTPRINT_EPSILON && pointOnHorizontalSegment(d, a, b)) return true;
  if (Math.abs(o3) <= FOOTPRINT_EPSILON && pointOnHorizontalSegment(a, c, d)) return true;
  if (Math.abs(o4) <= FOOTPRINT_EPSILON && pointOnHorizontalSegment(b, c, d)) return true;
  return false;
}

function horizontalSegmentIntersectsRing(
  start: HorizontalPoint,
  end: HorizontalPoint,
  ring: readonly number[]
): boolean {
  const vertexCount = Math.floor(ring.length / 2);
  if (vertexCount < 3) return false;

  for (let i = 0, j = vertexCount - 1; i < vertexCount; j = i++) {
    const edgeStart = { x: ring[j * 2], z: ring[j * 2 + 1] };
    const edgeEnd = { x: ring[i * 2], z: ring[i * 2 + 1] };
    if (horizontalSegmentsIntersect(start, end, edgeStart, edgeEnd)) return true;
  }

  return false;
}

function getVerticalSlabInterval(
  startY: number,
  endY: number,
  minY: number,
  maxY: number
): [number, number] | null {
  const deltaY = endY - startY;
  if (Math.abs(deltaY) < SEGMENT_EPSILON) {
    return startY >= minY && startY <= maxY ? [0, 1] : null;
  }

  let entry = (minY - startY) / deltaY;
  let exit = (maxY - startY) / deltaY;
  if (entry > exit) [entry, exit] = [exit, entry];

  const tMin = Math.max(0, entry);
  const tMax = Math.min(1, exit);
  return tMin <= tMax ? [tMin, tMax] : null;
}

/** Swept point against the collider's vertical polygonal prism. */
export function segmentIntersectsBuilding(
  start: CollisionPoint,
  end: CollisionPoint,
  collider: BuildingColliderBounds
): boolean {
  if (!segmentIntersectsAABB(start, end, collider)) return false;

  const verticalInterval = getVerticalSlabInterval(
    start.y,
    end.y,
    collider.minY,
    collider.maxY
  );
  if (!verticalInterval) return false;

  const horizontalPointAt = (t: number): HorizontalPoint => ({
    x: start.x + (end.x - start.x) * t,
    z: start.z + (end.z - start.z) * t,
  });
  const horizontalStart = horizontalPointAt(verticalInterval[0]);
  const horizontalEnd = horizontalPointAt(verticalInterval[1]);

  if (
    pointInBuildingFootprint(horizontalStart, collider)
    || pointInBuildingFootprint(horizontalEnd, collider)
    || horizontalSegmentIntersectsRing(horizontalStart, horizontalEnd, collider.outerRing)
  ) {
    return true;
  }

  return collider.holes.some(hole =>
    horizontalSegmentIntersectsRing(horizontalStart, horizontalEnd, hole)
  );
}

/** Lifecycle-aware spatial hash of loaded building bounds. */
class BuildingSpatialIndex {
  private readonly cells = new Map<string, Set<number>>();
  private readonly colliders = new Map<number, IndexedBuildingCollider>();
  private readonly tileColliderIds = new Map<string, Set<number>>();
  private nextColliderId = 1;

  registerTile(tileKey: string, bounds: readonly BuildingColliderBounds[]): void {
    this.removeTile(tileKey);
    if (bounds.length === 0) return;

    const tileIds = new Set<number>();
    for (const colliderBounds of bounds) {
      const collider: IndexedBuildingCollider = {
        ...colliderBounds,
        id: this.nextColliderId++,
      };
      this.colliders.set(collider.id, collider);
      tileIds.add(collider.id);

      this.forEachCell(collider, (cellKey) => {
        let cell = this.cells.get(cellKey);
        if (!cell) {
          cell = new Set<number>();
          this.cells.set(cellKey, cell);
        }
        cell.add(collider.id);
      });
    }

    this.tileColliderIds.set(tileKey, tileIds);
  }

  removeTile(tileKey: string): void {
    const tileIds = this.tileColliderIds.get(tileKey);
    if (!tileIds) return;

    for (const colliderId of tileIds) {
      const collider = this.colliders.get(colliderId);
      if (!collider) continue;

      this.forEachCell(collider, (cellKey) => {
        const cell = this.cells.get(cellKey);
        if (!cell) return;
        cell.delete(colliderId);
        if (cell.size === 0) this.cells.delete(cellKey);
      });
      this.colliders.delete(colliderId);
    }

    this.tileColliderIds.delete(tileKey);
  }

  clear(): void {
    this.cells.clear();
    this.colliders.clear();
    this.tileColliderIds.clear();
  }

  findIntersection(start: CollisionPoint, end: CollisionPoint): IndexedBuildingCollider | null {
    const candidateIds = new Set<number>();
    const segmentBounds: Pick<
      BuildingColliderBounds,
      'minX' | 'minY' | 'minZ' | 'maxX' | 'maxY' | 'maxZ'
    > = {
      minX: Math.min(start.x, end.x),
      minY: Math.min(start.y, end.y),
      minZ: Math.min(start.z, end.z),
      maxX: Math.max(start.x, end.x),
      maxY: Math.max(start.y, end.y),
      maxZ: Math.max(start.z, end.z),
    };

    this.forEachCell(segmentBounds, (cellKey) => {
      const cell = this.cells.get(cellKey);
      if (!cell) return;
      for (const colliderId of cell) candidateIds.add(colliderId);
    });

    for (const colliderId of candidateIds) {
      const collider = this.colliders.get(colliderId);
      if (collider && segmentIntersectsBuilding(start, end, collider)) {
        return collider;
      }
    }

    return null;
  }

  private forEachCell(
    bounds: Pick<BuildingColliderBounds, 'minX' | 'maxX' | 'minZ' | 'maxZ'>,
    callback: (cellKey: string) => void
  ): void {
    const minCellX = Math.floor(bounds.minX / BUILDING_COLLISION_CELL_SIZE);
    const maxCellX = Math.floor(bounds.maxX / BUILDING_COLLISION_CELL_SIZE);
    const minCellZ = Math.floor(bounds.minZ / BUILDING_COLLISION_CELL_SIZE);
    const maxCellZ = Math.floor(bounds.maxZ / BUILDING_COLLISION_CELL_SIZE);

    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
        callback(`${cellX},${cellZ}`);
      }
    }
  }
}

const buildingSpatialIndex = new BuildingSpatialIndex();
let previousCollisionPosition: CollisionPoint | null = null;
let buildingCollisionsSuppressedUntilClear = false;

/** Register all rendered building bounds for a loaded tile. */
export function registerBuildingColliders(
  tileKey: string,
  colliders: readonly BuildingColliderBounds[]
): void {
  buildingSpatialIndex.registerTile(tileKey, colliders);
}

/** Remove all building bounds owned by an unloaded tile. */
export function unregisterBuildingColliders(tileKey: string): void {
  buildingSpatialIndex.removeTile(tileKey);
}

/** Clear every loaded building bound, used when replacing the whole local world. */
export function clearBuildingColliders(): void {
  buildingSpatialIndex.clear();
  buildingCollisionsSuppressedUntilClear = false;
}

/**
 * Ignore building hits after a building crash until the respawned plane is no
 * longer inside a loaded collider. Terrain collision remains active.
 */
export function suppressBuildingCollisionsUntilClear(): void {
  buildingCollisionsSuppressedUntilClear = true;
}

/**
 * Forget the previous frame position after a teleport or respawn. The next
 * collision check starts a fresh sweep at the new position.
 */
export function resetCollisionSweep(): void {
  previousCollisionPosition = null;
}

/**
 * Check if plane has collided with terrain or buildings.
 * Uses elevation data for accurate ground collision detection.
 */
export function checkCollision(planeState: PlaneState): boolean {
  return checkCollisionDetailed(planeState).collided;
}

/**
 * Check collision with detailed information. Building checks sweep from the
 * previous checked position to prevent a fast plane tunnelling between frames.
 */
export function checkCollisionDetailed(planeState: PlaneState): CollisionResult {
  const { lng, lat, altitude } = planeState;
  const currentWorldPosition = geoToWorld(lng, lat, altitude);
  const sweepStart = previousCollisionPosition ?? currentWorldPosition;
  previousCollisionPosition = { ...currentWorldPosition };

  // Preserve the existing terrain collision behavior at the current position.
  let groundHeight = 0;
  if (ELEVATION.TERRAIN_ENABLED) {
    groundHeight = getTerrainHeight(lng, lat) * ELEVATION.VERTICAL_EXAGGERATION;
  }

  if (altitude <= groundHeight) {
    return {
      collided: true,
      type: groundHeight > 0 ? 'terrain' : 'ground',
      height: groundHeight,
    };
  }

  if (BUILDING_COLLISION_ENABLED) {
    if (buildingCollisionsSuppressedUntilClear) {
      const stillInside = buildingSpatialIndex.findIntersection(
        currentWorldPosition,
        currentWorldPosition
      );
      if (stillInside) {
        return { collided: false };
      }
      buildingCollisionsSuppressedUntilClear = false;
      // Do not sweep from the last suppressed point inside the building to the
      // first clear point outside it. The next frame starts fully outside.
      return { collided: false };
    }

    const buildingHit = buildingSpatialIndex.findIntersection(sweepStart, currentWorldPosition);
    if (buildingHit) {
      return {
        collided: true,
        type: 'building',
        height: buildingHit.maxY,
        buildingId: buildingHit.id,
      };
    }
  }

  return { collided: false };
}

/**
 * Get the ground height at a specific location
 * Useful for UI display or spawn point calculation
 */
export function getGroundHeight(lng: number, lat: number): number {
  if (!ELEVATION.TERRAIN_ENABLED) {
    return 0;
  }
  return getTerrainHeight(lng, lat) * ELEVATION.VERTICAL_EXAGGERATION;
}
