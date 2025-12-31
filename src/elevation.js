/**
 * Elevation data module using AWS Terrarium tiles
 * Based on the arnis project's elevation_data.rs implementation
 *
 * Terrarium tiles encode elevation as RGB values:
 * height_meters = (R * 256 + G + B/256) - 32768
 */

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
 * Perform bilinear interpolation on a height grid
 * @param {Float32Array} heights - Height grid data
 * @param {number} gridX - X position in grid coordinates (can be fractional)
 * @param {number} gridY - Y position in grid coordinates (can be fractional)
 * @param {number} gridSize - Size of the grid (typically ELEVATION.TILE_SIZE)
 * @returns {number} Interpolated height value
 */
function bilinearInterpolate(heights, gridX, gridY, gridSize) {
  // Clamp grid coordinates to valid range
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

  // Handle NaN values - if any corner is NaN, return NaN
  if (Number.isNaN(h00) || Number.isNaN(h10) || Number.isNaN(h01) || Number.isNaN(h11)) {
    return NaN;
  }

  // Bilinear interpolation formula
  return (
    h00 * (1 - fx) * (1 - fy) +
    h10 * fx * (1 - fy) +
    h01 * (1 - fx) * fy +
    h11 * fx * fy
  );
}

/**
 * Load elevation tile and decode to height grid
 * @param {number} x - Tile X coordinate
 * @param {number} y - Tile Y coordinate
 * @param {number} z - Zoom level
 * @returns {Promise<Float32Array>} 256x256 height grid in meters (NaN for no data)
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
        if (!Number.isNaN(h)) {
          if (h < min) min = h;
          if (h > max) max = h;
        }
      }
      console.log(`Elevation tile ${key}: range ${min.toFixed(1)}m to ${max.toFixed(1)}m`);

      return heights;
    } catch (error) {
      console.error(`Failed to load elevation tile ${key}:`, error);
      // Cache NaN values to indicate no data (handles below-sea-level areas correctly)
      const fallback = new Float32Array(ELEVATION.TILE_SIZE * ELEVATION.TILE_SIZE).fill(NaN);
      elevationCache.set(key, { heights: fallback, loading: false });
      pendingLoads.delete(key);
      return fallback;
    }
  })();

  pendingLoads.set(key, loadPromise);
  return loadPromise;
}

/**
 * Validate geographic coordinates
 * @param {number} lng - Longitude
 * @param {number} lat - Latitude
 * @returns {boolean} True if coordinates are valid
 */
function isValidCoordinate(lng, lat) {
  return (
    typeof lng === 'number' && !Number.isNaN(lng) &&
    typeof lat === 'number' && !Number.isNaN(lat) &&
    lng >= -180 && lng <= 180 &&
    lat >= -90 && lat <= 90
  );
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
 * @returns {number} Height in meters (0 if not loaded or invalid coordinates)
 */
export function getTerrainHeight(lng, lat) {
  // Validate input coordinates
  if (!isValidCoordinate(lng, lat)) {
    return 0;
  }

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

  // Use shared bilinear interpolation helper
  const height = bilinearInterpolate(heights, gridX, gridY, ELEVATION.TILE_SIZE);

  // Return 0 for NaN (no data) to avoid physics issues
  return Number.isNaN(height) ? 0 : height;
}

/**
 * Get terrain height (async version that ensures tile is loaded)
 * @param {number} lng - Longitude
 * @param {number} lat - Latitude
 * @returns {Promise<number>} Height in meters
 */
export async function getTerrainHeightAsync(lng, lat) {
  if (!isValidCoordinate(lng, lat)) {
    return 0;
  }

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
  if (!isValidCoordinate(lng, lat)) {
    console.warn('Invalid coordinates for elevation preload');
    return;
  }

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
 * Sample elevation from a height grid using bilinear interpolation
 * Exported for use in terrain mesh generation
 * @param {Float32Array} heights - Height grid data
 * @param {number} gridX - X position in grid coordinates
 * @param {number} gridY - Y position in grid coordinates
 * @param {number} gridSize - Size of the grid
 * @returns {number} Interpolated height value
 */
export function sampleElevation(heights, gridX, gridY, gridSize) {
  return bilinearInterpolate(heights, gridX, gridY, gridSize);
}

/**
 * Unload elevation tiles that are far from the given position
 * @param {number} lng - Center longitude
 * @param {number} lat - Center latitude
 * @param {number} maxDistance - Max tile distance before unloading (default 4)
 */
export function unloadDistantElevationTiles(lng, lat, maxDistance = 4) {
  if (!isValidCoordinate(lng, lat)) {
    return;
  }

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
