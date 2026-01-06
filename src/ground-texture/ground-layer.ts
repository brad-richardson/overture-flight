import * as THREE from 'three';
import type { GroundTileData } from './types.js';
import { TileTextureCache, initTextureCache } from './tile-texture-cache.js';
import { renderTileTexture } from './tile-texture-renderer.js';
import { TerrainQuad } from './terrain-quad.js';
import { loadBaseTile, loadTransportationTile, loadWaterPolygonsFromLowerZooms, tileToBounds } from '../tile-manager.js';
import { getTerrainHeight } from '../elevation.js';
import { getScene } from '../scene.js';
import { GROUND_TEXTURE, ELEVATION, WORKERS, PROCESS_CHAINING, PROFILING, OVERTURE_BASE_PMTILES, OVERTURE_TRANSPORTATION_PMTILES } from '../constants.js';
import { storeFeatures, removeStoredFeatures } from '../feature-picker.js';
import type { StoredFeature } from '../feature-picker.js';
import { getWorkerPool, getFullPipelineWorkerPool } from '../workers/index.js';
import { getTileSemaphore, TilePriority } from '../semaphore.js';
import * as profiler from '../profiling/tile-profiler.js';
import {
  getCachedTexture,
  cacheTexture,
  canvasToBlob,
  blobToImageBitmap,
  isTextureCacheEnabled,
} from '../cache/indexed-db-texture-cache.js';

// Active ground tiles
const activeTiles = new Map<string, GroundTileData>();

// Track tiles currently being loaded to prevent race conditions
const loadingTiles = new Set<string>();

// Texture cache (initialized lazily)
let textureCache: TileTextureCache | null = null;

/**
 * Persist texture to IndexedDB (non-blocking)
 * Errors are logged but don't block rendering
 */
function persistTextureToIndexedDB(
  tileKey: string,
  canvas: HTMLCanvasElement,
  bounds: { west: number; east: number; north: number; south: number }
): void {
  // Run async in background - don't await
  (async () => {
    try {
      const blob = await canvasToBlob(canvas);
      await cacheTexture(tileKey, blob, bounds);
    } catch (error) {
      console.warn('[TextureCache] Failed to persist texture:', error);
    }
  })();
}

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

  const scene = getScene();
  if (!scene) {
    loadingTiles.delete(key);
    profiler.endTile(key);
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
    // Try full pipeline worker first (fetch+parse+render all in worker)
    // This avoids structured clone overhead for feature arrays
    let useFullPipeline = WORKERS.FULL_PIPELINE_ENABLED;

    if (useFullPipeline) {
      try {
        profiler.startPhase(key, 'canvasRender');
        const fullPipelinePool = getFullPipelineWorkerPool();
        const isSupported = await fullPipelinePool.isWorkerSupported();

        if (isSupported) {
          // Full pipeline: worker fetches, parses, and renders
          const bitmap = await fullPipelinePool.renderTile(
            tileX,
            tileY,
            tileZ,
            GROUND_TEXTURE.TEXTURE_SIZE,
            OVERTURE_BASE_PMTILES,
            OVERTURE_TRANSPORTATION_PMTILES,
            true, // includeNeighbors
            true  // includeTransportation
          );

          // Create texture from ImageBitmap
          const workerTexture = new THREE.Texture(bitmap);
          workerTexture.minFilter = THREE.LinearMipmapLinearFilter;
          workerTexture.magFilter = THREE.LinearFilter;
          workerTexture.generateMipmaps = true;
          workerTexture.colorSpace = THREE.SRGBColorSpace;
          workerTexture.needsUpdate = true;

          texture = workerTexture as unknown as THREE.CanvasTexture;
          profiler.endPhase(key, 'canvasRender');

          // Cache the texture
          cache.set(key, texture, bounds);
        } else {
          useFullPipeline = false;
          profiler.endPhase(key, 'canvasRender');
        }
      } catch (error) {
        console.warn('Full pipeline worker failed, falling back to standard path:', error);
        useFullPipeline = false;
        profiler.endPhase(key, 'canvasRender');
      }
    }

    // Standard path: load features on main thread, optionally render in worker
    if (!useFullPipeline || !texture) {
      // Load features from surrounding tiles (3x3 grid) for texture rendering
      profiler.startPhase(key, 'neighborFetch');
      const neighborOffsets: [number, number][] = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          // Skip center tile - already loaded above
          if (dx === 0 && dy === 0) continue;
          neighborOffsets.push([dx, dy]);
        }
      }

      // Also load from a lower zoom level (z12) for larger land_cover polygons
      // This helps fill gaps where detailed tiles don't have land_cover data
      const lowerZoom = Math.max(10, tileZ - 2);
      const scale = Math.pow(2, tileZ - lowerZoom);
      const lowerX = Math.floor(tileX / scale);
      const lowerY = Math.floor(tileY / scale);

      const loadPromises = neighborOffsets.map(([dx, dy]) =>
        Promise.all([
          loadBaseTile(tileX + dx, tileY + dy, tileZ),
          loadTransportationTile(tileX + dx, tileY + dy, tileZ),
        ])
      );

      // Load lower zoom base features for background land_cover
      const lowerZoomPromise = loadBaseTile(lowerX, lowerY, lowerZoom);

      // Load water polygons from lower zoom levels
      // In fast mode (DEFER_LOW_ZOOM_WATER=true), only load z10 in the critical path
      // z8/z6 are skipped to reduce initial network requests
      const fastWaterMode = PROCESS_CHAINING.DEFER_LOW_ZOOM_WATER;
      const lowerZoomWaterPromise = loadWaterPolygonsFromLowerZooms(
        tileX, tileY, tileZ, TilePriority.Z14_GROUND, fastWaterMode
      );

      const [neighborResults, lowerZoomFeatures, lowerZoomWater] = await Promise.all([
        Promise.all(loadPromises),
        lowerZoomPromise,
        lowerZoomWaterPromise,
      ]);
      profiler.endPhase(key, 'neighborFetch');

      // Background load z8/z6 water if deferred (non-blocking, just warms the cache)
      // NOTE: We intentionally don't re-render to avoid texture swap flicker
      // The cached data will be used on subsequent tile loads or page revisits
      // Use BUILDINGS priority (lowest) to avoid competing with critical Z14 tiles
      if (fastWaterMode) {
        loadWaterPolygonsFromLowerZooms(tileX, tileY, tileZ, TilePriority.BUILDINGS, false)
          .catch((error) => {
            // Log in dev/profiling mode for debugging
            if (PROFILING.ENABLED || import.meta.env.DEV) {
              console.warn(`[GroundLayer] Background z8/z6 water load failed for ${tileX}/${tileY}:`, error);
            }
          });
      }

      // Merge all features - lower zoom features go first (background)
      // Lower zoom water goes first so it provides ocean coverage behind everything
      const baseFeatures = [
        ...lowerZoomWater,
        ...lowerZoomFeatures,
        ...currentTileBase,
        ...neighborResults.flatMap(([base]) => base),
      ];
      const transportFeatures = [
        ...currentTileTransport,
        ...neighborResults.flatMap(([, transport]) => transport),
      ];

      // Record feature counts for profiling
      profiler.recordFeatureCounts(key, baseFeatures.length, transportFeatures.length);

      // Render to texture (canvas will clip features outside bounds)
      // Use worker pool if enabled and supported, otherwise fall back to main thread
      profiler.startPhase(key, 'canvasRender');
      let useWorker = WORKERS.ENABLED;
      if (useWorker) {
        try {
          const pool = getWorkerPool();
          const isSupported = await pool.isWorkerSupported();
          if (isSupported) {
            // Render in worker, returns ImageBitmap
            const bitmap = await pool.renderTileTexture(
              baseFeatures,
              transportFeatures,
              bounds,
              GROUND_TEXTURE.TEXTURE_SIZE
            );

            // Create texture from ImageBitmap
            const workerTexture = new THREE.Texture(bitmap);
            workerTexture.minFilter = THREE.LinearMipmapLinearFilter;
            workerTexture.magFilter = THREE.LinearFilter;
            workerTexture.generateMipmaps = true;
            workerTexture.colorSpace = THREE.SRGBColorSpace;
            workerTexture.needsUpdate = true;

            // Cast to CanvasTexture for cache compatibility (works at runtime)
            // Note: Don't close the bitmap - let Three.js/GC handle memory
            texture = workerTexture as unknown as THREE.CanvasTexture;
          } else {
            useWorker = false;
          }
        } catch (error) {
          console.warn('Worker rendering failed, falling back to main thread:', error);
          useWorker = false;
        }
      }

      // Fallback to main thread rendering
      if (!useWorker || !texture) {
        texture = renderTileTexture(baseFeatures, transportFeatures, bounds);

        // Persist to IndexedDB (non-blocking)
        // Only for main thread rendering since we have access to the canvas
        if (isTextureCacheEnabled() && texture.image instanceof HTMLCanvasElement) {
          persistTextureToIndexedDB(key, texture.image, bounds);
        }
      }
      profiler.endPhase(key, 'canvasRender');

      cache.set(key, texture, bounds);
    }
  }

  // Create terrain-following quad
  const quad = new TerrainQuad(bounds, GROUND_TEXTURE.TERRAIN_QUAD_SEGMENTS);

  // Apply terrain elevation
  if (ELEVATION.TERRAIN_ENABLED) {
    profiler.startPhase(key, 'terrainElevation');
    quad.updateElevation(getTerrainHeight, ELEVATION.VERTICAL_EXAGGERATION);
    profiler.endPhase(key, 'terrainElevation');
  }

  // Apply ground texture
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

  // Mark loading complete
  loadingTiles.delete(key);

  // End profiling for this tile
  profiler.endTile(key);

  return group;
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
