import { queryBuildingsAt, getTerrainElevation } from './map.js';

/**
 * Check if plane has collided with terrain or buildings
 * @param {Object} planeState - Current plane state
 * @returns {boolean} True if collision detected
 */
export function checkCollision(planeState) {
  const { lat, lng, altitude } = planeState;

  // Check ground collision
  const groundElevation = getTerrainElevation(lng, lat);
  if (altitude <= groundElevation) {
    return true;
  }

  // Check building collision
  const buildings = queryBuildingsAt(lng, lat);
  for (const building of buildings) {
    const buildingHeight = building.properties?.height || 10;
    if (altitude < buildingHeight) {
      return true;
    }
  }

  return false;
}

/**
 * @typedef {Object} CollisionResult
 * @property {boolean} collided - Whether a collision occurred
 * @property {string} [type] - Type of collision ('ground' | 'building')
 * @property {number} [height] - Height of obstacle
 */

/**
 * Check collision with detailed information
 * @param {Object} planeState - Current plane state
 * @returns {CollisionResult}
 */
export function checkCollisionDetailed(planeState) {
  const { lat, lng, altitude } = planeState;

  // Check ground collision
  const groundElevation = getTerrainElevation(lng, lat);
  if (altitude <= groundElevation) {
    return {
      collided: true,
      type: 'ground',
      height: groundElevation,
    };
  }

  // Check building collision
  const buildings = queryBuildingsAt(lng, lat);
  for (const building of buildings) {
    const buildingHeight = building.properties?.height || 10;
    if (altitude < buildingHeight) {
      return {
        collided: true,
        type: 'building',
        height: buildingHeight,
      };
    }
  }

  return { collided: false };
}
