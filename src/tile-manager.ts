import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { PROFILING, WORKERS } from './constants.js';
import { initializeOvertureSources, isUnavailableOvertureSource } from './overture-sources.js';
import { getOrigin } from './scene.js';
import { getFetchSemaphore, TilePriority } from './semaphore.js';
import { recordFetchTiming, mark, measure } from './profiling/tile-profiler.js';
import { getMVTWorkerPool, compactFeatureToFeature } from './workers/index.js';

// Types
export interface TileBounds {
  west: number;
  east: number;
  north: number;
  south: number;
}

export interface WorldBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface ParsedFeature {
  type: string;
  coordinates: number[] | number[][] | number[][][] | number[][][][];
  properties: Record<string, unknown>;
  layer: string;
}

export interface TileInfo {
  x: number;
  y: number;
  z: number;
  key: string;
}

interface InitStatus {
  buildings: boolean;
  base: boolean;
  transportation: boolean;
  errors: string[];
}

// PMTiles sources
let buildingsPMTiles: PMTiles | null = null;
let basePMTiles: PMTiles | null = null;
let transportationPMTiles: PMTiles | null = null;
let buildingsMaxZoom: number | null = null;
let baseMaxZoom: number | null = null;
let transportationMaxZoom: number | null = null;

// Track initialization errors for user feedback
let initErrors: string[] = [];

/**
 * Retry a fetch operation with exponential backoff
 */
async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Get any initialization errors that occurred
 */
export function getInitErrors(): string[] {
  return [...initErrors];
}

// Water polygon cache - keyed by lower zoom tile "z/x/y"
// Shared between base-layer (for rendering) and tree-layer (for filtering)
const waterPolygonCache = new Map<string, ParsedFeature[]>();

// In-flight request deduplication cache
// Key format: "source:z/x/y:layerName" to prevent cross-contamination between different layer requests
// For example: "base:14/1234/5678:__ALL__" vs "base:14/1234/5678:water"
// Tracks both promise and priority - higher priority requests skip dedupe to avoid being delayed
interface InFlightRequest {
  promise: Promise<ParsedFeature[]>;
  priority: TilePriority;
}
const inFlightRequests = new Map<string, InFlightRequest>();

// Tile loading settings (aggressive performance tuning)
// Simulation detail zoom; each PMTiles source is capped independently from its header.
const TILE_ZOOM = 14;
const TILE_RADIUS = 1; // Load tiles within this radius of center (3x3 grid)
const PREDICTIVE_TILES = 2; // Max tiles ahead to load based on heading (reduced from 4 for perf)
const SPEED_THRESHOLD = 10; // m/s (~22 mph) - lowered to trigger predictive loading at slower speeds
// Speed divisor to calculate tiles ahead: tilesAhead = speed / SPEED_TO_TILES_DIVISOR
// At 25 m/s = 1 tile ahead, 50 m/s = 2 tiles
const SPEED_TO_TILES_DIVISOR = 25;
const MIN_FALLBACK_ZOOM = 6; // Minimum zoom level for base tile fallback
const WATER_POLYGON_ZOOM_LEVELS = [10, 8, 6]; // Lower zoom levels to check for larger water polygons

// ============================================================================
// HEADING TRIGONOMETRY CACHE
// ============================================================================
// Cache sin/cos values to avoid recalculating every frame
// Quantizes heading to integer degrees for cache efficiency

interface HeadingTrig {
  heading: number;  // Quantized heading (integer degrees)
  sinH: number;     // sin(heading in radians)
  cosH: number;     // cos(heading in radians)
}

let cachedHeadingTrig: HeadingTrig | null = null;

/**
 * Get cached sin/cos values for a heading
 * Quantizes to integer degrees to improve cache hit rate
 */
function getHeadingTrig(heading: number): { sinH: number; cosH: number } {
  // Quantize to integer degrees (0-359), handling negative values correctly
  const quantizedHeading = ((Math.round(heading) % 360) + 360) % 360;

  // Return cached values if heading hasn't changed
  if (cachedHeadingTrig && cachedHeadingTrig.heading === quantizedHeading) {
    return { sinH: cachedHeadingTrig.sinH, cosH: cachedHeadingTrig.cosH };
  }

  // Calculate new values
  const headingRad = (quantizedHeading * Math.PI) / 180;
  const sinH = Math.sin(headingRad);
  const cosH = Math.cos(headingRad);

  // Cache the result
  cachedHeadingTrig = { heading: quantizedHeading, sinH, cosH };

  return { sinH, cosH };
}

// Constants for geo conversion
const METERS_PER_DEGREE_LAT = 111320;
const metersPerDegreeLng = (lat: number): number => 111320 * Math.cos(lat * Math.PI / 180);

/**
 * Initialize PMTiles sources with retry logic
 */
export async function initTileManager(): Promise<InitStatus> {
  initErrors = [];
  buildingsMaxZoom = null;
  baseMaxZoom = null;
  transportationMaxZoom = null;

  // Also initialize here so direct users of the tile manager cannot bypass
  // the application's Overture source bootstrap.
  const overtureSources = await initializeOvertureSources();

  // Placeholder sources represent a known discovery failure. Do not run the
  // normal network retry/backoff loop for them, which would delay partial app
  // startup by several seconds per unavailable theme.
  const initializeSource = async (url: string, label: string): Promise<{ pmtiles: PMTiles; maxZoom: number } | null> => {
    if (isUnavailableOvertureSource(url)) {
      const msg = `Failed to load ${label} data: latest Overture release is unavailable`;
      console.warn(msg);
      initErrors.push(msg);
      return null;
    }

    const source = new PMTiles(url);
    try {
      const header = await retryWithBackoff(() => source.getHeader(), 3, 1000);
      return { pmtiles: source, maxZoom: header.maxZoom };
    } catch (e) {
      const error = e as Error;
      const msg = `Failed to load ${label} data: ${error.message || 'Network error'}`;
      console.error(msg, e);
      initErrors.push(msg);
      return null;
    }
  };

  const [buildingsResult, baseResult, transportResult] = await Promise.all([
    initializeSource(overtureSources.buildings, 'buildings'),
    initializeSource(overtureSources.base, 'terrain'),
    initializeSource(overtureSources.transportation, 'transportation'),
  ]);

  buildingsPMTiles = buildingsResult?.pmtiles ?? null;
  buildingsMaxZoom = buildingsResult?.maxZoom ?? null;
  basePMTiles = baseResult?.pmtiles ?? null;
  baseMaxZoom = baseResult?.maxZoom ?? null;
  transportationPMTiles = transportResult?.pmtiles ?? null;
  transportationMaxZoom = transportResult?.maxZoom ?? null;

  // Return status for caller to handle
  return {
    buildings: buildingsPMTiles !== null,
    base: basePMTiles !== null,
    transportation: transportationPMTiles !== null,
    errors: initErrors
  };
}

interface SourceTileCoordinates {
  x: number;
  y: number;
  z: number;
}

/**
 * Map a requested tile to the highest-detail tile available in a PMTiles source.
 * A source tile can cover multiple requested tiles when its max zoom is lower.
 */
function mapTileToSourceZoom(
  x: number,
  y: number,
  zoom: number,
  maxZoom: number
): SourceTileCoordinates {
  if (zoom <= maxZoom) {
    return { x, y, z: zoom };
  }

  const scale = Math.pow(2, zoom - maxZoom);
  return {
    x: Math.floor(x / scale),
    y: Math.floor(y / scale),
    z: maxZoom,
  };
}

/**
 * Convert lng/lat to tile coordinates
 */
export function lngLatToTile(lng: number, lat: number, zoom: number): [number, number] {
  const n = Math.pow(2, zoom);
  const rawX = Math.floor((lng + 180) / 360 * n);
  const x = ((rawX % n) + n) % n;
  // Web Mercator is finite only within this latitude range. Clamping keeps
  // callers at the poles from producing infinite/out-of-world tile rows.
  const mercatorLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const latRad = mercatorLat * Math.PI / 180;
  const rawY = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
  const y = Math.max(0, Math.min(n - 1, rawY));
  return [x, y];
}

/**
 * Convert tile coordinates to lng/lat bounds
 */
export function tileToBounds(x: number, y: number, zoom: number): TileBounds {
  const n = Math.pow(2, zoom);
  const west = x / n * 360 - 180;
  const east = (x + 1) / n * 360 - 180;
  const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return { west, east, north, south };
}

/**
 * Convert tile bounds to world coordinates
 */
export function tileToWorldBounds(x: number, y: number, zoom: number): WorldBounds {
  const origin = getOrigin();
  const bounds = tileToBounds(x, y, zoom);

  return {
    minX: (bounds.west - origin.lng) * metersPerDegreeLng(origin.lat),
    maxX: (bounds.east - origin.lng) * metersPerDegreeLng(origin.lat),
    minZ: -(bounds.north - origin.lat) * METERS_PER_DEGREE_LAT,
    maxZ: -(bounds.south - origin.lat) * METERS_PER_DEGREE_LAT
  };
}

/**
 * Parse MVT data and extract features
 * Records parse timing for profiling when enabled
 */
export function parseMVT(
  data: ArrayBuffer,
  tileX: number,
  tileY: number,
  zoom: number,
  layerName: string | null = null
): ParsedFeature[] {
  const parseStart = PROFILING.ENABLED ? performance.now() : 0;
  const tileKey = `${zoom}/${tileX}/${tileY}`;

  if (PROFILING.ENABLED) {
    mark(`mvt:parse:start:${tileKey}`);
  }

  const tile = new VectorTile(new Pbf(data));
  const features: ParsedFeature[] = [];

  const allLayerNames = Object.keys(tile.layers);

  // If layer name not found, use all available layers
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
        layer: name
      });
    }
  }

  if (PROFILING.ENABLED) {
    const parseEnd = performance.now();
    mark(`mvt:parse:end:${tileKey}`);
    measure(`mvt:parse:${tileKey}`, `mvt:parse:start:${tileKey}`, `mvt:parse:end:${tileKey}`);
    // Record parse time (network time is recorded separately in getTileData)
    recordFetchTiming(0, parseEnd - parseStart);
  }

  return features;
}

/**
 * Parse MVT data asynchronously using web worker (if enabled)
 * Falls back to synchronous parsing on main thread if workers disabled
 *
 * @param data - MVT tile ArrayBuffer (NOTE: this buffer is transferred to worker and becomes unusable)
 * @param tileX - Tile X coordinate
 * @param tileY - Tile Y coordinate
 * @param zoom - Zoom level
 * @param layerName - Optional layer name filter
 * @returns Parsed features
 */
export async function parseMVTAsync(
  data: ArrayBuffer,
  tileX: number,
  tileY: number,
  zoom: number,
  layerName: string | null = null
): Promise<ParsedFeature[]> {
  // Use worker if enabled, otherwise fall back to synchronous parsing
  if (!WORKERS.MVT_ENABLED) {
    return parseMVT(data, tileX, tileY, zoom, layerName);
  }

  const parseStart = PROFILING.ENABLED ? performance.now() : 0;
  const tileKey = `${zoom}/${tileX}/${tileY}`;

  if (PROFILING.ENABLED) {
    mark(`mvt:parse:async:start:${tileKey}`);
  }

  try {
    const pool = getMVTWorkerPool();
    const result = await pool.parseMVT(data, tileX, tileY, zoom, layerName);

    // Convert CompactFeature[] back to ParsedFeature[]
    const features = result.features.map(compactFeatureToFeature);

    if (PROFILING.ENABLED) {
      const parseEnd = performance.now();
      mark(`mvt:parse:async:end:${tileKey}`);
      measure(`mvt:parse:async:${tileKey}`, `mvt:parse:async:start:${tileKey}`, `mvt:parse:async:end:${tileKey}`);
      recordFetchTiming(0, parseEnd - parseStart);
    }

    return features;
  } catch (error) {
    // Fall back to synchronous parsing if worker fails
    console.warn(`MVT worker parsing failed for ${tileKey}, falling back to main thread:`, error);
    // Note: data may be transferred and unusable, so we can't fall back
    // Return empty array to prevent errors
    return [];
  }
}

/**
 * Get tile data from PMTiles source with retry logic
 * Uses priority-based fetch queue to prevent request flooding
 * Returns ArrayBuffer and optionally records network timing for profiling
 */
async function getTileData(
  pmtiles: PMTiles | null,
  z: number,
  x: number,
  y: number,
  priority: TilePriority = TilePriority.BUILDINGS
): Promise<ArrayBuffer | null> {
  if (!pmtiles) {
    return null;
  }

  // Use fetch semaphore to limit concurrent network requests
  const semaphore = getFetchSemaphore();
  const fetchFn = async (): Promise<ArrayBuffer | null> => {
    const tileKey = `${z}/${x}/${y}`;
    const networkStart = PROFILING.ENABLED ? performance.now() : 0;

    try {
      if (PROFILING.ENABLED) {
        mark(`pmtiles:fetch:start:${tileKey}`);
      }

      const result = await retryWithBackoff(
        () => pmtiles.getZxy(z, x, y),
        2, // fewer retries for individual tiles
        500
      );

      if (PROFILING.ENABLED) {
        const networkEnd = performance.now();
        mark(`pmtiles:fetch:end:${tileKey}`);
        measure(`pmtiles:fetch:${tileKey}`, `pmtiles:fetch:start:${tileKey}`, `pmtiles:fetch:end:${tileKey}`);
        // Record just the network time here; parse time will be recorded in parseMVT
        recordFetchTiming(networkEnd - networkStart, 0);
      }

      if (result && result.data) {
        return result.data;
      }
      return null;
    } catch (e) {
      // Only log occasionally to avoid spam
      if (Math.random() < 0.1) {
        console.warn(`PMTiles tile ${z}/${x}/${y} failed after retries:`, (e as Error).message);
      }
      return null;
    }
  };

  if (semaphore) {
    return semaphore.run(fetchFn, priority);
  }
  return fetchFn();
}

/**
 * Load building features for a tile
 * Loads both 'building' and 'building_part' layers from the PMTiles
 */
export async function loadBuildingTile(
  x: number,
  y: number,
  zoom: number = TILE_ZOOM
): Promise<ParsedFeature[]> {
  if (!buildingsPMTiles || buildingsMaxZoom === null) return [];

  const sourceTile = mapTileToSourceZoom(x, y, zoom, buildingsMaxZoom);

  // Buildings have lowest priority in fetch queue
  const data = await getTileData(
    buildingsPMTiles,
    sourceTile.z,
    sourceTile.x,
    sourceTile.y,
    TilePriority.BUILDINGS
  );
  if (!data) return [];

  // Load all layers (building + building_part) from the buildings PMTiles
  return parseMVTAsync(data, sourceTile.x, sourceTile.y, sourceTile.z, null);
}

/**
 * Load base layer features for a tile (land, water, etc.)
 * Tries multiple fallback zoom levels if the requested zoom has no data
 * Uses request deduplication to prevent redundant fetches for the same tile
 * @param priority - Fetch priority (Z14_GROUND for high-detail, Z10_GROUND for low-detail)
 */
export async function loadBaseTile(
  x: number,
  y: number,
  zoom: number = TILE_ZOOM,
  priority: TilePriority = TilePriority.Z14_GROUND
): Promise<ParsedFeature[]> {
  if (!basePMTiles || baseMaxZoom === null) {
    console.warn('Base PMTiles not initialized');
    return [];
  }

  const sourceTile = mapTileToSourceZoom(x, y, zoom, baseMaxZoom);

  // Check deduplication cache - key includes source and layer (__ALL__ = all layers)
  const dedupeKey = `base:${sourceTile.z}/${sourceTile.x}/${sourceTile.y}:__ALL__`;
  const existing = inFlightRequests.get(dedupeKey);
  // Only dedupe if existing request has same or higher priority (lower number)
  // Higher priority requests skip dedupe to avoid being delayed by lower priority ones
  if (existing && existing.priority <= priority) {
    return existing.promise;
  }

  // Create the loading promise
  const loadPromise = (async (): Promise<ParsedFeature[]> => {
    const data = await getTileData(
      basePMTiles,
      sourceTile.z,
      sourceTile.x,
      sourceTile.y,
      priority
    );
    if (data) {
      // Base PMTiles has layers: water, land, land_use, land_cover, infrastructure
      return parseMVTAsync(data, sourceTile.x, sourceTile.y, sourceTile.z);
    }

    // Try fallback zoom levels from the source's highest available zoom down to MIN_FALLBACK_ZOOM
    // Water and land data may only be available at certain zoom levels in the PMTiles
    for (let fallbackZoom = sourceTile.z - 1; fallbackZoom >= MIN_FALLBACK_ZOOM; fallbackZoom--) {
      const scale = Math.pow(2, sourceTile.z - fallbackZoom);
      const fallbackX = Math.floor(sourceTile.x / scale);
      const fallbackY = Math.floor(sourceTile.y / scale);

      const fallbackData = await getTileData(basePMTiles, fallbackZoom, fallbackX, fallbackY, priority);
      if (fallbackData) {
        return parseMVTAsync(fallbackData, fallbackX, fallbackY, fallbackZoom);
      }
    }

    return [];
  })();

  // Store in deduplication cache and clean up when done
  inFlightRequests.set(dedupeKey, { promise: loadPromise, priority });
  loadPromise.finally(() => {
    // Only delete if this is still our request (higher priority may have replaced it)
    const current = inFlightRequests.get(dedupeKey);
    if (current?.promise === loadPromise) {
      inFlightRequests.delete(dedupeKey);
    }
  });

  return loadPromise;
}

/**
 * Load water polygon features from lower zoom levels
 * This helps find larger water bodies (like full river extents) that may only
 * be represented as polygons at lower (zoomed out) zoom levels.
 * At higher zooms, rivers often only exist as line features.
 *
 * Results are cached by lower zoom tile coordinates for efficiency -
 * multiple detail tiles share the same lower zoom water data.
 * @param priority - Fetch priority (Z14_GROUND for high-detail, Z10_GROUND for low-detail)
 * @param fastMode - If true, only load z10 (skip z8/z6) for faster initial load
 */
export async function loadWaterPolygonsFromLowerZooms(
  x: number,
  y: number,
  zoom: number = TILE_ZOOM,
  priority: TilePriority = TilePriority.Z14_GROUND,
  fastMode: boolean = false
): Promise<ParsedFeature[]> {
  if (!basePMTiles || baseMaxZoom === null) {
    return [];
  }

  const waterPolygons: ParsedFeature[] = [];
  const seenAreas = new Set<string>(); // Track polygons to avoid duplicates

  // In fast mode, only check z10; otherwise check all levels
  const requestedZoomLevels = fastMode ? [10] : WATER_POLYGON_ZOOM_LEVELS;
  // A release may advertise less detail than our preferred fallback levels.
  // Clamp to the header and deduplicate levels that collapse to the same tile.
  const zoomLevels = [...new Set(
    requestedZoomLevels.map(lowerZoom => Math.min(lowerZoom, baseMaxZoom!))
  )];

  for (const lowerZoom of zoomLevels) {
    if (lowerZoom >= zoom) continue; // Only check lower (zoomed out) levels

    const scale = Math.pow(2, zoom - lowerZoom);
    const lowerX = Math.floor(x / scale);
    const lowerY = Math.floor(y / scale);
    const cacheKey = `${lowerZoom}/${lowerX}/${lowerY}`;

    // Check cache first
    let features: ParsedFeature[];
    if (waterPolygonCache.has(cacheKey)) {
      features = waterPolygonCache.get(cacheKey)!;
    } else {
      // Fetch and cache
      const data = await getTileData(basePMTiles, lowerZoom, lowerX, lowerY, priority);
      if (!data) continue;

      const allFeatures = await parseMVTAsync(data, lowerX, lowerY, lowerZoom, 'water');

      // Filter for polygon features only and mark them
      features = [];
      for (const feature of allFeatures) {
        if (feature.type !== 'Polygon' && feature.type !== 'MultiPolygon') {
          continue;
        }
        // Mark this feature as coming from a lower zoom level
        feature.properties = {
          ...feature.properties,
          _fromLowerZoom: true,
          _sourceZoom: lowerZoom
        };
        features.push(feature);
      }

      waterPolygonCache.set(cacheKey, features);
    }

    // Dedupe across zoom levels
    for (const feature of features) {
      const coords = feature.coordinates as number[][][] | number[][][][];
      const firstRing = feature.type === 'Polygon' ? coords[0] : (coords[0] as number[][][])[0];
      if (!firstRing || firstRing.length < 3) continue;

      const firstCoord = firstRing[0] as number[];
      const areaKey = `${firstCoord[0].toFixed(4)},${firstCoord[1].toFixed(4)}`;

      if (seenAreas.has(areaKey)) continue;
      seenAreas.add(areaKey);

      waterPolygons.push(feature);
    }

    // In fast mode, stop early if we found water (optimization for rendering)
    // In non-fast mode (background cache warming), continue to populate all zoom level caches
    if (fastMode && waterPolygons.length > 0) {
      break;
    }
  }

  return waterPolygons;
}

/**
 * Clear water polygon cache entries for tiles far from the given position
 */
export function clearDistantWaterPolygonCache(
  centerLat: number,
  centerLng: number,
  maxDistanceMeters: number = 50000
): number {
  const toRemove: string[] = [];

  for (const key of waterPolygonCache.keys()) {
    const [zoom, x, y] = key.split('/').map(Number);
    // Convert tile to approximate center lat/lng
    const n = Math.pow(2, zoom);
    const tileLng = (x / n) * 360 - 180;
    const tileLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;

    // Simple distance check
    const dLat = (tileLat - centerLat) * METERS_PER_DEGREE_LAT;
    const dLng = (tileLng - centerLng) * metersPerDegreeLng(centerLat);
    const distance = Math.sqrt(dLat * dLat + dLng * dLng);

    if (distance > maxDistanceMeters) {
      toRemove.push(key);
    }
  }

  for (const key of toRemove) {
    waterPolygonCache.delete(key);
  }

  return toRemove.length;
}

/**
 * Load transportation features for a tile (roads, paths, railways)
 * Uses request deduplication to prevent redundant fetches for the same tile
 * @param priority - Fetch priority (defaults to Z14_GROUND for road network)
 */
export async function loadTransportationTile(
  x: number,
  y: number,
  zoom: number = TILE_ZOOM,
  priority: TilePriority = TilePriority.Z14_GROUND
): Promise<ParsedFeature[]> {
  if (!transportationPMTiles || transportationMaxZoom === null) return [];

  const sourceTile = mapTileToSourceZoom(x, y, zoom, transportationMaxZoom);

  // Check deduplication cache
  const dedupeKey = `transport:${sourceTile.z}/${sourceTile.x}/${sourceTile.y}:__ALL__`;
  const existing = inFlightRequests.get(dedupeKey);
  // Only dedupe if existing request has same or higher priority (lower number)
  if (existing && existing.priority <= priority) {
    return existing.promise;
  }

  // Create the loading promise
  const loadPromise = (async (): Promise<ParsedFeature[]> => {
    const data = await getTileData(
      transportationPMTiles,
      sourceTile.z,
      sourceTile.x,
      sourceTile.y,
      priority
    );
    if (!data) return [];

    // Transportation PMTiles has layers: segment, connector
    return parseMVTAsync(data, sourceTile.x, sourceTile.y, sourceTile.z);
  })();

  // Store in deduplication cache and clean up when done
  inFlightRequests.set(dedupeKey, { promise: loadPromise, priority });
  loadPromise.finally(() => {
    // Only delete if this is still our request (higher priority may have replaced it)
    const current = inFlightRequests.get(dedupeKey);
    if (current?.promise === loadPromise) {
      inFlightRequests.delete(dedupeKey);
    }
  });

  return loadPromise;
}

/**
 * Get which tiles should be loaded based on plane position, heading, and speed
 * Implements predictive loading to fetch tiles ahead of the plane's direction of travel
 */
export function getTilesToLoad(
  lng: number,
  lat: number,
  heading: number = 0,
  speed: number = 0
): TileInfo[] {
  const [centerX, centerY] = lngLatToTile(lng, lat, TILE_ZOOM);
  const worldWidth = Math.pow(2, TILE_ZOOM);
  const tiles: TileInfo[] = [];
  const addedTiles = new Set<string>();

  // Helper to add a valid tile if not already added. The world wraps east/west,
  // but Web Mercator has hard north/south bounds.
  const addTile = (x: number, y: number) => {
    if (!Number.isInteger(x) || !Number.isInteger(y) || y < 0 || y >= worldWidth) return;

    const wrappedX = ((x % worldWidth) + worldWidth) % worldWidth;
    const key = `${TILE_ZOOM}/${wrappedX}/${y}`;
    if (!addedTiles.has(key)) {
      addedTiles.add(key);
      tiles.push({ x: wrappedX, y, z: TILE_ZOOM, key });
    }
  };

  const wrappedXDelta = (x: number): number => {
    let delta = x - centerX;
    if (delta > worldWidth / 2) delta -= worldWidth;
    if (delta < -worldWidth / 2) delta += worldWidth;
    return delta;
  };

  // Pre-compute heading direction vector using cached sin/cos values
  // This avoids recalculating every frame when heading doesn't change
  // Heading 0 = North = -Y in tile coords (lower Y = further north)
  // Heading 90 = East = +X in tile coords
  const { sinH, cosH } = getHeadingTrig(heading);
  const headingDx = sinH;
  const headingDy = -cosH; // Negative because tile Y increases southward

  // Load tiles in radius around current position
  for (let dx = -TILE_RADIUS; dx <= TILE_RADIUS; dx++) {
    for (let dy = -TILE_RADIUS; dy <= TILE_RADIUS; dy++) {
      addTile(centerX + dx, centerY + dy);
    }
  }

  // Predictive loading: load tiles ahead based on heading and speed
  if (speed > SPEED_THRESHOLD) {
    // Load tiles ahead based on speed (faster = more tiles ahead)
    const tilesAhead = Math.min(PREDICTIVE_TILES, Math.ceil(speed / SPEED_TO_TILES_DIVISOR));

    for (let i = 1; i <= tilesAhead; i++) {
      // Extend in the direction of travel
      const aheadX = centerX + Math.round(headingDx * (TILE_RADIUS + i));
      const aheadY = centerY + Math.round(headingDy * (TILE_RADIUS + i));

      // Add a small cone of tiles in the direction of travel
      addTile(aheadX, aheadY);

      // Add adjacent tiles for a wider cone as we go further
      if (i >= 2) {
        // Perpendicular direction for cone spread (cos, sin instead of sin, cos)
        addTile(aheadX + Math.round(cosH), aheadY + Math.round(sinH));
        addTile(aheadX - Math.round(cosH), aheadY - Math.round(sinH));
      }
    }
  }

  // Sort tiles by distance from center (plane position) so closest tiles load first
  // This ensures tiles directly under/around the plane get priority over distant ones

  tiles.sort((a, b) => {
    const aDx = wrappedXDelta(a.x);
    const aDy = a.y - centerY;
    const bDx = wrappedXDelta(b.x);
    const bDy = b.y - centerY;

    // Calculate base distance (Euclidean)
    const aDist = Math.sqrt(aDx * aDx + aDy * aDy);
    const bDist = Math.sqrt(bDx * bDx + bDy * bDy);

    // Calculate how aligned each tile is with heading direction (dot product)
    // Positive = ahead of plane, negative = behind
    const aAhead = aDx * headingDx + aDy * headingDy;
    const bAhead = bDx * headingDx + bDy * headingDy;

    // Slight bonus (0.3 tiles) for tiles ahead of the plane
    const aScore = aDist - aAhead * 0.3;
    const bScore = bDist - bAhead * 0.3;

    return aScore - bScore;
  });

  return tiles;
}

/**
 * Get loaded tile keys that are outside the retention radius.
 *
 * The caller owns the loaded-tile collection. Keeping one authoritative
 * registry avoids the renderer and tile manager drifting out of sync.
 */
export function getTilesToUnload(
  lng: number,
  lat: number,
  loadedTileKeys: Iterable<string>,
  maxDistance: number = 4
): string[] {
  const toUnload: string[] = [];

  for (const key of loadedTileKeys) {
    const [zStr, xStr, yStr] = key.split('/');
    const z = Number(zStr);
    const x = Number(xStr);
    const y = Number(yStr);

    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 0) {
      // An invalid key cannot be associated with the current position, so do
      // not allow it to remain resident indefinitely.
      toUnload.push(key);
      continue;
    }

    const worldWidth = Math.pow(2, z);
    if (x < 0 || x >= worldWidth || y < 0 || y >= worldWidth) {
      toUnload.push(key);
      continue;
    }

    const [centerX, centerY] = lngLatToTile(lng, lat, z);
    const rawXDistance = Math.abs(x - centerX);
    const xDistance = Math.min(rawXDistance, worldWidth - rawXDistance);
    const distance = Math.max(xDistance, Math.abs(y - centerY));

    if (distance > maxDistance) {
      toUnload.push(key);
    }
  }

  return toUnload;
}

/**
 * Get the PMTiles sources
 */
export function getPMTilesSources(): {
  buildingsPMTiles: PMTiles | null;
  basePMTiles: PMTiles | null;
  transportationPMTiles: PMTiles | null;
} {
  return { buildingsPMTiles, basePMTiles, transportationPMTiles };
}

/**
 * Get the tile zoom level being used
 */
export function getTileZoom(): number {
  return TILE_ZOOM;
}
