import * as THREE from 'three';
import type { GroundTileData } from './types.js';
import { TileTextureCache, initTextureCache } from './tile-texture-cache.js';
import { TerrainQuad } from './terrain-quad.js';
import { tileToBounds, lngLatToTile } from '../tile-manager.js';
import { getTerrainHeight, getElevationDataForTile } from '../elevation.js';
import { getScene } from '../scene.js';
import { EXPANDED_TERRAIN, ELEVATION, GROUND_TEXTURE, OVERTURE_BASE_PMTILES, OVERTURE_TRANSPORTATION_PMTILES } from '../constants.js';
import { getTileSemaphore, TilePriority } from '../semaphore.js';
import { getFullPipelineWorkerPool } from '../workers/index.js';

// Tile info type
interface TileInfo {
  x: number;
  y: number;
  z: number;
  key: string;
}

// Active expanded ground tiles (terrain + roads, no buildings)
const activeExpandedTiles = new Map<string, GroundTileData>();

// Track tiles currently being loaded to prevent race conditions
const loadingExpandedTiles = new Set<string>();

// Track tiles that have been promoted to core (prevents race condition where
// in-flight async load completes after promotion and re-adds the expanded tile)
const promotedTiles = new Set<string>();

// Queue for expanded tiles waiting to be loaded (FIFO for fairness)
const expandedTileQueue: TileInfo[] = [];
let isProcessingQueue = false;

// Dedicated texture cache for expanded tiles (separate from core tiles)
// This ensures expanded tiles are evicted before core tiles
let expandedTextureCache: TileTextureCache | null = null;

/**
 * Get or initialize the expanded tile texture cache
 */
function getExpandedCache(): TileTextureCache {
  if (!expandedTextureCache) {
    expandedTextureCache = initTextureCache({
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
  if (activeExpandedTiles.has(key) || loadingExpandedTiles.has(key) || promotedTiles.has(key)) {
    return;
  }

  if (expandedTileQueue.some(t => t.key === key)) {
    return;
  }

  expandedTileQueue.push(tile);
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
    // Check how many expanded tiles are currently loading
    if (loadingExpandedTiles.size >= EXPANDED_TERRAIN.MAX_CONCURRENT) {
      // Wait a bit before checking again
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }

    const tile = expandedTileQueue.shift();
    if (!tile) break;

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
  if (loadingExpandedTiles.has(key)) {
    return null;
  }

  // Mark as loading
  loadingExpandedTiles.add(key);

  // Use semaphore to limit concurrent tile processing
  // EXPANDED_TERRAIN has lowest priority (after buildings)
  const semaphore = getTileSemaphore();
  try {
    if (semaphore) {
      return await semaphore.run(
        () => createExpandedGroundForTileInner(tileX, tileY, tileZ, key),
        TilePriority.EXPANDED_TERRAIN
      );
    }
    return await createExpandedGroundForTileInner(tileX, tileY, tileZ, key);
  } catch (error) {
    // Ensure cleanup on error to prevent permanently stuck entries
    loadingExpandedTiles.delete(key);
    throw error;
  }
}

/**
 * Inner implementation of expanded tile creation (runs with semaphore permit)
 */
async function createExpandedGroundForTileInner(
  tileX: number,
  tileY: number,
  tileZ: number,
  key: string
): Promise<THREE.Group | null> {
  const scene = getScene();
  if (!scene) {
    loadingExpandedTiles.delete(key);
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
    const bitmap = await fullPipelinePool.renderTile(
      tileX,
      tileY,
      tileZ,
      EXPANDED_TERRAIN.TEXTURE_SIZE,
      OVERTURE_BASE_PMTILES,
      OVERTURE_TRANSPORTATION_PMTILES,
      false, // includeNeighbors - not needed for expanded tiles
      true   // includeTransportation
    );

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

  // Apply terrain elevation
  if (ELEVATION.TERRAIN_ENABLED) {
    if (ELEVATION.GPU_DISPLACEMENT) {
      // GPU path: use vertex shader displacement
      const centerLng = (bounds.west + bounds.east) / 2;
      const centerLat = (bounds.north + bounds.south) / 2;
      const [elevTileX, elevTileY] = lngLatToTile(centerLng, centerLat, ELEVATION.ZOOM);

      const elevationData = await getElevationDataForTile(elevTileX, elevTileY);
      if (elevationData) {
        quad.applyGPUDisplacement(
          elevationData.heights,
          ELEVATION.TILE_SIZE,
          elevationData.bounds,
          ELEVATION.VERTICAL_EXAGGERATION
        );
      }
    } else {
      // CPU path: iterate over vertices
      quad.updateElevation(getTerrainHeight, ELEVATION.VERTICAL_EXAGGERATION);
    }
  }

  // Apply ground texture
  quad.setTexture(texture);

  // Mark texture as in-use so it won't be evicted while bound to this tile
  cache.markInUse(key);

  // Enable stencil writing: expanded tiles (like core Z14) write to stencil buffer,
  // which masks Z10 low-detail tiles from rendering in the same area
  quad.enableStencilWrite();

  // Set render order: must match core Z14 tiles so stencil works correctly
  // Lower renderOrder = renders earlier in Three.js
  const mesh = quad.getMesh();
  mesh.renderOrder = -5;

  // Check if this tile was promoted to core while we were loading
  // If so, abort - the core tile takes precedence
  if (promotedTiles.has(key)) {
    // Clean up: unmark texture as in-use and dispose resources
    cache.unmarkInUse(key);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    loadingExpandedTiles.delete(key);
    return null;
  }

  // Create group
  const group = new THREE.Group();
  group.name = key;
  group.add(mesh);

  // Store in active tiles
  activeExpandedTiles.set(key, {
    group,
    x: tileX,
    y: tileY,
    z: tileZ,
    key,
  });

  // Add to scene
  scene.add(group);

  // Mark loading complete
  loadingExpandedTiles.delete(key);

  return group;
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

  // Dispose quad resources (but not texture - it's cached)
  const mesh = tileData.group.children[0] as THREE.Mesh;
  if (mesh) {
    mesh.geometry.dispose();
    // Don't dispose material.map - it's in the cache
    (mesh.material as THREE.Material).dispose();
  }

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
  }

  // Remove from loading set if in progress
  loadingExpandedTiles.delete(expandedKey);
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
 * Returns outer ring tiles (radius 4) excluding the core area (radius 1)
 */
export function getExpandedTilesToLoad(lng: number, lat: number, coreTileKeys: Set<string>): TileInfo[] {
  const z = 14; // Always Z14 (same as core tiles)
  const [centerX, centerY] = lngLatToTile(lng, lat, z);
  const tiles: TileInfo[] = [];

  const expandedRadius = EXPANDED_TERRAIN.TILE_RADIUS;
  const coreRadius = EXPANDED_TERRAIN.CORE_RADIUS;

  for (let dy = -expandedRadius; dy <= expandedRadius; dy++) {
    for (let dx = -expandedRadius; dx <= expandedRadius; dx++) {
      const x = centerX + dx;
      const y = centerY + dy;

      // Skip invalid tile coordinates
      const maxTile = Math.pow(2, z);
      if (x < 0 || x >= maxTile || y < 0 || y >= maxTile) continue;

      // Skip tiles within core area (they get full processing with buildings)
      const chebyshevDist = Math.max(Math.abs(dx), Math.abs(dy));
      if (chebyshevDist <= coreRadius) continue;

      // Also skip if already a core tile (in case core area is larger)
      const coreKey = `${z}/${x}/${y}`;
      if (coreTileKeys.has(coreKey)) continue;

      const expandedKey = `expanded-${z}/${x}/${y}`;
      tiles.push({ x, y, z, key: expandedKey });
    }
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
    const dx = Math.abs(tileData.x - centerX);
    const dy = Math.abs(tileData.y - centerY);
    const chebyshevDist = Math.max(dx, dy);

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
    const dx = Math.abs(tile.x - centerX);
    const dy = Math.abs(tile.y - centerY);
    const chebyshevDist = Math.max(dx, dy);

    if (chebyshevDist > maxDistance) {
      expandedTileQueue.splice(i, 1);
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
  const scene = getScene();

  for (const [_key, tileData] of activeExpandedTiles) {
    if (scene) {
      scene.remove(tileData.group);
    }

    // Dispose mesh resources
    const mesh = tileData.group.children[0] as THREE.Mesh;
    if (mesh) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }

  activeExpandedTiles.clear();
  expandedTileQueue.length = 0;
  loadingExpandedTiles.clear();
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
