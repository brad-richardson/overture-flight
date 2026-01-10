import * as THREE from 'three';
import { getScene, getSceneOriginForWorker } from './scene.js';
import { loadBuildingTile, tileToWorldBounds } from './tile-manager.js';
import { ELEVATION, WORKERS } from './constants.js';
import {
  isUndergroundBuilding,
  isBuildingFeature,
} from './building-materials.js';
import { storeFeatures, removeStoredFeatures } from './feature-picker.js';
import type { StoredFeature } from './feature-picker.js';
import { getTileSemaphore, TilePriority } from './semaphore.js';
import { clearPendingUpdatesForTile } from './elevation-sync.js';
import { getBuildingGeometryWorkerPool } from './workers/index.js';
import type { BuildingFeatureInput, ElevationConfig } from './workers/index.js';

// Default building height when not specified
const DEFAULT_BUILDING_HEIGHT = 10;

// LOD (Level of Detail) settings
const LOD_NEAR_DISTANCE = 1000; // meters - full detail
const LOD_MEDIUM_DISTANCE = 5000; // meters - reduced detail

// LOD levels
export enum LODLevel {
  HIGH = 0,   // Full detail
  MEDIUM = 1, // Reduced detail (simplified geometry)
  LOW = 2     // Minimal detail (heavily simplified geometry)
}

/**
 * Calculate distance from origin (player) to tile center
 * @param tileX - Tile X coordinate
 * @param tileY - Tile Y coordinate
 * @param tileZoom - Tile zoom level (not Z coordinate)
 */
function getTileDistanceFromOrigin(tileX: number, tileY: number, tileZoom: number): number {
  const bounds = tileToWorldBounds(tileX, tileY, tileZoom);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  // Origin is at 0,0 in world coordinates
  return Math.sqrt(centerX * centerX + centerZ * centerZ);
}

/**
 * Determine LOD level based on distance from player
 */
function getLODLevel(distance: number): LODLevel {
  if (distance < LOD_NEAR_DISTANCE) {
    return LODLevel.HIGH;
  } else if (distance < LOD_MEDIUM_DISTANCE) {
    return LODLevel.MEDIUM;
  } else {
    return LODLevel.LOW;
  }
}

// Track tiles currently being loaded to prevent race conditions
const loadingBuildingTiles = new Set<string>();

/**
 * Material that uses vertex colors for individual building variation
 */
const vertexColorMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.75,
  metalness: 0.1,
});

/**
 * Create building meshes from tile features with LOD-based detail reduction
 */
export async function createBuildingsForTile(
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<THREE.Group | null> {
  const scene = getScene();
  if (!scene) {
    console.warn('Scene not initialized');
    return null;
  }

  const tileKey = `buildings-${tileZ}/${tileX}/${tileY}`;

  // Check if currently loading (prevent race condition)
  if (loadingBuildingTiles.has(tileKey)) {
    return null;
  }

  // Mark as loading
  loadingBuildingTiles.add(tileKey);

  // Use semaphore to limit concurrent tile processing (maintains 60fps)
  // Buildings have lowest priority - ground tiles load first
  const semaphore = getTileSemaphore();
  try {
    if (semaphore) {
      return await semaphore.run(() => createBuildingsForTileInner(tileX, tileY, tileZ, tileKey), TilePriority.BUILDINGS);
    }
    return await createBuildingsForTileInner(tileX, tileY, tileZ, tileKey);
  } catch (error) {
    // Ensure cleanup on error to prevent permanently stuck entries
    loadingBuildingTiles.delete(tileKey);
    // Clean up stored features to prevent memory leak
    removeStoredFeatures(tileKey);
    throw error;
  }
}

/**
 * Inner implementation of building tile creation (runs with semaphore permit)
 */
async function createBuildingsForTileInner(
  tileX: number,
  tileY: number,
  tileZ: number,
  tileKey: string
): Promise<THREE.Group | null> {
  const scene = getScene();
  if (!scene) {
    loadingBuildingTiles.delete(tileKey);
    return null;
  }

  const features = await loadBuildingTile(tileX, tileY, tileZ);
  if (features.length === 0) {
    loadingBuildingTiles.delete(tileKey);
    return null;
  }

  // Store features for click picking
  const storedFeatures: StoredFeature[] = features
    .filter(f => {
      // Only process polygon/multipolygon types using type guard
      if (!isBuildingFeature(f)) return false;
      // Skip underground buildings
      return !isUndergroundBuilding(f);
    })
    .map(f => ({
      type: f.type as 'Polygon' | 'MultiPolygon',
      coordinates: f.coordinates as number[][][] | number[][][][],
      properties: (f.properties || {}) as Record<string, unknown>,
      layer: f.layer || 'building',
      tileKey
    }));
  storeFeatures(tileKey, storedFeatures);

  // Calculate LOD level based on distance from player
  const tileDistance = getTileDistanceFromOrigin(tileX, tileY, tileZ);
  const lodLevel = getLODLevel(tileDistance);

  const group = new THREE.Group();
  group.name = `buildings-${tileZ}/${tileX}/${tileY}`;
  // Store tile info for LOD updates
  group.userData = { tileX, tileY, tileZ, lodLevel, tileDistance };

  // Worker-based building geometry generation
  // Worker produces single merged mesh with uniform material properties.
  // Benefits: Heavy geometry computation off main thread, better frame rates.
  // Note: Origin captured here; if floating origin shifts during processing,
  // geometry may be slightly offset (acceptable for typical movement speeds).
  if (WORKERS.BUILDING_GEOMETRY_ENABLED) {
    try {
      const workerPool = getBuildingGeometryWorkerPool();
      const isSupported = await workerPool.isWorkerSupported();

      if (isSupported) {
        const origin = getSceneOriginForWorker();
        if (origin) {
          // Convert features to worker format
          const workerFeatures: BuildingFeatureInput[] = [];

          for (const f of features) {
            if (!isBuildingFeature(f)) continue;
            if (isUndergroundBuilding(f)) continue;

            workerFeatures.push({
              type: f.type as 'Polygon' | 'MultiPolygon',
              coordinates: f.coordinates as number[][][] | number[][][][],
              layer: f.layer,
              properties: f.properties as BuildingFeatureInput['properties'],
            });
          }

          if (workerFeatures.length > 0) {
            // Pass elevation config for worker-side terrain lookups (HTTP cache should hit)
            const elevationConfig: ElevationConfig | undefined = ELEVATION.TERRAIN_ENABLED ? {
              urlTemplate: ELEVATION.TERRARIUM_URL,
              zoom: ELEVATION.ZOOM,
              tileSize: ELEVATION.TILE_SIZE,
              terrariumOffset: ELEVATION.TERRARIUM_OFFSET,
            } : undefined;

            const result = await workerPool.createBuildingGeometry(
              workerFeatures,
              origin,
              tileX,
              tileY,
              tileZ,
              lodLevel,
              DEFAULT_BUILDING_HEIGHT,
              elevationConfig,
              ELEVATION.VERTICAL_EXAGGERATION
            );

            if (result.geometry) {
              // Create Three.js BufferGeometry from worker result
              const geometry = new THREE.BufferGeometry();
              geometry.setAttribute('position', new THREE.BufferAttribute(result.geometry.positions, 3));
              geometry.setAttribute('normal', new THREE.BufferAttribute(result.geometry.normals, 3));
              geometry.setAttribute('color', new THREE.BufferAttribute(result.geometry.colors, 3));
              geometry.setIndex(new THREE.Uint32BufferAttribute(result.geometry.indices, 1));

              const mesh = new THREE.Mesh(geometry, vertexColorMaterial.clone());
              mesh.castShadow = true;
              mesh.receiveShadow = true;
              mesh.name = 'buildings-worker';
              group.add(mesh);

              if (group.children.length > 0) {
                scene.add(group);
                loadingBuildingTiles.delete(tileKey);
                return group;
              }
            }
          }
        }
      }
    } catch (error) {
      console.warn('Building geometry worker failed:', error);
    }
  }

  // Worker didn't produce results - clean up and return null
  loadingBuildingTiles.delete(tileKey);
  return null;
}

/**
 * Remove building meshes for a tile and properly dispose all GPU resources
 */
export function removeBuildingsGroup(group: THREE.Group): void {
  if (!group) return;

  // Remove stored features and pending elevation updates for this tile
  if (group.name) {
    const tileKey = group.name; // e.g., "buildings-14/8372/5739"
    removeStoredFeatures(tileKey);
    clearPendingUpdatesForTile(tileKey);
  }

  const scene = getScene();
  if (scene) {
    scene.remove(group);
  }

  let disposedGeometries = 0;
  let disposedMaterials = 0;

  // Dispose of geometries and materials
  group.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;

      // Dispose geometry and all its attributes
      if (mesh.geometry) {
        mesh.geometry.dispose();
        disposedGeometries++;
      }

      // Dispose materials (handle array of materials)
      if (mesh.material) {
        if (Array.isArray(mesh.material)) {
          for (const mat of mesh.material) {
            mat.dispose();
            disposedMaterials++;
          }
        } else {
          (mesh.material as THREE.Material).dispose();
          disposedMaterials++;
        }
      }
    }
  });

  // Clear the group's children array
  group.clear();
}
