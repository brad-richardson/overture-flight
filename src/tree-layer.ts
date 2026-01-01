/**
 * Tree layer module for rendering trees from OpenStreetMap and procedural generation
 *
 * Two sources of trees:
 * 1. OSM individual trees (natural=tree) via Overpass API
 * 2. Procedural trees generated within landcover polygons (forest, shrub, etc.)
 */

import * as THREE from 'three';
import { getScene, geoToWorld } from './scene.js';
import { tileToBounds, TileBounds, loadBaseTile } from './tile-manager.js';
import { getTerrainHeight } from './elevation.js';
import { ELEVATION } from './constants.js';

// Types
export interface TreeData {
  lat: number;
  lng: number;
  height?: number;        // Height in meters (from OSM tag)
  species?: string;       // Tree species
  leafType?: string;      // broadleaved, needleleaved
  genus?: string;         // Tree genus (e.g., Quercus, Acer)
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

interface TreeCacheEntry {
  trees: TreeData[];
  timestamp: number;
  isFailure?: boolean;  // True if this was a failed API request
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

// Cache for tree data - uses tile key as index
const treeCache = new Map<string, TreeCacheEntry>();

// LocalStorage key prefix for persistent caching (OSM trees from Overpass API)
const CACHE_PREFIX = 'osm-trees-';
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days - trees don't change often
const FAILURE_CACHE_TTL = 5 * 60 * 1000;   // 5 minutes - retry failures sooner

// Overpass API endpoints (use multiple for redundancy)
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Current endpoint index for round-robin
let currentEndpointIndex = 0;

// Pending loads to avoid duplicate fetches
const pendingLoads = new Map<string, Promise<TreeData[]>>();

// ============================================================================
// REGIONAL LOADING - Batch multiple tiles into larger queries
// ============================================================================

// Regional cache: load trees at a lower zoom level to cover more area per API call
// Zoom 11 tiles are 8x larger than zoom 14 tiles (2^3 = 8 per axis, 64 tiles total)
const REGIONAL_ZOOM = 11;

// Regional cache for trees (covers multiple detail tiles per entry)
const regionalTreeCache = new Map<string, TreeCacheEntry>();

// Pending regional loads to prevent duplicate fetches
const pendingRegionalLoads = new Map<string, Promise<TreeData[]>>();

// Request queue for rate limiting Overpass API calls
interface QueuedRequest {
  resolve: (value: TreeData[]) => void;
  reject: (error: Error) => void;
  bounds: TileBounds;
}

const requestQueue: QueuedRequest[] = [];
let isProcessingQueue = false;

// Minimum delay between Overpass API requests (ms)
const MIN_REQUEST_DELAY = 1000;
// Last request timestamp
let lastRequestTime = 0;

/**
 * Process the request queue with rate limiting
 */
async function processRequestQueue(): Promise<void> {
  if (isProcessingQueue) {
    return;
  }

  isProcessingQueue = true;

  try {
    while (requestQueue.length > 0) {
      const request = requestQueue.shift()!;

      // Enforce minimum delay between requests
      const now = Date.now();
      const timeSinceLastRequest = now - lastRequestTime;
      if (timeSinceLastRequest < MIN_REQUEST_DELAY) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_DELAY - timeSinceLastRequest));
      }

      // Update timestamp before making request to prevent race conditions
      lastRequestTime = Date.now();

      try {
        const trees = await fetchTreesFromOverpass(request.bounds);
        request.resolve(trees);
      } catch (error) {
        request.reject(error as Error);
      }
    }
  } finally {
    isProcessingQueue = false;
    // Check if new requests were added while we were processing
    if (requestQueue.length > 0) {
      processRequestQueue();
    }
  }
}

/**
 * Queue a request to the Overpass API with rate limiting
 */
function queueOverpassRequest(bounds: TileBounds): Promise<TreeData[]> {
  return new Promise((resolve, reject) => {
    requestQueue.push({ resolve, reject, bounds });
    processRequestQueue();
  });
}

/**
 * Convert detail tile coordinates to regional tile coordinates
 * Returns the regional tile that contains the given detail tile
 */
function detailToRegionalTile(tileX: number, tileY: number, tileZ: number): { rx: number; ry: number; rz: number } {
  // If zoom is at or below regional zoom, use the tile coordinates directly
  if (tileZ <= REGIONAL_ZOOM) {
    // Scale up to regional zoom level
    const zoomDiff = REGIONAL_ZOOM - tileZ;
    const scale = Math.pow(2, zoomDiff);
    return {
      rx: Math.floor(tileX * scale),
      ry: Math.floor(tileY * scale),
      rz: REGIONAL_ZOOM,
    };
  }

  // Normal case: zoom is higher than regional zoom, scale down
  const zoomDiff = tileZ - REGIONAL_ZOOM;
  const scale = Math.pow(2, zoomDiff);
  return {
    rx: Math.floor(tileX / scale),
    ry: Math.floor(tileY / scale),
    rz: REGIONAL_ZOOM,
  };
}

/**
 * Get the bounds for a regional tile
 */
function getRegionalTileBounds(rx: number, ry: number): TileBounds {
  const n = Math.pow(2, REGIONAL_ZOOM);
  const west = rx / n * 360 - 180;
  const east = (rx + 1) / n * 360 - 180;
  const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * ry / n))) * 180 / Math.PI;
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ry + 1) / n))) * 180 / Math.PI;
  return { west, east, north, south };
}

/**
 * Load trees for a regional tile (covers multiple detail tiles)
 */
async function loadTreesForRegion(rx: number, ry: number): Promise<TreeData[]> {
  const key = `${REGIONAL_ZOOM}/${rx}/${ry}`;

  // Check memory cache first
  if (regionalTreeCache.has(key)) {
    const entry = regionalTreeCache.get(key)!;
    const ttl = entry.isFailure ? FAILURE_CACHE_TTL : CACHE_TTL;
    if (Date.now() - entry.timestamp < ttl) {
      return entry.trees;
    }
    regionalTreeCache.delete(key);
  }

  // Check localStorage cache
  const localEntry = loadFromLocalStorage(key);
  if (localEntry) {
    const ttl = localEntry.isFailure ? FAILURE_CACHE_TTL : CACHE_TTL;
    if (Date.now() - localEntry.timestamp < ttl) {
      regionalTreeCache.set(key, localEntry);
      return localEntry.trees;
    }
  }

  // Check if already loading
  if (pendingRegionalLoads.has(key)) {
    return pendingRegionalLoads.get(key)!;
  }

  // Fetch from Overpass with rate limiting
  const loadPromise = (async (): Promise<TreeData[]> => {
    try {
      const bounds = getRegionalTileBounds(rx, ry);
      const trees = await queueOverpassRequest(bounds);

      console.log(`Loaded ${trees.length} trees for regional tile ${key}`);

      // Cache in memory
      const entry: TreeCacheEntry = {
        trees,
        timestamp: Date.now(),
      };
      regionalTreeCache.set(key, entry);

      // Cache in localStorage
      saveToLocalStorage(key, trees);

      pendingRegionalLoads.delete(key);
      return trees;
    } catch (error) {
      console.warn(`Failed to load trees for regional tile ${key}:`, (error as Error).message);
      pendingRegionalLoads.delete(key);

      // Cache failure with short TTL
      const failureEntry: TreeCacheEntry = {
        trees: [],
        timestamp: Date.now(),
        isFailure: true,
      };
      regionalTreeCache.set(key, failureEntry);

      return [];
    }
  })();

  pendingRegionalLoads.set(key, loadPromise);
  return loadPromise;
}

/**
 * Filter regional trees to only those within a specific detail tile
 */
function filterTreesForTile(trees: TreeData[], bounds: TileBounds): TreeData[] {
  return trees.filter(tree =>
    tree.lat >= bounds.south &&
    tree.lat <= bounds.north &&
    tree.lng >= bounds.west &&
    tree.lng <= bounds.east
  );
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

/**
 * Get the next Overpass endpoint (round-robin)
 */
function getNextEndpoint(): string {
  const endpoint = OVERPASS_ENDPOINTS[currentEndpointIndex];
  currentEndpointIndex = (currentEndpointIndex + 1) % OVERPASS_ENDPOINTS.length;
  return endpoint;
}

/**
 * Build Overpass QL query for trees in a bounding box
 */
function buildOverpassQuery(bounds: TileBounds): string {
  // Query for natural=tree nodes within the bounding box
  // south,west,north,east format for Overpass
  const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;

  return `
    [out:json][timeout:25];
    node["natural"="tree"](${bbox});
    out body;
  `.trim();
}

/**
 * Parse tree height from OSM tags
 */
function parseTreeHeight(tags: Record<string, string> | undefined): number | undefined {
  if (!tags) return undefined;

  // Try various height tags
  const heightStr = tags['height'] || tags['est_height'];
  if (!heightStr) return undefined;

  // Parse height value (remove 'm' suffix if present)
  const heightMatch = heightStr.match(/^([\d.]+)\s*m?$/);
  if (heightMatch) {
    const height = parseFloat(heightMatch[1]);
    if (!isNaN(height) && height >= MIN_TREE_HEIGHT && height <= MAX_TREE_HEIGHT) {
      return height;
    }
  }

  return undefined;
}

/**
 * Determine leaf type from OSM tags
 */
function parseLeafType(tags: Record<string, string> | undefined): string | undefined {
  if (!tags) return undefined;
  return tags['leaf_type'] || undefined;
}

/**
 * Try to load cached trees from localStorage
 */
function loadFromLocalStorage(key: string): TreeCacheEntry | null {
  try {
    const stored = localStorage.getItem(CACHE_PREFIX + key);
    if (stored) {
      const entry = JSON.parse(stored) as TreeCacheEntry;
      // Check if cache is still valid
      if (Date.now() - entry.timestamp < CACHE_TTL) {
        return entry;
      }
      // Cache expired, remove it
      localStorage.removeItem(CACHE_PREFIX + key);
    }
  } catch {
    // localStorage not available or parse error
  }
  return null;
}

/**
 * Save trees to localStorage
 */
function saveToLocalStorage(key: string, trees: TreeData[]): void {
  try {
    const entry: TreeCacheEntry = {
      trees,
      timestamp: Date.now(),
    };
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry));
  } catch {
    // localStorage full or not available - silently fail
  }
}

/**
 * Fetch trees from Overpass API with retry logic
 * Immediately tries next endpoint on failure (no delay between different endpoints)
 * Only applies backoff delay when retrying after rate limiting (429) or server error (503)
 */
async function fetchTreesFromOverpass(bounds: TileBounds): Promise<TreeData[]> {
  const query = buildOverpassQuery(bounds);
  let lastError: Error | undefined;
  let rateLimitBackoff = 0; // Backoff only for rate limiting

  // Try each endpoint
  for (let attempt = 0; attempt < OVERPASS_ENDPOINTS.length; attempt++) {
    const endpoint = getNextEndpoint();

    // Apply backoff only if we hit rate limiting on previous attempt
    if (rateLimitBackoff > 0) {
      console.log(`Rate limited, waiting ${rateLimitBackoff}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, rateLimitBackoff));
      rateLimitBackoff = 0; // Reset after waiting
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });

      if (!response.ok) {
        // Set backoff for rate limiting or server errors
        if (response.status === 429 || response.status === 503) {
          rateLimitBackoff = Math.min(1000 * Math.pow(2, attempt), 8000);
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as OverpassResponse;

      // Validate response structure
      if (!data || !Array.isArray(data.elements)) {
        throw new Error('Invalid Overpass response structure');
      }

      // Parse elements into TreeData
      const trees: TreeData[] = [];
      for (const element of data.elements) {
        if (element.type === 'node' && element.lat !== undefined && element.lon !== undefined) {
          trees.push({
            lat: element.lat,
            lng: element.lon,
            height: parseTreeHeight(element.tags),
            species: element.tags?.['species'] || element.tags?.['taxon'],
            leafType: parseLeafType(element.tags),
            genus: element.tags?.['genus'],
          });
        }
      }

      return trees;
    } catch (error) {
      lastError = error as Error;
      const errorMessage = (error as Error).name === 'AbortError'
        ? 'Request timed out'
        : (error as Error).message;
      console.warn(`Overpass endpoint ${endpoint} failed:`, errorMessage);
      // Try next endpoint immediately (no delay for switching endpoints)
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error('All Overpass endpoints failed');
}

/**
 * Load trees for a tile with caching
 * Uses regional loading to reduce API calls - loads a larger area and filters
 */
export async function loadTreesForTile(
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<TreeData[]> {
  const key = `${tileZ}/${tileX}/${tileY}`;

  // Check tile-level memory cache first (for quick lookups after initial load)
  if (treeCache.has(key)) {
    const entry = treeCache.get(key)!;
    const ttl = entry.isFailure ? FAILURE_CACHE_TTL : CACHE_TTL;
    if (Date.now() - entry.timestamp < ttl) {
      return entry.trees;
    }
    treeCache.delete(key);
  }

  // Check if already loading this tile
  if (pendingLoads.has(key)) {
    return pendingLoads.get(key)!;
  }

  // Use regional loading - load the parent regional tile and filter
  const loadPromise = (async (): Promise<TreeData[]> => {
    try {
      // Get the regional tile that contains this detail tile
      const { rx, ry } = detailToRegionalTile(tileX, tileY, tileZ);

      // Load trees for the entire region (this is cached and rate-limited)
      const regionalTrees = await loadTreesForRegion(rx, ry);

      // Filter to just the trees in this specific tile
      const tileBounds = tileToBounds(tileX, tileY, tileZ);
      const tileTrees = filterTreesForTile(regionalTrees, tileBounds);

      // Cache the filtered result for this specific tile
      const entry: TreeCacheEntry = {
        trees: tileTrees,
        timestamp: Date.now(),
      };
      treeCache.set(key, entry);

      pendingLoads.delete(key);
      return tileTrees;
    } catch (error) {
      console.warn(`Failed to load trees for tile ${key}:`, (error as Error).message);
      pendingLoads.delete(key);

      // Cache failure with short TTL to allow retry
      const failureEntry: TreeCacheEntry = {
        trees: [],
        timestamp: Date.now(),
        isFailure: true,
      };
      treeCache.set(key, failureEntry);

      return [];
    }
  })();

  pendingLoads.set(key, loadPromise);
  return loadPromise;
}

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
    const z = Math.sqrt(-2 * Math.log(Math.max(u1, 0.0001))) * Math.cos(2 * Math.PI * u2);
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

  // Warn if we couldn't place enough trees (complex polygon with low fill ratio)
  if (trees.length < treeCount * 0.5 && treeCount > 10) {
    console.warn(`Rejection sampling placed only ${trees.length}/${treeCount} trees (${Math.round(trees.length / treeCount * 100)}%) - polygon may have low fill ratio`);
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

  console.log(`Generated ${allTrees.length} procedural trees for tile ${tileZ}/${tileX}/${tileY} from ${treeCoverFeatures.length} landcover features`);
  return allTrees;
}

/**
 * Load all trees for a tile (OSM + procedural)
 */
export async function loadAllTreesForTile(
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<TreeData[]> {
  // Load OSM trees and procedural trees in parallel
  const [osmTrees, proceduralTrees] = await Promise.all([
    loadTreesForTile(tileX, tileY, tileZ),
    generateProceduralTrees(tileX, tileY, tileZ),
  ]);

  // Combine both sources
  const allTrees = [...osmTrees, ...proceduralTrees];

  console.log(`Total trees for tile ${tileZ}/${tileX}/${tileY}: ${allTrees.length} (${osmTrees.length} OSM + ${proceduralTrees.length} procedural)`);

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

  // Load both OSM trees and procedurally generated trees
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
  console.log(`Trees ${tileZ}/${tileX}/${tileY}: ${trees.length} trees (${conifers.length} conifers, ${deciduous.length} deciduous)`);

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

  if (disposedGeometries > 0) {
    console.log(`Disposed trees group ${group.name}: ${disposedGeometries} geometries`);
  }
}

/**
 * Clear tree cache for a specific tile
 */
export function clearTreeCache(key: string): void {
  treeCache.delete(key);
  try {
    localStorage.removeItem(CACHE_PREFIX + key);
  } catch {
    // Ignore localStorage errors
  }
}

/**
 * Clear entire tree cache (including regional cache and pending loads)
 */
export function clearAllTreeCache(): void {
  treeCache.clear();
  regionalTreeCache.clear();
  pendingLoads.clear();
  pendingRegionalLoads.clear();
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(CACHE_PREFIX)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Ignore localStorage errors
  }
}

/**
 * Get tree cache statistics
 */
export function getTreeCacheStats(): {
  memoryCacheSize: number;
  regionalCacheSize: number;
  localStorageCacheSize: number;
  pendingRequests: number;
} {
  let localStorageCacheSize = 0;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(CACHE_PREFIX)) {
        localStorageCacheSize++;
      }
    }
  } catch {
    // Ignore localStorage errors
  }

  return {
    memoryCacheSize: treeCache.size,
    regionalCacheSize: regionalTreeCache.size,
    localStorageCacheSize,
    pendingRequests: requestQueue.length,
  };
}
