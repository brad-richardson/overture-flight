import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { OVERTURE_BUILDINGS_PMTILES, OVERTURE_BASE_PMTILES, OVERTURE_TRANSPORTATION_PMTILES } from './constants.js';
import { getOrigin } from './scene.js';

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

interface TileData {
  meshes: unknown[];
  loading: boolean;
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

// Loaded tiles cache
const loadedTiles = new Map<string, TileData>(); // "z/x/y" -> { meshes: [], loading: boolean }

// Tile loading settings
const TILE_ZOOM = 14; // Zoom level for tile loading
const TILE_RADIUS = 2; // Load tiles within this radius of center
const PREDICTIVE_TILES = 3; // Max tiles ahead to load based on heading
const SPEED_THRESHOLD = 30; // m/s - only predictive load above this speed
// Speed divisor to calculate tiles ahead: tilesAhead = speed / SPEED_TO_TILES_DIVISOR
// At 50 m/s = 1 tile ahead, 100 m/s = 2 tiles, 150 m/s = 3 tiles (capped at PREDICTIVE_TILES)
const SPEED_TO_TILES_DIVISOR = 50;
const MIN_FALLBACK_ZOOM = 6; // Minimum zoom level for base tile fallback

// Constants for geo conversion
const METERS_PER_DEGREE_LAT = 111320;
const metersPerDegreeLng = (lat: number): number => 111320 * Math.cos(lat * Math.PI / 180);

/**
 * Initialize PMTiles sources with retry logic
 */
export async function initTileManager(): Promise<InitStatus> {
  initErrors = [];

  buildingsPMTiles = new PMTiles(OVERTURE_BUILDINGS_PMTILES);
  basePMTiles = new PMTiles(OVERTURE_BASE_PMTILES);
  transportationPMTiles = new PMTiles(OVERTURE_TRANSPORTATION_PMTILES);

  // Get metadata to verify sources are working with retry
  try {
    const buildingsHeader = await retryWithBackoff(
      () => buildingsPMTiles!.getHeader(),
      3,
      1000
    );
    console.log('Buildings PMTiles initialized:', buildingsHeader);
  } catch (e) {
    const error = e as Error;
    const msg = `Failed to load buildings data: ${error.message || 'Network error'}`;
    console.error(msg, e);
    initErrors.push(msg);
    buildingsPMTiles = null;
  }

  try {
    const baseHeader = await retryWithBackoff(
      () => basePMTiles!.getHeader(),
      3,
      1000
    );
    console.log('Base PMTiles initialized:', baseHeader);
  } catch (e) {
    const error = e as Error;
    const msg = `Failed to load terrain data: ${error.message || 'Network error'}`;
    console.error(msg, e);
    initErrors.push(msg);
    basePMTiles = null;
  }

  try {
    const transportationHeader = await retryWithBackoff(
      () => transportationPMTiles!.getHeader(),
      3,
      1000
    );
    console.log('Transportation PMTiles initialized:', transportationHeader);
  } catch (e) {
    const error = e as Error;
    const msg = `Failed to load transportation data: ${error.message || 'Network error'}`;
    console.error(msg, e);
    initErrors.push(msg);
    transportationPMTiles = null;
  }

  // Return status for caller to handle
  return {
    buildings: buildingsPMTiles !== null,
    base: basePMTiles !== null,
    transportation: transportationPMTiles !== null,
    errors: initErrors
  };
}

/**
 * Convert lng/lat to tile coordinates
 */
export function lngLatToTile(lng: number, lat: number, zoom: number): [number, number] {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
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
 */
export function parseMVT(
  data: ArrayBuffer,
  tileX: number,
  tileY: number,
  zoom: number,
  layerName: string | null = null
): ParsedFeature[] {
  const tile = new VectorTile(new Pbf(data));
  const features: ParsedFeature[] = [];

  const allLayerNames = Object.keys(tile.layers);
  console.log(`MVT layers at ${zoom}/${tileX}/${tileY}: [${allLayerNames.join(', ')}] requested: ${layerName}`);

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

  return features;
}

/**
 * Get tile data from PMTiles source with retry logic
 */
async function getTileData(
  pmtiles: PMTiles | null,
  z: number,
  x: number,
  y: number
): Promise<ArrayBuffer | null> {
  if (!pmtiles) {
    return null;
  }

  try {
    const result = await retryWithBackoff(
      () => pmtiles.getZxy(z, x, y),
      2, // fewer retries for individual tiles
      500
    );
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
}

/**
 * Load building features for a tile
 */
export async function loadBuildingTile(
  x: number,
  y: number,
  zoom: number = TILE_ZOOM
): Promise<ParsedFeature[]> {
  if (!buildingsPMTiles) return [];

  const data = await getTileData(buildingsPMTiles, zoom, x, y);
  if (!data) return [];

  return parseMVT(data, x, y, zoom, 'building');
}

/**
 * Load base layer features for a tile (land, water, etc.)
 * Tries multiple fallback zoom levels if the requested zoom has no data
 */
export async function loadBaseTile(
  x: number,
  y: number,
  zoom: number = TILE_ZOOM
): Promise<ParsedFeature[]> {
  if (!basePMTiles) {
    console.warn('Base PMTiles not initialized');
    return [];
  }

  const data = await getTileData(basePMTiles, zoom, x, y);
  if (data) {
    // Base PMTiles has layers: water, land, land_use, land_cover, infrastructure
    return parseMVT(data, x, y, zoom);
  }

  // Try fallback zoom levels from zoom-1 down to MIN_FALLBACK_ZOOM
  // Water and land data may only be available at certain zoom levels in the PMTiles
  for (let fallbackZoom = zoom - 1; fallbackZoom >= MIN_FALLBACK_ZOOM; fallbackZoom--) {
    const scale = Math.pow(2, zoom - fallbackZoom);
    const fallbackX = Math.floor(x / scale);
    const fallbackY = Math.floor(y / scale);

    const fallbackData = await getTileData(basePMTiles, fallbackZoom, fallbackX, fallbackY);
    if (fallbackData) {
      console.log(`Base tile ${zoom}/${x}/${y} empty, using fallback ${fallbackZoom}/${fallbackX}/${fallbackY}`);
      return parseMVT(fallbackData, fallbackX, fallbackY, fallbackZoom);
    }
  }

  console.log(`Base tile ${zoom}/${x}/${y}: no data found at any zoom level`);
  return [];
}

/**
 * Load transportation features for a tile (roads, paths, railways)
 */
export async function loadTransportationTile(
  x: number,
  y: number,
  zoom: number = TILE_ZOOM
): Promise<ParsedFeature[]> {
  if (!transportationPMTiles) {
    console.warn('Transportation PMTiles not initialized');
    return [];
  }

  const data = await getTileData(transportationPMTiles, zoom, x, y);
  if (!data) {
    return [];
  }

  // Transportation PMTiles has layers: segment, connector
  return parseMVT(data, x, y, zoom);
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
  const tiles: TileInfo[] = [];
  const addedTiles = new Set<string>();

  // Debug: Log tile calculation (only occasionally to avoid spam)
  if (Math.random() < 0.01) {
    console.log(`Tile calc: lng=${lng.toFixed(4)}, lat=${lat.toFixed(4)} -> center tile ${TILE_ZOOM}/${centerX}/${centerY}`);
    const bounds = tileToBounds(centerX, centerY, TILE_ZOOM);
    console.log(`Center tile bounds: W=${bounds.west.toFixed(4)}, E=${bounds.east.toFixed(4)}, N=${bounds.north.toFixed(4)}, S=${bounds.south.toFixed(4)}`);
  }

  // Helper to add tile if not already added
  const addTile = (x: number, y: number) => {
    const key = `${TILE_ZOOM}/${x}/${y}`;
    if (!addedTiles.has(key)) {
      addedTiles.add(key);
      tiles.push({ x, y, z: TILE_ZOOM, key });
    }
  };

  // Load tiles in radius around current position
  for (let dx = -TILE_RADIUS; dx <= TILE_RADIUS; dx++) {
    for (let dy = -TILE_RADIUS; dy <= TILE_RADIUS; dy++) {
      addTile(centerX + dx, centerY + dy);
    }
  }

  // Predictive loading: load tiles ahead based on heading and speed
  if (speed > SPEED_THRESHOLD) {
    const headingRad = (heading * Math.PI) / 180;

    // Calculate tile offset direction from heading
    // Heading 0 = North = -Y in tile coords (lower Y = further north)
    // Heading 90 = East = +X in tile coords
    const dx = Math.sin(headingRad);
    const dy = -Math.cos(headingRad); // Negative because tile Y increases southward

    // Load tiles ahead based on speed (faster = more tiles ahead)
    const tilesAhead = Math.min(PREDICTIVE_TILES, Math.ceil(speed / SPEED_TO_TILES_DIVISOR));

    for (let i = 1; i <= tilesAhead; i++) {
      // Extend in the direction of travel
      const aheadX = centerX + Math.round(dx * (TILE_RADIUS + i));
      const aheadY = centerY + Math.round(dy * (TILE_RADIUS + i));

      // Add a small cone of tiles in the direction of travel
      addTile(aheadX, aheadY);

      // Add adjacent tiles for a wider cone as we go further
      if (i >= 2) {
        // Perpendicular direction for cone spread
        const perpX = Math.cos(headingRad);
        const perpY = Math.sin(headingRad);
        addTile(aheadX + Math.round(perpX), aheadY + Math.round(perpY));
        addTile(aheadX - Math.round(perpX), aheadY - Math.round(perpY));
      }
    }
  }

  return tiles;
}

/**
 * Check if a tile is loaded
 */
export function isTileLoaded(key: string): boolean {
  return loadedTiles.has(key) && !loadedTiles.get(key)!.loading;
}

/**
 * Mark a tile as loading
 */
export function markTileLoading(key: string): void {
  loadedTiles.set(key, { meshes: [], loading: true });
}

/**
 * Mark a tile as loaded with its meshes
 */
export function markTileLoaded(key: string, meshes: unknown[]): void {
  loadedTiles.set(key, { meshes, loading: false });
}

/**
 * Get meshes for a tile
 */
export function getTileMeshes(key: string): unknown[] | null {
  const tile = loadedTiles.get(key);
  return tile ? tile.meshes : null;
}

/**
 * Get keys of tiles that should be unloaded
 */
export function getTilesToUnload(lng: number, lat: number, maxDistance: number = 4): string[] {
  const [centerX, centerY] = lngLatToTile(lng, lat, TILE_ZOOM);
  const toUnload: string[] = [];

  for (const [key] of loadedTiles) {
    const [, xStr, yStr] = key.split('/');
    const x = Number(xStr);
    const y = Number(yStr);
    const distance = Math.max(Math.abs(x - centerX), Math.abs(y - centerY));

    if (distance > maxDistance) {
      toUnload.push(key);
    }
  }

  return toUnload;
}

/**
 * Remove a tile from cache
 */
export function removeTile(key: string): void {
  loadedTiles.delete(key);
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
