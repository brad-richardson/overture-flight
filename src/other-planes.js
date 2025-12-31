import maplibregl from 'maplibre-gl';
import { getMap } from './map.js';
import { NETWORK } from './constants.js';

/** @type {Map<string, maplibregl.Marker>} */
const markers = new Map();

/** @type {Map<string, Object>} */
const planeStates = new Map();

/** @type {Map<string, {prev: Object, next: Object, timestamp: number}>} */
const interpolationData = new Map();

let animationFrameId = null;
let localPlayerId = null;

/**
 * Create a plane marker element
 * @param {string} color - Plane color
 * @returns {HTMLElement}
 */
function createPlaneElement(color) {
  const el = document.createElement('div');
  el.className = 'other-plane-marker';
  el.innerHTML = `
    <svg width="32" height="32" viewBox="0 0 32 32" style="transform: rotate(-90deg);">
      <polygon
        points="16,0 24,28 16,22 8,28"
        fill="${color}"
        stroke="white"
        stroke-width="1.5"
      />
    </svg>
  `;
  el.style.width = '32px';
  el.style.height = '32px';
  el.style.cursor = 'pointer';
  return el;
}

/**
 * Linear interpolation
 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Interpolate heading (handles 360° wraparound)
 */
function lerpHeading(a, b, t) {
  let diff = b - a;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return (a + diff * t + 360) % 360;
}

/**
 * Animation loop for smooth interpolation
 */
function animateInterpolation() {
  const map = getMap();
  if (!map) {
    animationFrameId = requestAnimationFrame(animateInterpolation);
    return;
  }

  const now = Date.now();
  const interpolationDuration = NETWORK.INTERPOLATION_DELAY || 100;

  for (const [id, data] of interpolationData) {
    const marker = markers.get(id);
    if (!marker || !data.prev || !data.next) continue;

    // Calculate interpolation progress (0 to 1)
    const elapsed = now - data.timestamp;
    const t = Math.min(1, elapsed / interpolationDuration);

    // Interpolate position and heading
    const lng = lerp(data.prev.lng, data.next.lng, t);
    const lat = lerp(data.prev.lat, data.next.lat, t);
    const heading = lerpHeading(data.prev.heading, data.next.heading, t);

    marker.setLngLat([lng, lat]);
    marker.setRotation(heading);
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
 * Update other players' planes on the map
 * @param {Object<string, Object>} planes - Map of plane states by ID
 * @param {string} localId - Local player's ID (to exclude)
 */
export function updateOtherPlanes(planes, localId) {
  const map = getMap();
  if (!map) return;

  localPlayerId = localId;
  const currentIds = new Set(Object.keys(planes));
  const now = Date.now();

  // Remove markers for planes that left
  for (const [id, marker] of markers) {
    if (!currentIds.has(id) || id === localId) {
      marker.remove();
      markers.delete(id);
      planeStates.delete(id);
      interpolationData.delete(id);
    }
  }

  // Update or create markers for other planes
  for (const [id, plane] of Object.entries(planes)) {
    if (id === localId) continue;

    const prevState = planeStates.get(id);
    planeStates.set(id, plane);

    // Store interpolation data
    if (prevState) {
      interpolationData.set(id, {
        prev: { lng: prevState.lng, lat: prevState.lat, heading: prevState.heading },
        next: { lng: plane.lng, lat: plane.lat, heading: plane.heading },
        timestamp: now,
      });
    }

    if (markers.has(id)) {
      // Marker exists, interpolation loop will handle updates
      // Only update immediately if no previous state (first update after join)
      if (!prevState) {
        const marker = markers.get(id);
        marker.setLngLat([plane.lng, plane.lat]);
        marker.setRotation(plane.heading);
      }
    } else {
      // Create new marker
      const el = createPlaneElement(plane.color || '#888');
      const marker = new maplibregl.Marker({
        element: el,
        rotation: plane.heading,
        pitchAlignment: 'map',
        rotationAlignment: 'map',
      })
        .setLngLat([plane.lng, plane.lat])
        .addTo(map);

      markers.set(id, marker);
    }
  }

  // Start animation loop if there are other planes
  if (markers.size > 0) {
    startAnimationLoop();
  } else {
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
 * Remove a specific plane marker
 * @param {string} id - Plane ID to remove
 */
export function removePlane(id) {
  const marker = markers.get(id);
  if (marker) {
    marker.remove();
    markers.delete(id);
    planeStates.delete(id);
    interpolationData.delete(id);
  }

  // Stop animation loop if no more planes
  if (markers.size === 0) {
    stopAnimationLoop();
  }
}

/**
 * Clear all other plane markers
 */
export function clearAllPlanes() {
  stopAnimationLoop();
  for (const marker of markers.values()) {
    marker.remove();
  }
  markers.clear();
  planeStates.clear();
  interpolationData.clear();
}
