import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import { getDeckOverlay } from './map.js';
import { PLANE_MODEL_URL, PLANE_RENDER } from './constants.js';

/**
 * Update the 3D plane rendering layer with current plane data
 * @param {Array<Object>} planes - Array of plane states to render
 * @param {string} [localId] - ID of local player (for potential different rendering)
 */
export function updatePlaneLayer(planes, localId = null) {
  const overlay = getDeckOverlay();
  if (!overlay) return;

  // Filter out local player if not visible
  const visiblePlanes = PLANE_RENDER.LOCAL_VISIBLE
    ? planes
    : planes.filter(p => p.id !== localId);

  const planeLayer = new ScenegraphLayer({
    id: 'planes-3d',
    data: visiblePlanes,
    scenegraph: PLANE_MODEL_URL,

    // Position: [lng, lat, altitude in meters]
    getPosition: d => [d.lng, d.lat, d.altitude],

    // Orientation: [pitch, roll, yaw] in degrees
    // Note: The model's default orientation may need adjustment
    // Yaw (heading): 0 = north, increases clockwise
    // Pitch: positive = nose up
    // Roll: positive = right wing down
    getOrientation: d => [d.pitch || 0, d.roll || 0, d.heading || 0],

    // Scale the model
    sizeScale: PLANE_RENDER.SCALE,
    getScale: [1, 1, 1],

    // Color tinting based on player color
    getColor: d => {
      // Parse hex color to RGB array
      const hex = d.color || '#ffffff';
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return [r, g, b, 255];
    },

    // Rendering options
    _lighting: 'pbr',
    parameters: {
      depthTest: true,
    },

    // Update triggers for efficient re-renders
    updateTriggers: {
      getPosition: planes.map(p => `${p.lng},${p.lat},${p.altitude}`).join('|'),
      getOrientation: planes.map(p => `${p.pitch},${p.roll},${p.heading}`).join('|'),
    },
  });

  overlay.setProps({ layers: [planeLayer] });
}

/**
 * Clear all plane layers
 */
export function clearPlaneLayer() {
  const overlay = getDeckOverlay();
  if (!overlay) return;

  overlay.setProps({ layers: [] });
}
