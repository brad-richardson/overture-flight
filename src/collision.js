/**
 * Check if plane has collided with terrain or buildings
 * For now, simple ground collision at altitude 0
 * TODO: Implement proper building collision with Three.js raycasting
 * @param {Object} planeState - Current plane state
 * @returns {boolean} True if collision detected
 */
export function checkCollision(planeState) {
  const { altitude } = planeState;

  // Simple ground collision check
  if (altitude <= 0) {
    return true;
  }

  // TODO: Add building collision detection using Three.js raycasting
  // against the loaded building meshes

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
  const { altitude } = planeState;

  // Check ground collision
  if (altitude <= 0) {
    return {
      collided: true,
      type: 'ground',
      height: 0,
    };
  }

  // TODO: Add building collision detection

  return { collided: false };
}
