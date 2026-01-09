import * as THREE from 'three';
import type { GroundTileData } from './types.js';
import { TileTextureCache, initTextureCache } from './tile-texture-cache.js';
import { TerrainQuad } from './terrain-quad.js';
import { loadBaseTile, loadTransportationTile, tileToBounds } from '../tile-manager.js';
import { getTerrainHeight, getElevationDataForTile } from '../elevation.js';
import { lngLatToTile } from '../tile-manager.js';
import { getScene } from '../scene.js';
import { GROUND_TEXTURE, ELEVATION, OVERTURE_BASE_PMTILES, OVERTURE_TRANSPORTATION_PMTILES } from '../constants.js';
import { storeFeatures, removeStoredFeatures } from '../feature-picker.js';
import type { StoredFeature } from '../feature-picker.js';
import { getFullPipelineWorkerPool } from '../workers/index.js';
import { getTileSemaphore, TilePriority } from '../semaphore.js';
import * as profiler from '../profiling/tile-profiler.js';
import {
  getCachedTexture,
  blobToImageBitmap,
  isTextureCacheEnabled,
} from '../cache/indexed-db-texture-cache.js';
import { promoteExpandedToCore, demoteFromCore } from './expanded-ground-layer.js';

// Active ground tiles
const activeTiles = new Map<string, GroundTileData>();

// Track tiles currently being loaded to prevent race conditions
const loadingTiles = new Set<string>();

// Texture cache (initialized lazily)
let textureCache: TileTextureCache | null = null;

/**
 * Get or initialize the texture cache
 */
function getCache(): TileTextureCache {
  if (!textureCache) {
    textureCache = initTextureCache({
      maxSize: GROUND_TEXTURE.CACHE_MAX_SIZE,
      disposeThreshold: GROUND_TEXTURE.CACHE_DISPOSE_THRESHOLD,
    });
  }
  return textureCache;
}

/**
 * Create ground layer for a tile
 * Loads features, renders to texture, and creates terrain-following quad
 */
export async function createGroundForTile(
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<THREE.Group | null> {
  const scene = getScene();
  if (!scene) {
    console.warn('Scene not initialized');
    return null;
  }

  const key = `ground-${tileZ}/${tileX}/${tileY}`;

  // Check if already loaded
  if (activeTiles.has(key)) {
    return activeTiles.get(key)!.group;
  }

  // Check if currently loading (prevent race condition)
  if (loadingTiles.has(key)) {
    return null;
  }

  // Mark as loading
  loadingTiles.add(key);

  // Use semaphore to limit concurrent tile processing (maintains 60fps)
  // Z14 ground tiles have highest priority
  const semaphore = getTileSemaphore();
  try {
    if (semaphore) {
      return await semaphore.run(() => createGroundForTileInner(tileX, tileY, tileZ, key), TilePriority.Z14_GROUND);
    }
    return await createGroundForTileInner(tileX, tileY, tileZ, key);
  } catch (error) {
    // Ensure cleanup on error to prevent permanently stuck entries
    loadingTiles.delete(key);
    throw error;
  }
}

/**
 * Inner implementation of tile creation (runs with semaphore permit)
 */
async function createGroundForTileInner(
  tileX: number,
  tileY: number,
  tileZ: number,
  key: string
): Promise<THREE.Group | null> {
  // Start profiling this tile
  profiler.startTile(key);

  try {
    const scene = getScene();
    if (!scene) {
      loadingTiles.delete(key);
      return null;
    }

  const bounds = tileToBounds(tileX, tileY, tileZ);
  const cache = getCache();

  // Try to get texture from in-memory cache first
  let texture = cache.get(key);

  // If not in memory, try IndexedDB persistent cache
  if (!texture && isTextureCacheEnabled()) {
    try {
      const persistedTexture = await getCachedTexture(key);
      if (persistedTexture) {
        // Reconstruct Three.js texture from cached blob
        const bitmap = await blobToImageBitmap(persistedTexture.blob);
        const restoredTexture = new THREE.Texture(bitmap);
        restoredTexture.flipY = false;
        restoredTexture.minFilter = THREE.LinearMipmapLinearFilter;
        restoredTexture.magFilter = THREE.LinearFilter;
        restoredTexture.generateMipmaps = true;
        restoredTexture.colorSpace = THREE.SRGBColorSpace;
        restoredTexture.needsUpdate = true;
        texture = restoredTexture as unknown as THREE.CanvasTexture;

        // Store in memory cache for faster subsequent access
        cache.set(key, texture, bounds);
      }
    } catch (error) {
      // IndexedDB errors shouldn't block rendering
      console.warn('[TextureCache] Failed to restore from IndexedDB:', error);
    }
  }

  // Track cache hit/miss for profiling
  if (texture) {
    profiler.recordCacheHit();
  } else {
    profiler.recordCacheMiss();
  }

  // Always load features for the current tile (needed for click picking)
  // Even if texture is cached, we need features for interaction
  profiler.startPhase(key, 'fetch');
  const [currentTileBase, currentTileTransport] = await Promise.all([
    loadBaseTile(tileX, tileY, tileZ),
    loadTransportationTile(tileX, tileY, tileZ),
  ]);
  profiler.endPhase(key, 'fetch');

  // Store features for click picking (only from current tile, not neighbors)
  // Only include layers that are actually rendered (exclude infrastructure, etc.)
  const RENDERED_LAYERS = ['land', 'land_use', 'land_cover', 'water', 'segment'];
  const pickableFeatures = [...currentTileBase, ...currentTileTransport];
  const storedFeatures: StoredFeature[] = pickableFeatures
    .filter(f => RENDERED_LAYERS.includes(f.layer || ''))
    .filter(f => f.type === 'Polygon' || f.type === 'MultiPolygon' ||
                 f.type === 'LineString' || f.type === 'MultiLineString')
    .map(f => ({
      type: f.type as StoredFeature['type'],
      coordinates: f.coordinates as StoredFeature['coordinates'],
      properties: f.properties || {},
      layer: f.layer || 'unknown',
      tileKey: key
    }));
  storeFeatures(key, storedFeatures);

  if (!texture) {
    // Full pipeline: fetches, parses, renders all in worker (avoids structured clone overhead)
    profiler.startPhase(key, 'fullPipeline');
    const fullPipelinePool = getFullPipelineWorkerPool();
    const bitmap = await fullPipelinePool.renderTile(
      tileX,
      tileY,
      tileZ,
      GROUND_TEXTURE.TEXTURE_SIZE,
      OVERTURE_BASE_PMTILES,
      OVERTURE_TRANSPORTATION_PMTILES,
      !GROUND_TEXTURE.SKIP_NEIGHBOR_TILES, // includeNeighbors
      true // includeTransportation
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
    profiler.endPhase(key, 'fullPipeline');

    if (texture) {
      cache.set(key, texture, bounds);
    } else {
      console.error(`Failed to create texture for tile ${key}: worker returned null`);
    }
  }

  // Create terrain-following quad
  const quad = new TerrainQuad(bounds, GROUND_TEXTURE.TERRAIN_QUAD_SEGMENTS);

  // Apply terrain elevation
  if (ELEVATION.TERRAIN_ENABLED) {
    profiler.startPhase(key, 'terrainElevation');

    if (ELEVATION.GPU_DISPLACEMENT) {
      // GPU path: use vertex shader displacement
      // Find the elevation tile that covers this ground tile
      const centerLng = (bounds.west + bounds.east) / 2;
      const centerLat = (bounds.north + bounds.south) / 2;
      const [elevTileX, elevTileY] = lngLatToTile(centerLng, centerLat, ELEVATION.ZOOM);

      const elevationData = await getElevationDataForTile(elevTileX, elevTileY);
      if (elevationData) {
        quad.applyGPUDisplacement(
          elevationData.heights,
          ELEVATION.TILE_SIZE,
          elevationData.bounds, // Pass elevation tile bounds, not ground tile bounds
          ELEVATION.VERTICAL_EXAGGERATION
        );
      }
    } else {
      // CPU path: iterate over vertices
      quad.updateElevation(getTerrainHeight, ELEVATION.VERTICAL_EXAGGERATION);
    }

    profiler.endPhase(key, 'terrainElevation');
  }

  // Apply ground texture
  if (!texture) {
    console.error(`Cannot apply texture for tile ${key}: texture is null`);
    quad.dispose();
    return null;
  }
  quad.setTexture(texture);

  // Mark texture as in-use so it won't be evicted while bound to this tile
  cache.markInUse(key);

  // Enable stencil writing: Z14 high-detail tiles write to stencil buffer,
  // which masks Z10 low-detail tiles from rendering in the same area
  quad.enableStencilWrite();

  // Set render order: Z14 must render BEFORE Z10 so stencil is written first
  // Lower renderOrder = renders earlier in Three.js
  const mesh = quad.getMesh();
  mesh.renderOrder = -5;

  // Create group
  const group = new THREE.Group();
  group.name = key;
  group.add(mesh);

  // Store in active tiles
  activeTiles.set(key, {
    group,
    x: tileX,
    y: tileY,
    z: tileZ,
    key,
  });

  // Add to scene
  scene.add(group);

  // Promote: remove any expanded tile at this position (expanded tiles are terrain-only)
  // Core tiles have full features (buildings, etc), so they take precedence
  promoteExpandedToCore(tileX, tileY, tileZ);

  // Mark loading complete
  loadingTiles.delete(key);

  return group;
  } finally {
    // Always end profiling, even if an error occurred
    profiler.endTile(key);
  }
}

/**
 * Remove a ground tile group from scene
 */
export function removeGroundGroup(group: THREE.Group): void {
  const key = group.name;
  const tileData = activeTiles.get(key);

  if (tileData) {
    // Unmark texture as in-use so it can be evicted if needed
    const cache = getCache();
    cache.unmarkInUse(key);

    // Remove stored features for click picking
    removeStoredFeatures(key);

    // Clear promoted status so this position can become an expanded tile again
    demoteFromCore(tileData.x, tileData.y, tileData.z);

    // Dispose quad resources (but not texture - it's cached)
    const mesh = group.children[0] as THREE.Mesh;
    if (mesh) {
      mesh.geometry.dispose();
      // Don't dispose material.map - it's in the cache
      (mesh.material as THREE.Material).dispose();
    }

    activeTiles.delete(key);
  }

  const scene = getScene();
  if (scene) {
    scene.remove(group);
  }
}

/**
 * Check if a ground tile exists for given coordinates
 */
export function hasGroundTile(tileX: number, tileY: number, tileZ: number): boolean {
  const key = `ground-${tileZ}/${tileX}/${tileY}`;
  return activeTiles.has(key);
}

/**
 * Get count of active ground tiles
 */
export function getActiveGroundTileCount(): number {
  return activeTiles.size;
}

/**
 * Evict distant textures from cache based on player position
 * @param lng Player longitude
 * @param lat Player latitude
 * @param maxDistance Maximum distance in degrees before eviction
 */
export function evictDistantGroundTextures(lng: number, lat: number, maxDistance: number = 0.1): number {
  const cache = getCache();
  return cache.evictDistant(lng, lat, maxDistance);
}

/**
 * Clear all ground tiles and textures
 */
export function clearAllGroundTiles(): void {
  const scene = getScene();

  for (const [_key, tileData] of activeTiles) {
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

  activeTiles.clear();

  // Clear texture cache
  if (textureCache) {
    textureCache.clear();
  }
}

/**
 * Get cache statistics
 */
export function getGroundCacheStats(): { activeTiles: number; cachedTextures: number } {
  return {
    activeTiles: activeTiles.size,
    cachedTextures: textureCache?.size ?? 0,
  };
}
