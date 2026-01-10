import * as THREE from 'three';
import type { CachedTexture, TileBounds } from './types.js';
import { disposeTexture, isDeferredDisposalEnabled } from '../renderer/texture-disposal.js';

/**
 * LRU cache for rendered ground textures
 * Manages GPU memory by disposing textures when cache exceeds limits
 *
 * Uses the global texture-disposal utility for WebGPU-safe disposal.
 * The utility handles deferred disposal automatically when WebGPU is active.
 */
export class TileTextureCache {
  private cache = new Map<string, CachedTexture>();
  private disposeThreshold: number;
  // Track textures that are currently bound to active tiles and should not be evicted
  private inUseTextures = new Set<string>();
  // Track textures pending "unmark" - they were recently in use and should stay protected
  private pendingUnmark = new Set<string>();
  private unmarkScheduled = false;

  constructor(config: { maxSize: number; disposeThreshold?: number; deferDisposal?: boolean }) {
    // Start evicting when we hit 80% of max size (or at specified threshold)
    this.disposeThreshold = config.disposeThreshold ?? Math.floor(config.maxSize * 0.8);
    // Note: deferDisposal config is now ignored - we use the global texture-disposal utility
    // which automatically handles deferred disposal based on renderer type
  }

  /**
   * Mark a texture as in-use (bound to an active tile)
   * In-use textures will not be evicted by LRU
   */
  markInUse(key: string): void {
    // Cancel any pending unmark for this key
    this.pendingUnmark.delete(key);
    this.inUseTextures.add(key);
  }

  /**
   * Unmark a texture as in-use (tile has been removed)
   * For WebGPU, this is deferred to allow GPU commands to complete.
   * The texture can be evicted by LRU after the deferral period.
   */
  unmarkInUse(key: string): void {
    if (isDeferredDisposalEnabled()) {
      // Defer the unmark to allow GPU commands referencing this texture to complete
      this.pendingUnmark.add(key);
      this.scheduleUnmark();
    } else {
      this.inUseTextures.delete(key);
    }
  }

  /**
   * Schedule deferred unmark of textures
   * Waits several frames to ensure GPU commands have completed
   */
  private scheduleUnmark(): void {
    if (this.unmarkScheduled) return;
    this.unmarkScheduled = true;

    // Wait 4 frames (same as texture disposal) before actually unmarking
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.flushPendingUnmarks();
          });
        });
      });
    });
  }

  /**
   * Process pending unmarks
   */
  private flushPendingUnmarks(): void {
    for (const key of this.pendingUnmark) {
      this.inUseTextures.delete(key);
    }
    this.pendingUnmark.clear();
    this.unmarkScheduled = false;
  }

  /**
   * Check if a texture is currently in use
   */
  isInUse(key: string): boolean {
    return this.inUseTextures.has(key);
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
      // Use global utility for WebGPU-safe disposal
      disposeTexture(cached.texture);
      this.cache.delete(key);
    }
  }

  /**
   * Dispose all textures and clear cache
   */
  clear(): void {
    for (const cached of this.cache.values()) {
      // Use global utility for WebGPU-safe disposal
      disposeTexture(cached.texture);
    }
    this.cache.clear();
  }

  /**
   * Evict least recently used entries until we're under threshold
   * IMPORTANT: Never evicts textures that are marked as in-use
   */
  private evictLRU(): void {
    const targetSize = Math.floor(this.disposeThreshold * 0.75);

    // Sort by last accessed time (oldest first), filtering out in-use textures
    const entries = Array.from(this.cache.entries())
      .filter(([key]) => !this.inUseTextures.has(key))
      .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

    // Evict oldest (non-in-use) until we're at target size
    let index = 0;
    while (this.cache.size > targetSize && index < entries.length) {
      const [key, cached] = entries[index];
      // Double-check it's still not in use (defensive)
      if (!this.inUseTextures.has(key)) {
        // Use global utility for WebGPU-safe disposal
        disposeTexture(cached.texture);
        this.cache.delete(key);
      }
      index++;
    }
  }
}

// Singleton instance
let cacheInstance: TileTextureCache | null = null;

/**
 * Get the shared texture cache instance
 * NOTE: Prefer using initTextureCache() first to set proper config values.
 * This fallback uses defaults that may not match GROUND_TEXTURE constants.
 */
export function getTextureCache(): TileTextureCache {
  if (!cacheInstance) {
    console.warn('TileTextureCache: Using default values. Call initTextureCache() first for proper config.');
    cacheInstance = new TileTextureCache({
      maxSize: 100,
      disposeThreshold: 80,
    });
  }
  return cacheInstance;
}

/**
 * Initialize the texture cache with custom config
 * @param config.deferDisposal Enable deferred disposal for WebGPU compatibility
 */
export function initTextureCache(config: { maxSize: number; disposeThreshold?: number; deferDisposal?: boolean }): TileTextureCache {
  if (cacheInstance) {
    cacheInstance.clear();
  }
  cacheInstance = new TileTextureCache(config);
  return cacheInstance;
}
