/**
 * Tree layer module for rendering trees from pre-computed OSM density data and procedural generation
 *
 * Two sources of trees:
 * 1. OSM tree density data (pre-computed from natural=tree nodes, stored in tree-tiles.bin)
 * 2. Procedural trees generated within landcover polygons (forest, shrub, etc.)
 *
 * Tree generation and spatial filtering is done in a web worker to avoid main thread stutter.
 */

import * as THREE from 'three';
import { getScene, geoToWorld } from './scene.js';
import { ELEVATION, OVERTURE_BASE_PMTILES, OVERTURE_BUILDINGS_PMTILES, OVERTURE_TRANSPORTATION_PMTILES } from './constants.js';
import { clearPendingUpdatesForTile } from './elevation-sync.js';
import { getTreeProcessingWorkerPool, type TreeData, type LandcoverTreeConfig } from './workers/index.js';

// Re-export TreeData type for external use
export type { TreeData };

// ============================================================================
// TREE TILES CONFIG
// ============================================================================

// URL for tree-tiles.bin (worker fetches this directly)
const TREE_TILES_URL = `${import.meta.env.BASE_URL}tree-tiles.bin`;

// Default zoom level for tile hints (worker will read actual zoom from file)
const DEFAULT_TREE_TILES_ZOOM = 14;

// ============================================================================
// LANDCOVER CONFIGURATION (passed to worker)
// ============================================================================

// Aggressive performance tuning: reduced tree densities
const LANDCOVER_TREE_CONFIG: Record<string, LandcoverTreeConfig> = {
  // Dense forests (reduced from 15 to 6)
  forest: {
    density: 6,
    coniferRatio: 0.4,
    minHeight: 8,
    maxHeight: 30,
    heightVariation: 5,
  },
  // Woodland - dense tree coverage similar to forest
  wood: {
    density: 5,
    coniferRatio: 0.35,
    minHeight: 8,
    maxHeight: 28,
    heightVariation: 5,
  },
  // Shrubland - smaller, sparser vegetation
  shrub: {
    density: 3,
    coniferRatio: 0.2,
    minHeight: 2,
    maxHeight: 8,
    heightVariation: 2,
  },
  // Parks - well-spaced ornamental trees
  park: {
    density: 1.5,
    coniferRatio: 0.3,
    minHeight: 6,
    maxHeight: 20,
    heightVariation: 4,
  },
  // Wetland - sparse, varied vegetation
  wetland: {
    density: 1,
    coniferRatio: 0.1,
    minHeight: 4,
    maxHeight: 15,
    heightVariation: 4,
  },
  // Swamp - similar to wetland
  swamp: {
    density: 1,
    coniferRatio: 0.1,
    minHeight: 4,
    maxHeight: 15,
    heightVariation: 4,
  },
  // Mangrove - dense but short
  mangrove: {
    density: 4,
    coniferRatio: 0.0,
    minHeight: 3,
    maxHeight: 12,
    heightVariation: 3,
  },
  // Grass/meadow - occasional trees
  grass: {
    density: 0.2,
    coniferRatio: 0.2,
    minHeight: 5,
    maxHeight: 15,
    heightVariation: 3,
  },
  meadow: {
    density: 0.2,
    coniferRatio: 0.2,
    minHeight: 5,
    maxHeight: 15,
    heightVariation: 3,
  },
  // Farmland - very sparse
  crop: {
    density: 0.1,
    coniferRatio: 0.1,
    minHeight: 6,
    maxHeight: 18,
    heightVariation: 4,
  },
  farmland: {
    density: 0.1,
    coniferRatio: 0.1,
    minHeight: 6,
    maxHeight: 18,
    heightVariation: 4,
  },
};

// Maximum trees per tile
const MAX_PROCEDURAL_TREES_PER_TILE = 500;
const MAX_OSM_DENSITY_TREES_PER_TILE = 200;

// ============================================================================
// TREE RENDERING
// ============================================================================

// Tree rendering settings
const DEFAULT_TREE_HEIGHT = 8;
const MIN_TREE_HEIGHT = 3;
const MAX_TREE_HEIGHT = 40;
const TREE_CROWN_RATIO = 0.6;
const TREE_TRUNK_RADIUS = 0.15;
const TREE_CROWN_SEGMENTS = 6;

// Tree colors by type
const TREE_COLORS = {
  needleleaved: {
    crown: 0x1a472a,
    trunk: 0x4a3728,
  },
  broadleaved: {
    crown: 0x2d5a27,
    trunk: 0x5c4033,
  },
  default: {
    crown: 0x228b22,
    trunk: 0x4a3728,
  },
};

// Materials cache
const materials = {
  needleleavedCrown: new THREE.MeshStandardMaterial({
    color: TREE_COLORS.needleleaved.crown,
    roughness: 0.9,
    metalness: 0,
  }),
  needleleavedTrunk: new THREE.MeshStandardMaterial({
    color: TREE_COLORS.needleleaved.trunk,
    roughness: 0.95,
    metalness: 0,
  }),
  broadleavedCrown: new THREE.MeshStandardMaterial({
    color: TREE_COLORS.broadleaved.crown,
    roughness: 0.85,
    metalness: 0,
  }),
  broadleavedTrunk: new THREE.MeshStandardMaterial({
    color: TREE_COLORS.broadleaved.trunk,
    roughness: 0.9,
    metalness: 0,
  }),
  defaultCrown: new THREE.MeshStandardMaterial({
    color: TREE_COLORS.default.crown,
    roughness: 0.85,
    metalness: 0,
  }),
  defaultTrunk: new THREE.MeshStandardMaterial({
    color: TREE_COLORS.default.trunk,
    roughness: 0.9,
    metalness: 0,
  }),
};

/**
 * Simple seeded random number generator for consistent procedural generation
 */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/**
 * Create a seed from tile coordinates for consistent tree placement
 */
function getTileSeed(tileX: number, tileY: number, tileZ: number): number {
  return ((tileX * 73856093) ^ (tileY * 19349663) ^ (tileZ * 83492791)) & 0x7fffffff;
}

/**
 * Get random tree height with normal distribution
 */
function getRandomTreeHeight(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const height = DEFAULT_TREE_HEIGHT + z * 3;
  return Math.max(MIN_TREE_HEIGHT, Math.min(MAX_TREE_HEIGHT, height));
}

/**
 * Create instanced mesh for conifer trees (cone-shaped crown)
 */
function createConiferInstancedMesh(
  trees: TreeData[],
  worldPositions: { x: number; y: number; z: number }[]
): THREE.Group {
  const group = new THREE.Group();

  if (trees.length === 0) return group;

  const crownGeometry = new THREE.ConeGeometry(2, 5, TREE_CROWN_SEGMENTS, 1);
  const trunkGeometry = new THREE.CylinderGeometry(
    TREE_TRUNK_RADIUS,
    TREE_TRUNK_RADIUS * 1.5,
    2,
    4
  );

  const crownMesh = new THREE.InstancedMesh(
    crownGeometry,
    materials.needleleavedCrown,
    trees.length
  );
  const trunkMesh = new THREE.InstancedMesh(
    trunkGeometry,
    materials.needleleavedTrunk,
    trees.length
  );

  crownMesh.castShadow = true;
  crownMesh.receiveShadow = true;
  trunkMesh.castShadow = true;
  trunkMesh.receiveShadow = true;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  for (let i = 0; i < trees.length; i++) {
    const tree = trees[i];
    const pos = worldPositions[i];
    const height = tree.height || getRandomTreeHeight();

    const crownHeight = height * TREE_CROWN_RATIO;
    const trunkHeight = height * (1 - TREE_CROWN_RATIO);

    position.set(pos.x, pos.y + trunkHeight + crownHeight / 2, pos.z);
    quaternion.identity();
    scale.set(crownHeight / 5, crownHeight / 5, crownHeight / 5);
    matrix.compose(position, quaternion, scale);
    crownMesh.setMatrixAt(i, matrix);

    position.set(pos.x, pos.y + trunkHeight / 2, pos.z);
    scale.set(1, trunkHeight / 2, 1);
    matrix.compose(position, quaternion, scale);
    trunkMesh.setMatrixAt(i, matrix);
  }

  crownMesh.instanceMatrix.needsUpdate = true;
  trunkMesh.instanceMatrix.needsUpdate = true;

  group.add(crownMesh);
  group.add(trunkMesh);

  return group;
}

/**
 * Create instanced mesh for deciduous trees (sphere/icosahedron-shaped crown)
 */
function createDeciduousInstancedMesh(
  trees: TreeData[],
  worldPositions: { x: number; y: number; z: number }[],
  random: () => number
): THREE.Group {
  const group = new THREE.Group();

  if (trees.length === 0) return group;

  const crownGeometry = new THREE.IcosahedronGeometry(1.5, 1);
  const trunkGeometry = new THREE.CylinderGeometry(
    TREE_TRUNK_RADIUS,
    TREE_TRUNK_RADIUS * 1.3,
    2,
    4
  );

  const crownMesh = new THREE.InstancedMesh(
    crownGeometry,
    materials.broadleavedCrown,
    trees.length
  );
  const trunkMesh = new THREE.InstancedMesh(
    trunkGeometry,
    materials.broadleavedTrunk,
    trees.length
  );

  crownMesh.castShadow = true;
  crownMesh.receiveShadow = true;
  trunkMesh.castShadow = true;
  trunkMesh.receiveShadow = true;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  for (let i = 0; i < trees.length; i++) {
    const tree = trees[i];
    const pos = worldPositions[i];
    const height = tree.height || getRandomTreeHeight();

    const crownHeight = height * TREE_CROWN_RATIO;
    const trunkHeight = height * (1 - TREE_CROWN_RATIO);
    const crownRadius = crownHeight * 0.5;

    const offsetX = (random() - 0.5) * 0.3;
    const offsetZ = (random() - 0.5) * 0.3;
    position.set(pos.x + offsetX, pos.y + trunkHeight + crownRadius * 0.8, pos.z + offsetZ);

    quaternion.setFromEuler(new THREE.Euler(
      (random() - 0.5) * 0.1,
      random() * Math.PI * 2,
      (random() - 0.5) * 0.1
    ));

    scale.set(crownRadius, crownRadius * 0.9, crownRadius);
    matrix.compose(position, quaternion, scale);
    crownMesh.setMatrixAt(i, matrix);

    position.set(pos.x, pos.y + trunkHeight / 2, pos.z);
    quaternion.identity();
    scale.set(1, trunkHeight / 2, 1);
    matrix.compose(position, quaternion, scale);
    trunkMesh.setMatrixAt(i, matrix);
  }

  crownMesh.instanceMatrix.needsUpdate = true;
  trunkMesh.instanceMatrix.needsUpdate = true;

  group.add(crownMesh);
  group.add(trunkMesh);

  return group;
}

/**
 * Create trees for a tile using web worker for generation/filtering
 */
export async function createTreesForTile(
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<THREE.Group | null> {
  const scene = getScene();
  if (!scene) {
    console.warn('Scene not initialized');
    return null;
  }

  // Process trees in worker (worker fetches tree hints, PMTiles, and elevation data directly)
  const elevationConfig = ELEVATION.TERRAIN_ENABLED ? {
    urlTemplate: ELEVATION.TERRARIUM_URL,
    zoom: ELEVATION.ZOOM,
    tileSize: ELEVATION.TILE_SIZE,
    terrariumOffset: ELEVATION.TERRARIUM_OFFSET,
  } : undefined;

  const pool = getTreeProcessingWorkerPool();
  const result = await pool.processTrees(
    tileX,
    tileY,
    tileZ,
    LANDCOVER_TREE_CONFIG,
    MAX_PROCEDURAL_TREES_PER_TILE,
    MAX_OSM_DENSITY_TREES_PER_TILE,
    OVERTURE_BASE_PMTILES,
    OVERTURE_BUILDINGS_PMTILES,
    OVERTURE_TRANSPORTATION_PMTILES,
    TREE_TILES_URL,
    DEFAULT_TREE_TILES_ZOOM,
    elevationConfig,
    ELEVATION.VERTICAL_EXAGGERATION
  );

  const trees = result.trees;

  if (trees.length === 0) {
    return null;
  }

  // Use seeded random for consistent unknown tree type assignment
  const seed = getTileSeed(tileX, tileY, tileZ);
  const random = seededRandom(seed + 12345);

  // Separate trees by type and calculate world positions
  const conifers: TreeData[] = [];
  const deciduous: TreeData[] = [];
  const coniferPositions: { x: number; y: number; z: number }[] = [];
  const deciduousPositions: { x: number; y: number; z: number }[] = [];

  for (const tree of trees) {
    const worldPos = geoToWorld(tree.lng, tree.lat, 0);

    // Use terrain height from worker (already includes vertical exaggeration)
    // Fall back to 0 if not computed (when elevation is disabled)
    const terrainHeight = tree.terrainHeight ?? 0;

    const position = {
      x: worldPos.x,
      y: terrainHeight,
      z: worldPos.z,
    };

    if (tree.leafType === 'needleleaved') {
      conifers.push(tree);
      coniferPositions.push(position);
    } else if (tree.leafType === 'broadleaved') {
      deciduous.push(tree);
      deciduousPositions.push(position);
    } else {
      // Use seeded random for consistent assignment (70% deciduous, 30% conifer)
      if (random() < 0.7) {
        deciduous.push(tree);
        deciduousPositions.push(position);
      } else {
        conifers.push(tree);
        coniferPositions.push(position);
      }
    }
  }

  const group = new THREE.Group();
  group.name = `trees-${tileZ}/${tileX}/${tileY}`;
  group.userData = { tileX, tileY, tileZ, treeCount: trees.length };

  // Create seeded random for deciduous mesh variation
  const meshRandom = seededRandom(seed + 54321);

  // Create instanced meshes for each type
  if (conifers.length > 0) {
    const coniferGroup = createConiferInstancedMesh(conifers, coniferPositions);
    coniferGroup.name = 'conifers';
    group.add(coniferGroup);
  }

  if (deciduous.length > 0) {
    const deciduousGroup = createDeciduousInstancedMesh(deciduous, deciduousPositions, meshRandom);
    deciduousGroup.name = 'deciduous';
    group.add(deciduousGroup);
  }

  if (group.children.length === 0) {
    return null;
  }

  scene.add(group);

  return group;
}

/**
 * Remove tree meshes for a tile and properly dispose all GPU resources
 */
export function removeTreesGroup(group: THREE.Group): void {
  if (!group) return;

  // Clear any pending elevation updates for this tile
  if (group.name) {
    clearPendingUpdatesForTile(group.name);
  }

  const scene = getScene();
  if (scene) {
    scene.remove(group);
  }

  // Dispose of geometries (materials are shared, don't dispose them)
  group.traverse((child) => {
    if ((child as THREE.InstancedMesh).isInstancedMesh) {
      const mesh = child as THREE.InstancedMesh;
      if (mesh.geometry) {
        mesh.geometry.dispose();
      }
    }
  });

  group.clear();
}

/**
 * Initialize tree layer
 * Tree hints are now loaded by the worker on first use (and cached there)
 */
export async function initTreeLayer(): Promise<void> {
  // No-op: tree hints are now loaded in the tree processing worker
}

/**
 * Get tree hints data statistics
 * Note: Data is now managed in the worker, so we can't easily report stats from main thread
 */
export function getTreeHintsStats(): {
  loaded: boolean;
  tileCount: number;
  error: string | null;
} {
  return {
    loaded: true, // Worker handles loading
    tileCount: 0, // Not tracked on main thread
    error: null,
  };
}
