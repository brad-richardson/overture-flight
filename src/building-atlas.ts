/**
 * Building texture atlas system
 *
 * Loads and manages a texture atlas for building facades.
 * Atlas layout: 4x4 grid of 512x512 tiles (2048x2048 total, 1024x1024 on mobile)
 *
 * Row 0: Residential (brick, stucco, wood, stone)
 * Row 1: Commercial (glass, office, retail, modern)
 * Row 2: Industrial + Civic (corrugated, warehouse, limestone, civic)
 * Row 3: Religious + Roofs (church, mosque, flat roof, shingles)
 */

import * as THREE from 'three';
import { IS_MOBILE } from './constants.js';

// Atlas configuration
export const ATLAS_CONFIG = {
  // Full atlas dimensions
  size: IS_MOBILE ? 1024 : 2048,
  // Individual tile dimensions
  tileSize: IS_MOBILE ? 256 : 512,
  // Tiles per row/column
  tilesPerRow: 4,
  // How many times a facade tile repeats vertically per floor
  floorsPerTile: 3,
} as const;

/**
 * Building categories mapped to atlas tile positions
 * Each category has 1-4 variants for visual diversity
 */
export const ATLAS_TILES: Record<string, { row: number; cols: number[] }> = {
  // Row 0: Residential variants
  residential: { row: 0, cols: [0, 1, 2, 3] },

  // Row 1: Commercial variants
  commercial: { row: 1, cols: [0, 1, 2, 3] },

  // Row 2: Industrial and Civic
  industrial: { row: 2, cols: [0, 1] },
  civic: { row: 2, cols: [2, 3] },

  // Row 3: Religious and special
  religious: { row: 3, cols: [0, 1] },

  // Fallback categories map to closest match
  education: { row: 2, cols: [2, 3] }, // Similar to civic
  medical: { row: 1, cols: [2, 3] }, // Modern/retail style
  agricultural: { row: 2, cols: [0, 1] }, // Industrial style
  entertainment: { row: 1, cols: [0, 1] }, // Glass/modern
  military: { row: 2, cols: [0, 1] }, // Industrial
  outbuilding: { row: 2, cols: [0, 1] }, // Industrial
  service: { row: 1, cols: [2, 3] }, // Commercial
  transportation: { row: 1, cols: [2, 3] }, // Commercial
};

// Default tile for unknown categories
const DEFAULT_TILE = { row: 1, cols: [2] };

/**
 * UV coordinates for a tile in the atlas
 */
export interface AtlasUVs {
  u0: number; // Left edge (0-1)
  v0: number; // Bottom edge (0-1)
  u1: number; // Right edge (0-1)
  v1: number; // Top edge (0-1)
}

/**
 * Get UV coordinates for a specific atlas tile
 * @param category Building category (residential, commercial, etc.)
 * @param variant Variant index (0-3, wraps if exceeds available)
 */
export function getAtlasUVs(category: string, variant: number = 0): AtlasUVs {
  const tile = ATLAS_TILES[category] || DEFAULT_TILE;
  const col = tile.cols[variant % tile.cols.length];
  const row = tile.row;

  const tileNorm = 1 / ATLAS_CONFIG.tilesPerRow;

  return {
    u0: col * tileNorm,
    v0: 1 - (row + 1) * tileNorm, // Flip V (texture coords are bottom-up)
    u1: (col + 1) * tileNorm,
    v1: 1 - row * tileNorm,
  };
}

// Cached atlas texture (loaded once)
let atlasTexture: THREE.Texture | null = null;
let atlasLoadPromise: Promise<THREE.Texture> | null = null;

/**
 * Load the building texture atlas
 * Returns cached texture if already loaded
 */
export function loadBuildingAtlas(): Promise<THREE.Texture> {
  if (atlasTexture) {
    return Promise.resolve(atlasTexture);
  }

  if (atlasLoadPromise) {
    return atlasLoadPromise;
  }

  atlasLoadPromise = new Promise((resolve) => {
    const image = new Image();

    image.onload = () => {
      const texture = new THREE.Texture(image);
      texture.needsUpdate = true;

      // Configure for tiling facades
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;

      // Use sRGB for correct color
      texture.colorSpace = THREE.SRGBColorSpace;

      atlasTexture = texture;
      resolve(texture);
    };

    image.onerror = () => {
      console.warn('Failed to load building atlas, using fallback colors');
      // Create a simple fallback texture (solid gray)
      const fallback = createFallbackAtlas();
      atlasTexture = fallback;
      resolve(fallback);
    };

    // Try to load the atlas
    const suffix = IS_MOBILE ? '-mobile' : '';
    image.src = `/textures/building-atlas${suffix}.png`;
  });

  return atlasLoadPromise;
}

/**
 * Get the cached atlas texture (must call loadBuildingAtlas first)
 */
export function getBuildingAtlas(): THREE.Texture | null {
  return atlasTexture;
}

/**
 * Create a fallback atlas with solid colors for each category
 * Used when the real atlas fails to load
 */
function createFallbackAtlas(): THREE.Texture {
  const size = ATLAS_CONFIG.size;
  const tileSize = ATLAS_CONFIG.tileSize;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Category colors (approximate facade colors)
  const tileColors = [
    // Row 0: Residential
    ['#D4C4B0', '#E8DCC8', '#C4A882', '#B8A090'],
    // Row 1: Commercial
    ['#708090', '#A0A8B0', '#909898', '#B0B8C0'],
    // Row 2: Industrial, Civic
    ['#787878', '#686868', '#C8C0B8', '#D0C8C0'],
    // Row 3: Religious, Roofs
    ['#A89888', '#C0B0A0', '#505050', '#8B7355'],
  ];

  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const x = col * tileSize;
      const y = row * tileSize;

      // Fill with base color
      ctx.fillStyle = tileColors[row][col];
      ctx.fillRect(x, y, tileSize, tileSize);

      // Add subtle grid pattern to simulate windows
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.lineWidth = 1;

      const windowRows = 4;
      const windowCols = 3;
      const windowW = tileSize / (windowCols + 1);
      const windowH = tileSize / (windowRows + 0.5);
      const marginX = windowW / 2;
      const marginY = windowH / 4;

      for (let wy = 0; wy < windowRows; wy++) {
        for (let wx = 0; wx < windowCols; wx++) {
          const winX = x + marginX + wx * windowW;
          const winY = y + marginY + wy * windowH;
          const winW = windowW * 0.6;
          const winH = windowH * 0.5;

          // Dark window
          ctx.fillStyle = 'rgba(40,50,60,0.6)';
          ctx.fillRect(winX, winY, winW, winH);

          // Window frame
          ctx.strokeRect(winX, winY, winW, winH);
        }
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;

  return texture;
}

/**
 * Calculate UV coordinates for a building face
 *
 * @param category Building category for atlas tile selection
 * @param variant Seeded variant index
 * @param faceWidth Width of the face in meters
 * @param buildingHeight Height of the building in meters
 * @param numFloors Number of floors (used for vertical tiling)
 */
export interface FaceUVParams {
  category: string;
  variant: number;
  faceWidth: number;
  buildingHeight: number;
  numFloors: number;
}

/**
 * Calculate how many times the texture should tile horizontally and vertically
 */
export function calculateTiling(params: FaceUVParams): { tilesX: number; tilesY: number } {
  // Assume each atlas tile represents ~10m width of facade
  const METERS_PER_TILE_X = 10;

  // Vertical tiling based on floors (each tile covers FLOORS_PER_TILE floors)
  const tilesX = Math.max(1, params.faceWidth / METERS_PER_TILE_X);
  const tilesY = Math.max(1, params.numFloors / ATLAS_CONFIG.floorsPerTile);

  return { tilesX, tilesY };
}
