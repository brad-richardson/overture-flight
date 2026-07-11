import { initScene, render, updatePlaneMesh, removePlaneMesh, setOrigin, updateSkySystem, getRenderer } from './scene.js';
import {
  initControls,
  updatePlane,
  getPlaneState,
  setPlaneIdentity,
  teleportPlane,
  setMobileInput,
  setPlaneAltitude,
  resetPlaneWithTerrainAwareness,
  isAutopilotActive,
  applyAutopilot,
  CRASH_RECOVERY,
  PlaneState
} from './plane.js';
import { initCameraControls, followPlane } from './camera.js';
import { createConnection, Connection, WelcomeMessage } from './network.js';
import {
  checkCollisionDetailed,
  clearBuildingColliders,
  getGroundHeight,
  resetCollisionSweep,
  suppressBuildingCollisionsUntilClear,
} from './collision.js';
import { updateHUD, updatePlayerList, showCrashMessage, setTeleportToPlayerCallback, updateAutopilotIndicator } from './ui.js';
import { initMinimap, updateMinimap } from './minimap.js';
import { initTileManager, getTilesToLoad, getTilesToUnload, clearDistantWaterPolygonCache } from './tile-manager.js';
import { createBuildingsForTile, invalidateBuildingLoads, removeBuildingsGroup } from './buildings.js';
import { createBaseLayerForTile, removeBaseLayerGroup } from './base-layer.js';
import { createTransportationForTile, removeTransportationGroup } from './transportation-layer.js';
import {
  createGroundForTile,
  removeGroundGroup,
  clearAllGroundTiles,
  queueExpandedTile,
  getExpandedTilesToLoad,
  getExpandedTilesToUnload,
  pruneExpandedQueue,
  removeExpandedTile,
  clearAllExpandedTiles,
} from './ground-texture/index.js';
import { createTreesForTile, removeTreesGroup } from './tree-layer.js';
import { preloadElevationTiles, unloadDistantElevationTiles, getTerrainHeightAsync } from './elevation.js';
import { DEFAULT_LOCATION, ELEVATION, PLAYER_COLORS, PLANE_RENDER, FLIGHT, GROUND_TEXTURE, EXPANDED_TERRAIN } from './constants.js';
import { initializeOvertureSources } from './overture-sources.js';
import { getLoadingGate } from './loading-gate.js';
import { initMobileControls, getJoystickState, getThrottleState } from './mobile-controls.js';
import { initFeaturePicker, clearAllFeatures, unregisterTileForLazyPicking } from './feature-picker.js';
import { initFeatureModal, showFeatureModal } from './feature-modal.js';
import { setPlayerTarget, updateInterpolation, getInterpolatedState, removeInterpolatedPlayer } from './interpolation.js';
import * as THREE from 'three';
import { cancelWorkerTasksForWorldChange } from './workers/index.js';
import { TileLifecycleCoordinator } from './tile-lifecycle-coordinator.js';

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

// UI update throttling - DOM updates don't need to happen every frame
let lastHudUpdateTime = 0;
let lastPlayerListUpdateTime = 0;
let lastMinimapUpdateTime = 0;
const HUD_UPDATE_INTERVAL = 100; // 10 Hz - humans can't perceive faster HUD changes
const PLAYER_LIST_UPDATE_INTERVAL = 100; // 10 Hz - player list doesn't change that fast
const MINIMAP_UPDATE_INTERVAL = 50; // 20 Hz - minimap needs slightly smoother updates
const TILE_UPDATE_INTERVAL = 200; // Tile decisions only need to run at 5 Hz
const TILE_CLEANUP_INTERVAL = 1000;
let lastTileUpdateTime = 0;
let lastTileCleanupTime = 0;

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

// Crash recovery state
let isCrashRecovering = false;
let crashRecoveryStartTime = 0;
let crashRecoveryMinimumAltitude = FLIGHT.MIN_ALTITUDE;

// Autopilot indicator state (track previous state to avoid unnecessary DOM updates)
let wasAutopilotActive = false;

// FPS tracking (always active for performance gating, display only in dev)
let fpsElement: HTMLDivElement | null = null;
let frameCount = 0;
let fpsLastTime = 0;
let currentFps = 60; // Start optimistic, will converge quickly

// FPS thresholds for performance gating
const EXPANDED_TERRAIN_MIN_FPS = 30;  // Don't load expanded terrain below this
const CRITICAL_FPS_THRESHOLD = 15;    // Throttle core tile loading below this

// Dynamic resolution scaling thresholds
const RESOLUTION_REDUCE_FPS = 25;     // Reduce pixel ratio below this FPS
const RESOLUTION_RESTORE_FPS = 40;    // Restore pixel ratio above this FPS
const REDUCED_PIXEL_RATIO = 1.0;      // Target when reducing (1.0 = native resolution)
let basePixelRatio = Math.min(window.devicePixelRatio, 1.5);
let currentPixelRatio = basePixelRatio;
let resolutionScalingActive = false;

// Update base pixel ratio when device pixel ratio changes (monitor switch, zoom)
window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => {
  basePixelRatio = Math.min(window.devicePixelRatio, 1.5);
  // If not in reduced mode, update current ratio to match new base
  if (!resolutionScalingActive) {
    currentPixelRatio = basePixelRatio;
    const renderer = getRenderer();
    if (renderer) {
      renderer.setPixelRatio(currentPixelRatio);
    }
  }
});

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

function updateFpsTracking(time: number): void {
  // Initialize on first call to avoid incorrect FPS calculation
  // Without this, elapsed would be huge (time since page load) causing very low FPS
  if (fpsLastTime === 0) {
    fpsLastTime = time;
    return;
  }

  frameCount++;
  const elapsed = time - fpsLastTime;

  if (elapsed >= 1000) {
    currentFps = Math.round((frameCount * 1000) / elapsed);
    if (fpsElement) {
      fpsElement.textContent = `${currentFps} FPS${resolutionScalingActive ? ' (reduced res)' : ''}`;
    }
    frameCount = 0;
    fpsLastTime = time;

    // Update dynamic resolution scaling
    updateDynamicResolution();
  }
}

/**
 * Adjust pixel ratio based on FPS to maintain smooth frame rate
 */
function updateDynamicResolution(): void {
  const renderer = getRenderer();
  if (!renderer) return;

  // Only reduce if FPS is valid (> 0 prevents reducing before first FPS calculation)
  const shouldReduce = currentFps < RESOLUTION_REDUCE_FPS && currentFps > 0;
  // Restore whenever FPS is high enough (no > 0 check needed since high FPS implies valid measurement)
  const shouldRestore = currentFps >= RESOLUTION_RESTORE_FPS;

  if (shouldReduce && !resolutionScalingActive) {
    // Reduce resolution to help GPU
    currentPixelRatio = REDUCED_PIXEL_RATIO;
    renderer.setPixelRatio(currentPixelRatio);
    resolutionScalingActive = true;
  } else if (shouldRestore && resolutionScalingActive) {
    // Restore resolution when FPS is healthy
    currentPixelRatio = basePixelRatio;
    renderer.setPixelRatio(currentPixelRatio);
    resolutionScalingActive = false;
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

// The lifecycle coordinator keeps generation validity, exact request ownership,
// and outstanding work separate so stale cleanup cannot release a newer load.
const tileLifecycle = new TileLifecycleCoordinator<string>();
let teleportInFlightGeneration: number | null = null;
const TELEPORT_ELEVATION_TIMEOUT_MS = 5_000;

type TimedResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'timeout' };

async function settleWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<TimedResult<T>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const settled: Promise<TimedResult<T>> = promise.then(
    value => ({ status: 'fulfilled' as const, value }),
    reason => ({ status: 'rejected' as const, reason })
  );
  const timeout = new Promise<TimedResult<T>>(resolve => {
    timeoutId = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
  });

  const result = await Promise.race([settled, timeout]);
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
  }
  return result;
}

function disposeTileMeshes(meshes: TileMeshes): void {
  if (meshes.ground) removeGroundGroup(meshes.ground);
  if (meshes.base) removeBaseLayerGroup(meshes.base);
  if (meshes.transportation) removeTransportationGroup(meshes.transportation);
  if (meshes.buildings) removeBuildingsGroup(meshes.buildings);
  if (meshes.trees) removeTreesGroup(meshes.trees);
}

async function guardSceneGroup(
  task: Promise<THREE.Group | null>,
  isStillCurrent: () => boolean,
  dispose: (group: THREE.Group) => void
): Promise<THREE.Group | null> {
  const group = await task;
  if (group && !isStillCurrent()) {
    // Layer factories attach their group before resolving. This continuation runs
    // in the same microtask chain, removing stale work before the next render.
    dispose(group);
    return null;
  }
  return group;
}

/**
 * Load every required layer for a core tile as one bundle. Layer factories add
 * their groups to the scene before resolving, so wait for every task to settle
 * and dispose successful siblings if any required layer rejects.
 */
async function loadCoreTileBundle(
  x: number,
  y: number,
  z: number,
  isStillCurrent: () => boolean
): Promise<TileMeshes> {
  const tasks: Promise<THREE.Group | null>[] = GROUND_TEXTURE.ENABLED
    ? [
        guardSceneGroup(createGroundForTile(x, y, z), isStillCurrent, removeGroundGroup),
        guardSceneGroup(createBuildingsForTile(x, y, z), isStillCurrent, removeBuildingsGroup),
      ]
    : [
        guardSceneGroup(createBaseLayerForTile(x, y, z), isStillCurrent, removeBaseLayerGroup),
        guardSceneGroup(createBuildingsForTile(x, y, z), isStillCurrent, removeBuildingsGroup),
        guardSceneGroup(
          createTransportationForTile(x, y, z),
          isStillCurrent,
          removeTransportationGroup
        ),
      ];

  const results = await Promise.allSettled(tasks);
  const groups = results.map(result => result.status === 'fulfilled' ? result.value : null);

  const meshes: TileMeshes = GROUND_TEXTURE.ENABLED
    ? {
        ground: groups[0],
        base: null,
        transportation: null,
        buildings: groups[1],
        trees: null,
      }
    : {
        ground: null,
        base: groups[0],
        buildings: groups[1],
        transportation: groups[2],
        trees: null,
      };

  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failure) {
    disposeTileMeshes(meshes);
    throw failure.reason;
  }

  return meshes;
}

/**
 * Load tiles around the current position with predictive loading
 */
async function updateTiles(
  lng: number,
  lat: number,
  heading: number = 0,
  speed: number = 0
): Promise<void> {
  // setOrigin changes before the plane position does. Pause the entire tile
  // coordinator so that old plane coordinates cannot seed the new generation.
  if (teleportInFlightGeneration !== null) {
    return;
  }

  const tilesToLoad = getTilesToLoad(lng, lat, heading, speed);

  // Throttle core tile loading when FPS is critically low
  // This helps prevent a "death spiral" where loading causes more FPS drop
  const shouldThrottleCoreTiles = currentFps < CRITICAL_FPS_THRESHOLD && currentFps > 0;

  // Load new tiles
  for (const tile of tilesToLoad) {
    // Skip if already loaded or currently loading
    if (tileMeshes.has(tile.key) || tileLifecycle.hasClaim(tile.key)) {
      continue;
    }

    // When FPS is critical, skip loading new tiles to let system recover
    // Existing tiles remain visible, and loading resumes when FPS recovers
    if (shouldThrottleCoreTiles) {
      continue;
    }

    const loadToken = tileLifecycle.claim(tile.key);
    if (!loadToken) {
      continue;
    }

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

    // Terrain/base, buildings, and roads (legacy mode) form the required core
    // bundle. Trees remain optional and load after the core tile is registered.
    void loadCoreTileBundle(
      tile.x,
      tile.y,
      tile.z,
      () => tileLifecycle.isCurrent(loadToken)
    ).then(meshes => {
      if (!tileLifecycle.isCurrent(loadToken)) {
        // A teleport changed the scene origin while this work was in flight.
        // Layer factories already attached these groups, so fully remove them.
        disposeTileMeshes(meshes);
        return;
      }

      tileMeshes.set(tile.key, meshes);
      getLoadingGate().onTileLoaded();

      // Capture this specific tile instance and its generation. A late tree job
      // must satisfy both checks before it can become active.
      const meshesRef = meshes;
      void safeCreateTrees().then(treesGroup => {
        if (
          loadToken.generation === tileLifecycle.generation &&
          tileMeshes.get(tile.key) === meshesRef &&
          treesGroup
        ) {
          meshesRef.trees = treesGroup;
        } else if (treesGroup) {
          removeTreesGroup(treesGroup);
        }
      });
    }).catch(e => {
      // Only the owner may clean key-scoped registrations. This remains true for
      // a superseded generation until its finally block releases the slot.
      if (tileLifecycle.owns(loadToken)) {
        unregisterTileForLazyPicking(`ground-${tile.key}`);
      }
      if (loadToken.generation === tileLifecycle.generation) {
        console.warn(`Failed to load tile ${tile.key}:`, e);
      }
    }).finally(() => {
      // Never allow an older completion to clear a newer load for the same key.
      tileLifecycle.release(loadToken);
    });
  }

  const cleanupNow = performance.now();
  if (cleanupNow - lastTileCleanupTime >= TILE_CLEANUP_INTERVAL) {
    lastTileCleanupTime = cleanupNow;

    // Keep a 5x5 retention window around the plane; textures outside it are
    // disposed before they can accumulate into a large GPU working set.
    const tilesToUnload = getTilesToUnload(lng, lat, tileMeshes.keys(), 2);
    for (const key of tilesToUnload) {
      const meshes = tileMeshes.get(key);
      if (meshes) {
        disposeTileMeshes(meshes);
        tileMeshes.delete(key);
      }
    }

    if (ELEVATION.TERRAIN_ENABLED) {
      unloadDistantElevationTiles(lng, lat, 5);
    }

    clearDistantWaterPolygonCache(lat, lng);
  }

  // === Expanded terrain loading (Z14 outer ring, no buildings) ===
  // Loads terrain + roads for a larger area to avoid "edge of world"
  // Only load when FPS is above threshold to avoid adding load when struggling
  if (EXPANDED_TERRAIN.ENABLED && GROUND_TEXTURE.ENABLED && currentFps >= EXPANDED_TERRAIN_MIN_FPS) {
    // Build set of core tile keys (tiles that get full processing with buildings)
    const coreTileKeys = new Set(tilesToLoad.map(t => t.key));

    // Get expanded tiles (outer ring excluding core)
    const expandedTilesToLoad = getExpandedTilesToLoad(lng, lat, coreTileKeys);

    // Queue expanded tiles for background loading (1 at a time, lowest priority)
    for (const tile of expandedTilesToLoad) {
      queueExpandedTile(tile);
    }

    // Unload distant expanded tiles
    const expandedTilesToUnload = getExpandedTilesToUnload(lng, lat);
    for (const key of expandedTilesToUnload) {
      removeExpandedTile(key);
    }

    // Prune queue of out-of-range tiles to avoid unnecessary work
    pruneExpandedQueue(lng, lat);
  }
}

/**
 * Main game loop
 */
function gameLoop(time: number): void {
  if (!isRunning) return;

  // Update FPS tracking (used for performance gating)
  updateFpsTracking(time);

  // Calculate delta time
  const deltaTime = lastTime ? (time - lastTime) / 1000 : 0.016;
  lastTime = time;

  // Cap delta time to avoid physics issues
  const cappedDelta = Math.min(deltaTime, 0.1);

  // Handle crash recovery pause
  if (isCrashRecovering) {
    const elapsedSinceCrash = time - crashRecoveryStartTime;

    if (elapsedSinceCrash >= CRASH_RECOVERY.PAUSE_DURATION) {
      // Recovery period complete - get fresh terrain height at current position
      // (plane may have moved during crash, so recalculate instead of using cached value)
      const planeState = getPlaneState();
      const currentTerrainHeight = getGroundHeight(planeState.lng, planeState.lat);
      resetPlaneWithTerrainAwareness(currentTerrainHeight, crashRecoveryMinimumAltitude);
      crashRecoveryMinimumAltitude = FLIGHT.MIN_ALTITUDE;
      resetCollisionSweep();
      isCrashRecovering = false;
    } else {
      // Still in recovery pause - only update camera and render, skip physics
      const planeState = getPlaneState();
      followPlane(planeState);

      // Keep updating remote players and rendering during pause
      updateInterpolation(cappedDelta);
      for (const [id] of players) {
        if (id !== localId) {
          const interpolated = getInterpolatedState(id);
          if (interpolated) {
            updatePlaneMesh(interpolated, id, interpolated.color, cappedDelta);
          }
        }
      }

      updateSkySystem(cappedDelta);
      render();
      requestAnimationFrame(gameLoop);
      return;
    }
  }

  // Update touch/button input each frame
  // Always update throttle button state (works on desktop too)
  // Joystick state will be 0 on desktop (no joystick created)
  setMobileInput(getJoystickState(), getThrottleState());

  // Update plane physics
  updatePlane(cappedDelta);

  // Get current state
  const planeState = getPlaneState();

  // Get current terrain height for collision and autopilot
  const terrainHeight = getGroundHeight(planeState.lng, planeState.lat);

  // Check for collisions
  const collision = checkCollisionDetailed(planeState);
  if (collision.collided) {
    if (collision.type === 'building') {
      crashRecoveryMinimumAltitude = (collision.height ?? planeState.altitude) + 30;
      suppressBuildingCollisionsUntilClear();
    } else {
      crashRecoveryMinimumAltitude = FLIGHT.MIN_ALTITUDE;
    }
    showCrashMessage();
    // Start crash recovery pause instead of immediately resetting
    isCrashRecovering = true;
    crashRecoveryStartTime = time;
    // Continue to next frame - recovery will be handled above
    requestAnimationFrame(gameLoop);
    return;
  }

  // Apply autopilot if no input for threshold duration
  const autopilotActive = isAutopilotActive();
  if (autopilotActive) {
    applyAutopilot(cappedDelta, terrainHeight);
  }
  // Only update DOM when autopilot state changes to reduce unnecessary updates
  if (autopilotActive !== wasAutopilotActive) {
    updateAutopilotIndicator(autopilotActive);
    wasAutopilotActive = autopilotActive;
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
        updatePlaneMesh(interpolated, id, interpolated.color, cappedDelta);
      }
    }
  }

  // Update local plane mesh
  if (localId) {
    updatePlaneMesh(planeState, localId, localColor, cappedDelta);
    players.set(localId, planeState);

    // Throttle player list updates (DOM rebuild is expensive)
    if (time - lastPlayerListUpdateTime >= PLAYER_LIST_UPDATE_INTERVAL) {
      lastPlayerListUpdateTime = time;
      updatePlayerList(players, localId);
    }
  }

  // Throttle HUD updates (humans can't perceive 60Hz text changes)
  if (time - lastHudUpdateTime >= HUD_UPDATE_INTERVAL) {
    lastHudUpdateTime = time;
    updateHUD(planeState);
  }

  // Throttle minimap updates
  if (time - lastMinimapUpdateTime >= MINIMAP_UPDATE_INTERVAL) {
    lastMinimapUpdateTime = time;
    updateMinimap(planeState);
  }

  // Update URL hash with current tile location
  updateLocationHash(planeState.lng, planeState.lat);

  // Send position to server
  if (connection) {
    connection.sendPosition(planeState);
  }

  // Tile selection allocates and scans several caches, so coordinate it at 5 Hz.
  if (time - lastTileUpdateTime >= TILE_UPDATE_INTERVAL) {
    lastTileUpdateTime = time;
    void updateTiles(planeState.lng, planeState.lat, planeState.heading, planeState.speed);
  }

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
  isCrashRecovering = false;
  crashRecoveryMinimumAltitude = FLIGHT.MIN_ALTITUDE;
  // Reject stale worker promises immediately instead of letting old-world work
  // occupy every pool until completion or timeout.
  cancelWorkerTasksForWorldChange();
  // Invalidate worker results before any origin or world state changes.
  invalidateBuildingLoads();

  // A teleport starts a new local coordinate space and must not sweep-test the
  // long path from the plane's prior frame position.
  resetCollisionSweep();

  // Invalidate all scene work before changing the origin or removing active tiles.
  // In-flight jobs retain their slots until they settle, preventing the same key
  // from being started twice against different origins.
  const teleportGeneration = tileLifecycle.invalidate({ retainClaims: true });
  teleportInFlightGeneration = teleportGeneration;

  try {
    await completeTeleport(lat, lng, teleportGeneration);
  } finally {
    // An older overlapping teleport must not resume tile loading while the latest
    // teleport still owns the origin transition.
    if (teleportInFlightGeneration === teleportGeneration) {
      teleportInFlightGeneration = null;
    }
  }
}

async function completeTeleport(
  lat: number,
  lng: number,
  teleportGeneration: number
): Promise<void> {

  // Reset location tracking so URL updates after teleport
  lastLocationHash = null;
  lastHashUpdateTime = 0;

  // Update origin for new location
  setOrigin(lng, lat);

  // Clear existing tiles
  for (const meshes of tileMeshes.values()) {
    disposeTileMeshes(meshes);
  }
  tileMeshes.clear();
  // Defensive cleanup for colliders whose owning group failed to finish loading.
  clearBuildingColliders();

  // Clear ground texture tiles and cache
  clearAllGroundTiles();
  clearAllExpandedTiles();

  // Clear stored features for click picking
  clearAllFeatures();

  // Preload elevation tiles for the new location, but do not let a stalled
  // network request pause the tile coordinator indefinitely. A late preload is
  // still allowed to warm the cache; generation checks below own scene/plane mutation.
  if (ELEVATION.TERRAIN_ENABLED) {
    const preloadResult = await settleWithTimeout(
      preloadElevationTiles(lng, lat, 2),
      TELEPORT_ELEVATION_TIMEOUT_MS
    );
    if (preloadResult.status === 'rejected') {
      console.warn('Failed to preload elevation tiles:', preloadResult.reason);
    } else if (preloadResult.status === 'timeout') {
      console.warn(
        `Elevation preload exceeded ${TELEPORT_ELEVATION_TIMEOUT_MS}ms; continuing teleport`
      );
    }
  }

  // A newer teleport owns the origin now. Do not move the plane or publish the
  // superseded destination after this asynchronous preload completes.
  if (teleportGeneration !== tileLifecycle.generation) {
    return;
  }

  // Teleport plane
  teleportPlane(lat, lng);
  resetCollisionSweep();

  // Ensure minimum clearance above terrain
  if (ELEVATION.TERRAIN_ENABLED) {
    // The center-tile request is normally a cache hit after preload, but bound it
    // too so a timed-out preload cannot reintroduce an indefinite coordinator pause.
    const terrainResult = await settleWithTimeout(
      getTerrainHeightAsync(lng, lat),
      TELEPORT_ELEVATION_TIMEOUT_MS
    );
    if (teleportGeneration !== tileLifecycle.generation) {
      return;
    }
    if (terrainResult.status === 'fulfilled') {
      const terrainHeight = terrainResult.value;
      const minAltitude = terrainHeight + PLANE_RENDER.MIN_TERRAIN_CLEARANCE;
      if (FLIGHT.SPAWN_ALTITUDE < minAltitude) {
        console.log(`Adjusting spawn altitude from ${FLIGHT.SPAWN_ALTITUDE}m to ${minAltitude.toFixed(1)}m (terrain: ${terrainHeight.toFixed(1)}m)`);
        setPlaneAltitude(minAltitude);
        resetCollisionSweep();
      }
    } else if (terrainResult.status === 'rejected') {
      console.warn('Failed to resolve terrain height after teleport:', terrainResult.reason);
    } else {
      console.warn(
        `Terrain height lookup exceeded ${TELEPORT_ELEVATION_TIMEOUT_MS}ms; keeping spawn altitude`
      );
    }
  }

  if (teleportGeneration === tileLifecycle.generation && connection) {
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

    // Resolve the current Overture release before any tile consumer starts.
    await initializeOvertureSources();

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
      resetCollisionSweep();
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

    // Start loading gate indicator (non-blocking, just shows visual feedback)
    const loadingGate = getLoadingGate();
    loadingGate.start();

    // Start game loop immediately (allows rendering while tiles load)
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
