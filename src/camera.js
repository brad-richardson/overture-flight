import { CAMERA } from './constants.js';
import { updateCamera, altitudeToZoom } from './map.js';

let orbitAngle = 0;  // Horizontal offset from plane heading
let orbitPitch = CAMERA.DEFAULT_PITCH;

let isDragging = false;
let lastMouseX = 0;
let lastMouseY = 0;

/**
 * Initialize camera mouse controls for orbiting
 */
export function initCameraControls() {
  const mapContainer = document.getElementById('map');

  mapContainer.addEventListener('mousedown', (e) => {
    isDragging = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    mapContainer.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const deltaX = e.clientX - lastMouseX;
    const deltaY = e.clientY - lastMouseY;

    // Horizontal drag changes orbit angle
    orbitAngle += deltaX * CAMERA.ORBIT_SENSITIVITY;
    orbitAngle = ((orbitAngle % 360) + 360) % 360;

    // Vertical drag changes camera pitch
    orbitPitch -= deltaY * CAMERA.ORBIT_SENSITIVITY;
    orbitPitch = Math.max(CAMERA.MIN_PITCH, Math.min(CAMERA.MAX_PITCH, orbitPitch));

    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    document.getElementById('map').style.cursor = 'grab';
  });

  // Set initial cursor
  mapContainer.style.cursor = 'grab';
}

/**
 * Update camera to follow plane
 * @param {Object} planeState - Current plane state
 */
export function followPlane(planeState) {
  const bearing = planeState.heading + orbitAngle + 180; // +180 to look at plane from behind
  const zoom = altitudeToZoom(planeState.altitude);

  updateCamera({
    lng: planeState.lng,
    lat: planeState.lat,
    bearing: bearing,
    pitch: orbitPitch,
    zoom: zoom,
  });
}

/**
 * Reset camera to default position
 */
export function resetCamera() {
  orbitAngle = 0;
  orbitPitch = CAMERA.DEFAULT_PITCH;
}
