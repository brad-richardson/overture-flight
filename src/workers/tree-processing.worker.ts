/**
 * Tree processing worker
 * Handles CPU-intensive tree generation, spatial filtering, AND data fetching
 * all off the main thread to avoid structured clone overhead.
 *
 * Like full-pipeline worker, this fetches PMTiles data directly in the worker
 * to avoid sending large feature arrays over the message channel.
 */

import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type {
  WorkerResponse,
  ProcessTreesResult,
  TreeData,
  ParsedFeature,
  LandcoverTreeConfig,
  TileBounds,
  ElevationConfig,
} from './types.js';

// ============================================================================
// PMTILES INITIALIZATION
// ============================================================================

// PMTiles sources (lazy initialized)
let basePMTiles: PMTiles | null = null;
let buildingsPMTiles: PMTiles | null = null;
let transportationPMTiles: PMTiles | null = null;
let pmtilesInitialized = false;
let pmtilesInitPromise: Promise<void> | null = null;

// Cached URLs for initialization
let basePMTilesUrl: string | null = null;
let buildingsPMTilesUrl: string | null = null;
let transportationPMTilesUrl: string | null = null;

// ============================================================================
// TREE HINTS DATA (from tree-tiles.bin)
// ============================================================================

interface TileHint {
  count: number;
  coniferRatio: number;
}

// Tree hints data: Map<packedXY => packedValue>
// Memory optimization: uses packed integers instead of string keys and object values
// Key: (x << 16) | y (uint32)
// Value: (count << 8) | coniferRatioUint8 (uint32)
// This reduces memory from ~113MB to ~18MB per worker for ~750k entries
let treeHintsData: Map<number, number> | null = null;
let treeHintsLoadPromise: Promise<void> | null = null;
let treeHintsUrl: string | null = null;
let treeHintsZoom: number = 10; // Default, will be updated from file

/** Pack x,y coordinates into a single uint32 key */
function packKey(x: number, y: number): number {
  return (x << 16) | y;
}

/** Pack count and coniferRatio into a single uint32 value */
function packValue(count: number, coniferRatioUint8: number): number {
  return (count << 8) | coniferRatioUint8;
}

/** Unpack value into count and coniferRatio */
function unpackValue(packed: number): TileHint {
  return {
    count: packed >>> 8,
    coniferRatio: (packed & 0xFF) / 255
  };
}

/**
 * Load and parse tree-tiles.bin (runs entirely in worker)
 */
async function loadTreeHints(url: string): Promise<void> {
  // Already loaded with same URL
  if (treeHintsData !== null && treeHintsUrl === url) {
    return;
  }

  // Already loading
  if (treeHintsLoadPromise !== null && treeHintsUrl === url) {
    return treeHintsLoadPromise;
  }

  treeHintsUrl = url;
  treeHintsLoadPromise = (async () => {
    try {
      const response = await fetch(url);
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
      treeHintsZoom = zoom;

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

      // Parse tiles into memory-efficient packed format
      treeHintsData = new Map();

      for (let i = 0; i < tileCount; i++) {
        const x = data.getUint16(offset, true); offset += 2;
        const y = data.getUint16(offset, true); offset += 2;
        const count = data.getUint16(offset, true); offset += 2;
        const coniferRatioUint8 = data.getUint8(offset); offset += 1;

        treeHintsData.set(packKey(x, y), packValue(count, coniferRatioUint8));
      }
    } catch (error) {
      console.warn('[TreeWorker] Failed to load tree hints:', (error as Error).message);
      // Graceful degradation: use empty map
      treeHintsData = new Map();
    }
  })();

  return treeHintsLoadPromise;
}

/**
 * Get tree hint for a tile (converts from detail zoom to hints zoom)
 * Uses the treeHintsZoom loaded from the file header
 */
function getTileHint(tileX: number, tileY: number, tileZ: number): TileHint | null {
  if (!treeHintsData) return null;

  // Use the zoom level loaded from the tree-tiles.bin file header
  const hintsZoom = treeHintsZoom;

  let hx: number, hy: number;

  // Convert from detail tile coords to hints tile coords
  if (tileZ === hintsZoom) {
    hx = tileX;
    hy = tileY;
  } else if (tileZ > hintsZoom) {
    // Detail tile is smaller, scale down
    const scale = Math.pow(2, tileZ - hintsZoom);
    hx = Math.floor(tileX / scale);
    hy = Math.floor(tileY / scale);
  } else {
    // Detail tile is larger than hints tile - use center
    const scale = Math.pow(2, hintsZoom - tileZ);
    hx = tileX * scale + Math.floor(scale / 2);
    hy = tileY * scale + Math.floor(scale / 2);
  }

  const packed = treeHintsData.get(packKey(hx, hy));
  return packed !== undefined ? unpackValue(packed) : null;
}

/**
 * Initialize PMTiles sources (called once, lazy)
 */
async function initializePMTiles(
  baseUrl: string,
  buildingsUrl: string,
  transportUrl: string
): Promise<void> {
  // Already initialized with matching URLs
  if (
    pmtilesInitialized &&
    basePMTilesUrl === baseUrl &&
    buildingsPMTilesUrl === buildingsUrl &&
    transportationPMTilesUrl === transportUrl
  ) {
    return;
  }

  // If there's a pending init, wait for it
  if (pmtilesInitPromise) {
    if (
      basePMTilesUrl !== baseUrl ||
      buildingsPMTilesUrl !== buildingsUrl ||
      transportationPMTilesUrl !== transportUrl
    ) {
      await pmtilesInitPromise;
      pmtilesInitialized = false;
    } else {
      await pmtilesInitPromise;
      return;
    }
  }

  pmtilesInitPromise = (async () => {
    try {
      basePMTilesUrl = baseUrl;
      buildingsPMTilesUrl = buildingsUrl;
      transportationPMTilesUrl = transportUrl;

      basePMTiles = new PMTiles(baseUrl);
      buildingsPMTiles = new PMTiles(buildingsUrl);
      transportationPMTiles = new PMTiles(transportUrl);

      // Verify headers are accessible (validates CORS)
      await Promise.all([
        basePMTiles.getHeader(),
        buildingsPMTiles.getHeader(),
        transportationPMTiles.getHeader(),
      ]);

      pmtilesInitialized = true;
    } catch (error) {
      console.error('[TreeProcessingWorker] Failed to initialize PMTiles:', error);
      basePMTiles = null;
      buildingsPMTiles = null;
      transportationPMTiles = null;
      basePMTilesUrl = null;
      buildingsPMTilesUrl = null;
      transportationPMTilesUrl = null;
      pmtilesInitialized = false;
      throw error;
    }
  })();

  try {
    await pmtilesInitPromise;
  } finally {
    pmtilesInitPromise = null;
  }
}

// ============================================================================
// TILE FETCHING AND PARSING
// ============================================================================

/**
 * Fetch tile data from PMTiles
 */
async function fetchTileData(
  pmtiles: PMTiles,
  z: number,
  x: number,
  y: number
): Promise<ArrayBuffer | null> {
  try {
    const result = await pmtiles.getZxy(z, x, y);
    return result?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Parse MVT data to features
 */
function parseMVT(
  data: ArrayBuffer,
  tileX: number,
  tileY: number,
  zoom: number,
  layerName: string | null = null
): ParsedFeature[] {
  const tile = new VectorTile(new Pbf(data));
  const features: ParsedFeature[] = [];

  const allLayerNames = Object.keys(tile.layers);
  const layerNames = layerName && tile.layers[layerName] ? [layerName] : allLayerNames;

  for (const name of layerNames) {
    const layer = tile.layers[name];
    if (!layer) continue;

    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      const geojson = feature.toGeoJSON(tileX, tileY, zoom);

      features.push({
        type: geojson.geometry.type,
        coordinates: geojson.geometry.coordinates,
        properties: feature.properties as Record<string, unknown>,
        layer: name,
      });
    }
  }

  return features;
}

/**
 * Calculate tile bounds from tile coordinates
 */
function tileToBounds(x: number, y: number, z: number): TileBounds {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  const north = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));

  const n2 = Math.PI - (2 * Math.PI * (y + 1)) / Math.pow(2, z);
  const south = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n2) - Math.exp(-n2)));

  const west = (x / Math.pow(2, z)) * 360 - 180;
  const east = ((x + 1) / Math.pow(2, z)) * 360 - 180;

  return { north, south, west, east };
}

// ============================================================================
// ELEVATION TILE HANDLING
// ============================================================================

interface CachedElevationTile {
  heights: Float32Array;
  bounds: { west: number; east: number; north: number; south: number };
}

// In-memory cache for elevation tiles within this worker
const elevationCache = new Map<string, CachedElevationTile>();

/**
 * Convert lng/lat to tile coordinates
 */
function lngLatToTile(lng: number, lat: number, zoom: number): [number, number] {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return [x, y];
}

/**
 * Get elevation tile bounds
 */
function elevationTileToBounds(x: number, y: number, zoom: number): { west: number; east: number; north: number; south: number } {
  const n = Math.pow(2, zoom);
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * (180 / Math.PI);
  const south = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * (180 / Math.PI);
  return { west, east, north, south };
}

/**
 * Decode Terrarium RGB to height
 */
function decodeTerrarium(r: number, g: number, b: number, offset: number): number {
  return (r * 256 + g + b / 256) - offset;
}

/**
 * Fetch and decode an elevation tile
 */
async function fetchElevationTile(
  x: number,
  y: number,
  config: ElevationConfig
): Promise<CachedElevationTile | null> {
  const key = `${config.zoom}/${x}/${y}`;

  // Check cache first
  const cached = elevationCache.get(key);
  if (cached) return cached;

  const url = config.urlTemplate
    .replace('{z}', config.zoom.toString())
    .replace('{x}', x.toString())
    .replace('{y}', y.toString());

  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);

    // Draw to offscreen canvas to get pixel data
    const canvas = new OffscreenCanvas(config.tileSize, config.tileSize);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, config.tileSize, config.tileSize);

    const imageData = ctx.getImageData(0, 0, config.tileSize, config.tileSize);
    const heights = new Float32Array(config.tileSize * config.tileSize);

    for (let i = 0; i < config.tileSize * config.tileSize; i++) {
      const r = imageData.data[i * 4];
      const g = imageData.data[i * 4 + 1];
      const b = imageData.data[i * 4 + 2];
      heights[i] = decodeTerrarium(r, g, b, config.terrariumOffset);
    }

    const bounds = elevationTileToBounds(x, y, config.zoom);
    const tile: CachedElevationTile = { heights, bounds };
    elevationCache.set(key, tile);

    return tile;
  } catch {
    return null;
  }
}

/**
 * Bilinear interpolation on height grid
 */
function bilinearInterpolate(
  heights: Float32Array,
  gridX: number,
  gridY: number,
  gridSize: number
): number {
  const clampedX = Math.max(0, Math.min(gridSize - 1, gridX));
  const clampedY = Math.max(0, Math.min(gridSize - 1, gridY));

  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(x0 + 1, gridSize - 1);
  const y1 = Math.min(y0 + 1, gridSize - 1);

  const fx = clampedX - x0;
  const fy = clampedY - y0;

  const h00 = heights[y0 * gridSize + x0];
  const h10 = heights[y0 * gridSize + x1];
  const h01 = heights[y1 * gridSize + x0];
  const h11 = heights[y1 * gridSize + x1];

  // Handle NaN values
  const corners = [h00, h10, h01, h11];
  const validCorners = corners.filter(h => !Number.isNaN(h));
  if (validCorners.length === 0) return 0;

  if (validCorners.length < 4) {
    const avg = validCorners.reduce((a, b) => a + b, 0) / validCorners.length;
    const h00Safe = Number.isNaN(h00) ? avg : h00;
    const h10Safe = Number.isNaN(h10) ? avg : h10;
    const h01Safe = Number.isNaN(h01) ? avg : h01;
    const h11Safe = Number.isNaN(h11) ? avg : h11;
    return h00Safe * (1 - fx) * (1 - fy) + h10Safe * fx * (1 - fy) + h01Safe * (1 - fx) * fy + h11Safe * fx * fy;
  }

  return h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;
}

/**
 * Get terrain height at a coordinate using cached elevation tiles
 */
function getTerrainHeightFromCache(
  lng: number,
  lat: number,
  config: ElevationConfig
): number {
  const [tileX, tileY] = lngLatToTile(lng, lat, config.zoom);
  const key = `${config.zoom}/${tileX}/${tileY}`;

  const cached = elevationCache.get(key);
  if (!cached) return 0;

  const { heights, bounds } = cached;

  // Calculate position within tile
  const relX = (lng - bounds.west) / (bounds.east - bounds.west);
  const relY = (bounds.north - lat) / (bounds.north - bounds.south);

  const gridX = relX * (config.tileSize - 1);
  const gridY = relY * (config.tileSize - 1);

  const height = bilinearInterpolate(heights, gridX, gridY, config.tileSize);
  return Number.isNaN(height) ? 0 : height;
}

/**
 * Prefetch all elevation tiles needed for tree positions
 */
async function prefetchElevationTilesForTrees(
  trees: TreeData[],
  config: ElevationConfig
): Promise<void> {
  const neededTiles = new Set<string>();

  // Collect all unique tile coordinates
  for (const tree of trees) {
    const [tileX, tileY] = lngLatToTile(tree.lng, tree.lat, config.zoom);
    neededTiles.add(`${tileX}/${tileY}`);
  }

  // Fetch all tiles in parallel
  const fetchPromises: Promise<CachedElevationTile | null>[] = [];
  for (const tileKey of neededTiles) {
    const [x, y] = tileKey.split('/').map(Number);
    fetchPromises.push(fetchElevationTile(x, y, config));
  }

  await Promise.all(fetchPromises);
}

/**
 * Compute terrain heights for all trees
 */
async function computeTerrainHeightsForTrees(
  trees: TreeData[],
  config: ElevationConfig,
  verticalExaggeration: number
): Promise<void> {
  // Prefetch elevation tiles
  await prefetchElevationTilesForTrees(trees, config);

  // Compute heights
  for (const tree of trees) {
    const rawHeight = getTerrainHeightFromCache(tree.lng, tree.lat, config);
    tree.terrainHeight = rawHeight * verticalExaggeration;
  }
}

// Lower zoom levels to check for water polygons
const WATER_ZOOM_LEVELS = [12, 11, 10, 9, 8];

/**
 * Load base tile features
 */
async function loadBaseTile(x: number, y: number, zoom: number): Promise<ParsedFeature[]> {
  if (!basePMTiles) return [];

  const data = await fetchTileData(basePMTiles, zoom, x, y);
  if (data) {
    return parseMVT(data, x, y, zoom);
  }
  return [];
}

/**
 * Load water polygons from lower zoom levels for better coverage
 */
async function loadWaterPolygons(x: number, y: number, zoom: number): Promise<ParsedFeature[]> {
  if (!basePMTiles) return [];

  const features: ParsedFeature[] = [];
  const seenPolygons = new Set<string>();

  for (const fallbackZoom of WATER_ZOOM_LEVELS) {
    if (fallbackZoom > zoom) continue;

    const scale = Math.pow(2, zoom - fallbackZoom);
    const fallbackX = Math.floor(x / scale);
    const fallbackY = Math.floor(y / scale);

    const data = await fetchTileData(basePMTiles, fallbackZoom, fallbackX, fallbackY);
    if (data) {
      const allFeatures = parseMVT(data, fallbackX, fallbackY, fallbackZoom, 'water');
      for (const feature of allFeatures) {
        if (feature.type === 'Polygon' || feature.type === 'MultiPolygon') {
          // Deduplicate by coordinates hash
          const coordHash = JSON.stringify(feature.coordinates).slice(0, 100);
          if (!seenPolygons.has(coordHash)) {
            seenPolygons.add(coordHash);
            features.push(feature);
          }
        }
      }
    }
  }

  return features;
}

/**
 * Load building tile features
 */
async function loadBuildingTile(x: number, y: number, zoom: number): Promise<ParsedFeature[]> {
  if (!buildingsPMTiles) return [];

  const data = await fetchTileData(buildingsPMTiles, zoom, x, y);
  if (data) {
    return parseMVT(data, x, y, zoom);
  }
  return [];
}

/**
 * Load transportation tile features
 */
async function loadTransportationTile(x: number, y: number, zoom: number): Promise<ParsedFeature[]> {
  if (!transportationPMTiles) return [];

  const data = await fetchTileData(transportationPMTiles, zoom, x, y);
  if (data) {
    return parseMVT(data, x, y, zoom);
  }
  return [];
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

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
 */
function calculatePolygonAreaMeters(polygon: number[][]): number {
  if (polygon.length < 3) return 0;

  let centroidLat = 0;
  for (const [, lat] of polygon) {
    centroidLat += lat;
  }
  centroidLat /= polygon.length;

  let area = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    area += (polygon[j][0] + polygon[i][0]) * (polygon[j][1] - polygon[i][1]);
  }
  area = Math.abs(area / 2);

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

// ============================================================================
// TREE GENERATION
// ============================================================================

/**
 * Generate trees within a single polygon based on landcover type
 */
function generateTreesInPolygon(
  polygon: number[][],
  _subtype: string,
  config: LandcoverTreeConfig,
  random: () => number,
  maxTrees: number
): TreeData[] {
  const trees: TreeData[] = [];
  const areaSqMeters = calculatePolygonAreaMeters(polygon);

  // Calculate number of trees based on area and density
  const treesPerHectare = config.density;
  const areaHectares = areaSqMeters / 10000;
  let targetTreeCount = Math.ceil(areaHectares * treesPerHectare);
  targetTreeCount = Math.min(targetTreeCount, maxTrees);

  if (targetTreeCount <= 0) return trees;

  // Get polygon bounds for rejection sampling
  const bounds = getPolygonBounds(polygon);

  // Generate trees using rejection sampling
  let attempts = 0;
  const maxAttempts = targetTreeCount * 10;

  while (trees.length < targetTreeCount && attempts < maxAttempts) {
    attempts++;

    const lng = bounds.minLng + random() * (bounds.maxLng - bounds.minLng);
    const lat = bounds.minLat + random() * (bounds.maxLat - bounds.minLat);

    if (!pointInPolygon(lng, lat, polygon)) {
      continue;
    }

    // Determine tree type based on config
    const isConifer = random() < config.coniferRatio;
    const leafType = isConifer ? 'needleleaved' : 'broadleaved';

    // Calculate height with variation
    const baseHeight = config.minHeight + random() * (config.maxHeight - config.minHeight);
    const height = baseHeight + (random() - 0.5) * 2 * config.heightVariation;

    trees.push({
      lat,
      lng,
      height: Math.max(config.minHeight, Math.min(config.maxHeight, height)),
      leafType,
    });
  }

  return trees;
}

/**
 * Generate procedural trees from landcover polygons
 */
function generateProceduralTrees(
  features: ParsedFeature[],
  tileX: number,
  tileY: number,
  tileZ: number,
  landcoverConfig: Record<string, LandcoverTreeConfig>,
  maxTrees: number
): TreeData[] {
  const seed = getTileSeed(tileX, tileY, tileZ);
  const random = seededRandom(seed);

  const allTrees: TreeData[] = [];

  for (const feature of features) {
    if (feature.layer !== 'land_cover') continue;

    const subtype = (feature.properties.subtype as string) || '';
    const config = landcoverConfig[subtype];
    if (!config) continue;

    const remainingSlots = maxTrees - allTrees.length;
    if (remainingSlots <= 0) break;

    if (feature.type === 'Polygon') {
      const rings = feature.coordinates as number[][][];
      if (rings.length > 0) {
        const trees = generateTreesInPolygon(rings[0], subtype, config, random, remainingSlots);
        allTrees.push(...trees);
      }
    } else if (feature.type === 'MultiPolygon') {
      const polygons = feature.coordinates as number[][][][];
      for (const rings of polygons) {
        const remaining = maxTrees - allTrees.length;
        if (remaining <= 0) break;
        if (rings.length > 0) {
          const trees = generateTreesInPolygon(rings[0], subtype, config, random, remaining);
          allTrees.push(...trees);
        }
      }
    }
  }

  return allTrees;
}

/**
 * Generate trees based on OSM density data
 */
function generateOSMDensityTrees(
  tileX: number,
  tileY: number,
  tileZ: number,
  bounds: TileBounds,
  tileHint: { count: number; coniferRatio: number } | null,
  maxTrees: number
): TreeData[] {
  if (!tileHint || tileHint.count <= 0) {
    return [];
  }

  const seed = getTileSeed(tileX, tileY, tileZ) + 99999;
  const random = seededRandom(seed);

  const trees: TreeData[] = [];
  const targetCount = Math.min(tileHint.count, maxTrees);
  const coniferRatio = tileHint.coniferRatio;

  for (let i = 0; i < targetCount; i++) {
    const lng = bounds.west + random() * (bounds.east - bounds.west);
    const lat = bounds.south + random() * (bounds.north - bounds.south);

    const isConifer = random() < coniferRatio;
    const leafType = isConifer ? 'needleleaved' : 'broadleaved';

    // Variable height based on type
    const baseHeight = isConifer ? 12 : 10;
    const height = baseHeight + (random() - 0.5) * 8;

    trees.push({
      lat,
      lng,
      height: Math.max(4, Math.min(25, height)),
      leafType,
    });
  }

  return trees;
}

// ============================================================================
// SPATIAL FILTERING
// ============================================================================

interface PolygonWithBounds {
  rings: number[][][];
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
}

// Road buffer distances by class (in meters)
const ROAD_BUFFER_METERS: Record<string, number> = {
  motorway: 25,
  trunk: 20,
  primary: 15,
  secondary: 12,
  tertiary: 10,
  residential: 6,
  service: 4,
  default: 8,
};

interface RoadWithBounds {
  feature: ParsedFeature;
  bufferMeters: number;
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
}

/**
 * Preprocess polygons for fast filtering
 */
function preprocessPolygons(features: ParsedFeature[]): PolygonWithBounds[] {
  const result: PolygonWithBounds[] = [];

  for (const feature of features) {
    if (feature.type === 'Polygon') {
      const rings = feature.coordinates as number[][][];
      if (rings.length === 0 || rings[0].length === 0) continue;

      const bounds = getPolygonBounds(rings[0]);
      result.push({
        rings,
        minLng: bounds.minLng,
        maxLng: bounds.maxLng,
        minLat: bounds.minLat,
        maxLat: bounds.maxLat,
      });
    } else if (feature.type === 'MultiPolygon') {
      const polygons = feature.coordinates as number[][][][];
      for (const rings of polygons) {
        if (rings.length === 0 || rings[0].length === 0) continue;

        const bounds = getPolygonBounds(rings[0]);
        result.push({
          rings,
          minLng: bounds.minLng,
          maxLng: bounds.maxLng,
          minLat: bounds.minLat,
          maxLat: bounds.maxLat,
        });
      }
    }
  }

  return result;
}

/**
 * Preprocess roads for fast filtering
 */
function preprocessRoads(features: ParsedFeature[]): RoadWithBounds[] {
  const result: RoadWithBounds[] = [];
  // Convert max buffer to approximate degrees for bbox expansion
  const bufferDegrees = 25 / 111320;

  for (const feature of features) {
    if (feature.type !== 'LineString' && feature.type !== 'MultiLineString') {
      continue;
    }

    const roadClass = (feature.properties.class as string) || 'default';
    const bufferMeters = ROAD_BUFFER_METERS[roadClass] || ROAD_BUFFER_METERS.default;

    let minLng = Infinity, maxLng = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;

    if (feature.type === 'LineString') {
      const coords = feature.coordinates as number[][];
      for (const [lng, lat] of coords) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    } else {
      const lines = feature.coordinates as number[][][];
      for (const line of lines) {
        for (const [lng, lat] of line) {
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
      }
    }

    result.push({
      feature,
      bufferMeters,
      minLng: minLng - bufferDegrees,
      maxLng: maxLng + bufferDegrees,
      minLat: minLat - bufferDegrees,
      maxLat: maxLat + bufferDegrees,
    });
  }

  return result;
}

function pointInPolygonWithHoles(lng: number, lat: number, rings: number[][][]): boolean {
  if (rings.length === 0) return false;

  if (!pointInPolygon(lng, lat, rings[0])) {
    return false;
  }

  for (let i = 1; i < rings.length; i++) {
    if (pointInPolygon(lng, lat, rings[i])) {
      return false;
    }
  }

  return true;
}

function isPointInPolygons(lng: number, lat: number, polygons: PolygonWithBounds[]): boolean {
  for (const polygon of polygons) {
    if (lng < polygon.minLng || lng > polygon.maxLng || lat < polygon.minLat || lat > polygon.maxLat) {
      continue;
    }
    if (pointInPolygonWithHoles(lng, lat, polygon.rings)) {
      return true;
    }
  }
  return false;
}

function pointToSegmentDistanceMeters(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;

  let t = 0;
  if (lengthSq > 0) {
    t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
  }

  const nearestX = x1 + t * dx;
  const nearestY = y1 + t * dy;

  const metersPerDegreeLat = 111320;
  const metersPerDegreeLng = 111320 * Math.cos(py * Math.PI / 180);

  const distLng = (px - nearestX) * metersPerDegreeLng;
  const distLat = (py - nearestY) * metersPerDegreeLat;

  return Math.sqrt(distLng * distLng + distLat * distLat);
}

function isPointNearRoad(lng: number, lat: number, roads: RoadWithBounds[]): boolean {
  for (const road of roads) {
    if (lng < road.minLng || lng > road.maxLng || lat < road.minLat || lat > road.maxLat) {
      continue;
    }

    const feature = road.feature;
    const bufferMeters = road.bufferMeters;

    if (feature.type === 'LineString') {
      const coords = feature.coordinates as number[][];
      for (let i = 0; i < coords.length - 1; i++) {
        const dist = pointToSegmentDistanceMeters(
          lng, lat,
          coords[i][0], coords[i][1],
          coords[i + 1][0], coords[i + 1][1]
        );
        if (dist < bufferMeters) {
          return true;
        }
      }
    } else if (feature.type === 'MultiLineString') {
      const lines = feature.coordinates as number[][][];
      for (const line of lines) {
        for (let i = 0; i < line.length - 1; i++) {
          const dist = pointToSegmentDistanceMeters(
            lng, lat,
            line[i][0], line[i][1],
            line[i + 1][0], line[i + 1][1]
          );
          if (dist < bufferMeters) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

// ============================================================================
// MAIN PROCESSING FUNCTION
// ============================================================================

interface ProcessTreesPayloadInternal {
  tileX: number;
  tileY: number;
  tileZ: number;
  landcoverConfig: Record<string, LandcoverTreeConfig>;
  maxProceduralTrees: number;
  maxOSMDensityTrees: number;
  basePMTilesUrl: string;
  buildingsPMTilesUrl: string;
  transportationPMTilesUrl: string;
  treeTilesUrl: string;
  treeTilesZoom: number;
  elevationConfig?: ElevationConfig;
  verticalExaggeration?: number;
}

async function processTrees(payload: ProcessTreesPayloadInternal): Promise<ProcessTreesResult> {
  const {
    tileX,
    tileY,
    tileZ,
    landcoverConfig,
    maxProceduralTrees,
    maxOSMDensityTrees,
    basePMTilesUrl,
    buildingsPMTilesUrl,
    transportationPMTilesUrl,
    treeTilesUrl,
    // treeTilesZoom is ignored - we read the actual zoom from the file header
    elevationConfig,
    verticalExaggeration = 1.0,
  } = payload;

  // Initialize PMTiles and tree hints in parallel
  await Promise.all([
    initializePMTiles(basePMTilesUrl, buildingsPMTilesUrl, transportationPMTilesUrl),
    loadTreeHints(treeTilesUrl),
  ]);

  // Look up tile hint from worker-loaded data (uses zoom from file header)
  const tileHint = getTileHint(tileX, tileY, tileZ);

  // Calculate bounds
  const bounds = tileToBounds(tileX, tileY, tileZ);

  // Fetch all required features in parallel
  const [baseFeatures, waterFeatures, buildingFeatures, roadFeatures] = await Promise.all([
    loadBaseTile(tileX, tileY, tileZ),
    loadWaterPolygons(tileX, tileY, tileZ),
    loadBuildingTile(tileX, tileY, tileZ),
    loadTransportationTile(tileX, tileY, tileZ),
  ]);

  // Generate trees from both sources
  const osmTrees = generateOSMDensityTrees(
    tileX, tileY, tileZ,
    bounds,
    tileHint,
    maxOSMDensityTrees
  );

  const proceduralTrees = generateProceduralTrees(
    baseFeatures,
    tileX, tileY, tileZ,
    landcoverConfig,
    maxProceduralTrees
  );

  let allTrees = [...osmTrees, ...proceduralTrees];
  const totalBefore = allTrees.length;

  // Preprocess polygons and roads for fast filtering
  const processedWater = preprocessPolygons(waterFeatures);
  const processedBuildings = preprocessPolygons(buildingFeatures);
  const processedRoads = preprocessRoads(roadFeatures);

  // Filter trees
  allTrees = allTrees.filter(tree => {
    const { lng, lat } = tree;

    if (processedWater.length > 0 && isPointInPolygons(lng, lat, processedWater)) {
      return false;
    }

    if (processedBuildings.length > 0 && isPointInPolygons(lng, lat, processedBuildings)) {
      return false;
    }

    if (processedRoads.length > 0 && isPointNearRoad(lng, lat, processedRoads)) {
      return false;
    }

    return true;
  });

  // Compute terrain heights for filtered trees (HTTP cache should hit)
  if (elevationConfig && allTrees.length > 0) {
    await computeTerrainHeightsForTrees(allTrees, elevationConfig, verticalExaggeration);
  }

  return {
    trees: allTrees,
    stats: {
      osmTrees: osmTrees.length,
      proceduralTrees: proceduralTrees.length,
      filteredOut: totalBefore - allTrees.length,
    },
  };
}

// ============================================================================
// WORKER MESSAGE HANDLER
// ============================================================================

interface TreeProcessRequest {
  type: 'PROCESS_TREES';
  id: string;
  payload: ProcessTreesPayloadInternal;
}

interface CapabilityRequest {
  type: 'CAPABILITY_CHECK';
  id: string;
}

type WorkerRequest = TreeProcessRequest | CapabilityRequest;

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  if (request.type === 'CAPABILITY_CHECK') {
    const response: WorkerResponse = {
      type: 'CAPABILITY_CHECK_RESULT',
      id: request.id,
      supported: true,
    };
    self.postMessage(response);
    return;
  }

  if (request.type === 'PROCESS_TREES') {
    try {
      const result = await processTrees(request.payload);
      const response: WorkerResponse = {
        type: 'PROCESS_TREES_RESULT',
        id: request.id,
        result,
      };
      self.postMessage(response);
    } catch (error) {
      const response: WorkerResponse = {
        type: 'ERROR',
        id: request.id,
        error: (error as Error).message,
      };
      self.postMessage(response);
    }
    return;
  }
};

// Signal ready
self.postMessage({ type: 'READY' });
