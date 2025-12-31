/**
 * Elevation data module using AWS Terrarium tiles
 * Based on the arnis project's elevation_data.rs implementation
 *
 * Terrarium tiles encode elevation as RGB values:
 * height_meters = (R * 256 + G + B/256) - 32768
 */

import { getOrigin } from './scene.js';
import { lngLatToTile, tileToBounds } from './tile-manager.js';
import { ELEVATION } from './constants.js';

// Elevation tile cache: "z/x/y" -> { heights: Float32Array, loading: boolean }
const elevationCache = new Map();

// Pending load promises to avoid duplicate fetches
const pendingLoads = new Map();

/**
 * Decode Terrarium RGB values to height in meters
 * Formula: height = (R * 256 + G + B/256) - 32768
 * @param {number} r - Red channel (0-255)
 * @param {number} g - Green channel (0-255)
 * @param {number} b - Blue channel (0-255)
 * @returns {number} Height in meters
 */
function decodeTerrarium(r, g, b) {
  return (r * 256 + g + b / 256) - ELEVATION.TERRARIUM_OFFSET;
}

/**
 * Load an image from URL
 * @param {string} url
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

/**
 * Load elevation tile and decode to height grid
 * @param {number} x - Tile X coordinate
 * @param {number} y - Tile Y coordinate
 * @param {number} z - Zoom level
 * @returns {Promise<Float32Array>} 256x256 height grid in meters
 */
async function loadElevationTile(x, y, z) {
  const key = `${z}/${x}/${y}`;

  // Return cached data if available
  if (elevationCache.has(key)) {
    const cached = elevationCache.get(key);
    if (!cached.loading && cached.heights) {
      return cached.heights;
    }
  }

  // Return pending promise if already loading
  if (pendingLoads.has(key)) {
    return pendingLoads.get(key);
  }

  // Mark as loading
  elevationCache.set(key, { heights: null, loading: true });

  const loadPromise = (async () => {
    try {
      const url = ELEVATION.TERRARIUM_URL
        .replace('{z}', z.toString())
        .replace('{x}', x.toString())
        .replace('{y}', y.toString());

      console.log(`Loading elevation tile ${key} from ${url}`);

      const img = await loadImage(url);

      // Draw to canvas to extract pixel data
      const canvas = document.createElement('canvas');
      canvas.width = ELEVATION.TILE_SIZE;
      canvas.height = ELEVATION.TILE_SIZE;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, ELEVATION.TILE_SIZE, ELEVATION.TILE_SIZE);

      const imageData = ctx.getImageData(0, 0, ELEVATION.TILE_SIZE, ELEVATION.TILE_SIZE);
      const heights = new Float32Array(ELEVATION.TILE_SIZE * ELEVATION.TILE_SIZE);

      for (let i = 0; i < ELEVATION.TILE_SIZE * ELEVATION.TILE_SIZE; i++) {
        const r = imageData.data[i * 4];
        const g = imageData.data[i * 4 + 1];
        const b = imageData.data[i * 4 + 2];
        heights[i] = decodeTerrarium(r, g, b);
      }

      // Cache the result
      elevationCache.set(key, { heights, loading: false });
      pendingLoads.delete(key);

      // Log elevation range for debugging
      let min = Infinity, max = -Infinity;
      for (const h of heights) {
        if (h < min) min = h;
        if (h > max) max = h;
      }
      console.log(`Elevation tile ${key}: range ${min.toFixed(1)}m to ${max.toFixed(1)}m`);

      return heights;
    } catch (error) {
      console.error(`Failed to load elevation tile ${key}:`, error);
      // Cache a flat elevation on error (sea level)
      const fallback = new Float32Array(ELEVATION.TILE_SIZE * ELEVATION.TILE_SIZE).fill(0);
      elevationCache.set(key, { heights: fallback, loading: false });
      pendingLoads.delete(key);
      return fallback;
    }
  })();

  pendingLoads.set(key, loadPromise);
  return loadPromise;
}

/**
 * Get the elevation tile key for a geographic coordinate
 * @param {number} lng - Longitude
 * @param {number} lat - Latitude
 * @returns {{key: string, x: number, y: number, z: number}}
 */
function getElevationTileInfo(lng, lat) {
  const z = ELEVATION.ZOOM;
  const [x, y] = lngLatToTile(lng, lat, z);
  return { key: `${z}/${x}/${y}`, x, y, z };
}

/**
 * Get terrain height at a geographic coordinate using bilinear interpolation
 * @param {number} lng - Longitude
 * @param {number} lat - Latitude
 * @returns {number} Height in meters (0 if not loaded)
 */
export function getTerrainHeight(lng, lat) {
  const { key, x, y, z } = getElevationTileInfo(lng, lat);

  const cached = elevationCache.get(key);
  if (!cached || cached.loading || !cached.heights) {
    // Tile not loaded, trigger async load and return 0
    loadElevationTile(x, y, z);
    return 0;
  }

  const heights = cached.heights;
  const bounds = tileToBounds(x, y, z);

  // Calculate position within tile (0-1 range)
  const relX = (lng - bounds.west) / (bounds.east - bounds.west);
  const relY = (bounds.north - lat) / (bounds.north - bounds.south); // Note: Y is inverted

  // Convert to grid coordinates
  const gridX = relX * (ELEVATION.TILE_SIZE - 1);
  const gridY = relY * (ELEVATION.TILE_SIZE - 1);

  // Bilinear interpolation
  const x0 = Math.floor(gridX);
  const y0 = Math.floor(gridY);
  const x1 = Math.min(x0 + 1, ELEVATION.TILE_SIZE - 1);
  const y1 = Math.min(y0 + 1, ELEVATION.TILE_SIZE - 1);

  const fx = gridX - x0;
  const fy = gridY - y0;

  const h00 = heights[y0 * ELEVATION.TILE_SIZE + x0];
  const h10 = heights[y0 * ELEVATION.TILE_SIZE + x1];
  const h01 = heights[y1 * ELEVATION.TILE_SIZE + x0];
  const h11 = heights[y1 * ELEVATION.TILE_SIZE + x1];

  // Bilinear interpolation formula
  const height =
    h00 * (1 - fx) * (1 - fy) +
    h10 * fx * (1 - fy) +
    h01 * (1 - fx) * fy +
    h11 * fx * fy;

  return height;
}

/**
 * Get terrain height (async version that ensures tile is loaded)
 * @param {number} lng - Longitude
 * @param {number} lat - Latitude
 * @returns {Promise<number>} Height in meters
 */
export async function getTerrainHeightAsync(lng, lat) {
  const { x, y, z } = getElevationTileInfo(lng, lat);
  await loadElevationTile(x, y, z);
  return getTerrainHeight(lng, lat);
}

/**
 * Preload elevation tiles around a geographic point
 * @param {number} lng - Center longitude
 * @param {number} lat - Center latitude
 * @param {number} radius - Tile radius to load (default 2)
 * @returns {Promise<void>}
 */
export async function preloadElevationTiles(lng, lat, radius = 2) {
  const z = ELEVATION.ZOOM;
  const [centerX, centerY] = lngLatToTile(lng, lat, z);

  const promises = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      const x = centerX + dx;
      const y = centerY + dy;
      promises.push(loadElevationTile(x, y, z));
    }
  }

  await Promise.all(promises);
  console.log(`Preloaded ${promises.length} elevation tiles around (${lng.toFixed(4)}, ${lat.toFixed(4)})`);
}

/**
 * Get elevation data for a tile (for terrain mesh generation)
 * @param {number} tileX - Tile X coordinate (at ELEVATION.ZOOM)
 * @param {number} tileY - Tile Y coordinate (at ELEVATION.ZOOM)
 * @returns {Promise<{heights: Float32Array, bounds: Object}|null>}
 */
export async function getElevationDataForTile(tileX, tileY) {
  const z = ELEVATION.ZOOM;
  const key = `${z}/${tileX}/${tileY}`;

  try {
    const heights = await loadElevationTile(tileX, tileY, z);
    const bounds = tileToBounds(tileX, tileY, z);
    return { heights, bounds };
  } catch (error) {
    console.error(`Failed to get elevation data for tile ${key}:`, error);
    return null;
  }
}

/**
 * Check if elevation tile is loaded and available
 * @param {number} tileX
 * @param {number} tileY
 * @returns {boolean}
 */
export function isElevationTileLoaded(tileX, tileY) {
  const key = `${ELEVATION.ZOOM}/${tileX}/${tileY}`;
  const cached = elevationCache.get(key);
  return cached && !cached.loading && cached.heights !== null;
}

/**
 * Unload elevation tiles that are far from the given position
 * @param {number} lng - Center longitude
 * @param {number} lat - Center latitude
 * @param {number} maxDistance - Max tile distance before unloading (default 4)
 */
export function unloadDistantElevationTiles(lng, lat, maxDistance = 4) {
  const z = ELEVATION.ZOOM;
  const [centerX, centerY] = lngLatToTile(lng, lat, z);

  for (const [key] of elevationCache) {
    const [tz, tx, ty] = key.split('/').map(Number);
    if (tz !== z) continue;

    const distance = Math.max(Math.abs(tx - centerX), Math.abs(ty - centerY));
    if (distance > maxDistance) {
      elevationCache.delete(key);
      console.log(`Unloaded distant elevation tile ${key}`);
    }
  }
}

/**
 * Get statistics about loaded elevation tiles
 * @returns {{loaded: number, loading: number, cacheSize: number}}
 */
export function getElevationStats() {
  let loaded = 0;
  let loading = 0;

  for (const [, value] of elevationCache) {
    if (value.loading) {
      loading++;
    } else if (value.heights) {
      loaded++;
    }
  }

  return { loaded, loading, cacheSize: elevationCache.size };
}
