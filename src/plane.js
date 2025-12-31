import { FLIGHT, DEFAULT_LOCATION } from './constants.js';

/**
 * @typedef {Object} PlaneState
 * @property {string} id - Unique player ID
 * @property {number} lat - Latitude in degrees
 * @property {number} lng - Longitude in degrees
 * @property {number} altitude - Altitude in meters
 * @property {number} heading - Compass heading 0-360
 * @property {number} pitch - Nose pitch in degrees (positive = up)
 * @property {number} roll - Bank angle in degrees (positive = right)
 * @property {number} speed - Speed in m/s
 * @property {string} color - Assigned plane color
 * @property {string} [name] - Optional player name
 */

/** @type {PlaneState} */
let planeState = {
  id: '',
  lat: DEFAULT_LOCATION.lat,
  lng: DEFAULT_LOCATION.lng,
  altitude: FLIGHT.SPAWN_ALTITUDE,
  heading: 0,
  pitch: 0,
  roll: 0,
  speed: FLIGHT.DEFAULT_SPEED,
  color: '#3b82f6',
  name: '',
};

// Input state
const input = {
  pitchUp: false,
  pitchDown: false,
  rollLeft: false,
  rollRight: false,
  throttleUp: false,
  throttleDown: false,
};

/**
 * Initialize keyboard controls
 */
export function initControls() {
  document.addEventListener('keydown', (e) => {
    handleKeyChange(e.code, true);
  });

  document.addEventListener('keyup', (e) => {
    handleKeyChange(e.code, false);
  });
}

/**
 * Handle key state changes
 * @param {string} code - Key code
 * @param {boolean} pressed - Whether key is pressed
 */
function handleKeyChange(code, pressed) {
  switch (code) {
    case 'KeyW':
    case 'ArrowUp':
      input.pitchDown = pressed;  // W = push forward = nose down = descend
      break;
    case 'KeyS':
    case 'ArrowDown':
      input.pitchUp = pressed;    // S = pull back = nose up = climb
      break;
    case 'KeyA':
    case 'ArrowLeft':
      input.rollLeft = pressed;
      break;
    case 'KeyD':
    case 'ArrowRight':
      input.rollRight = pressed;
      break;
    case 'ShiftLeft':
    case 'ShiftRight':
      input.throttleUp = pressed;
      break;
    case 'ControlLeft':
    case 'ControlRight':
      input.throttleDown = pressed;
      break;
  }
}

/**
 * Update plane physics for one frame
 * @param {number} deltaTime - Time since last frame in seconds
 */
export function updatePlane(deltaTime) {
  // Handle pitch input
  if (input.pitchUp) {
    planeState.pitch = Math.min(45, planeState.pitch + FLIGHT.PITCH_RATE * deltaTime);
  }
  if (input.pitchDown) {
    planeState.pitch = Math.max(-45, planeState.pitch - FLIGHT.PITCH_RATE * deltaTime);
  }

  // Handle roll input
  if (input.rollLeft) {
    planeState.roll = Math.max(-60, planeState.roll - FLIGHT.ROLL_RATE * deltaTime);
  }
  if (input.rollRight) {
    planeState.roll = Math.min(60, planeState.roll + FLIGHT.ROLL_RATE * deltaTime);
  }

  // Auto-level roll when no input
  if (!input.rollLeft && !input.rollRight) {
    planeState.roll *= 0.95;
    if (Math.abs(planeState.roll) < 0.5) planeState.roll = 0;
  }

  // Auto-level pitch when no input
  if (!input.pitchUp && !input.pitchDown) {
    planeState.pitch *= 0.98;
    if (Math.abs(planeState.pitch) < 0.5) planeState.pitch = 0;
  }

  // Handle throttle
  if (input.throttleUp) {
    planeState.speed = Math.min(FLIGHT.MAX_SPEED, planeState.speed + FLIGHT.THROTTLE_RATE * deltaTime);
  }
  if (input.throttleDown) {
    planeState.speed = Math.max(FLIGHT.MIN_SPEED, planeState.speed - FLIGHT.THROTTLE_RATE * deltaTime);
  }

  // Banking turns - roll affects heading
  planeState.heading += planeState.roll * FLIGHT.TURN_RATE * deltaTime;
  planeState.heading = ((planeState.heading % 360) + 360) % 360;

  // Calculate movement
  const speedKmPerSec = planeState.speed / 1000;
  const headingRad = (planeState.heading * Math.PI) / 180;
  const pitchRad = (planeState.pitch * Math.PI) / 180;

  // Convert speed to lat/lng change (approximate)
  // 1 degree latitude ≈ 111km, longitude varies with latitude
  const latChange = Math.cos(headingRad) * speedKmPerSec * deltaTime / 111;
  const lngScale = Math.cos((planeState.lat * Math.PI) / 180);
  const lngChange = Math.sin(headingRad) * speedKmPerSec * deltaTime / (111 * lngScale);

  planeState.lat += latChange;
  planeState.lng += lngChange;

  // Altitude change based on pitch and speed
  const climbRate = Math.sin(pitchRad) * planeState.speed;
  planeState.altitude += climbRate * deltaTime;

  // Stall behavior - if too slow, gravity pulls down
  if (planeState.speed < FLIGHT.MIN_SPEED * 1.5) {
    const stallFactor = 1 - (planeState.speed / (FLIGHT.MIN_SPEED * 1.5));
    planeState.altitude -= FLIGHT.GRAVITY * stallFactor * deltaTime;
  }

  // Clamp altitude
  planeState.altitude = Math.max(FLIGHT.MIN_ALTITUDE, Math.min(FLIGHT.MAX_ALTITUDE, planeState.altitude));
}

/**
 * Get current plane state
 * @returns {PlaneState}
 */
export function getPlaneState() {
  return { ...planeState };
}

/**
 * Set plane ID and color (from server)
 * @param {string} id
 * @param {string} color
 */
export function setPlaneIdentity(id, color) {
  planeState.id = id;
  planeState.color = color;
}

/**
 * Teleport plane to a new location
 * @param {number} lat
 * @param {number} lng
 */
export function teleportPlane(lat, lng) {
  planeState.lat = lat;
  planeState.lng = lng;
  planeState.altitude = FLIGHT.SPAWN_ALTITUDE;
  planeState.heading = 0;
  planeState.pitch = 0;
  planeState.roll = 0;
  planeState.speed = FLIGHT.DEFAULT_SPEED;
}

/**
 * Reset plane after crash (same location, respawn altitude)
 */
export function resetPlane() {
  planeState.altitude = FLIGHT.SPAWN_ALTITUDE;
  planeState.pitch = 0;
  planeState.roll = 0;
  planeState.speed = FLIGHT.DEFAULT_SPEED;
}
