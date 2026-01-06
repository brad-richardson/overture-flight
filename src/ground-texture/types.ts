import * as THREE from 'three';

// Re-export types from tile-manager for convenience
export type { TileBounds, ParsedFeature } from '../tile-manager.js';

/**
 * Configuration for ground texture rendering
 */
export interface GroundTextureConfig {
  /** Texture resolution in pixels (width and height) */
  textureSize: number;
  /** Maximum number of textures to cache */
  cacheMaxSize: number;
  /** Number of subdivisions for terrain-following quads */
  terrainQuadSegments: number;
}

/**
 * Cached texture entry with metadata
 */
export interface CachedTexture {
  /** The Three.js texture */
  texture: THREE.CanvasTexture;
  /** Timestamp of last access (for LRU eviction) */
  lastAccessed: number;
  /** Tile key (z/x/y) */
  tileKey: string;
  /** Geographic bounds of the tile */
  bounds: {
    west: number;
    east: number;
    north: number;
    south: number;
  };
}

/**
 * Result of rendering a tile texture
 */
export interface RenderedTile {
  /** The ground color/albedo texture */
  colorTexture: THREE.CanvasTexture;
  /** Optional elevation texture for GPU displacement */
  elevationTexture?: THREE.DataTexture;
}

/**
 * Layer rendering configuration
 */
export interface LayerConfig {
  /** Layer name (e.g., 'land_cover', 'water') */
  name: string;
  /** Render order (lower = rendered first, underneath) */
  order: number;
}

/**
 * Road style configuration
 */
export interface RoadStyle {
  color: number;
  width: number;
}

/**
 * Ground tile data stored in active tiles map
 */
export interface GroundTileData {
  /** The Three.js group containing the terrain quad */
  group: THREE.Group;
  /** Tile coordinates */
  x: number;
  y: number;
  z: number;
  /** Unique key for this tile */
  key: string;
}
