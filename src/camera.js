import * as THREE from 'three';
import { CAMERA } from './constants.js';
import { getCamera, geoToWorld } from './scene.js';

let orbitAngle = 0;  // Horizontal offset from plane heading
let orbitPitch = CAMERA.DEFAULT_PITCH;

let isDragging = false;
let lastMouseX = 0;
let lastMouseY = 0;

/**
 * Initialize camera mouse controls for orbiting
 */
export function initCameraControls() {
  const container = document.getElementById('map');

  container.addEventListener('mousedown', (e) => {
    isDragging = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    container.style.cursor = 'grabbing';
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
  container.style.cursor = 'grab';
}

/**
 * Update camera to follow plane (Three.js version)
 * @param {Object} planeState - Current plane state
 */
export function followPlane(planeState) {
  const camera = getCamera();
  if (!camera) return;

  // Convert plane position to world coordinates
  const planePos = geoToWorld(planeState.lng, planeState.lat, planeState.altitude);

  // Calculate camera position based on chase distance, heading, and orbit
  const distance = CAMERA.DEFAULT_DISTANCE;
  const headingRad = THREE.MathUtils.degToRad(planeState.heading + orbitAngle);
  const pitchRad = THREE.MathUtils.degToRad(orbitPitch);

  // Camera position: behind and above the plane
  // Use spherical coordinates around the plane
  const horizontalDist = distance * Math.cos(pitchRad);
  const verticalDist = distance * Math.sin(pitchRad);

  camera.position.set(
    planePos.x - Math.sin(headingRad) * horizontalDist,
    planePos.y + verticalDist,
    planePos.z + Math.cos(headingRad) * horizontalDist
  );

  // Look at the plane
  camera.lookAt(planePos.x, planePos.y, planePos.z);
}

/**
 * Reset camera to default position
 */
export function resetCamera() {
  orbitAngle = 0;
  orbitPitch = CAMERA.DEFAULT_PITCH;
}

/**
 * Get current orbit angle
 * @returns {number}
 */
export function getOrbitAngle() {
  return orbitAngle;
}

/**
 * Get current orbit pitch
 * @returns {number}
 */
export function getOrbitPitch() {
  return orbitPitch;
}
