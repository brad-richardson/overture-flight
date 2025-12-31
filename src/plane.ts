import { FLIGHT, DEFAULT_LOCATION } from './constants.js';

/**
 * Plane state interface
 */
export interface PlaneState {
  id: string;
  lat: number;
  lng: number;
  altitude: number;
  heading: number;
  pitch: number;
  roll: number;
  speed: number;
  color: string;
  name: string;
}

/**
 * Joystick input interface
 */
export interface JoystickInput {
  x: number;
  y: number;
}

/**
 * Throttle input interface
 */
export interface ThrottleInput {
  up: boolean;
  down: boolean;
}

let planeState: PlaneState = {
  id: '',
  lat: DEFAULT_LOCATION.lat,
  lng: DEFAULT_LOCATION.lng,
  altitude: FLIGHT.SPAWN_ALTITUDE,
  heading: 150, // SE direction
  pitch: 0,
  roll: 0,
  speed: FLIGHT.DEFAULT_SPEED,
  color: '#3b82f6',
  name: '',
};

// Keyboard input state
const input = {
  pitchUp: false,
  pitchDown: false,
  rollLeft: false,
  rollRight: false,
  throttleUp: false,
  throttleDown: false,
};

// Mobile joystick input (analog -1 to 1)
const mobileInput = {
  pitch: 0,   // -1 = nose down, 1 = nose up
  roll: 0,    // -1 = roll left, 1 = roll right
  throttleUp: false,
  throttleDown: false,
};

/**
 * Set mobile joystick input
 */
export function setMobileInput(joystick: JoystickInput, throttle: ThrottleInput): void {
  // X = roll (left/right), Y = pitch (up/down but inverted - push forward = dive)
  mobileInput.roll = joystick.x;
  mobileInput.pitch = -joystick.y; // Invert: pushing joystick up = nose down
  mobileInput.throttleUp = throttle.up;
  mobileInput.throttleDown = throttle.down;
}

/**
 * Initialize keyboard controls
 */
export function initControls(): void {
  document.addEventListener('keydown', (e) => {
    handleKeyChange(e.code, true);
  });

  document.addEventListener('keyup', (e) => {
    handleKeyChange(e.code, false);
  });
}

/**
 * Handle key state changes
 */
function handleKeyChange(code: string, pressed: boolean): void {
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
 */
export function updatePlane(deltaTime: number): void {
  // Combine keyboard and mobile input
  // Keyboard uses boolean, mobile uses analog (-1 to 1)
  const pitchInput = (input.pitchUp ? 1 : 0) - (input.pitchDown ? 1 : 0) + mobileInput.pitch;
  const rollInput = (input.rollRight ? 1 : 0) - (input.rollLeft ? 1 : 0) + mobileInput.roll;
  const throttleUp = input.throttleUp || mobileInput.throttleUp;
  const throttleDown = input.throttleDown || mobileInput.throttleDown;

  // Clamp combined input to -1 to 1 range
  const clampedPitch = Math.max(-1, Math.min(1, pitchInput));
  const clampedRoll = Math.max(-1, Math.min(1, rollInput));

  // Handle pitch input (analog)
  if (clampedPitch !== 0) {
    planeState.pitch += clampedPitch * FLIGHT.PITCH_RATE * deltaTime;
    planeState.pitch = Math.max(-45, Math.min(45, planeState.pitch));
  }

  // Handle roll input (analog)
  if (clampedRoll !== 0) {
    planeState.roll += clampedRoll * FLIGHT.ROLL_RATE * deltaTime;
    planeState.roll = Math.max(-60, Math.min(60, planeState.roll));
  }

  // Auto-level roll when no input
  const hasRollInput = input.rollLeft || input.rollRight || Math.abs(mobileInput.roll) > 0.1;
  if (!hasRollInput) {
    planeState.roll *= 0.95;
    if (Math.abs(planeState.roll) < 0.5) planeState.roll = 0;
  }

  // Auto-level pitch when no input
  const hasPitchInput = input.pitchUp || input.pitchDown || Math.abs(mobileInput.pitch) > 0.1;
  if (!hasPitchInput) {
    planeState.pitch *= 0.98;
    if (Math.abs(planeState.pitch) < 0.5) planeState.pitch = 0;
  }

  // Handle throttle
  if (throttleUp) {
    planeState.speed = Math.min(FLIGHT.MAX_SPEED, planeState.speed + FLIGHT.THROTTLE_RATE * deltaTime);
  }
  if (throttleDown) {
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
 */
export function getPlaneState(): PlaneState {
  return { ...planeState };
}

/**
 * Set plane ID and color (from server)
 */
export function setPlaneIdentity(id: string, color: string): void {
  planeState.id = id;
  planeState.color = color;
}

/**
 * Teleport plane to a new location
 */
export function teleportPlane(lat: number, lng: number): void {
  planeState.lat = lat;
  planeState.lng = lng;
  planeState.altitude = FLIGHT.SPAWN_ALTITUDE;
  planeState.heading = 150; // SE direction
  planeState.pitch = 0;
  planeState.roll = 0;
  planeState.speed = FLIGHT.DEFAULT_SPEED;
}

/**
 * Reset plane after crash (same location, respawn altitude)
 */
export function resetPlane(): void {
  planeState.altitude = FLIGHT.SPAWN_ALTITUDE;
  planeState.pitch = 0;
  planeState.roll = 0;
  planeState.speed = FLIGHT.DEFAULT_SPEED;
}
