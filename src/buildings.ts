import * as THREE from 'three';
import { getScene, getSceneOriginForWorker } from './scene.js';
import { loadBuildingTile, tileToWorldBounds } from './tile-manager.js';
import { ELEVATION, WORKERS } from './constants.js';
import {
  isUndergroundBuilding,
  isBuildingFeature,
} from './building-materials.js';
import { loadBuildingAtlas, getBuildingAtlas } from './building-atlas.js';
import { registerBuildingColliders, unregisterBuildingColliders } from './collision.js';
import { storeFeatures, removeStoredFeatures } from './feature-picker.js';
import type { StoredFeature } from './feature-picker.js';
import { getTileSemaphore, TilePriority } from './semaphore.js';
import { clearPendingUpdatesForTile } from './elevation-sync.js';
import { getBuildingGeometryWorkerPool } from './workers/index.js';
import type { BuildingFeatureInput, ElevationConfig, SceneOrigin } from './workers/index.js';

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

// Track tiles currently being loaded to prevent race conditions. The epoch is
// bumped before a teleport changes the scene origin, invalidating every queued
// or in-flight result from the prior local world.
let buildingLoadEpoch = 0;
const loadingBuildingTiles = new Map<string, number>();

/** Invalidate queued/in-flight building work before replacing the local world. */
export function invalidateBuildingLoads(): void {
  buildingLoadEpoch++;
  loadingBuildingTiles.clear();
}

function isBuildingLoadCurrent(
  tileKey: string,
  loadEpoch: number,
  loadOrigin: SceneOrigin
): boolean {
  if (loadEpoch !== buildingLoadEpoch || loadingBuildingTiles.get(tileKey) !== loadEpoch) {
    return false;
  }

  const currentOrigin = getSceneOriginForWorker();
  return currentOrigin.lng === loadOrigin.lng && currentOrigin.lat === loadOrigin.lat;
}

/** Delete the loading marker only when this request still owns it. */
function finishBuildingLoad(tileKey: string, loadEpoch: number): boolean {
  if (loadingBuildingTiles.get(tileKey) !== loadEpoch) return false;
  loadingBuildingTiles.delete(tileKey);
  return true;
}

const vertexColorMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.75,
  metalness: 0.1,
});

const buildingAtlasEnabled = import.meta.env.VITE_BUILDING_ATLAS !== 'false';
if (buildingAtlasEnabled) {
  void loadBuildingAtlas();
}

function getTexturedMaterial(): THREE.MeshStandardMaterial {
  const atlas = buildingAtlasEnabled ? getBuildingAtlas() : null;
  if (atlas) {
    return new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.8,
      metalness: 0.05,
      map: atlas,
    });
  }
  return vertexColorMaterial.clone();
}

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

  const loadEpoch = buildingLoadEpoch;
  const loadOrigin = getSceneOriginForWorker();
  loadingBuildingTiles.set(tileKey, loadEpoch);

  // Use semaphore to limit concurrent tile processing (maintains 60fps)
  // Buildings have lowest priority - ground tiles load first
  const semaphore = getTileSemaphore();
  try {
    if (semaphore) {
      return await semaphore.run(
        () => createBuildingsForTileInner(tileX, tileY, tileZ, tileKey, loadEpoch, loadOrigin),
        TilePriority.BUILDINGS
      );
    }
    return await createBuildingsForTileInner(tileX, tileY, tileZ, tileKey, loadEpoch, loadOrigin);
  } catch (error) {
    // A stale request must not delete state owned by a newer same-key request.
    if (finishBuildingLoad(tileKey, loadEpoch)) {
      removeStoredFeatures(tileKey);
    }
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
  tileKey: string,
  loadEpoch: number,
  loadOrigin: SceneOrigin
): Promise<THREE.Group | null> {
  const scene = getScene();
  if (!scene || !isBuildingLoadCurrent(tileKey, loadEpoch, loadOrigin)) {
    finishBuildingLoad(tileKey, loadEpoch);
    return null;
  }

  const features = await loadBuildingTile(tileX, tileY, tileZ);
  if (!isBuildingLoadCurrent(tileKey, loadEpoch, loadOrigin) || features.length === 0) {
    finishBuildingLoad(tileKey, loadEpoch);
    return null;
  }

  // Prepare click-picking features, but publish them only after the async
  // geometry result passes the epoch/origin guard.
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
  // Results are accepted only while the captured epoch and origin remain current.
  if (WORKERS.BUILDING_GEOMETRY_ENABLED) {
    try {
      const workerPool = getBuildingGeometryWorkerPool();
      const isSupported = await workerPool.isWorkerSupported();

      if (isSupported && isBuildingLoadCurrent(tileKey, loadEpoch, loadOrigin)) {
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
            loadOrigin,
            tileX,
            tileY,
            tileZ,
            lodLevel,
            DEFAULT_BUILDING_HEIGHT,
            elevationConfig,
            ELEVATION.VERTICAL_EXAGGERATION
          );

          if (result.geometry) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(result.geometry.positions, 3));
            geometry.setAttribute('normal', new THREE.BufferAttribute(result.geometry.normals, 3));
            geometry.setAttribute('color', new THREE.BufferAttribute(result.geometry.colors, 3));
            geometry.setIndex(new THREE.Uint32BufferAttribute(result.geometry.indices, 1));
            if (result.geometry.uvs) {
              geometry.setAttribute('uv', new THREE.BufferAttribute(result.geometry.uvs, 2));
            }

            const mesh = new THREE.Mesh(geometry, getTexturedMaterial());
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.name = 'buildings-worker';
              group.add(mesh);

            // Guard the post-worker await boundary before mutating the scene,
            // picking registry, or collision index.
            if (!isBuildingLoadCurrent(tileKey, loadEpoch, loadOrigin)) {
              disposeBuildingGroupResources(group);
              finishBuildingLoad(tileKey, loadEpoch);
              return null;
            }

            storeFeatures(tileKey, storedFeatures);
            scene.add(group);
            registerBuildingColliders(tileKey, result.colliders);
            finishBuildingLoad(tileKey, loadEpoch);
            return group;
          }
        }
      }
    } catch (error) {
      if (isBuildingLoadCurrent(tileKey, loadEpoch, loadOrigin)) {
        console.warn('Building geometry worker failed:', error);
      }
    }
  }

  // Worker didn't produce results - clean up and return null
  disposeBuildingGroupResources(group);
  finishBuildingLoad(tileKey, loadEpoch);
  return null;
}

function disposeBuildingGroupResources(group: THREE.Group): void {
  group.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;

    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    if (Array.isArray(mesh.material)) {
      for (const material of mesh.material) material.dispose();
    } else {
      mesh.material?.dispose();
    }
  });
  group.clear();
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
    unregisterBuildingColliders(tileKey);
  }

  const scene = getScene();
  if (scene) {
    scene.remove(group);
  }

  disposeBuildingGroupResources(group);
}
