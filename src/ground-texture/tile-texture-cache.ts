import * as THREE from 'three';
import type { CachedTexture, TileBounds } from './types.js';

/**
 * LRU cache for rendered ground textures
 * Manages GPU memory by disposing textures when cache exceeds limits
 */
export class TileTextureCache {
  private cache = new Map<string, CachedTexture>();
  private disposeThreshold: number;

  constructor(config: { maxSize: number; disposeThreshold?: number }) {
    // Start evicting when we hit 80% of max size (or at specified threshold)
    this.disposeThreshold = config.disposeThreshold ?? Math.floor(config.maxSize * 0.8);
  }

  /**
   * Get a texture from cache, updating its access time
   */
  get(key: string): THREE.CanvasTexture | null {
    const cached = this.cache.get(key);
    if (cached) {
      cached.lastAccessed = Date.now();
      return cached.texture;
    }
    return null;
  }

  /**
   * Store a texture in cache
   */
  set(key: string, texture: THREE.CanvasTexture, bounds: TileBounds): void {
    // Evict if we're over threshold
    if (this.cache.size >= this.disposeThreshold) {
      this.evictLRU();
    }

    this.cache.set(key, {
      texture,
      lastAccessed: Date.now(),
      tileKey: key,
      bounds,
    });
  }

  /**
   * Check if a key exists in cache
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Get the current cache size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Evict textures for tiles far from a given position
   * @param lng Current longitude
   * @param lat Current latitude
   * @param maxDistance Maximum distance in degrees before eviction
   */
  evictDistant(lng: number, lat: number, maxDistance: number): number {
    const toEvict: string[] = [];

    for (const [key, cached] of this.cache) {
      const centerLng = (cached.bounds.west + cached.bounds.east) / 2;
      const centerLat = (cached.bounds.north + cached.bounds.south) / 2;

      const dlng = Math.abs(centerLng - lng);
      const dlat = Math.abs(centerLat - lat);
      const distance = Math.sqrt(dlng * dlng + dlat * dlat);

      if (distance > maxDistance) {
        toEvict.push(key);
      }
    }

    for (const key of toEvict) {
      this.dispose(key);
    }

    return toEvict.length;
  }

  /**
   * Dispose a specific texture and remove from cache
   */
  dispose(key: string): void {
    const cached = this.cache.get(key);
    if (cached) {
      cached.texture.dispose();
      this.cache.delete(key);
    }
  }

  /**
   * Dispose all textures and clear cache
   */
  clear(): void {
    for (const cached of this.cache.values()) {
      cached.texture.dispose();
    }
    this.cache.clear();
  }

  /**
   * Evict least recently used entries until we're under threshold
   */
  private evictLRU(): void {
    const targetSize = Math.floor(this.disposeThreshold * 0.75);

    // Sort by last accessed time (oldest first)
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

    // Evict oldest until we're at target size
    let evicted = 0;
    while (this.cache.size > targetSize && evicted < entries.length) {
      const [key, cached] = entries[evicted];
      cached.texture.dispose();
      this.cache.delete(key);
      evicted++;
    }

    if (evicted > 0) {
      console.log(`TileTextureCache: Evicted ${evicted} textures (LRU)`);
    }
  }
}

// Singleton instance
let cacheInstance: TileTextureCache | null = null;

/**
 * Get the shared texture cache instance
 */
export function getTextureCache(): TileTextureCache {
  if (!cacheInstance) {
    // Import will be done in ground-layer.ts after constants are available
    cacheInstance = new TileTextureCache({
      maxSize: 100,
      disposeThreshold: 80,
    });
  }
  return cacheInstance;
}

/**
 * Initialize the texture cache with custom config
 */
export function initTextureCache(config: { maxSize: number; disposeThreshold?: number }): TileTextureCache {
  if (cacheInstance) {
    cacheInstance.clear();
  }
  cacheInstance = new TileTextureCache(config);
  return cacheInstance;
}
