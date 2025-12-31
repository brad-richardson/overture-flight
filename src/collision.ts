import { getTerrainHeight } from './elevation.js';
import { ELEVATION } from './constants.js';
import type { PlaneState } from './plane.js';

/**
 * Collision result interface
 */
export interface CollisionResult {
  collided: boolean;
  type?: 'ground' | 'terrain' | 'building';
  height?: number;
}

/**
 * Check if plane has collided with terrain or buildings
 * Uses elevation data for accurate ground collision detection
 */
export function checkCollision(planeState: PlaneState): boolean {
  const { lng, lat, altitude } = planeState;

  // Get terrain height at plane position
  let groundHeight = 0;
  if (ELEVATION.TERRAIN_ENABLED) {
    groundHeight = getTerrainHeight(lng, lat) * ELEVATION.VERTICAL_EXAGGERATION;
  }

  // Collision if altitude is at or below terrain
  if (altitude <= groundHeight) {
    return true;
  }

  // TODO: Add building collision detection using Three.js raycasting
  // against the loaded building meshes

  return false;
}

/**
 * Check collision with detailed information
 */
export function checkCollisionDetailed(planeState: PlaneState): CollisionResult {
  const { lng, lat, altitude } = planeState;

  // Get terrain height at plane position
  let groundHeight = 0;
  if (ELEVATION.TERRAIN_ENABLED) {
    groundHeight = getTerrainHeight(lng, lat) * ELEVATION.VERTICAL_EXAGGERATION;
  }

  // Check terrain collision
  if (altitude <= groundHeight) {
    return {
      collided: true,
      type: groundHeight > 0 ? 'terrain' : 'ground',
      height: groundHeight,
    };
  }

  // TODO: Add building collision detection

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
