import { initScene, render, updatePlaneMesh, removePlaneMesh, setOrigin, updateSkySystem } from './scene.js';
import { initControls, updatePlane, getPlaneState, setPlaneIdentity, teleportPlane, resetPlane, setMobileInput, setPlaneAltitude, PlaneState } from './plane.js';
import { initCameraControls, followPlane } from './camera.js';
import { createConnection, Connection, WelcomeMessage } from './network.js';
import { checkCollision } from './collision.js';
import { updateHUD, updatePlayerList, showCrashMessage, setTeleportToPlayerCallback } from './ui.js';
import { initMinimap, updateMinimap } from './minimap.js';
import { initTileManager, getTilesToLoad, getTilesToUnload, removeTile, clearDistantWaterPolygonCache } from './tile-manager.js';
import { createBuildingsForTile, removeBuildingsGroup } from './buildings.js';
import { createBaseLayerForTile, removeBaseLayerGroup } from './base-layer.js';
import { createTransportationForTile, removeTransportationGroup } from './transportation-layer.js';
import { createGroundForTile, removeGroundGroup, clearAllGroundTiles } from './ground-texture/index.js';
import { createTreesForTile, removeTreesGroup } from './tree-layer.js';
import { preloadElevationTiles, unloadDistantElevationTiles, getTerrainHeightAsync } from './elevation.js';
import { DEFAULT_LOCATION, ELEVATION, PLAYER_COLORS, PLANE_RENDER, FLIGHT, GROUND_TEXTURE } from './constants.js';
import { initMobileControls, getJoystickState, getThrottleState } from './mobile-controls.js';
import { initFeaturePicker, clearAllFeatures } from './feature-picker.js';
import { initFeatureModal, showFeatureModal } from './feature-modal.js';
import { setPlayerTarget, updateInterpolation, getInterpolatedState, removeInterpolatedPlayer } from './interpolation.js';
import * as THREE from 'three';

// Tile meshes type
interface TileMeshes {
  buildings: THREE.Group | null;
  base: THREE.Group | null;
  transportation: THREE.Group | null;
  trees: THREE.Group | null;
  ground: THREE.Group | null; // New texture-based ground rendering
}

// URL location tracking - store last hash to detect meaningful changes
let lastLocationHash: string | null = null;
let lastHashUpdateTime = 0;
const HASH_UPDATE_INTERVAL = 1000; // Only check/update URL every 1 second

/**
 * Parse location from URL hash in format #z/lat/lng (compatible with explore site)
 * Returns null if hash is invalid or not present
 */
function parseLocationFromHash(): { lat: number; lng: number } | null {
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return null;

  // Format: #z/lat/lng
  const parts = hash.substring(1).split('/');
  if (parts.length !== 3) return null;

  const lat = parseFloat(parts[1]);
  const lng = parseFloat(parts[2]);

  // Validate values (zoom is ignored, we always use z14)
  if (isNaN(lat) || isNaN(lng)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lng < -180 || lng > 180) return null;

  return { lat, lng };
}

/**
 * Update URL hash with current location
 * Format: #z/lat/lng (compatible with explore site, z is always 14)
 * Uses 2 decimal places (~1.1km precision) for stable URLs that don't spin constantly
 * Note: When parsing, we accept any precision for shared URLs with more detail
 * Throttled to avoid unnecessary work every frame
 */
function updateLocationHash(lng: number, lat: number): void {
  // Throttle: only check every HASH_UPDATE_INTERVAL ms
  const now = performance.now();
  if (now - lastHashUpdateTime < HASH_UPDATE_INTERVAL) return;
  lastHashUpdateTime = now;

  // Format: #z/lat/lng with z fixed at 14, 2 decimal places for lat/lng
  const newHash = `#14/${lat.toFixed(2)}/${lng.toFixed(2)}`;

  // Only update URL if position has changed meaningfully
  if (newHash === lastLocationHash) return;
  lastLocationHash = newHash;

  // Use replaceState to avoid polluting browser history
  history.replaceState(null, '', newHash);
}

// Flag to track if we're currently handling a hash change (to avoid re-triggering)
let isHandlingHashChange = false;

/**
 * Handle URL hash changes (user manually editing URL or using back/forward)
 */
function handleHashChange(): void {
  if (isHandlingHashChange) return;

  const location = parseLocationFromHash();
  if (!location) return;

  // Check if this is actually a different location than where we are
  const currentHash = lastLocationHash;
  const newHash = window.location.hash;
  if (currentHash === newHash) return;

  isHandlingHashChange = true;
  handleTeleport(location.lat, location.lng).finally(() => {
    isHandlingHashChange = false;
  });
}

// Listen for hash changes (user editing URL or back/forward navigation)
window.addEventListener('hashchange', handleHashChange);

// Game state
let connection: Connection | null = null;
let localId = '';
let localColor = '#3b82f6';
let lastTime = 0;
let isRunning = false;

// FPS counter (development only)
let fpsElement: HTMLDivElement | null = null;
let frameCount = 0;
let fpsLastTime = 0;

function initFpsCounter(): void {
  if (!import.meta.env.DEV) return;

  fpsElement = document.createElement('div');
  fpsElement.style.cssText = `
    position: fixed;
    top: 8px;
    right: 8px;
    background: rgba(0, 0, 0, 0.7);
    color: #0f0;
    font-family: monospace;
    font-size: 14px;
    padding: 4px 8px;
    border-radius: 4px;
    z-index: 9999;
  `;
  document.body.appendChild(fpsElement);
}

function updateFpsCounter(time: number): void {
  if (!fpsElement) return;

  frameCount++;
  const elapsed = time - fpsLastTime;

  if (elapsed >= 1000) {
    const fps = Math.round((frameCount * 1000) / elapsed);
    fpsElement.textContent = `${fps} FPS`;
    frameCount = 0;
    fpsLastTime = time;
  }
}

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
 * Load tiles around the current position with predictive loading
 */
async function updateTiles(
  lng: number,
  lat: number,
  heading: number = 0,
  speed: number = 0
): Promise<void> {
  const tilesToLoad = getTilesToLoad(lng, lat, heading, speed);

  // Load new tiles
  for (const tile of tilesToLoad) {
    // Skip if already loaded or currently loading
    if (tileMeshes.has(tile.key) || loadingTiles.has(tile.key)) {
      continue;
    }

    loadingTiles.add(tile.key);

    // Load layers in parallel
    // Wrap tree creation to isolate failures - trees are optional, other layers are critical
    const safeCreateTrees = async () => {
      try {
        return await createTreesForTile(tile.x, tile.y, tile.z);
      } catch (e) {
        console.warn(`Tree creation failed for tile ${tile.key}:`, e);
        return null;
      }
    };

    // Use new texture-based ground rendering if enabled
    if (GROUND_TEXTURE.ENABLED) {
      Promise.all([
        createGroundForTile(tile.x, tile.y, tile.z),
        createBuildingsForTile(tile.x, tile.y, tile.z),
        safeCreateTrees()
      ]).then(([groundGroup, buildingsGroup, treesGroup]) => {
        tileMeshes.set(tile.key, {
          ground: groundGroup,
          base: null,
          transportation: null,
          buildings: buildingsGroup,
          trees: treesGroup
        });
        loadingTiles.delete(tile.key);
      }).catch(e => {
        console.warn(`Failed to load tile ${tile.key}:`, e);
        loadingTiles.delete(tile.key);
      });
    } else {
      // Legacy polygon-based rendering
      Promise.all([
        createBaseLayerForTile(tile.x, tile.y, tile.z),
        createBuildingsForTile(tile.x, tile.y, tile.z),
        createTransportationForTile(tile.x, tile.y, tile.z),
        safeCreateTrees()
      ]).then(([baseGroup, buildingsGroup, transportationGroup, treesGroup]) => {
        tileMeshes.set(tile.key, {
          ground: null,
          base: baseGroup,
          buildings: buildingsGroup,
          transportation: transportationGroup,
          trees: treesGroup
        });
        loadingTiles.delete(tile.key);
      }).catch(e => {
        console.warn(`Failed to load tile ${tile.key}:`, e);
        loadingTiles.delete(tile.key);
      });
    }
  }

  // Unload distant tiles
  const tilesToUnload = getTilesToUnload(lng, lat);
  for (const key of tilesToUnload) {
    const meshes = tileMeshes.get(key);
    if (meshes) {
      // New texture-based ground
      if (meshes.ground) removeGroundGroup(meshes.ground);
      // Legacy polygon-based rendering
      if (meshes.base) removeBaseLayerGroup(meshes.base);
      if (meshes.transportation) removeTransportationGroup(meshes.transportation);
      // Common to both
      if (meshes.buildings) removeBuildingsGroup(meshes.buildings);
      if (meshes.trees) removeTreesGroup(meshes.trees);
      tileMeshes.delete(key);
    }
    removeTile(key);
  }

  // Clean up distant elevation tiles if terrain is enabled
  if (ELEVATION.TERRAIN_ENABLED) {
    unloadDistantElevationTiles(lng, lat, 5);
  }

  // Clean up distant water polygon cache
  clearDistantWaterPolygonCache(lat, lng);
}

/**
 * Main game loop
 */
function gameLoop(time: number): void {
  if (!isRunning) return;

  // Update FPS counter (development only)
  updateFpsCounter(time);

  // Calculate delta time
  const deltaTime = lastTime ? (time - lastTime) / 1000 : 0.016;
  lastTime = time;

  // Cap delta time to avoid physics issues
  const cappedDelta = Math.min(deltaTime, 0.1);

  // Update touch/button input each frame
  // Always update throttle button state (works on desktop too)
  // Joystick state will be 0 on desktop (no joystick created)
  setMobileInput(getJoystickState(), getThrottleState());

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

  // Update interpolation for remote players
  updateInterpolation(cappedDelta);

  // Update remote player meshes with interpolated positions
  for (const [id] of players) {
    if (id !== localId) {
      const interpolated = getInterpolatedState(id);
      if (interpolated) {
        updatePlaneMesh(interpolated, id, interpolated.color);
      }
    }
  }

  // Update local plane mesh
  if (localId) {
    updatePlaneMesh(planeState, localId, localColor);
    players.set(localId, planeState);
    updatePlayerList(players, localId);
  }

  // Update HUD
  updateHUD(planeState);

  // Update minimap
  updateMinimap(planeState);

  // Update URL hash with current tile location
  updateLocationHash(planeState.lng, planeState.lat);

  // Send position to server
  if (connection) {
    connection.sendPosition(planeState);
  }

  // Update tiles based on plane position, heading, and speed (predictive loading)
  updateTiles(planeState.lng, planeState.lat, planeState.heading, planeState.speed);

  // Update sky system (clouds, atmospheric effects)
  updateSkySystem(cappedDelta);

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
        // Initialize interpolation for existing player
        setPlayerTarget(id, plane);
        updatePlaneMesh(plane, id, plane.color);
      }
    }
  }
}

/**
 * Handle sync message from server
 */
function handleSync(planes: Record<string, PlaneState>): void {
  // Update players map and set interpolation targets
  for (const [id, plane] of Object.entries(planes)) {
    if (id !== localId) {
      players.set(id, plane);
      // Set target for interpolation instead of directly updating mesh
      setPlayerTarget(id, plane);
    }
  }
}

/**
 * Handle player joined message
 */
function handlePlayerJoined(player: PlaneState): void {
  console.log('Player joined:', player.id);
  players.set(player.id, player);
  // Initialize interpolation for new player
  setPlayerTarget(player.id, player);
  updatePlaneMesh(player, player.id, player.color);
}

/**
 * Handle player left message
 */
function handlePlayerLeft(id: string): void {
  console.log('Player left:', id);
  players.delete(id);
  removeInterpolatedPlayer(id);
  removePlaneMesh(id);
  updatePlayerList(players, localId);
}

/**
 * Handle teleport action
 */
async function handleTeleport(lat: number, lng: number): Promise<void> {
  // Reset location tracking so URL updates after teleport
  lastLocationHash = null;
  lastHashUpdateTime = 0;

  // Update origin for new location
  setOrigin(lng, lat);

  // Clear existing tiles
  for (const [key, meshes] of tileMeshes) {
    if (meshes.base) removeBaseLayerGroup(meshes.base);
    if (meshes.buildings) removeBuildingsGroup(meshes.buildings);
    if (meshes.transportation) removeTransportationGroup(meshes.transportation);
    if (meshes.trees) removeTreesGroup(meshes.trees);
    if (meshes.ground) removeGroundGroup(meshes.ground);
    removeTile(key);
  }
  tileMeshes.clear();

  // Clear ground texture tiles and cache
  clearAllGroundTiles();

  // Clear stored features for click picking
  clearAllFeatures();

  // Preload elevation tiles for the new location
  if (ELEVATION.TERRAIN_ENABLED) {
    try {
      await preloadElevationTiles(lng, lat, 2);
    } catch (error) {
      console.warn('Failed to preload elevation tiles:', error);
    }
  }

  // Teleport plane
  teleportPlane(lat, lng);

  // Ensure minimum clearance above terrain
  if (ELEVATION.TERRAIN_ENABLED) {
    const terrainHeight = await getTerrainHeightAsync(lng, lat);
    const minAltitude = terrainHeight + PLANE_RENDER.MIN_TERRAIN_CLEARANCE;
    if (FLIGHT.SPAWN_ALTITUDE < minAltitude) {
      console.log(`Adjusting spawn altitude from ${FLIGHT.SPAWN_ALTITUDE}m to ${minAltitude.toFixed(1)}m (terrain: ${terrainHeight.toFixed(1)}m)`);
      setPlaneAltitude(minAltitude);
    }
  }

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
  try {
    // Check for location in URL hash
    const urlLocation = parseLocationFromHash();
    const startLocation = urlLocation || DEFAULT_LOCATION;

    // Set initial origin from URL or default
    setOrigin(startLocation.lng, startLocation.lat);

    // Initialize Three.js scene
    await initScene();

    // Initialize FPS counter (development only)
    initFpsCounter();

    // Initialize tile manager (PMTiles sources)
    const tileStatus = await initTileManager();

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
      await preloadElevationTiles(startLocation.lng, startLocation.lat, 2);
    }

    // Teleport plane to start location if from URL
    if (urlLocation) {
      teleportPlane(urlLocation.lat, urlLocation.lng);
    }

    // Initialize controls (keyboard)
    initControls();
    initCameraControls();

    // Initialize mobile controls (touch joystick)
    initMobileControls();

    // Initialize minimap
    initMinimap(handleTeleport);

    // Set up teleport-to-player callback for the player list UI
    setTeleportToPlayerCallback(handleTeleport);

    // Initialize feature picker and modal (click on features to see properties)
    initFeatureModal();
    initFeaturePicker((features, worldPos) => {
      showFeatureModal(features, worldPos);
    });

    // Generate local ID and color immediately so plane renders without network
    localId = generateLocalId();
    localColor = PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
    setPlaneIdentity(localId, localColor);

    // Connect to multiplayer server
    connection = createConnection('global', {
      onWelcome: handleWelcome,
      onSync: handleSync,
      onPlayerJoined: handlePlayerJoined,
      onPlayerLeft: handlePlayerLeft,
    });

    // Start game loop
    isRunning = true;
    requestAnimationFrame(gameLoop);

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
