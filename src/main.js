import { initMap } from './map.js';
import { initControls, updatePlane, getPlaneState, setPlaneIdentity, teleportPlane, resetPlane } from './plane.js';
import { initCameraControls, followPlane } from './camera.js';
import { createConnection } from './network.js';
import { checkCollision } from './collision.js';
import { updateOtherPlanes, updateLocalPlane, removePlane } from './other-planes.js';
import { updateHUD, updatePlayerList, showCrashMessage, initLocationPicker } from './ui.js';

// Game state
let connection = null;
let localId = '';
let localColor = '#3b82f6';
let lastTime = 0;
let isRunning = false;

// All known players (including self)
const players = new Map();

/**
 * Main game loop
 * @param {number} time - Current timestamp
 */
function gameLoop(time) {
  if (!isRunning) return;

  // Calculate delta time
  const deltaTime = lastTime ? (time - lastTime) / 1000 : 0.016;
  lastTime = time;

  // Cap delta time to avoid physics issues
  const cappedDelta = Math.min(deltaTime, 0.1);

  // Update plane physics
  updatePlane(cappedDelta);

  // Get current state
  const planeState = getPlaneState();

  // Check for collisions
  if (checkCollision(planeState)) {
    showCrashMessage();
    resetPlane();
  }

  // Update camera to follow plane
  followPlane(planeState);

  // Update HUD
  updateHUD(planeState);

  // Send position to server
  if (connection) {
    connection.sendPosition(planeState);
  }

  // Update local player in players map and render 3D plane
  if (localId) {
    players.set(localId, planeState);
    updatePlayerList(players, localId);
    updateLocalPlane(planeState, localId, localColor);
  }

  // Continue loop
  requestAnimationFrame(gameLoop);
}

/**
 * Handle welcome message from server
 * @param {Object} msg - Welcome message
 */
function handleWelcome(msg) {
  console.log('Welcome! ID:', msg.id, 'Color:', msg.color);
  localId = msg.id;
  localColor = msg.color || '#3b82f6';
  setPlaneIdentity(msg.id, msg.color);

  // Add existing players
  if (msg.planes) {
    for (const [id, plane] of Object.entries(msg.planes)) {
      players.set(id, plane);
    }
    updateOtherPlanes(Object.fromEntries(players), localId);
  }
}

/**
 * Handle sync message from server
 * @param {Object} planes - All plane states
 */
function handleSync(planes) {
  // Update players map
  for (const [id, plane] of Object.entries(planes)) {
    if (id !== localId) {
      players.set(id, plane);
    }
  }

  // Update other plane markers
  updateOtherPlanes(planes, localId);
}

/**
 * Handle player joined message
 * @param {Object} player - New player info
 */
function handlePlayerJoined(player) {
  console.log('Player joined:', player.id);
  players.set(player.id, player);
}

/**
 * Handle player left message
 * @param {string} id - Player ID who left
 */
function handlePlayerLeft(id) {
  console.log('Player left:', id);
  players.delete(id);
  removePlane(id);
  updatePlayerList(players, localId);
}

/**
 * Handle teleport action
 * @param {number} lat - Destination latitude
 * @param {number} lng - Destination longitude
 */
function handleTeleport(lat, lng) {
  teleportPlane(lat, lng);
  if (connection) {
    connection.sendTeleport(lat, lng);
  }
}

/**
 * Initialize the game
 */
async function init() {
  console.log('Initializing Flight Simulator...');

  try {
    // Initialize map
    await initMap();
    console.log('Map initialized');

    // Initialize controls
    initControls();
    initCameraControls();
    console.log('Controls initialized');

    // Initialize UI
    initLocationPicker(handleTeleport);
    console.log('UI initialized');

    // Connect to multiplayer server
    connection = createConnection('global', {
      onWelcome: handleWelcome,
      onSync: handleSync,
      onPlayerJoined: handlePlayerJoined,
      onPlayerLeft: handlePlayerLeft,
    });
    console.log('Connecting to server...');

    // Start game loop
    isRunning = true;
    requestAnimationFrame(gameLoop);
    console.log('Game loop started');

  } catch (error) {
    console.error('Failed to initialize:', error);
  }
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
