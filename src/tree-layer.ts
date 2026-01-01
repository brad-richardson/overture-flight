/**
 * Tree layer module for rendering trees from pre-computed OSM density data and procedural generation
 *
 * Two sources of trees:
 * 1. OSM tree density data (pre-computed from natural=tree nodes, stored in tree-tiles.bin)
 * 2. Procedural trees generated within landcover polygons (forest, shrub, etc.)
 */

import * as THREE from 'three';
import { getScene, geoToWorld } from './scene.js';
import { tileToBounds, loadBaseTile } from './tile-manager.js';
import { getTerrainHeight } from './elevation.js';
import { ELEVATION } from './constants.js';

// Types
export interface TreeData {
  lat: number;
  lng: number;
  height?: number;        // Height in meters
  species?: string;       // Tree species
  leafType?: string;      // broadleaved, needleleaved
  genus?: string;         // Tree genus (e.g., Quercus, Acer)
}

// OSM tree density data per z11 tile (from tree-tiles.bin)
interface TileHint {
  count: number;          // Number of OSM-mapped trees in this tile
  coniferRatio: number;   // 0-1, ratio of conifers vs deciduous
}

// Landcover configuration for procedural tree generation
// Maps landcover subtype to tree generation parameters
interface LandcoverTreeConfig {
  density: number;           // trees per 1000 sq meters
  coniferRatio: number;      // 0-1, ratio of conifers vs deciduous
  minHeight: number;         // minimum tree height
  maxHeight: number;         // maximum tree height
  heightVariation: number;   // std dev of height distribution
}

// Aggressive performance tuning: reduced tree densities
const LANDCOVER_TREE_CONFIG: Record<string, LandcoverTreeConfig> = {
  // Dense forests (reduced from 15 to 6)
  forest: {
    density: 6,           // Reduced for performance
    coniferRatio: 0.4,    // Mix of both
    minHeight: 8,
    maxHeight: 30,
    heightVariation: 5,
  },
  // Woodland - dense tree coverage similar to forest (reduced from 14 to 5)
  wood: {
    density: 5,           // Reduced for performance
    coniferRatio: 0.35,   // Slightly more deciduous
    minHeight: 8,
    maxHeight: 28,
    heightVariation: 5,
  },
  // Shrubland - smaller, sparser vegetation (reduced from 8 to 3)
  shrub: {
    density: 3,           // Reduced for performance
    coniferRatio: 0.2,
    minHeight: 2,
    maxHeight: 8,
    heightVariation: 2,
  },
  // Parks - well-spaced ornamental trees (reduced from 3 to 1.5)
  park: {
    density: 1.5,         // Reduced for performance
    coniferRatio: 0.3,
    minHeight: 6,
    maxHeight: 20,
    heightVariation: 4,
  },
  // Wetland - sparse, varied vegetation (reduced from 2 to 1)
  wetland: {
    density: 1,           // Reduced for performance
    coniferRatio: 0.1,
    minHeight: 4,
    maxHeight: 15,
    heightVariation: 4,
  },
  // Swamp - similar to wetland (alias) (reduced from 2 to 1)
  swamp: {
    density: 1,           // Reduced for performance
    coniferRatio: 0.1,
    minHeight: 4,
    maxHeight: 15,
    heightVariation: 4,
  },
  // Mangrove - dense but short (reduced from 12 to 4)
  mangrove: {
    density: 4,           // Reduced for performance
    coniferRatio: 0.0,    // Broadleaved only
    minHeight: 3,
    maxHeight: 12,
    heightVariation: 3,
  },
  // Grass/meadow - occasional trees (reduced from 0.5 to 0.2)
  grass: {
    density: 0.2,         // Reduced for performance
    coniferRatio: 0.2,
    minHeight: 5,
    maxHeight: 15,
    heightVariation: 3,
  },
  meadow: {
    density: 0.2,         // Reduced for performance
    coniferRatio: 0.2,
    minHeight: 5,
    maxHeight: 15,
    heightVariation: 3,
  },
  // Farmland - very sparse, mostly field boundaries (reduced from 0.2 to 0.1)
  crop: {
    density: 0.1,         // Reduced for performance
    coniferRatio: 0.1,
    minHeight: 6,
    maxHeight: 18,
    heightVariation: 4,
  },
  farmland: {
    density: 0.1,         // Reduced for performance
    coniferRatio: 0.1,
    minHeight: 6,
    maxHeight: 18,
    heightVariation: 4,
  },
};

// Maximum procedural trees per tile to avoid performance issues (reduced from 2000)
const MAX_PROCEDURAL_TREES_PER_TILE = 500;

// Maximum OSM density-based trees per tile
const MAX_OSM_DENSITY_TREES_PER_TILE = 200;

// ============================================================================
// OSM TREE DENSITY DATA (from tree-tiles.bin)
// ============================================================================

// Default zoom level for tile hints (can be overridden by file header)
const DEFAULT_TILE_HINTS_ZOOM = 11;

// Actual zoom level from the loaded file
let tileHintsZoom = DEFAULT_TILE_HINTS_ZOOM;

// Pre-loaded tile hints data: Map<"x,y" => TileHint>
let tileHintsData: Map<string, TileHint> | null = null;
let tileHintsLoadPromise: Promise<void> | null = null;
let tileHintsLoadError: Error | null = null;

/**
 * Load the tree-tiles.bin file containing pre-computed OSM tree density data
 */
async function loadTreeHintsData(): Promise<void> {
  if (tileHintsData !== null) {
    return; // Already loaded
  }

  if (tileHintsLoadPromise !== null) {
    return tileHintsLoadPromise; // Already loading
  }

  tileHintsLoadPromise = (async () => {
    try {
      const response = await fetch('/tree-tiles.bin');
      if (!response.ok) {
        throw new Error(`Failed to load tree-tiles.bin: HTTP ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      const data = new DataView(buffer);

      // Parse header
      const magic = String.fromCharCode(
        data.getUint8(0),
        data.getUint8(1),
        data.getUint8(2),
        data.getUint8(3)
      );

      if (magic !== 'TREE') {
        throw new Error('Invalid tree-tiles.bin magic bytes');
      }

      const version = data.getUint8(4);
      const zoom = data.getUint8(5);

      // Use the zoom level from the file
      tileHintsZoom = zoom;
      if (zoom !== DEFAULT_TILE_HINTS_ZOOM) {
        console.log(`Tree hints data uses zoom ${zoom} (default is ${DEFAULT_TILE_HINTS_ZOOM})`);
      }

      let offset: number;
      let tileCount: number;

      if (version === 1) {
        tileCount = data.getUint16(6, true);
        offset = 8;
      } else if (version === 2) {
        tileCount = data.getUint32(6, true);
        offset = 10;
      } else {
        throw new Error(`Unsupported tree-tiles.bin version: ${version}`);
      }

      // Parse tiles
      tileHintsData = new Map();

      for (let i = 0; i < tileCount; i++) {
        const x = data.getUint16(offset, true); offset += 2;
        const y = data.getUint16(offset, true); offset += 2;
        const count = data.getUint16(offset, true); offset += 2;
        const coniferRatio = data.getUint8(offset) / 255; offset += 1;

        tileHintsData.set(`${x},${y}`, { count, coniferRatio });
      }

      console.log(`Loaded tree hints: ${tileHintsData.size} tiles with OSM tree data`);
    } catch (error) {
      tileHintsLoadError = error as Error;
      console.warn('Failed to load tree hints data:', (error as Error).message);
      // Graceful degradation: use empty map so procedural trees from landcover still work.
      // Check getTreeHintsStats().error to see if loading failed.
      tileHintsData = new Map();
    }
  })();

  return tileHintsLoadPromise;
}

/**
 * Get the tile hint for a given z11 tile
 */
function getTileHint(x: number, y: number): TileHint | null {
  if (!tileHintsData) {
    return null;
  }
  return tileHintsData.get(`${x},${y}`) || null;
}

/**
 * Convert detail tile coordinates to z11 tile coordinates
 */
function detailToHintsTile(tileX: number, tileY: number, tileZ: number): { hx: number; hy: number } {
  if (tileZ <= tileHintsZoom) {
    const zoomDiff = tileHintsZoom - tileZ;
    const scale = Math.pow(2, zoomDiff);
    return {
      hx: Math.floor(tileX * scale),
      hy: Math.floor(tileY * scale),
    };
  }

  const zoomDiff = tileZ - tileHintsZoom;
  const scale = Math.pow(2, zoomDiff);
  return {
    hx: Math.floor(tileX / scale),
    hy: Math.floor(tileY / scale),
  };
}

// Tree rendering settings
const DEFAULT_TREE_HEIGHT = 8;    // meters
const MIN_TREE_HEIGHT = 3;        // meters
const MAX_TREE_HEIGHT = 40;       // meters
const TREE_CROWN_RATIO = 0.6;     // crown takes 60% of tree height
const TREE_TRUNK_RADIUS = 0.15;   // meters
const TREE_CROWN_SEGMENTS = 6;    // cone segments (low for performance)

// Tree colors by type
const TREE_COLORS = {
  // Needleleaved (conifers) - darker green, cone shaped
  needleleaved: {
    crown: 0x1a472a,  // Dark forest green
    trunk: 0x4a3728,  // Dark brown
  },
  // Broadleaved (deciduous) - lighter green, round shaped
  broadleaved: {
    crown: 0x2d5a27,  // Medium green
    trunk: 0x5c4033,  // Brown
  },
  // Default
  default: {
    crown: 0x228b22,  // Forest green
    trunk: 0x4a3728,  // Dark brown
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

// ============================================================================
// PROCEDURAL TREE GENERATION
// ============================================================================

/**
 * Simple seeded random number generator for consistent procedural generation
 * Uses a simple hash-based seed for reproducibility
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
  // Simple hash combining tile coordinates
  return ((tileX * 73856093) ^ (tileY * 19349663) ^ (tileZ * 83492791)) & 0x7fffffff;
}

/**
 * Point-in-polygon test using ray casting algorithm
 */
function pointInPolygon(x: number, y: number, polygon: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];

    if (((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Calculate the approximate area of a polygon in square meters
 * Uses latitude-adjusted conversion for accuracy at different latitudes
 */
function calculatePolygonAreaMeters(polygon: number[][]): number {
  if (polygon.length < 3) return 0;

  // Calculate centroid latitude for conversion factor
  let centroidLat = 0;
  for (const [, lat] of polygon) {
    centroidLat += lat;
  }
  centroidLat /= polygon.length;

  // Shoelace formula for area in degrees²
  let area = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    area += (polygon[j][0] + polygon[i][0]) * (polygon[j][1] - polygon[i][1]);
  }
  area = Math.abs(area / 2);

  // Convert from degrees² to m² using latitude-adjusted factors
  // 1 degree latitude ≈ 111320m (constant)
  // 1 degree longitude ≈ 111320 * cos(latitude) meters
  const metersPerDegreeLat = 111320;
  const metersPerDegreeLng = 111320 * Math.cos(centroidLat * Math.PI / 180);
  return area * metersPerDegreeLat * metersPerDegreeLng;
}

/**
 * Get the bounding box of a polygon
 */
function getPolygonBounds(polygon: number[][]): { minLng: number; maxLng: number; minLat: number; maxLat: number } {
  let minLng = Infinity, maxLng = -Infinity;
  let minLat = Infinity, maxLat = -Infinity;

  for (const [lng, lat] of polygon) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  return { minLng, maxLng, minLat, maxLat };
}

/**
 * Generate random tree positions within a polygon based on landcover config
 */
function generateTreesInPolygon(
  polygon: number[][],
  config: LandcoverTreeConfig,
  random: () => number,
  maxTrees: number
): TreeData[] {
  const trees: TreeData[] = [];
  const area = calculatePolygonAreaMeters(polygon);

  // Calculate number of trees based on density
  const targetCount = Math.floor(area * config.density / 1000);
  const treeCount = Math.min(targetCount, maxTrees);

  if (treeCount === 0) return trees;

  const bounds = getPolygonBounds(polygon);

  // Use rejection sampling to place trees within polygon
  let attempts = 0;
  const maxAttempts = treeCount * 10; // Limit attempts to avoid infinite loops

  while (trees.length < treeCount && attempts < maxAttempts) {
    attempts++;

    // Generate random point within bounding box
    const lng = bounds.minLng + random() * (bounds.maxLng - bounds.minLng);
    const lat = bounds.minLat + random() * (bounds.maxLat - bounds.minLat);

    // Check if point is inside polygon
    if (!pointInPolygon(lng, lat, polygon)) {
      continue;
    }

    // Determine tree type based on config
    const isConifer = random() < config.coniferRatio;

    // Generate height using normal distribution
    const u1 = random();
    const u2 = random();
    const z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
    const meanHeight = (config.minHeight + config.maxHeight) / 2;
    let height = meanHeight + z * config.heightVariation;
    height = Math.max(config.minHeight, Math.min(config.maxHeight, height));

    trees.push({
      lat,
      lng,
      height,
      leafType: isConifer ? 'needleleaved' : 'broadleaved',
    });
  }

  return trees;
}

/**
 * Generate procedural trees from landcover polygons in a tile
 */
async function generateProceduralTrees(
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<TreeData[]> {
  // Load base layer features which include land_cover
  const features = await loadBaseTile(tileX, tileY, tileZ);

  // Filter to land_cover features that should have trees
  const treeCoverFeatures = features.filter(f => {
    if (f.layer !== 'land_cover') return false;
    const subtype = ((f.properties.subtype || f.properties.class || '') as string).toLowerCase();
    return LANDCOVER_TREE_CONFIG[subtype] !== undefined;
  });

  if (treeCoverFeatures.length === 0) {
    return [];
  }

  // Create seeded random for consistent placement
  const seed = getTileSeed(tileX, tileY, tileZ);
  const random = seededRandom(seed);

  const allTrees: TreeData[] = [];
  let remainingBudget = MAX_PROCEDURAL_TREES_PER_TILE;

  for (const feature of treeCoverFeatures) {
    if (remainingBudget <= 0) break;

    const subtype = ((feature.properties.subtype || feature.properties.class || '') as string).toLowerCase();
    const config = LANDCOVER_TREE_CONFIG[subtype];
    if (!config) continue;

    // Handle Polygon and MultiPolygon
    if (feature.type === 'Polygon') {
      const coords = feature.coordinates as number[][][];
      if (coords.length > 0) {
        const outerRing = coords[0];
        const trees = generateTreesInPolygon(outerRing, config, random, remainingBudget);
        allTrees.push(...trees);
        remainingBudget -= trees.length;
      }
    } else if (feature.type === 'MultiPolygon') {
      const multiCoords = feature.coordinates as number[][][][];
      for (const polygon of multiCoords) {
        if (remainingBudget <= 0) break;
        if (polygon.length > 0) {
          const outerRing = polygon[0];
          const trees = generateTreesInPolygon(outerRing, config, random, remainingBudget);
          allTrees.push(...trees);
          remainingBudget -= trees.length;
        }
      }
    }
  }

  return allTrees;
}

/**
 * Generate trees based on OSM density data for a tile
 * These represent individually mapped trees from OSM, placed procedurally
 * within the tile based on pre-computed density hints
 */
async function generateOSMDensityTrees(
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<TreeData[]> {
  // Ensure tile hints are loaded
  await loadTreeHintsData();

  // Get the z11 tile that contains this detail tile
  const { hx, hy } = detailToHintsTile(tileX, tileY, tileZ);
  const hint = getTileHint(hx, hy);

  if (!hint || hint.count === 0) {
    return [];
  }

  // Calculate how many trees to generate for this detail tile
  // A hints tile contains 2^(tileZ - hintsZoom) x 2^(tileZ - hintsZoom) detail tiles
  const zoomDiff = Math.max(0, tileZ - tileHintsZoom);
  const tilesPerHintTile = Math.pow(2, zoomDiff * 2); // Total detail tiles in this z11 tile
  const treesPerDetailTile = Math.ceil(hint.count / tilesPerHintTile);

  // Cap the number of trees per tile
  const treeCount = Math.min(treesPerDetailTile, MAX_OSM_DENSITY_TREES_PER_TILE);

  if (treeCount === 0) {
    return [];
  }

  // Get tile bounds for placing trees
  const bounds = tileToBounds(tileX, tileY, tileZ);

  // Create seeded random for consistent placement
  // Use a different seed offset than landcover trees to avoid overlap
  const seed = getTileSeed(tileX, tileY, tileZ) + 999999;
  const random = seededRandom(seed);

  const trees: TreeData[] = [];

  for (let i = 0; i < treeCount; i++) {
    // Random position within tile
    const lng = bounds.west + random() * (bounds.east - bounds.west);
    const lat = bounds.south + random() * (bounds.north - bounds.south);

    // Determine tree type based on hint's conifer ratio
    const isConifer = random() < hint.coniferRatio;

    // Generate height with some variation
    const u1 = random();
    const u2 = random();
    const z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
    const meanHeight = 10;
    const heightVariation = 4;
    let height = meanHeight + z * heightVariation;
    height = Math.max(MIN_TREE_HEIGHT, Math.min(MAX_TREE_HEIGHT, height));

    trees.push({
      lat,
      lng,
      height,
      leafType: isConifer ? 'needleleaved' : 'broadleaved',
    });
  }

  return trees;
}

/**
 * Load all trees for a tile (OSM density-based + procedural from landcover)
 */
export async function loadAllTreesForTile(
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<TreeData[]> {
  // Load OSM density trees and procedural trees in parallel
  const [osmTrees, proceduralTrees] = await Promise.all([
    generateOSMDensityTrees(tileX, tileY, tileZ),
    generateProceduralTrees(tileX, tileY, tileZ),
  ]);

  // Combine both sources
  const allTrees = [...osmTrees, ...proceduralTrees];

  if (allTrees.length > 0) {
    console.log(`Trees for tile ${tileZ}/${tileX}/${tileY}: ${allTrees.length} (${osmTrees.length} OSM + ${proceduralTrees.length} procedural)`);
  }

  return allTrees;
}

// ============================================================================
// TREE RENDERING
// ============================================================================

/**
 * Get random tree height with normal distribution
 */
function getRandomTreeHeight(): number {
  // Box-Muller transform for normal distribution
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

  // Mean of 10m, std dev of 3m
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

  // Create geometries
  const crownGeometry = new THREE.ConeGeometry(
    2,                    // radius at base
    5,                    // height (will be scaled)
    TREE_CROWN_SEGMENTS,  // radial segments
    1                     // height segments
  );

  const trunkGeometry = new THREE.CylinderGeometry(
    TREE_TRUNK_RADIUS,      // top radius
    TREE_TRUNK_RADIUS * 1.5, // bottom radius
    2,                       // height (will be scaled)
    4                        // radial segments
  );

  // Create instanced meshes
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

    // Crown position and scale
    position.set(pos.x, pos.y + trunkHeight + crownHeight / 2, pos.z);
    quaternion.identity();
    scale.set(crownHeight / 5, crownHeight / 5, crownHeight / 5); // Scale proportionally
    matrix.compose(position, quaternion, scale);
    crownMesh.setMatrixAt(i, matrix);

    // Trunk position and scale
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
 * @param random - Seeded random function for consistent placement across sessions
 */
function createDeciduousInstancedMesh(
  trees: TreeData[],
  worldPositions: { x: number; y: number; z: number }[],
  random: () => number
): THREE.Group {
  const group = new THREE.Group();

  if (trees.length === 0) return group;

  // Use icosahedron for a more natural tree look (low poly sphere)
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

    // Crown - positioned at top of trunk, slight random offset for variety
    const offsetX = (random() - 0.5) * 0.3;
    const offsetZ = (random() - 0.5) * 0.3;
    position.set(pos.x + offsetX, pos.y + trunkHeight + crownRadius * 0.8, pos.z + offsetZ);

    // Slight random rotation for variety
    quaternion.setFromEuler(new THREE.Euler(
      (random() - 0.5) * 0.1,
      random() * Math.PI * 2,
      (random() - 0.5) * 0.1
    ));

    scale.set(crownRadius, crownRadius * 0.9, crownRadius);
    matrix.compose(position, quaternion, scale);
    crownMesh.setMatrixAt(i, matrix);

    // Trunk
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
 * Create trees for a tile
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

  // Load all trees for this tile
  const trees = await loadAllTreesForTile(tileX, tileY, tileZ);

  if (trees.length === 0) {
    return null;
  }

  // Use seeded random for consistent unknown tree type assignment
  const seed = getTileSeed(tileX, tileY, tileZ);
  const random = seededRandom(seed + 12345); // Different seed offset from procedural generation

  // Separate trees by type
  const conifers: TreeData[] = [];
  const deciduous: TreeData[] = [];

  const coniferPositions: { x: number; y: number; z: number }[] = [];
  const deciduousPositions: { x: number; y: number; z: number }[] = [];

  // Calculate world positions and separate by type
  for (const tree of trees) {
    const worldPos = geoToWorld(tree.lng, tree.lat, 0);

    // Get terrain height at tree position
    let terrainHeight = 0;
    if (ELEVATION.TERRAIN_ENABLED) {
      terrainHeight = getTerrainHeight(tree.lng, tree.lat) * ELEVATION.VERTICAL_EXAGGERATION;
    }

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

  // Create seeded random for deciduous mesh variation (different seed offset)
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

  const scene = getScene();
  if (scene) {
    scene.remove(group);
  }

  let disposedGeometries = 0;

  // Dispose of geometries (materials are shared, don't dispose them)
  group.traverse((child) => {
    if ((child as THREE.InstancedMesh).isInstancedMesh) {
      const mesh = child as THREE.InstancedMesh;
      if (mesh.geometry) {
        mesh.geometry.dispose();
        disposedGeometries++;
      }
    }
  });

  group.clear();
}

/**
 * Initialize tree layer - call this early to preload the tile hints data
 */
export async function initTreeLayer(): Promise<void> {
  await loadTreeHintsData();
}

/**
 * Get tree hints data statistics
 */
export function getTreeHintsStats(): {
  loaded: boolean;
  tileCount: number;
  error: string | null;
} {
  return {
    loaded: tileHintsData !== null,
    tileCount: tileHintsData?.size || 0,
    error: tileHintsLoadError?.message || null,
  };
}
