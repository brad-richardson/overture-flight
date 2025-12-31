import { getTerrainHeight } from './elevation.js';
import { ELEVATION } from './constants.js';

/**
 * Check if plane has collided with terrain or buildings
 * Uses elevation data for accurate ground collision detection
 * @param {Object} planeState - Current plane state with lng, lat, altitude
 * @returns {boolean} True if collision detected
 */
export function checkCollision(planeState) {
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
 * @typedef {Object} CollisionResult
 * @property {boolean} collided - Whether a collision occurred
 * @property {string} [type] - Type of collision ('ground' | 'terrain' | 'building')
 * @property {number} [height] - Height of obstacle
 */

/**
 * Check collision with detailed information
 * @param {Object} planeState - Current plane state with lng, lat, altitude
 * @returns {CollisionResult}
 */
export function checkCollisionDetailed(planeState) {
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
 * @param {number} lng - Longitude
 * @param {number} lat - Latitude
 * @returns {number} Ground height in meters
 */
export function getGroundHeight(lng, lat) {
  if (!ELEVATION.TERRAIN_ENABLED) {
    return 0;
  }
  return getTerrainHeight(lng, lat) * ELEVATION.VERTICAL_EXAGGERATION;
}
