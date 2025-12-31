import { getMap } from './map.js';
import { NETWORK } from './constants.js';
import { updatePlaneLayer, clearPlaneLayer } from './plane-renderer.js';

/** @type {Map<string, Object>} */
const planeStates = new Map();

/** @type {Map<string, {prev: Object, next: Object, timestamp: number}>} */
const interpolationData = new Map();

/** @type {Map<string, Object>} Current interpolated states for rendering */
const interpolatedStates = new Map();

let animationFrameId = null;
let localPlayerId = null;
let localPlaneState = null;

/**
 * Linear interpolation
 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Interpolate angle (handles 360° wraparound)
 */
function lerpAngle(a, b, t) {
  let diff = b - a;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return (a + diff * t + 360) % 360;
}

/**
 * Interpolate pitch/roll (no wraparound needed)
 */
function lerpPitchRoll(a, b, t) {
  return lerp(a || 0, b || 0, t);
}

/**
 * Animation loop for smooth interpolation - now updates deck.gl layer
 */
function animateInterpolation() {
  const map = getMap();
  if (!map) {
    animationFrameId = requestAnimationFrame(animateInterpolation);
    return;
  }

  const now = Date.now();
  const interpolationDuration = NETWORK.INTERPOLATION_DELAY || 100;
  let hasUpdates = false;

  for (const [id, data] of interpolationData) {
    if (!data.prev || !data.next) continue;

    // Calculate interpolation progress (0 to 1)
    const elapsed = now - data.timestamp;
    const t = Math.min(1, elapsed / interpolationDuration);

    // Interpolate all properties
    const interpolated = {
      id,
      lng: lerp(data.prev.lng, data.next.lng, t),
      lat: lerp(data.prev.lat, data.next.lat, t),
      altitude: lerp(data.prev.altitude || 0, data.next.altitude || 0, t),
      heading: lerpAngle(data.prev.heading || 0, data.next.heading || 0, t),
      pitch: lerpPitchRoll(data.prev.pitch, data.next.pitch, t),
      roll: lerpPitchRoll(data.prev.roll, data.next.roll, t),
      speed: lerp(data.prev.speed || 0, data.next.speed || 0, t),
      color: data.next.color,
      name: data.next.name,
    };

    interpolatedStates.set(id, interpolated);
    hasUpdates = true;
  }

  // Update deck.gl layer with interpolated states
  if (hasUpdates || localPlaneState) {
    const allPlanes = Array.from(interpolatedStates.values());

    // Add local plane if available
    if (localPlaneState) {
      allPlanes.push({
        ...localPlaneState,
        id: localPlayerId || 'local',
      });
    }

    updatePlaneLayer(allPlanes, localPlayerId);
  }

  animationFrameId = requestAnimationFrame(animateInterpolation);
}

/**
 * Start the interpolation animation loop
 */
function startAnimationLoop() {
  if (!animationFrameId) {
    animationFrameId = requestAnimationFrame(animateInterpolation);
  }
}

/**
 * Stop the interpolation animation loop
 */
function stopAnimationLoop() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

/**
 * Update local player's plane state for rendering
 * @param {Object} planeState - Local plane state
 * @param {string} id - Local player ID
 * @param {string} color - Local player color
 */
export function updateLocalPlane(planeState, id, color) {
  localPlayerId = id;
  localPlaneState = {
    ...planeState,
    color: color || '#3b82f6',
  };

  // Ensure animation loop is running
  startAnimationLoop();
}

/**
 * Update other players' planes on the map
 * @param {Object<string, Object>} planes - Map of plane states by ID
 * @param {string} localId - Local player's ID (to exclude from other planes)
 */
export function updateOtherPlanes(planes, localId) {
  const map = getMap();
  if (!map) return;

  localPlayerId = localId;
  const currentIds = new Set(Object.keys(planes));
  const now = Date.now();

  // Remove data for planes that left
  for (const id of planeStates.keys()) {
    if (!currentIds.has(id) || id === localId) {
      planeStates.delete(id);
      interpolationData.delete(id);
      interpolatedStates.delete(id);
    }
  }

  // Update states for other planes
  for (const [id, plane] of Object.entries(planes)) {
    if (id === localId) continue;

    const prevState = planeStates.get(id);
    planeStates.set(id, plane);

    // Store interpolation data with full state
    if (prevState) {
      interpolationData.set(id, {
        prev: {
          lng: prevState.lng,
          lat: prevState.lat,
          altitude: prevState.altitude,
          heading: prevState.heading,
          pitch: prevState.pitch,
          roll: prevState.roll,
          speed: prevState.speed,
          color: prevState.color,
          name: prevState.name,
        },
        next: {
          lng: plane.lng,
          lat: plane.lat,
          altitude: plane.altitude,
          heading: plane.heading,
          pitch: plane.pitch,
          roll: plane.roll,
          speed: plane.speed,
          color: plane.color,
          name: plane.name,
        },
        timestamp: now,
      });
    } else {
      // First time seeing this plane, set it directly
      interpolatedStates.set(id, {
        id,
        ...plane,
      });
    }
  }

  // Start animation loop if there are planes to render
  if (planeStates.size > 0 || localPlaneState) {
    startAnimationLoop();
  } else if (!localPlaneState) {
    stopAnimationLoop();
  }
}

/**
 * Get all other plane states
 * @returns {Map<string, Object>}
 */
export function getOtherPlanes() {
  return new Map(planeStates);
}

/**
 * Remove a specific plane
 * @param {string} id - Plane ID to remove
 */
export function removePlane(id) {
  planeStates.delete(id);
  interpolationData.delete(id);
  interpolatedStates.delete(id);

  // Update the render
  const allPlanes = Array.from(interpolatedStates.values());
  if (localPlaneState) {
    allPlanes.push({ ...localPlaneState, id: localPlayerId || 'local' });
  }
  updatePlaneLayer(allPlanes, localPlayerId);

  // Stop animation loop if no more planes
  if (planeStates.size === 0 && !localPlaneState) {
    stopAnimationLoop();
  }
}

/**
 * Clear all plane rendering
 */
export function clearAllPlanes() {
  stopAnimationLoop();
  planeStates.clear();
  interpolationData.clear();
  interpolatedStates.clear();
  localPlaneState = null;
  clearPlaneLayer();
}
