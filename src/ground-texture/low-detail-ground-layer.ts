import * as THREE from 'three';
import type { GroundTileData } from './types.js';
import { TileTextureCache, initTextureCache } from './tile-texture-cache.js';
import { renderLowDetailTileTexture } from './tile-texture-renderer.js';
import { TerrainQuad } from './terrain-quad.js';
import { loadBaseTile, loadWaterPolygonsFromLowerZooms, tileToBounds, lngLatToTile } from '../tile-manager.js';
import { getTerrainHeight } from '../elevation.js';
import { getScene } from '../scene.js';
import { LOW_DETAIL_TERRAIN, ELEVATION } from '../constants.js';
import { getZ14CoverageBounds } from './ground-layer.js';

// Tile info type
interface TileInfo {
  x: number;
  y: number;
  z: number;
  key: string;
}

// Active low-detail ground tiles
const activeLowDetailTiles = new Map<string, GroundTileData>();

// Track tiles currently being loaded to prevent race conditions
const loadingLowDetailTiles = new Set<string>();

// Texture cache for low-detail tiles (separate from high-detail)
let lowDetailTextureCache: TileTextureCache | null = null;

/**
 * Get or initialize the low-detail texture cache
 */
function getLowDetailCache(): TileTextureCache {
  if (!lowDetailTextureCache) {
    lowDetailTextureCache = initTextureCache({
      maxSize: 50, // Fewer tiles needed at Z10
      disposeThreshold: 40,
    });
  }
  return lowDetailTextureCache;
}

/**
 * Create a low-detail ground tile for distant terrain (Z10)
 * Uses simplified features: land, water, land_cover (no roads)
 */
export async function createLowDetailGroundForTile(
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<THREE.Group | null> {
  const scene = getScene();
  if (!scene) {
    console.warn('Scene not initialized');
    return null;
  }

  const key = `lowdetail-${tileZ}/${tileX}/${tileY}`;

  // Check if already loaded
  if (activeLowDetailTiles.has(key)) {
    return activeLowDetailTiles.get(key)!.group;
  }

  // Check if currently loading (prevent race condition)
  if (loadingLowDetailTiles.has(key)) {
    return null;
  }

  // Mark as loading
  loadingLowDetailTiles.add(key);

  const bounds = tileToBounds(tileX, tileY, tileZ);
  const cache = getLowDetailCache();

  // Try to get texture from cache
  let texture = cache.get(key);

  if (!texture) {
    // Load base features (land, water, land_cover) - no transportation
    // At Z10, polygons are large enough that we don't need neighbor tiles
    const baseFeatures = await loadBaseTile(tileX, tileY, tileZ);

    // Also load water polygons from even lower zooms for ocean coverage
    const lowerZoomWater = await loadWaterPolygonsFromLowerZooms(tileX, tileY, tileZ);

    // Merge features - lower zoom water first
    const allBaseFeatures = [...lowerZoomWater, ...baseFeatures];

    // Render to texture with simplified renderer (no roads)
    texture = renderLowDetailTileTexture(
      allBaseFeatures,
      bounds,
      LOW_DETAIL_TERRAIN.TEXTURE_SIZE
    );
    cache.set(key, texture, bounds);
  }

  // Create terrain-following quad with fewer segments
  const quad = new TerrainQuad(bounds, LOW_DETAIL_TERRAIN.TERRAIN_QUAD_SEGMENTS);

  // Apply terrain elevation
  if (ELEVATION.TERRAIN_ENABLED) {
    quad.updateElevation(getTerrainHeight, ELEVATION.VERTICAL_EXAGGERATION);
  }

  // Apply ground texture
  quad.setTexture(texture);

  // Mark texture as in-use so it won't be evicted while bound to this tile
  cache.markInUse(key);

  // Configure material for stencil masking (Z10 only renders where Z14 doesn't exist)
  // stencilWrite must be true to enable stencil TESTING (not just writing)
  // KeepStencilOp on all ops means we test but don't modify the stencil buffer
  const material = quad.getMaterial();
  material.stencilWrite = true;
  material.stencilRef = 0;
  material.stencilFunc = THREE.EqualStencilFunc;
  material.stencilFail = THREE.KeepStencilOp;
  material.stencilZFail = THREE.KeepStencilOp;
  material.stencilZPass = THREE.KeepStencilOp;

  // Add shader-based clipping to discard fragments in Z14 coverage area
  // This is more robust than stencil masking alone because it works in world-space
  // regardless of mesh resolution differences on steep terrain
  const z14Bounds = getZ14CoverageBounds();
  if (z14Bounds) {
    // Create uniforms for Z14 bounds
    const clipUniforms = {
      u_z14MinX: { value: z14Bounds.minX },
      u_z14MaxX: { value: z14Bounds.maxX },
      u_z14MinZ: { value: z14Bounds.minZ },
      u_z14MaxZ: { value: z14Bounds.maxZ },
    };

    material.onBeforeCompile = (shader) => {
      // Add uniforms
      shader.uniforms.u_z14MinX = clipUniforms.u_z14MinX;
      shader.uniforms.u_z14MaxX = clipUniforms.u_z14MaxX;
      shader.uniforms.u_z14MinZ = clipUniforms.u_z14MinZ;
      shader.uniforms.u_z14MaxZ = clipUniforms.u_z14MaxZ;

      // Add varying for world position in vertex shader
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWorldPos;`
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

      // Add uniform declarations and clipping logic in fragment shader
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        uniform float u_z14MinX;
        uniform float u_z14MaxX;
        uniform float u_z14MinZ;
        uniform float u_z14MaxZ;
        varying vec3 vWorldPos;`
      );

      // Discard fragments within Z14 bounds early to avoid unnecessary lighting calculations
      // Insert after clipping_planes_fragment for early exit
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        // Z14 coverage clipping - discard Z10 fragments in Z14 area
        float margin = 2.0; // 2 meter margin to ensure clean edges
        if (vWorldPos.x > u_z14MinX - margin && vWorldPos.x < u_z14MaxX + margin &&
            vWorldPos.z > u_z14MinZ - margin && vWorldPos.z < u_z14MaxZ + margin) {
          discard;
        }`
      );
    };

    // Store uniforms reference so we can update them later if needed
    (material as THREE.MeshStandardMaterial & { _clipUniforms?: typeof clipUniforms })._clipUniforms = clipUniforms;
  }

  // Position mesh slightly below Z14 (as backup to shader clipping)
  const mesh = quad.getMesh();
  mesh.position.y += LOW_DETAIL_TERRAIN.Y_OFFSET;

  // Render order: Z10 must render AFTER Z14 so stencil test works
  // Z14 has renderOrder = -5, so Z10 needs higher value (renders later)
  mesh.renderOrder = -4;

  // Create group
  const group = new THREE.Group();
  group.name = key;
  group.add(mesh);

  // Store in active tiles
  activeLowDetailTiles.set(key, {
    group,
    x: tileX,
    y: tileY,
    z: tileZ,
    key,
  });

  // Add to scene
  scene.add(group);

  // Mark loading complete
  loadingLowDetailTiles.delete(key);

  return group;
}

/**
 * Remove a low-detail ground tile group from scene
 */
export function removeLowDetailGroundGroup(group: THREE.Group): void {
  const key = group.name;
  const tileData = activeLowDetailTiles.get(key);

  if (tileData) {
    // Unmark texture as in-use so it can be evicted if needed
    const cache = getLowDetailCache();
    cache.unmarkInUse(key);

    // Dispose quad resources (but not texture - it's cached)
    const mesh = group.children[0] as THREE.Mesh;
    if (mesh) {
      mesh.geometry.dispose();
      // Don't dispose material.map - it's in the cache
      (mesh.material as THREE.Material).dispose();
    }

    activeLowDetailTiles.delete(key);
  }

  const scene = getScene();
  if (scene) {
    scene.remove(group);
  }
}

/**
 * Get list of low-detail tiles to load based on player position
 * Returns a 5x5 grid of Z10 tiles centered on player
 */
export function getLowDetailTilesToLoad(lng: number, lat: number): TileInfo[] {
  const z = LOW_DETAIL_TERRAIN.ZOOM;
  const [centerX, centerY] = lngLatToTile(lng, lat, z);
  const tiles: TileInfo[] = [];

  const radius = LOW_DETAIL_TERRAIN.TILE_RADIUS;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = centerX + dx;
      const y = centerY + dy;

      // Skip invalid tile coordinates
      const maxTile = Math.pow(2, z);
      if (x < 0 || x >= maxTile || y < 0 || y >= maxTile) continue;

      const key = `lowdetail-${z}/${x}/${y}`;
      tiles.push({ x, y, z, key });
    }
  }

  return tiles;
}

/**
 * Get list of low-detail tiles that should be unloaded
 * Uses Chebyshev distance (max of |dx| or |dy|)
 */
export function getLowDetailTilesToUnload(lng: number, lat: number): string[] {
  const z = LOW_DETAIL_TERRAIN.ZOOM;
  const [centerX, centerY] = lngLatToTile(lng, lat, z);
  const maxDistance = LOW_DETAIL_TERRAIN.UNLOAD_DISTANCE;
  const tilesToUnload: string[] = [];

  for (const [key, tileData] of activeLowDetailTiles) {
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
 * Check if a low-detail tile exists for given coordinates
 */
export function hasLowDetailTile(tileX: number, tileY: number, tileZ: number): boolean {
  const key = `lowdetail-${tileZ}/${tileX}/${tileY}`;
  return activeLowDetailTiles.has(key);
}

/**
 * Get count of active low-detail ground tiles
 */
export function getActiveLowDetailTileCount(): number {
  return activeLowDetailTiles.size;
}

/**
 * Clear all low-detail ground tiles and textures
 */
export function clearAllLowDetailGroundTiles(): void {
  const scene = getScene();

  for (const [_key, tileData] of activeLowDetailTiles) {
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

  activeLowDetailTiles.clear();

  // Clear texture cache
  if (lowDetailTextureCache) {
    lowDetailTextureCache.clear();
  }
}

/**
 * Get low-detail cache statistics
 */
export function getLowDetailCacheStats(): { activeTiles: number; cachedTextures: number } {
  return {
    activeTiles: activeLowDetailTiles.size,
    cachedTextures: lowDetailTextureCache?.size ?? 0,
  };
}
