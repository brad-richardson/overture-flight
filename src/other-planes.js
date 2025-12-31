import maplibregl from 'maplibre-gl';
import { getMap } from './map.js';

/** @type {Map<string, maplibregl.Marker>} */
const markers = new Map();

/** @type {Map<string, Object>} */
const planeStates = new Map();

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
 * Update other players' planes on the map
 * @param {Object<string, Object>} planes - Map of plane states by ID
 * @param {string} localId - Local player's ID (to exclude)
 */
export function updateOtherPlanes(planes, localId) {
  const map = getMap();
  if (!map) return;

  const currentIds = new Set(Object.keys(planes));

  // Remove markers for planes that left
  for (const [id, marker] of markers) {
    if (!currentIds.has(id) || id === localId) {
      marker.remove();
      markers.delete(id);
      planeStates.delete(id);
    }
  }

  // Update or create markers for other planes
  for (const [id, plane] of Object.entries(planes)) {
    if (id === localId) continue;

    planeStates.set(id, plane);

    if (markers.has(id)) {
      // Update existing marker
      const marker = markers.get(id);
      marker.setLngLat([plane.lng, plane.lat]);
      marker.setRotation(plane.heading);
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
  }
}

/**
 * Clear all other plane markers
 */
export function clearAllPlanes() {
  for (const marker of markers.values()) {
    marker.remove();
  }
  markers.clear();
  planeStates.clear();
}
