import { initScene, render, updatePlaneMesh, removePlaneMesh, setOrigin } from './scene.js';
import { initControls, updatePlane, getPlaneState, setPlaneIdentity, teleportPlane, resetPlane, setMobileInput, PlaneState } from './plane.js';
import { initCameraControls, followPlane } from './camera.js';
import { createConnection, Connection, WelcomeMessage } from './network.js';
import { checkCollision } from './collision.js';
import { updateHUD, updatePlayerList, showCrashMessage, initLocationPicker } from './ui.js';
import { initTileManager, getTilesToLoad, getTilesToUnload, removeTile } from './tile-manager.js';
import { createBuildingsForTile, removeBuildingsGroup } from './buildings.js';
import { createBaseLayerForTile, removeBaseLayerGroup } from './base-layer.js';
import { createTransportationForTile, removeTransportationGroup } from './transportation-layer.js';
import { preloadElevationTiles, unloadDistantElevationTiles } from './elevation.js';
import { DEFAULT_LOCATION, ELEVATION, PLAYER_COLORS } from './constants.js';
import { initMobileControls, getJoystickState, getThrottleState, isMobileDevice } from './mobile-controls.js';
import * as THREE from 'three';

// Tile meshes type
interface TileMeshes {
  buildings: THREE.Group | null;
  base: THREE.Group | null;
  transportation: THREE.Group | null;
}

// Game state
let connection: Connection | null = null;
let localId = '';
let localColor = '#3b82f6';
let lastTime = 0;
let isRunning = false;

/**
 * Generate a unique local ID for offline/single-player mode
 */
function generateLocalId(): string {
  return 'local-' + Math.random().toString(36).substring(2, 11);
}

// All known players (including self)
const players = new Map<string, PlaneState>();

// Tile meshes tracking
const tileMeshes = new Map<string, TileMeshes>(); // key -> { buildings: Group, base: Group, transportation: Group }
const loadingTiles = new Set<string>(); // Track tiles currently being loaded

/**
 * Load tiles around the current position
 */
async function updateTiles(lng: number, lat: number): Promise<void> {
  const tilesToLoad = getTilesToLoad(lng, lat);

  // Load new tiles
  for (const tile of tilesToLoad) {
    // Skip if already loaded or currently loading
    if (tileMeshes.has(tile.key) || loadingTiles.has(tile.key)) {
      continue;
    }

    loadingTiles.add(tile.key);
    console.log('Loading tile:', tile.key);

    // Load base layer, buildings, and transportation in parallel
    Promise.all([
      createBaseLayerForTile(tile.x, tile.y, tile.z),
      createBuildingsForTile(tile.x, tile.y, tile.z),
      createTransportationForTile(tile.x, tile.y, tile.z)
    ]).then(([baseGroup, buildingsGroup, transportationGroup]) => {
      tileMeshes.set(tile.key, {
        base: baseGroup,
        buildings: buildingsGroup,
        transportation: transportationGroup
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
      if (meshes.transportation) removeTransportationGroup(meshes.transportation);
      tileMeshes.delete(key);
    }
    removeTile(key);
  }

  // Clean up distant elevation tiles if terrain is enabled
  if (ELEVATION.TERRAIN_ENABLED) {
    unloadDistantElevationTiles(lng, lat, 5);
  }
}

/**
 * Main game loop
 */
function gameLoop(time: number): void {
  if (!isRunning) return;

  // Calculate delta time
  const deltaTime = lastTime ? (time - lastTime) / 1000 : 0.016;
  lastTime = time;

  // Cap delta time to avoid physics issues
  const cappedDelta = Math.min(deltaTime, 0.1);

  // Update mobile input each frame (if on mobile)
  if (isMobileDevice()) {
    setMobileInput(getJoystickState(), getThrottleState());
  }

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
 */
function handleWelcome(msg: WelcomeMessage): void {
  console.log('Welcome! ID:', msg.id, 'Color:', msg.color);

  // Remove the temporary local plane mesh before updating ID
  const oldLocalId = localId;
  if (oldLocalId && oldLocalId !== msg.id) {
    removePlaneMesh(oldLocalId);
    players.delete(oldLocalId);
  }

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
 */
function handleSync(planes: Record<string, PlaneState>): void {
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
 */
function handlePlayerJoined(player: PlaneState): void {
  console.log('Player joined:', player.id);
  players.set(player.id, player);
  updatePlaneMesh(player, player.id, player.color);
}

/**
 * Handle player left message
 */
function handlePlayerLeft(id: string): void {
  console.log('Player left:', id);
  players.delete(id);
  removePlaneMesh(id);
  updatePlayerList(players, localId);
}

/**
 * Handle teleport action
 */
async function handleTeleport(lat: number, lng: number): Promise<void> {
  // Update origin for new location
  setOrigin(lng, lat);

  // Clear existing tiles
  for (const [key, meshes] of tileMeshes) {
    if (meshes.base) removeBaseLayerGroup(meshes.base);
    if (meshes.buildings) removeBuildingsGroup(meshes.buildings);
    if (meshes.transportation) removeTransportationGroup(meshes.transportation);
    removeTile(key);
  }
  tileMeshes.clear();

  // Preload elevation tiles for the new location
  if (ELEVATION.TERRAIN_ENABLED) {
    console.log(`Preloading elevation tiles for teleport to (${lat.toFixed(4)}, ${lng.toFixed(4)})...`);
    preloadElevationTiles(lng, lat, 2).catch((error) => {
      console.warn('Failed to preload elevation tiles:', error);
    });
  }

  // Teleport plane
  teleportPlane(lat, lng);

  if (connection) {
    connection.sendTeleport(lat, lng);
  }
}

/**
 * Show error notification to user
 */
function showError(title: string, details: string[] = [], footer: string = ''): void {
  // Create or update error display
  let errorDiv = document.getElementById('error-message');
  if (!errorDiv) {
    errorDiv = document.createElement('div');
    errorDiv.id = 'error-message';
    errorDiv.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: rgba(220, 38, 38, 0.95);
      color: white;
      padding: 20px 30px;
      border-radius: 8px;
      font-size: 16px;
      z-index: 10000;
      max-width: 80%;
      text-align: center;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    `;
    document.body.appendChild(errorDiv);
  }

  // Build content safely without innerHTML
  errorDiv.textContent = '';

  const titleEl = document.createElement('strong');
  titleEl.textContent = title;
  errorDiv.appendChild(titleEl);

  for (const detail of details) {
    errorDiv.appendChild(document.createElement('br'));
    errorDiv.appendChild(document.createTextNode(detail));
  }

  if (footer) {
    errorDiv.appendChild(document.createElement('br'));
    const footerEl = document.createElement('small');
    footerEl.textContent = footer;
    errorDiv.appendChild(footerEl);
  }

  errorDiv.style.display = 'block';

  // Auto-hide after 8 seconds
  setTimeout(() => {
    errorDiv!.style.display = 'none';
  }, 8000);
}

/**
 * Initialize the game
 */
async function init(): Promise<void> {
  console.log('Initializing Flight Simulator...');

  try {
    // Set initial origin
    setOrigin(DEFAULT_LOCATION.lng, DEFAULT_LOCATION.lat);

    // Initialize Three.js scene
    await initScene();
    console.log('Scene initialized');

    // Initialize tile manager (PMTiles sources)
    const tileStatus = await initTileManager();
    console.log('Tile manager initialized:', tileStatus);

    // Show warning if data failed to load
    if (tileStatus.errors && tileStatus.errors.length > 0) {
      showError(
        'Warning: Some data failed to load',
        tileStatus.errors,
        'The flight simulator will still work, but buildings/terrain may not appear.'
      );
    }

    // Preload elevation tiles for the starting area
    if (ELEVATION.TERRAIN_ENABLED) {
      console.log('Preloading elevation tiles...');
      await preloadElevationTiles(DEFAULT_LOCATION.lng, DEFAULT_LOCATION.lat, 2);
      console.log('Elevation tiles preloaded');
    }

    // Initialize controls (keyboard)
    initControls();
    initCameraControls();
    console.log('Controls initialized');

    // Initialize mobile controls (touch joystick)
    initMobileControls();
    console.log('Mobile controls initialized');

    // Initialize UI
    initLocationPicker(handleTeleport);
    console.log('UI initialized');

    // Generate local ID and color immediately so plane renders without network
    localId = generateLocalId();
    localColor = PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
    setPlaneIdentity(localId, localColor);
    console.log('Local player initialized:', localId);

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
    showError('Failed to start:', [(error as Error).message]);
  }
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
