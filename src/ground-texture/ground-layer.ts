import * as THREE from 'three';
import type { GroundTileData } from './types.js';
import { TileTextureCache, initTextureCache } from './tile-texture-cache.js';
import { renderTileTexture } from './tile-texture-renderer.js';
import { TerrainQuad } from './terrain-quad.js';
import { loadBaseTile, loadTransportationTile, loadWaterPolygonsFromLowerZooms, tileToBounds, tileToWorldBounds } from '../tile-manager.js';
import { getTerrainHeight } from '../elevation.js';
import { getScene } from '../scene.js';
import { GROUND_TEXTURE, ELEVATION } from '../constants.js';
import { storeFeatures, removeStoredFeatures } from '../feature-picker.js';
import type { StoredFeature } from '../feature-picker.js';

// Active ground tiles
const activeTiles = new Map<string, GroundTileData>();

// Track world-space bounds of all active Z14 tiles for Z10 clipping
let z14CoverageBounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;

/**
 * Recalculate the combined world-space bounds of all active Z14 tiles
 */
function updateZ14CoverageBounds(): void {
  if (activeTiles.size === 0) {
    z14CoverageBounds = null;
    return;
  }

  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (const tileData of activeTiles.values()) {
    const worldBounds = tileToWorldBounds(tileData.x, tileData.y, tileData.z);
    minX = Math.min(minX, worldBounds.minX);
    maxX = Math.max(maxX, worldBounds.maxX);
    minZ = Math.min(minZ, worldBounds.minZ);
    maxZ = Math.max(maxZ, worldBounds.maxZ);
  }

  z14CoverageBounds = { minX, maxX, minZ, maxZ };
}

/**
 * Get the current world-space bounds of Z14 tile coverage
 * Used by Z10 tiles to clip fragments in the Z14 region
 */
export function getZ14CoverageBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  return z14CoverageBounds;
}

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

  const bounds = tileToBounds(tileX, tileY, tileZ);
  const cache = getCache();

  // Try to get texture from cache
  let texture = cache.get(key);

  // Always load features for the current tile (needed for click picking)
  // Even if texture is cached, we need features for interaction
  const [currentTileBase, currentTileTransport] = await Promise.all([
    loadBaseTile(tileX, tileY, tileZ),
    loadTransportationTile(tileX, tileY, tileZ),
  ]);

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
    // Load features from surrounding tiles (3x3 grid) for texture rendering
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

    // Load water polygons from even lower zoom levels (z8-z10) for ocean coverage
    const lowerZoomWaterPromise = loadWaterPolygonsFromLowerZooms(tileX, tileY, tileZ);

    const [neighborResults, lowerZoomFeatures, lowerZoomWater] = await Promise.all([
      Promise.all(loadPromises),
      lowerZoomPromise,
      lowerZoomWaterPromise,
    ]);

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

    // Render to texture (canvas will clip features outside bounds)
    texture = renderTileTexture(baseFeatures, transportFeatures, bounds);
    cache.set(key, texture, bounds);
  }

  // Create terrain-following quad
  const quad = new TerrainQuad(bounds, GROUND_TEXTURE.TERRAIN_QUAD_SEGMENTS);

  // Apply terrain elevation
  if (ELEVATION.TERRAIN_ENABLED) {
    quad.updateElevation(getTerrainHeight, ELEVATION.VERTICAL_EXAGGERATION);
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

  // Update Z14 coverage bounds for Z10 clipping
  updateZ14CoverageBounds();

  // Add to scene
  scene.add(group);

  // Mark loading complete
  loadingTiles.delete(key);

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

    // Update Z14 coverage bounds for Z10 clipping
    updateZ14CoverageBounds();
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
