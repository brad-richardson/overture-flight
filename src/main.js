import { initScene, render, updatePlaneMesh, removePlaneMesh, setOrigin } from './scene.js';
import { initControls, updatePlane, getPlaneState, setPlaneIdentity, teleportPlane, resetPlane } from './plane.js';
import { initCameraControls, followPlane } from './camera.js';
import { createConnection } from './network.js';
import { checkCollision } from './collision.js';
import { updateHUD, updatePlayerList, showCrashMessage, initLocationPicker } from './ui.js';
import { initTileManager, getTilesToLoad, getTilesToUnload, isTileLoaded, markTileLoading, markTileLoaded, removeTile, getTileMeshes } from './tile-manager.js';
import { createBuildingsForTile, removeBuildingsGroup } from './buildings.js';
import { createBaseLayerForTile, removeBaseLayerGroup } from './base-layer.js';
import { DEFAULT_LOCATION } from './constants.js';

// Game state
let connection = null;
let localId = '';
let localColor = '#3b82f6';
let lastTime = 0;
let isRunning = false;

// All known players (including self)
const players = new Map();

// Tile meshes tracking
const tileMeshes = new Map(); // key -> { buildings: Group, base: Group }
const loadingTiles = new Set(); // Track tiles currently being loaded

/**
 * Load tiles around the current position
 * @param {number} lng
 * @param {number} lat
 */
async function updateTiles(lng, lat) {
  const tilesToLoad = getTilesToLoad(lng, lat);

  // Load new tiles
  for (const tile of tilesToLoad) {
    // Skip if already loaded or currently loading
    if (tileMeshes.has(tile.key) || loadingTiles.has(tile.key)) {
      continue;
    }

    loadingTiles.add(tile.key);
    console.log('Loading tile:', tile.key);

    // Load base layer and buildings in parallel
    Promise.all([
      createBaseLayerForTile(tile.x, tile.y, tile.z),
      createBuildingsForTile(tile.x, tile.y, tile.z)
    ]).then(([baseGroup, buildingsGroup]) => {
      tileMeshes.set(tile.key, {
        base: baseGroup,
        buildings: buildingsGroup
      });
      loadingTiles.delete(tile.key);
      console.log('Tile loaded:', tile.key);
    }).catch(e => {
      console.warn(`Failed to load tile ${tile.key}:`, e);
      loadingTiles.delete(tile.key);
    });
  }

  // Unload distant tiles
  const tilesToUnload = getTilesToUnload(lng, lat);
  for (const key of tilesToUnload) {
    const meshes = tileMeshes.get(key);
    if (meshes) {
      if (meshes.base) removeBaseLayerGroup(meshes.base);
      if (meshes.buildings) removeBuildingsGroup(meshes.buildings);
      tileMeshes.delete(key);
    }
    removeTile(key);
  }
}

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

  // Update local plane mesh
  if (localId) {
    updatePlaneMesh(planeState, localId, localColor);
    players.set(localId, planeState);
    updatePlayerList(players, localId);
  }

  // Update HUD
  updateHUD(planeState);

  // Send position to server
  if (connection) {
    connection.sendPosition(planeState);
  }

  // Update tiles based on plane position
  updateTiles(planeState.lng, planeState.lat);

  // Render the scene
  render();

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
      if (id !== localId) {
        updatePlaneMesh(plane, id, plane.color);
      }
    }
  }
}

/**
 * Handle sync message from server
 * @param {Object} planes - All plane states
 */
function handleSync(planes) {
  // Update players map and plane meshes
  for (const [id, plane] of Object.entries(planes)) {
    if (id !== localId) {
      players.set(id, plane);
      updatePlaneMesh(plane, id, plane.color);
    }
  }
}

/**
 * Handle player joined message
 * @param {Object} player - New player info
 */
function handlePlayerJoined(player) {
  console.log('Player joined:', player.id);
  players.set(player.id, player);
  updatePlaneMesh(player, player.id, player.color);
}

/**
 * Handle player left message
 * @param {string} id - Player ID who left
 */
function handlePlayerLeft(id) {
  console.log('Player left:', id);
  players.delete(id);
  removePlaneMesh(id);
  updatePlayerList(players, localId);
}

/**
 * Handle teleport action
 * @param {number} lat - Destination latitude
 * @param {number} lng - Destination longitude
 */
function handleTeleport(lat, lng) {
  // Update origin for new location
  setOrigin(lng, lat);

  // Clear existing tiles
  for (const [key, meshes] of tileMeshes) {
    if (meshes.base) removeBaseLayerGroup(meshes.base);
    if (meshes.buildings) removeBuildingsGroup(meshes.buildings);
    removeTile(key);
  }
  tileMeshes.clear();

  // Teleport plane
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
    // Set initial origin
    setOrigin(DEFAULT_LOCATION.lng, DEFAULT_LOCATION.lat);

    // Initialize Three.js scene
    await initScene();
    console.log('Scene initialized');

    // Initialize tile manager (PMTiles sources)
    await initTileManager();
    console.log('Tile manager initialized');

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
    console.log('Game started');

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
