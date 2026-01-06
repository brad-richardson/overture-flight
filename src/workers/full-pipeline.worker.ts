/**
 * Full-pipeline texture worker
 * Handles fetch -> parse -> render entirely in worker to avoid structured clone overhead
 *
 * Benefits:
 * - No structured clone for feature arrays (they never leave the worker)
 * - Only ImageBitmap transferred back (zero-copy)
 * - PMTiles fetch happens in worker thread (no main thread blocking)
 */

import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type { WorkerResponse, TileBounds, ParsedFeature } from './types.js';
import { renderTileTextureToCanvas } from './offscreen-renderer.js';

// PMTiles sources (lazy initialized)
let basePMTiles: PMTiles | null = null;
let transportationPMTiles: PMTiles | null = null;
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
      await Promise.all([
        basePMTiles.getHeader(),
        transportationPMTiles.getHeader(),
      ]);

      pmtilesInitialized = true;
    } catch (error) {
      console.error('[FullPipelineWorker] Failed to initialize PMTiles:', error);
      basePMTiles = null;
      transportationPMTiles = null;
      pmtilesInitialized = false;
      throw error;
    }
  })();

  await pmtilesInitPromise;
  pmtilesInitPromise = null;
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

/**
 * Load base features for a tile (and optionally neighbors)
 */
async function loadBaseFeatures(
  tileX: number,
  tileY: number,
  tileZ: number,
  includeNeighbors: boolean
): Promise<ParsedFeature[]> {
  if (!basePMTiles) return [];

  const features: ParsedFeature[] = [];

  // Load center tile
  const centerData = await fetchTileData(basePMTiles, tileZ, tileX, tileY);
  if (centerData) {
    features.push(...parseMVT(centerData, tileX, tileY, tileZ));
  }

  // Load neighbor tiles if requested
  if (includeNeighbors) {
    const neighborPromises: Promise<ParsedFeature[]>[] = [];

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue; // Skip center

        const nx = tileX + dx;
        const ny = tileY + dy;

        neighborPromises.push(
          fetchTileData(basePMTiles!, tileZ, nx, ny).then(data => {
            if (!data) return [];
            return parseMVT(data, nx, ny, tileZ);
          })
        );
      }
    }

    const neighborResults = await Promise.all(neighborPromises);
    for (const neighborFeatures of neighborResults) {
      features.push(...neighborFeatures);
    }
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
  if (!transportationPMTiles) return [];

  const data = await fetchTileData(transportationPMTiles, tileZ, tileX, tileY);
  if (!data) return [];

  return parseMVT(data, tileX, tileY, tileZ);
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
  includeTransportation: boolean
): Promise<ImageBitmap> {
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

  // Transfer ImageBitmap back (zero-copy)
  return canvas.transferToImageBitmap();
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
        } = request.payload;

        const bitmap = await renderFullPipeline(
          tileX,
          tileY,
          tileZ,
          textureSize,
          basePMTilesUrl,
          transportationPMTilesUrl,
          includeNeighbors,
          includeTransportation
        );

        const response: WorkerResponse = {
          type: 'RENDER_TILE_TEXTURE_RESULT',
          id: request.id,
          result: bitmap,
        };
        self.postMessage(response, { transfer: [bitmap] });
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
