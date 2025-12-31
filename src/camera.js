import * as THREE from 'three';
import { CAMERA } from './constants.js';
import { getCamera, geoToWorld } from './scene.js';

let orbitAngle = 0;  // Horizontal offset from plane heading
let orbitPitch = CAMERA.DEFAULT_PITCH;

let isDragging = false;
let lastMouseX = 0;
let lastMouseY = 0;

/**
 * Handle drag movement (shared between mouse and touch)
 * @param {number} clientX
 * @param {number} clientY
 */
function handleDragMove(clientX, clientY) {
  if (!isDragging) return;

  const deltaX = clientX - lastMouseX;
  const deltaY = clientY - lastMouseY;

  // Horizontal drag changes orbit angle
  orbitAngle += deltaX * CAMERA.ORBIT_SENSITIVITY;
  orbitAngle = ((orbitAngle % 360) + 360) % 360;

  // Vertical drag changes camera pitch
  orbitPitch -= deltaY * CAMERA.ORBIT_SENSITIVITY;
  orbitPitch = Math.max(CAMERA.MIN_PITCH, Math.min(CAMERA.MAX_PITCH, orbitPitch));

  lastMouseX = clientX;
  lastMouseY = clientY;
}

/**
 * Initialize camera mouse and touch controls for orbiting
 */
export function initCameraControls() {
  const container = document.getElementById('map');

  // Mouse controls
  container.addEventListener('mousedown', (e) => {
    isDragging = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    container.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    handleDragMove(e.clientX, e.clientY);
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    document.getElementById('map').style.cursor = 'grab';
  });

  // Touch controls for camera orbit (single finger on the map area, not on controls)
  container.addEventListener('touchstart', (e) => {
    // Only handle single-finger touches for camera
    if (e.touches.length === 1) {
      const touch = e.touches[0];

      // Check if touch is on the joystick area - if so, let joystick handle it
      const joystick = document.getElementById('joystick-container');
      if (joystick) {
        const rect = joystick.getBoundingClientRect();
        if (touch.clientX >= rect.left && touch.clientX <= rect.right &&
            touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
          return; // Let joystick handle this touch
        }
      }

      // Check if touch is on the throttle area - if so, let throttle handle it
      const throttle = document.getElementById('throttle-container');
      if (throttle) {
        const rect = throttle.getBoundingClientRect();
        if (touch.clientX >= rect.left && touch.clientX <= rect.right &&
            touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
          return; // Let throttle handle this touch
        }
      }

      isDragging = true;
      lastMouseX = touch.clientX;
      lastMouseY = touch.clientY;
    }
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && isDragging) {
      const touch = e.touches[0];
      handleDragMove(touch.clientX, touch.clientY);
    }
  }, { passive: true });

  container.addEventListener('touchend', () => {
    isDragging = false;
  }, { passive: true });

  container.addEventListener('touchcancel', () => {
    isDragging = false;
  }, { passive: true });

  // Set initial cursor (only relevant for mouse)
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
