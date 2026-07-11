import * as THREE from 'three';
import type { GroundTileData } from './types.js';
import { TileTextureCache } from './tile-texture-cache.js';
import { TerrainQuad } from './terrain-quad.js';
import { tileToBounds, lngLatToTile } from '../tile-manager.js';
import { getElevationDataForTile } from '../elevation.js';
import { getScene, getRendererType } from '../scene.js';
import { EXPANDED_TERRAIN, ELEVATION, GROUND_TEXTURE } from '../constants.js';
import { getOvertureSources } from '../overture-sources.js';
import { getTileSemaphore, TilePriority } from '../semaphore.js';
import { getFullPipelineWorkerPool } from '../workers/index.js';
import { disposeTexture } from '../renderer/texture-disposal.js';
import {
  TileLifecycleCoordinator,
  type TileLifecycleToken,
} from '../tile-lifecycle-coordinator.js';
import { getWrappedTileRing, wrappedTileChebyshevDistance } from '../tile-coordinates.js';

// Tile info type
interface TileInfo {
  x: number;
  y: number;
  z: number;
  key: string;
}

// Active expanded ground tiles (terrain + roads, no buildings)
const activeExpandedTiles = new Map<string, GroundTileData>();

// Expanded loads have their own lifecycle because they run independently of the
// core tile coordinator. Request identity prevents old cleanup from deleting a
// newer same-key load after a bulk clear.
const expandedLifecycle = new TileLifecycleCoordinator<string>(
  EXPANDED_TERRAIN.MAX_CONCURRENT
);

// Track tiles that have been promoted to core (prevents race condition where
// in-flight async load completes after promotion and re-adds the expanded tile)
const promotedTiles = new Set<string>();

// Queue for expanded tiles waiting to be loaded (FIFO for fairness)
const expandedTileQueue: TileInfo[] = [];
const queuedExpandedTileKeys = new Set<string>();
let isProcessingQueue = false;

// Dedicated texture cache for expanded tiles (separate from core tiles)
// This ensures expanded tiles are evicted before core tiles
let expandedTextureCache: TileTextureCache | null = null;
// Dev mode intentionally bypasses the cache, so active tiles must retain
// explicit ownership of their worker textures for disposal on normal removal.
const uncachedExpandedTextures = new Map<string, THREE.Texture>();

/**
 * Get or initialize the expanded tile texture cache
 */
function getExpandedCache(): TileTextureCache {
  if (!expandedTextureCache) {
    // Create a separate cache instance for expanded tiles (not using singleton)
    // The deferDisposal config is no longer needed - the cache uses the global
    // texture-disposal utility which automatically handles WebGPU deferral
    expandedTextureCache = new TileTextureCache({
      maxSize: EXPANDED_TERRAIN.CACHE_MAX_SIZE,
      disposeThreshold: Math.floor(EXPANDED_TERRAIN.CACHE_MAX_SIZE * 0.8),
    });
  }
  return expandedTextureCache;
}

/**
 * Queue an expanded tile for background loading
 * Tiles are processed one at a time at lowest priority
 */
export function queueExpandedTile(tile: TileInfo): void {
  const key = tile.key;

  // Skip if already loaded, loading, queued, or promoted to core
  if (activeExpandedTiles.has(key) || expandedLifecycle.hasClaim(key) || promotedTiles.has(key)) {
    return;
  }

  if (queuedExpandedTileKeys.has(key)) {
    return;
  }

  expandedTileQueue.push(tile);
  queuedExpandedTileKeys.add(key);
  processExpandedQueue();
}

/**
 * Process the expanded tile queue continuously
 * Only processes MAX_CONCURRENT tiles at a time (default: 1)
 */
async function processExpandedQueue(): Promise<void> {
  if (isProcessingQueue) return;
  if (expandedTileQueue.length === 0) return;

  isProcessingQueue = true;

  while (expandedTileQueue.length > 0) {
    // Count every outstanding generation, including loads invalidated by a
    // teleport, so repeated clears cannot exceed the configured work budget.
    if (!expandedLifecycle.hasCapacity) {
      // Wait a bit before checking again
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }

    const tile = expandedTileQueue.shift();
    if (!tile) break;
    queuedExpandedTileKeys.delete(tile.key);

    // Skip if it got loaded while waiting, or was promoted to core
    // (avoids unnecessary async work if tile became a core tile between dequeue and processing)
    if (activeExpandedTiles.has(tile.key) || promotedTiles.has(tile.key)) continue;

    // Start loading (don't await - let it run in background)
    createExpandedGroundForTile(tile.x, tile.y, tile.z)
      .catch(e => console.warn(`[ExpandedGround] Failed to load tile ${tile.key}:`, e));
  }

  isProcessingQueue = false;
}

/**
 * Create an expanded ground tile (terrain + roads, NO buildings)
 * Uses Z14 zoom level but at lowest priority
 */
export async function createExpandedGroundForTile(
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<THREE.Group | null> {
  const scene = getScene();
  if (!scene) {
    return null;
  }

  const key = `expanded-${tileZ}/${tileX}/${tileY}`;

  // Check if already loaded
  if (activeExpandedTiles.has(key)) {
    return activeExpandedTiles.get(key)!.group;
  }

  // Check if currently loading (prevent race condition)
  if (expandedLifecycle.hasClaim(key)) {
    return null;
  }

  // Mark as loading with per-request identity.
  const loadToken = expandedLifecycle.claim(key);
  if (!loadToken) {
    return null;
  }

  // Use semaphore to limit concurrent tile processing
  // EXPANDED_TERRAIN has lowest priority (after buildings)
  const semaphore = getTileSemaphore();
  try {
    if (semaphore) {
      return await semaphore.run(
        () => createExpandedGroundForTileInner(tileX, tileY, tileZ, key, loadToken),
        TilePriority.EXPANDED_TERRAIN
      );
    }
    return await createExpandedGroundForTileInner(tileX, tileY, tileZ, key, loadToken);
  } finally {
    expandedLifecycle.release(loadToken);
  }
}

/**
 * Inner implementation of expanded tile creation (runs with semaphore permit)
 */
async function createExpandedGroundForTileInner(
  tileX: number,
  tileY: number,
  tileZ: number,
  key: string,
  loadToken: TileLifecycleToken<string>
): Promise<THREE.Group | null> {
  const scene = getScene();
  if (!scene) {
    return null;
  }

  const bounds = tileToBounds(tileX, tileY, tileZ);
  const cache = getExpandedCache();

  // Skip cache in dev mode to catch rendering issues
  const useCache = !import.meta.env.DEV;
  let texture = useCache ? cache.get(key) : null;

  if (!texture) {
    // Full pipeline: fetch, parse, render all in worker (same as core tiles)
    const fullPipelinePool = getFullPipelineWorkerPool();
    const overtureSources = getOvertureSources();
    const result = await fullPipelinePool.renderTile(
      tileX,
      tileY,
      tileZ,
      EXPANDED_TERRAIN.TEXTURE_SIZE,
      overtureSources.base,
      overtureSources.transportation,
      false, // includeNeighbors - not needed for expanded tiles
      true   // includeTransportation
    );
    const { bitmap } = result;

    // A clear may have invalidated this request while the worker rendered. Do
    // not repopulate the cache or create scene resources for the old generation.
    if (!expandedLifecycle.isCurrent(loadToken) || promotedTiles.has(key)) {
      bitmap.close();
      return null;
    }

    // Create texture from ImageBitmap
    const workerTexture = new THREE.Texture(bitmap);
    workerTexture.flipY = false;
    workerTexture.minFilter = THREE.LinearMipmapLinearFilter;
    workerTexture.magFilter = THREE.LinearFilter;
    workerTexture.generateMipmaps = true;
    workerTexture.colorSpace = THREE.SRGBColorSpace;
    workerTexture.needsUpdate = true;

    texture = workerTexture as unknown as THREE.CanvasTexture;

    if (useCache) {
      cache.set(key, texture, bounds);
    }
  }

  // Create terrain-following quad (use same segments as core tiles for consistency)
  const quad = new TerrainQuad(bounds, GROUND_TEXTURE.TERRAIN_QUAD_SEGMENTS);
  let hasUncachedWorkerTexture = !useCache && texture !== null;
  let quadTransferredToActiveTile = false;

  try {
    // Apply terrain elevation
    if (ELEVATION.TERRAIN_ENABLED) {
      // GPU path: use vertex shader displacement
      // Use integer tile math for deterministic elevation tile selection
      // Ground tile is Z14, elevation is Z12, so shift by 2 bits (14 - 12 = 2)
      const zoomDiff = tileZ - ELEVATION.ZOOM;
      const elevTileX = tileX >> zoomDiff;
      const elevTileY = tileY >> zoomDiff;

      const elevationData = await getElevationDataForTile(elevTileX, elevTileY);
      if (elevationData) {
        // Use WebGPU or WebGL displacement path based on renderer type
        const rendererType = getRendererType();
        if (rendererType === 'webgpu') {
          await quad.applyGPUDisplacementWebGPU(
            elevationData.heights,
            ELEVATION.TILE_SIZE,
            elevationData.bounds,
            ELEVATION.VERTICAL_EXAGGERATION
          );
        } else {
          quad.applyGPUDisplacement(
            elevationData.heights,
            ELEVATION.TILE_SIZE,
            elevationData.bounds,
            ELEVATION.VERTICAL_EXAGGERATION
          );
        }
      }
    }

    // This is the final async boundary before active-map and scene mutation.
    if (!expandedLifecycle.isCurrent(loadToken) || promotedTiles.has(key)) {
      return null;
    }

    // Apply ground texture
    quad.setTexture(texture);

    // Mark texture as in-use so it won't be evicted while bound to this tile
    cache.markInUse(key);

    const mesh = quad.getMesh();

    // Create group
    const group = new THREE.Group();
    group.name = key;
    group.add(mesh);

    // Store in active tiles
    activeExpandedTiles.set(key, {
      group,
      quad,
      x: tileX,
      y: tileY,
      z: tileZ,
      key,
    });
    quadTransferredToActiveTile = true;
    if (hasUncachedWorkerTexture) {
      uncachedExpandedTextures.set(key, texture);
      hasUncachedWorkerTexture = false;
    }

    // Add to scene
    scene.add(group);

    return group;
  } finally {
    if (!quadTransferredToActiveTile) {
      quad.dispose({ disposeColorTexture: false });
    }
    if (hasUncachedWorkerTexture) {
      // Development bypasses the texture cache, so a failed/stale load still
      // owns and must release its worker-produced albedo.
      disposeTexture(texture);
    }
  }
}

/**
 * Remove an expanded ground tile (called during promotion to core or unloading)
 */
export function removeExpandedTile(key: string): void {
  const tileData = activeExpandedTiles.get(key);
  if (!tileData) return;

  const scene = getScene();

  // Unmark texture as in-use so it can be evicted if needed
  const cache = getExpandedCache();
  cache.unmarkInUse(key);
  const uncachedTexture = uncachedExpandedTextures.get(key);
  if (uncachedTexture) {
    disposeTexture(uncachedTexture);
    uncachedExpandedTextures.delete(key);
  }

  // Dispose geometry/material/elevation. Cached textures stay cache-owned;
  // uncached textures were disposed explicitly above.
  tileData.quad.dispose({ disposeColorTexture: false });

  activeExpandedTiles.delete(key);

  if (scene) {
    scene.remove(tileData.group);
  }
}

/**
 * Remove an expanded ground tile group from scene
 */
export function removeExpandedGroundGroup(group: THREE.Group): void {
  removeExpandedTile(group.name);
}

/**
 * Promote an expanded tile to core (remove expanded when core loads at same position)
 * Called from ground-layer.ts when a core tile is created
 */
export function promoteExpandedToCore(tileX: number, tileY: number, tileZ: number): void {
  const expandedKey = `expanded-${tileZ}/${tileX}/${tileY}`;

  // Mark as promoted to prevent in-flight async loads from re-adding
  promotedTiles.add(expandedKey);

  // Remove expanded tile if it exists
  if (activeExpandedTiles.has(expandedKey)) {
    removeExpandedTile(expandedKey);
  }

  // Also remove from queue if pending
  const queueIndex = expandedTileQueue.findIndex(t => t.key === expandedKey);
  if (queueIndex >= 0) {
    expandedTileQueue.splice(queueIndex, 1);
    queuedExpandedTileKeys.delete(expandedKey);
  }

  // In-flight work retains its loading token and will reject itself at the next
  // async boundary. Removing the slot here could allow a same-key replacement
  // whose state is later cleared by the older request.
}

/**
 * Demote a core tile (clear promoted status when core tile is unloaded)
 * Called from ground-layer.ts when a core tile is removed
 * This allows the position to become an expanded tile again if player moves away
 */
export function demoteFromCore(tileX: number, tileY: number, tileZ: number): void {
  const expandedKey = `expanded-${tileZ}/${tileX}/${tileY}`;
  promotedTiles.delete(expandedKey);
}

/**
 * Get list of expanded tiles to load based on player position
 * Returns the outer ring (out to EXPANDED_TERRAIN.TILE_RADIUS) excluding the
 * core area (EXPANDED_TERRAIN.CORE_RADIUS)
 */
export function getExpandedTilesToLoad(lng: number, lat: number, coreTileKeys: Set<string>): TileInfo[] {
  const z = 14; // Always Z14 (same as core tiles)
  const [centerX, centerY] = lngLatToTile(lng, lat, z);
  const tiles: TileInfo[] = [];

  const expandedRadius = EXPANDED_TERRAIN.TILE_RADIUS;
  const coreRadius = EXPANDED_TERRAIN.CORE_RADIUS;

  for (const { x, y } of getWrappedTileRing(
    centerX,
    centerY,
    z,
    expandedRadius,
    coreRadius
  )) {
    // Also skip if already a core tile (in case core area is larger)
    const coreKey = `${z}/${x}/${y}`;
    if (coreTileKeys.has(coreKey)) continue;

    const expandedKey = `expanded-${z}/${x}/${y}`;
    tiles.push({ x, y, z, key: expandedKey });
  }

  return tiles;
}

/**
 * Get list of expanded tiles that should be unloaded
 * Uses Chebyshev distance (max of |dx| or |dy|)
 */
export function getExpandedTilesToUnload(lng: number, lat: number): string[] {
  const z = 14;
  const [centerX, centerY] = lngLatToTile(lng, lat, z);
  const maxDistance = EXPANDED_TERRAIN.UNLOAD_DISTANCE;
  const tilesToUnload: string[] = [];

  for (const [key, tileData] of activeExpandedTiles) {
    const chebyshevDist = wrappedTileChebyshevDistance(
      tileData,
      { x: centerX, y: centerY },
      z
    );

    if (chebyshevDist > maxDistance) {
      tilesToUnload.push(key);
    }
  }

  return tilesToUnload;
}

/**
 * Prune the expanded tile queue of out-of-range tiles
 * Called periodically to avoid loading tiles that are no longer needed
 */
export function pruneExpandedQueue(lng: number, lat: number): number {
  const z = 14;
  const [centerX, centerY] = lngLatToTile(lng, lat, z);
  const maxDistance = EXPANDED_TERRAIN.UNLOAD_DISTANCE;

  // Filter out tiles that are now out of range
  const originalLength = expandedTileQueue.length;
  for (let i = expandedTileQueue.length - 1; i >= 0; i--) {
    const tile = expandedTileQueue[i];
    const chebyshevDist = wrappedTileChebyshevDistance(
      tile,
      { x: centerX, y: centerY },
      z
    );

    if (chebyshevDist > maxDistance) {
      expandedTileQueue.splice(i, 1);
      queuedExpandedTileKeys.delete(tile.key);
    }
  }

  return originalLength - expandedTileQueue.length;
}

/**
 * Check if an expanded tile exists for given coordinates
 */
export function hasExpandedTile(tileX: number, tileY: number, tileZ: number): boolean {
  const key = `expanded-${tileZ}/${tileX}/${tileY}`;
  return activeExpandedTiles.has(key);
}

/**
 * Get count of active expanded ground tiles
 */
export function getActiveExpandedTileCount(): number {
  return activeExpandedTiles.size;
}

/**
 * Get count of tiles in the loading queue
 */
export function getExpandedQueueLength(): number {
  return expandedTileQueue.length;
}

/**
 * Clear all expanded ground tiles and textures
 */
export function clearAllExpandedTiles(): void {
  // Invalidate in-flight work before clearing active state. Clearing key slots
  // lets the new generation queue replacements; the separate outstanding count
  // keeps them within the work budget until older generations settle.
  expandedLifecycle.invalidate();

  for (const key of [...activeExpandedTiles.keys()]) {
    removeExpandedTile(key);
  }

  activeExpandedTiles.clear();
  expandedTileQueue.length = 0;
  queuedExpandedTileKeys.clear();
  promotedTiles.clear();

  // Clear texture cache
  if (expandedTextureCache) {
    expandedTextureCache.clear();
  }
}

/**
 * Get expanded cache statistics
 */
export function getExpandedCacheStats(): { activeTiles: number; cachedTextures: number; queueLength: number } {
  return {
    activeTiles: activeExpandedTiles.size,
    cachedTextures: expandedTextureCache?.size ?? 0,
    queueLength: expandedTileQueue.length,
  };
}
