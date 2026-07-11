/**
 * Full-pipeline texture worker
 * Handles fetch -> parse -> render entirely in worker to avoid structured clone overhead
 *
 * Benefits:
 * - No structured clone for feature arrays (they never leave the worker)
 * - Only ImageBitmap transferred back (zero-copy)
 * - PMTiles fetch happens in worker thread (no main thread blocking)
 * - Loads lower-zoom water (z10) and land_cover (z12) for background coverage
 */

import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type { WorkerResponse, TileBounds, ParsedFeature } from './types.js';
import { renderTileTextureToCanvas } from './offscreen-renderer.js';
import { getWrappedTileNeighborhood } from '../tile-coordinates.js';
import { parseVectorTileLayers } from './mvt-layer-parser.js';

const BASE_LAYER_NAMES = ['land', 'land_use', 'land_cover', 'water'] as const;
const WATER_LAYER_NAMES = ['water'] as const;
const TRANSPORTATION_LAYER_NAMES = ['segment'] as const;

// PMTiles sources (lazy initialized)
let basePMTiles: PMTiles | null = null;
let transportationPMTiles: PMTiles | null = null;
let baseMaxZoom: number | null = null;
let transportationMaxZoom: number | null = null;
let pmtilesInitialized = false;
let pmtilesInitPromise: Promise<void> | null = null;

// Cached PMTiles URLs for initialization
let basePMTilesUrl: string | null = null;
let transportationPMTilesUrl: string | null = null;

// Test OffscreenCanvas capability
let offscreenCanvasSupported = false;
try {
  const testCanvas = new OffscreenCanvas(1, 1);
  const testCtx = testCanvas.getContext('2d');
  offscreenCanvasSupported = testCtx !== null;
} catch {
  offscreenCanvasSupported = false;
}

/**
 * Request types for full pipeline worker
 */
interface FullPipelineRequest {
  type: 'RENDER_FULL_PIPELINE';
  id: string;
  payload: {
    tileX: number;
    tileY: number;
    tileZ: number;
    textureSize: number;
    basePMTilesUrl: string;
    transportationPMTilesUrl: string;
    includeNeighbors: boolean;
    includeTransportation: boolean;
    persistTexture: boolean;
  };
}

interface InitRequest {
  type: 'INIT_PMTILES';
  id: string;
  payload: {
    basePMTilesUrl: string;
    transportationPMTilesUrl: string;
  };
}

interface CapabilityRequest {
  type: 'CAPABILITY_CHECK';
  id: string;
}

type WorkerRequest = FullPipelineRequest | InitRequest | CapabilityRequest;

/**
 * Initialize PMTiles sources (called once, lazy)
 */
async function initializePMTiles(baseUrl: string, transportUrl: string): Promise<void> {
  // Already initialized with matching URLs
  if (pmtilesInitialized && basePMTilesUrl === baseUrl && transportationPMTilesUrl === transportUrl) {
    return;
  }

  // If there's a pending init, check if URLs match before awaiting
  if (pmtilesInitPromise) {
    // URLs changed during pending init - wait for current to finish, then re-init
    if (basePMTilesUrl !== baseUrl || transportationPMTilesUrl !== transportUrl) {
      await pmtilesInitPromise;
      // Reset and fall through to re-initialize with new URLs
      pmtilesInitialized = false;
    } else {
      await pmtilesInitPromise;
      return;
    }
  }

  pmtilesInitPromise = (async () => {
    try {
      basePMTilesUrl = baseUrl;
      transportationPMTilesUrl = transportUrl;

      basePMTiles = new PMTiles(baseUrl);
      transportationPMTiles = new PMTiles(transportUrl);

      // Verify headers are accessible (validates CORS)
      const [baseHeader, transportationHeader] = await Promise.all([
        basePMTiles.getHeader(),
        transportationPMTiles.getHeader(),
      ]);
      baseMaxZoom = baseHeader.maxZoom;
      transportationMaxZoom = transportationHeader.maxZoom;

      pmtilesInitialized = true;
    } catch (error) {
      console.error('[FullPipelineWorker] Failed to initialize PMTiles:', error);
      basePMTiles = null;
      transportationPMTiles = null;
      baseMaxZoom = null;
      transportationMaxZoom = null;
      basePMTilesUrl = null;
      transportationPMTilesUrl = null;
      pmtilesInitialized = false;
      throw error;
    }
  })();

  try {
    await pmtilesInitPromise;
  } finally {
    // Always clear promise to allow retries after transient failures
    pmtilesInitPromise = null;
  }
}

interface SourceTileCoordinates {
  x: number;
  y: number;
  z: number;
}

/** Map a requested tile to the highest zoom available from a source. */
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

function tileKey(tile: SourceTileCoordinates): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
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

/**
 * Parse MVT data to features
 */
function parseMVT(
  data: ArrayBuffer,
  tileX: number,
  tileY: number,
  zoom: number,
  requestedLayerNames: readonly string[] | null
): ParsedFeature[] {
  const tile = new VectorTile(new Pbf(data));
  return parseVectorTileLayers(
    tile.layers,
    tileX,
    tileY,
    zoom,
    requestedLayerNames
  );
}

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
  } catch (error) {
    console.warn(`[FullPipelineWorker] Failed to fetch tile ${z}/${x}/${y}:`, error);
    return null;
  }
}

// Lower zoom levels to check for water polygons (highest detail first)
// Include more zoom levels to catch river polygons that may only exist at certain zooms
const WATER_POLYGON_ZOOM_LEVELS = [13, 12, 11, 10, 8, 6];

// Stop loading lower zoom water once we have this many polygons intersecting the tile
// This prevents loading overly simplified z6 data when we already have good coverage
const WATER_POLYGON_SUFFICIENT_COUNT = 5;

/**
 * Load water polygons from lower zoom levels for ocean coverage
 * Loads water from higher detail levels first, bailing out early once sufficient coverage is found.
 * This prevents loading overly simplified z6 data when we already have good river/lake coverage.
 */
async function loadLowerZoomWater(
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<ParsedFeature[]> {
  if (!basePMTiles || baseMaxZoom === null) return [];

  const waterPolygons: ParsedFeature[] = [];
  const seenAreas = new Set<string>(); // Track polygons to avoid duplicates
  const detailSourceZoom = Math.min(tileZ, baseMaxZoom);

  for (const lowerZoom of WATER_POLYGON_ZOOM_LEVELS) {
    // The detail source tile is loaded separately with all layers, including water.
    // Only fetch genuinely lower zooms here to avoid duplicate parsing/features.
    if (lowerZoom >= detailSourceZoom) continue;
    if (lowerZoom > baseMaxZoom) continue; // Never request beyond the source's advertised range

    // Calculate which lower-zoom tile contains this tile
    const scale = Math.pow(2, tileZ - lowerZoom);
    const lowerX = Math.floor(tileX / scale);
    const lowerY = Math.floor(tileY / scale);

    const data = await fetchTileData(basePMTiles, lowerZoom, lowerX, lowerY);
    if (!data) continue;

    // Only extract water layer polygons
    const allFeatures = parseMVT(
      data,
      lowerX,
      lowerY,
      lowerZoom,
      WATER_LAYER_NAMES
    );

    const waterFeatures = allFeatures.filter(f =>
      f.layer === 'water' &&
      (f.type === 'Polygon' || f.type === 'MultiPolygon')
    );

    // Dedupe across zoom levels using first coordinate as key
    for (const feature of waterFeatures) {
      const coords = feature.coordinates as number[][][] | number[][][][];
      const firstRing = feature.type === 'Polygon' ? coords[0] : (coords[0] as number[][][])[0];
      if (!firstRing || firstRing.length < 3) continue;

      const firstCoord = firstRing[0] as number[];
      const areaKey = `${firstCoord[0].toFixed(4)},${firstCoord[1].toFixed(4)}`;

      if (seenAreas.has(areaKey)) continue;
      seenAreas.add(areaKey);

      // Mark as coming from lower zoom
      feature.properties = {
        ...feature.properties,
        _fromLowerZoom: true,
        _sourceZoom: lowerZoom
      };
      waterPolygons.push(feature);
    }

    // Bail out early if we have sufficient water polygon coverage
    // This prevents loading overly simplified z6/z8 data when higher zoom data is available
    if (waterPolygons.length >= WATER_POLYGON_SUFFICIENT_COUNT) {
      break;
    }
  }

  return waterPolygons;
}

/**
 * Load base features for a tile (and optionally neighbors)
 * Also loads lower-zoom water and land_cover for background coverage
 */
async function loadBaseFeatures(
  tileX: number,
  tileY: number,
  tileZ: number,
  includeNeighbors: boolean
): Promise<ParsedFeature[]> {
  if (!basePMTiles || baseMaxZoom === null) return [];

  // Start all fetches in parallel
  const promises: Promise<ParsedFeature[]>[] = [];
  const scheduledBaseTiles = new Set<string>();

  const scheduleBaseTile = (tile: SourceTileCoordinates): void => {
    const key = tileKey(tile);
    if (scheduledBaseTiles.has(key)) return;

    scheduledBaseTiles.add(key);
    promises.push(
      fetchTileData(basePMTiles!, tile.z, tile.x, tile.y).then(data => {
        if (!data) return [];
        return parseMVT(data, tile.x, tile.y, tile.z, BASE_LAYER_NAMES);
      })
    );
  };

  // 1. Load lower-zoom water for ocean coverage (loads z10, z8, z6 and merges results)
  promises.push(loadLowerZoomWater(tileX, tileY, tileZ));

  // 2. Load lower-zoom base features for land_cover background (z12)
  const lowerZoom = Math.min(baseMaxZoom, Math.max(10, tileZ - 2));
  if (lowerZoom < tileZ) {
    scheduleBaseTile(mapTileToSourceZoom(tileX, tileY, tileZ, lowerZoom));
  }

  // 3. Load the highest-detail source tile that covers the center tile
  scheduleBaseTile(mapTileToSourceZoom(tileX, tileY, tileZ, baseMaxZoom));

  // 4. Load neighbor tiles if requested
  if (includeNeighbors) {
    for (const { x, y, dx, dy } of getWrappedTileNeighborhood(
      tileX,
      tileY,
      tileZ,
      1
    )) {
      if (dx === 0 && dy === 0) continue;

      // Several requested neighbors can map to the same parent source tile.
      // scheduleBaseTile deduplicates those requests before fetching.
      scheduleBaseTile(mapTileToSourceZoom(x, y, tileZ, baseMaxZoom));
    }
  }

  // Wait for all fetches and merge in order (lower zoom first for background)
  const results = await Promise.all(promises);

  // Merge: lower zoom water -> lower zoom base -> center tile -> neighbors
  const features: ParsedFeature[] = [];
  for (const result of results) {
    features.push(...result);
  }

  return features;
}

/**
 * Load transportation features for a tile
 */
async function loadTransportationFeatures(
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<ParsedFeature[]> {
  if (!transportationPMTiles || transportationMaxZoom === null) return [];

  const sourceTile = mapTileToSourceZoom(
    tileX,
    tileY,
    tileZ,
    transportationMaxZoom
  );

  const data = await fetchTileData(
    transportationPMTiles,
    sourceTile.z,
    sourceTile.x,
    sourceTile.y
  );
  if (!data) return [];

  return parseMVT(
    data,
    sourceTile.x,
    sourceTile.y,
    sourceTile.z,
    TRANSPORTATION_LAYER_NAMES
  );
}

/**
 * Render full tile pipeline
 */
async function renderFullPipeline(
  tileX: number,
  tileY: number,
  tileZ: number,
  textureSize: number,
  basePMTilesUrl: string,
  transportationPMTilesUrl: string,
  includeNeighbors: boolean,
  includeTransportation: boolean,
  persistTexture: boolean
): Promise<{ bitmap: ImageBitmap; blob?: Blob }> {
  // Initialize PMTiles if needed
  await initializePMTiles(basePMTilesUrl, transportationPMTilesUrl);

  // Calculate bounds
  const bounds = tileToBounds(tileX, tileY, tileZ);

  // Fetch and parse features in parallel
  const [baseFeatures, transportFeatures] = await Promise.all([
    loadBaseFeatures(tileX, tileY, tileZ, includeNeighbors),
    includeTransportation ? loadTransportationFeatures(tileX, tileY, tileZ) : Promise.resolve([]),
  ]);

  // Create OffscreenCanvas and render
  const canvas = new OffscreenCanvas(textureSize, textureSize);
  renderTileTextureToCanvas(canvas, baseFeatures, transportFeatures, bounds);

  let blob: Blob | undefined;
  if (persistTexture) {
    try {
      blob = await canvas.convertToBlob({ type: 'image/png' });
    } catch (error) {
      console.warn('[FullPipelineWorker] Texture persistence encode failed', error);
    }
  }
  return { bitmap: canvas.transferToImageBitmap(), blob };
}

/**
 * Handle incoming messages
 */
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    switch (request.type) {
      case 'CAPABILITY_CHECK': {
        const response: WorkerResponse = {
          type: 'CAPABILITY_CHECK_RESULT',
          id: request.id,
          supported: offscreenCanvasSupported,
        };
        self.postMessage(response);
        break;
      }

      case 'INIT_PMTILES': {
        const { basePMTilesUrl, transportationPMTilesUrl } = request.payload;
        await initializePMTiles(basePMTilesUrl, transportationPMTilesUrl);

        const response: WorkerResponse = {
          type: 'CAPABILITY_CHECK_RESULT',
          id: request.id,
          supported: true,
        };
        self.postMessage(response);
        break;
      }

      case 'RENDER_FULL_PIPELINE': {
        if (!offscreenCanvasSupported) {
          const response: WorkerResponse = {
            type: 'ERROR',
            id: request.id,
            error: 'OffscreenCanvas not supported',
          };
          self.postMessage(response);
          return;
        }

        const {
          tileX,
          tileY,
          tileZ,
          textureSize,
          basePMTilesUrl,
          transportationPMTilesUrl,
          includeNeighbors,
          includeTransportation,
          persistTexture,
        } = request.payload;

        const result = await renderFullPipeline(
          tileX,
          tileY,
          tileZ,
          textureSize,
          basePMTilesUrl,
          transportationPMTilesUrl,
          includeNeighbors,
          includeTransportation,
          persistTexture
        );

        const response: WorkerResponse = {
          type: 'RENDER_TILE_TEXTURE_RESULT',
          id: request.id,
          result,
        };
        self.postMessage(response, { transfer: [result.bitmap] });
        break;
      }

      default: {
        // Safe extraction of id and type from unknown request
        const unknownRequest = request as Record<string, unknown>;
        const requestId = typeof unknownRequest.id === 'string' ? unknownRequest.id : 'unknown';
        const requestType = typeof unknownRequest.type === 'string' ? unknownRequest.type : 'undefined';

        const response: WorkerResponse = {
          type: 'ERROR',
          id: requestId,
          error: `Unknown request type: ${requestType}`,
        };
        self.postMessage(response);
      }
    }
  } catch (error) {
    const response: WorkerResponse = {
      type: 'ERROR',
      id: request.id,
      error: error instanceof Error ? error.message : 'Unknown error in full-pipeline worker',
    };
    self.postMessage(response);
  }
};

// Signal that worker is ready
self.postMessage({ type: 'READY' });
