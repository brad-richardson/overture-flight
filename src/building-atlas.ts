import * as THREE from 'three';
import { IS_MOBILE } from './constants.js';

export const ATLAS_CONFIG = {
  size: IS_MOBILE ? 1024 : 2048,
  tileSize: IS_MOBILE ? 256 : 512,
  tilesPerRow: 4,
  floorsPerTile: 3,
} as const;

export const ATLAS_TILES: Record<string, { row: number; cols: number[] }> = {
  residential: { row: 0, cols: [0, 1, 2, 3] },
  commercial: { row: 1, cols: [0, 1, 2, 3] },
  industrial: { row: 2, cols: [0, 1] },
  civic: { row: 2, cols: [2, 3] },
  religious: { row: 3, cols: [0, 1] },
  education: { row: 2, cols: [2, 3] },
  medical: { row: 1, cols: [2, 3] },
  agricultural: { row: 2, cols: [0, 1] },
  entertainment: { row: 1, cols: [0, 1] },
  military: { row: 2, cols: [0, 1] },
  outbuilding: { row: 2, cols: [0, 1] },
  service: { row: 1, cols: [2, 3] },
  transportation: { row: 1, cols: [2, 3] },
};

const DEFAULT_TILE = { row: 1, cols: [2] };

export interface AtlasUVs {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export function getAtlasUVs(category: string, variant: number = 0): AtlasUVs {
  const tile = ATLAS_TILES[category] || DEFAULT_TILE;
  const col = tile.cols[variant % tile.cols.length];
  const row = tile.row;
  const tileNorm = 1 / ATLAS_CONFIG.tilesPerRow;
  return {
    u0: col * tileNorm,
    v0: 1 - (row + 1) * tileNorm,
    u1: (col + 1) * tileNorm,
    v1: 1 - row * tileNorm,
  };
}

let atlasTexture: THREE.Texture | null = null;

interface TileWindowConfig {
  rows: number;
  cols: number;
  winColor: string;
  frameColor: string;
  hasFrames: boolean;
}

function getTileWindowConfig(row: number, col: number): TileWindowConfig {
  const configs: TileWindowConfig[][] = [
    [
      { rows: 4, cols: 2, winColor: 'rgba(60,70,80,0.7)', frameColor: 'rgba(0,0,0,0.2)', hasFrames: true },
      { rows: 5, cols: 3, winColor: 'rgba(50,60,70,0.6)', frameColor: 'rgba(0,0,0,0.15)', hasFrames: true },
      { rows: 3, cols: 2, winColor: 'rgba(70,80,90,0.5)', frameColor: 'rgba(0,0,0,0.1)', hasFrames: false },
      { rows: 6, cols: 2, winColor: 'rgba(40,50,60,0.8)', frameColor: 'rgba(0,0,0,0.25)', hasFrames: true },
    ],
    [
      { rows: 3, cols: 4, winColor: 'rgba(100,130,160,0.5)', frameColor: 'rgba(80,100,120,0.3)', hasFrames: false },
      { rows: 2, cols: 3, winColor: 'rgba(80,110,140,0.6)', frameColor: 'rgba(60,80,100,0.2)', hasFrames: true },
      { rows: 3, cols: 2, winColor: 'rgba(90,100,90,0.4)', frameColor: 'rgba(0,0,0,0.15)', hasFrames: true },
      { rows: 4, cols: 5, winColor: 'rgba(110,140,170,0.45)', frameColor: 'rgba(90,110,130,0.25)', hasFrames: false },
    ],
    [
      { rows: 2, cols: 1, winColor: 'rgba(50,50,50,0.7)', frameColor: 'rgba(0,0,0,0.3)', hasFrames: true },
      { rows: 1, cols: 2, winColor: 'rgba(60,60,60,0.6)', frameColor: 'rgba(0,0,0,0.2)', hasFrames: false },
      { rows: 4, cols: 2, winColor: 'rgba(80,80,70,0.5)', frameColor: 'rgba(0,0,0,0.15)', hasFrames: true },
      { rows: 3, cols: 3, winColor: 'rgba(70,70,60,0.6)', frameColor: 'rgba(0,0,0,0.2)', hasFrames: true },
    ],
    [
      { rows: 2, cols: 1, winColor: 'rgba(60,50,40,0.6)', frameColor: 'rgba(0,0,0,0.2)', hasFrames: true },
      { rows: 3, cols: 2, winColor: 'rgba(80,70,60,0.5)', frameColor: 'rgba(0,0,0,0.15)', hasFrames: false },
      { rows: 1, cols: 1, winColor: 'rgba(30,30,30,0.8)', frameColor: 'rgba(0,0,0,0.3)', hasFrames: true },
      { rows: 5, cols: 3, winColor: 'rgba(50,40,30,0.6)', frameColor: 'rgba(0,0,0,0.15)', hasFrames: true },
    ],
  ];
  return configs[row][col];
}

function createFallbackAtlas(): THREE.Texture {
  const size = ATLAS_CONFIG.size;
  const tileSize = ATLAS_CONFIG.tileSize;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const tileColors = [
    ['#D4C4B0', '#E8DCC8', '#C4A882', '#B8A090'],
    ['#8AA0B8', '#6B8CAE', '#C9B99A', '#B0C4DE'],
    ['#787878', '#686868', '#C8C0B8', '#D0C8C0'],
    ['#A89888', '#C0B0A0', '#505050', '#8B7355'],
  ];

  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const x = col * tileSize;
      const y = row * tileSize;
      ctx.fillStyle = tileColors[row][col];
      ctx.fillRect(x, y, tileSize, tileSize);

      const cfg = getTileWindowConfig(row, col);
      ctx.strokeStyle = cfg.frameColor;
      ctx.lineWidth = 1;
      const windowW = tileSize / (cfg.cols + 1);
      const windowH = tileSize / (cfg.rows + 0.5);
      const marginX = windowW / 2;
      const marginY = windowH / 4;

      for (let wy = 0; wy < cfg.rows; wy++) {
        for (let wx = 0; wx < cfg.cols; wx++) {
          if ((row + col + wy + wx) % 7 === 0) continue;
          const jitterX = ((wy * 3 + wx * 7) % 5) * 2 - 5;
          const jitterY = ((wx * 5 + wy * 2) % 5) * 2 - 5;
          const winX = x + marginX + wx * windowW + jitterX;
          const winY = y + marginY + wy * windowH + jitterY;
          const winW = windowW * (0.5 + ((wy + wx) % 3) * 0.1);
          const winH = windowH * 0.5;
          ctx.fillStyle = cfg.winColor;
          ctx.fillRect(winX, winY, winW, winH);
          if (cfg.hasFrames) ctx.strokeRect(winX, winY, winW, winH);
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

export function loadBuildingAtlas(): Promise<THREE.Texture> {
  if (atlasTexture) return Promise.resolve(atlasTexture);
  atlasTexture = createFallbackAtlas();
  return Promise.resolve(atlasTexture);
}

export function getBuildingAtlas(): THREE.Texture | null {
  return atlasTexture;
}

export function calculateTiling(faceWidth: number, numFloors: number): { tilesX: number; tilesY: number } {
  const METERS_PER_TILE_X = 10;
  return {
    tilesX: Math.max(1, faceWidth / METERS_PER_TILE_X),
    tilesY: Math.max(1, numFloors / ATLAS_CONFIG.floorsPerTile),
  };
}
