import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { OVERTURE_BUILDINGS_PMTILES, OVERTURE_BASE_PMTILES } from './constants.js';
import { getOrigin } from './scene.js';

// PMTiles sources
let buildingsPMTiles = null;
let basePMTiles = null;

// Loaded tiles cache
const loadedTiles = new Map(); // "z/x/y" -> { meshes: [], loading: boolean }

// Tile loading settings
const TILE_ZOOM = 14; // Zoom level for tile loading
const TILE_RADIUS = 2; // Load tiles within this radius of center

// Constants for geo conversion
const METERS_PER_DEGREE_LAT = 111320;
const metersPerDegreeLng = (lat) => 111320 * Math.cos(lat * Math.PI / 180);

/**
 * Initialize PMTiles sources
 */
export async function initTileManager() {
  buildingsPMTiles = new PMTiles(OVERTURE_BUILDINGS_PMTILES);
  basePMTiles = new PMTiles(OVERTURE_BASE_PMTILES);

  // Get metadata to verify sources are working
  try {
    const buildingsHeader = await buildingsPMTiles.getHeader();
    console.log('Buildings PMTiles initialized:', buildingsHeader);
  } catch (e) {
    console.error('Failed to init buildings PMTiles:', e);
  }

  try {
    const baseHeader = await basePMTiles.getHeader();
    console.log('Base PMTiles initialized:', baseHeader);
  } catch (e) {
    console.error('Failed to init base PMTiles:', e);
  }
}

/**
 * Convert lng/lat to tile coordinates
 * @param {number} lng
 * @param {number} lat
 * @param {number} zoom
 * @returns {[number, number]} [x, y] tile coordinates
 */
export function lngLatToTile(lng, lat, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
  return [x, y];
}

/**
 * Convert tile coordinates to lng/lat bounds
 * @param {number} x
 * @param {number} y
 * @param {number} zoom
 * @returns {{west: number, east: number, north: number, south: number}}
 */
export function tileToBounds(x, y, zoom) {
  const n = Math.pow(2, zoom);
  const west = x / n * 360 - 180;
  const east = (x + 1) / n * 360 - 180;
  const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return { west, east, north, south };
}

/**
 * Convert tile bounds to world coordinates
 * @param {number} x
 * @param {number} y
 * @param {number} zoom
 * @returns {{minX: number, maxX: number, minZ: number, maxZ: number}}
 */
export function tileToWorldBounds(x, y, zoom) {
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
 * @param {ArrayBuffer} data - Raw MVT data
 * @param {string} [layerName] - Optional layer name to filter
 * @returns {Array<Object>} Parsed features
 */
export function parseMVT(data, tileX, tileY, zoom, layerName = null) {
  const tile = new VectorTile(new Pbf(data));
  const features = [];

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
        properties: feature.properties,
        layer: name
      });
    }
  }

  return features;
}

/**
 * Get tile data from PMTiles source
 * @param {PMTiles} pmtiles - PMTiles source
 * @param {number} z - Zoom level
 * @param {number} x - Tile X
 * @param {number} y - Tile Y
 * @returns {Promise<ArrayBuffer|null>}
 */
async function getTileData(pmtiles, z, x, y) {
  try {
    const result = await pmtiles.getZxy(z, x, y);
    console.log(`PMTiles getZxy(${z},${x},${y}):`, result ? `${result.data?.byteLength || 0} bytes` : 'null');
    if (result && result.data) {
      return result.data;
    }
    return null;
  } catch (e) {
    console.error(`PMTiles error at ${z}/${x}/${y}:`, e);
    return null;
  }
}

/**
 * Load building features for a tile
 * @param {number} x
 * @param {number} y
 * @param {number} zoom
 * @returns {Promise<Array<Object>>}
 */
export async function loadBuildingTile(x, y, zoom = TILE_ZOOM) {
  if (!buildingsPMTiles) return [];

  const data = await getTileData(buildingsPMTiles, zoom, x, y);
  if (!data) return [];

  return parseMVT(data, x, y, zoom, 'building');
}

/**
 * Load base layer features for a tile (land, water, etc.)
 * @param {number} x
 * @param {number} y
 * @param {number} zoom
 * @returns {Promise<Array<Object>>}
 */
export async function loadBaseTile(x, y, zoom = TILE_ZOOM) {
  if (!basePMTiles) {
    console.warn('Base PMTiles not initialized');
    return [];
  }

  const data = await getTileData(basePMTiles, zoom, x, y);
  if (!data) {
    // Try at a lower zoom level - base data might be at coarser resolution
    const lowerZoom = Math.max(10, zoom - 2);
    const scale = Math.pow(2, zoom - lowerZoom);
    const lowerX = Math.floor(x / scale);
    const lowerY = Math.floor(y / scale);
    console.log(`Base tile ${zoom}/${x}/${y} empty, trying ${lowerZoom}/${lowerX}/${lowerY}`);
    const lowerData = await getTileData(basePMTiles, lowerZoom, lowerX, lowerY);
    if (!lowerData) return [];
    return parseMVT(lowerData, lowerX, lowerY, lowerZoom);
  }

  // Base PMTiles has layers: water, land, land_use, land_cover, infrastructure
  return parseMVT(data, x, y, zoom);
}

/**
 * Get which tiles should be loaded based on plane position
 * @param {number} lng
 * @param {number} lat
 * @returns {Array<{x: number, y: number, z: number, key: string}>}
 */
export function getTilesToLoad(lng, lat) {
  const [centerX, centerY] = lngLatToTile(lng, lat, TILE_ZOOM);
  const tiles = [];

  // Debug: Log tile calculation (only occasionally to avoid spam)
  if (Math.random() < 0.01) {
    console.log(`Tile calc: lng=${lng.toFixed(4)}, lat=${lat.toFixed(4)} -> center tile ${TILE_ZOOM}/${centerX}/${centerY}`);
    const bounds = tileToBounds(centerX, centerY, TILE_ZOOM);
    console.log(`Center tile bounds: W=${bounds.west.toFixed(4)}, E=${bounds.east.toFixed(4)}, N=${bounds.north.toFixed(4)}, S=${bounds.south.toFixed(4)}`);
  }

  for (let dx = -TILE_RADIUS; dx <= TILE_RADIUS; dx++) {
    for (let dy = -TILE_RADIUS; dy <= TILE_RADIUS; dy++) {
      const x = centerX + dx;
      const y = centerY + dy;
      const key = `${TILE_ZOOM}/${x}/${y}`;
      tiles.push({ x, y, z: TILE_ZOOM, key });
    }
  }

  return tiles;
}

/**
 * Check if a tile is loaded
 * @param {string} key
 * @returns {boolean}
 */
export function isTileLoaded(key) {
  return loadedTiles.has(key) && !loadedTiles.get(key).loading;
}

/**
 * Mark a tile as loading
 * @param {string} key
 */
export function markTileLoading(key) {
  loadedTiles.set(key, { meshes: [], loading: true });
}

/**
 * Mark a tile as loaded with its meshes
 * @param {string} key
 * @param {Array} meshes
 */
export function markTileLoaded(key, meshes) {
  loadedTiles.set(key, { meshes, loading: false });
}

/**
 * Get meshes for a tile
 * @param {string} key
 * @returns {Array|null}
 */
export function getTileMeshes(key) {
  const tile = loadedTiles.get(key);
  return tile ? tile.meshes : null;
}

/**
 * Get keys of tiles that should be unloaded
 * @param {number} lng
 * @param {number} lat
 * @param {number} [maxDistance=4] - Max tile distance before unloading
 * @returns {Array<string>}
 */
export function getTilesToUnload(lng, lat, maxDistance = 4) {
  const [centerX, centerY] = lngLatToTile(lng, lat, TILE_ZOOM);
  const toUnload = [];

  for (const [key, tile] of loadedTiles) {
    const [z, x, y] = key.split('/').map(Number);
    const distance = Math.max(Math.abs(x - centerX), Math.abs(y - centerY));

    if (distance > maxDistance) {
      toUnload.push(key);
    }
  }

  return toUnload;
}

/**
 * Remove a tile from cache
 * @param {string} key
 */
export function removeTile(key) {
  loadedTiles.delete(key);
}

/**
 * Get the PMTiles sources
 */
export function getPMTilesSources() {
  return { buildingsPMTiles, basePMTiles };
}

/**
 * Get the tile zoom level being used
 */
export function getTileZoom() {
  return TILE_ZOOM;
}
