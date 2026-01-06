/**
 * IndexedDB persistent texture cache
 *
 * Caches rendered textures (PNG blobs) for faster repeat visits.
 * Uses LRU eviction when cache exceeds MAX_ENTRIES.
 *
 * Note: Only enabled in production builds by default.
 * Override with VITE_TEXTURE_CACHE=true/false
 */

import { TEXTURE_CACHE } from '../constants.js';

interface CachedTexture {
  /** Cache key (e.g., "v1:ground-14/1234/5678") */
  key: string;
  /** PNG-encoded texture data */
  blob: Blob;
  /** Timestamp for LRU eviction */
  timestamp: number;
  /** Tile bounds for reference */
  bounds: {
    west: number;
    east: number;
    north: number;
    south: number;
  };
}

// Database instance (lazy initialized)
let db: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase | null> | null = null;

/**
 * Get versioned cache key
 */
function getVersionedKey(tileKey: string): string {
  return `v${TEXTURE_CACHE.VERSION}:${tileKey}`;
}

/**
 * Initialize the IndexedDB database
 */
async function initDB(): Promise<IDBDatabase | null> {
  if (!TEXTURE_CACHE.ENABLED) {
    return null;
  }

  if (db) {
    return db;
  }

  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(TEXTURE_CACHE.DB_NAME, 1);

      request.onerror = () => {
        console.warn('[TextureCache] Failed to open IndexedDB:', request.error);
        resolve(null);
      };

      request.onsuccess = () => {
        db = request.result;
        resolve(db);
      };

      request.onupgradeneeded = (event) => {
        const database = (event.target as IDBOpenDBRequest).result;

        // Create textures object store with key path
        if (!database.objectStoreNames.contains(TEXTURE_CACHE.STORE_NAME)) {
          const store = database.createObjectStore(TEXTURE_CACHE.STORE_NAME, {
            keyPath: 'key',
          });
          // Index for LRU eviction by timestamp
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
    } catch (error) {
      console.warn('[TextureCache] IndexedDB not available:', error);
      resolve(null);
    }
  });

  return dbPromise;
}

/**
 * Get a cached texture
 * Returns null if not found or cache disabled
 */
export async function getCachedTexture(
  tileKey: string
): Promise<{ blob: Blob; bounds: CachedTexture['bounds'] } | null> {
  const database = await initDB();
  if (!database) {
    return null;
  }

  const key = getVersionedKey(tileKey);

  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(TEXTURE_CACHE.STORE_NAME, 'readonly');
      const store = transaction.objectStore(TEXTURE_CACHE.STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => {
        const result = request.result as CachedTexture | undefined;
        if (result) {
          // Update timestamp for LRU (in separate transaction)
          updateTimestamp(key);
          resolve({ blob: result.blob, bounds: result.bounds });
        } else {
          resolve(null);
        }
      };

      request.onerror = () => {
        console.warn('[TextureCache] Failed to get texture:', request.error);
        resolve(null);
      };
    } catch (error) {
      console.warn('[TextureCache] Transaction error:', error);
      resolve(null);
    }
  });
}

/**
 * Update timestamp for LRU tracking (non-blocking)
 */
function updateTimestamp(key: string): void {
  if (!db) return;

  try {
    const transaction = db.transaction(TEXTURE_CACHE.STORE_NAME, 'readwrite');
    const store = transaction.objectStore(TEXTURE_CACHE.STORE_NAME);
    const request = store.get(key);

    request.onsuccess = () => {
      const entry = request.result as CachedTexture | undefined;
      if (entry) {
        entry.timestamp = Date.now();
        store.put(entry);
      }
    };
  } catch {
    // Ignore timestamp update errors
  }
}

/**
 * Cache a texture
 * Non-blocking - errors are logged but don't block rendering
 */
export async function cacheTexture(
  tileKey: string,
  blob: Blob,
  bounds: CachedTexture['bounds']
): Promise<void> {
  const database = await initDB();
  if (!database) {
    return;
  }

  const key = getVersionedKey(tileKey);
  const entry: CachedTexture = {
    key,
    blob,
    timestamp: Date.now(),
    bounds,
  };

  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(TEXTURE_CACHE.STORE_NAME, 'readwrite');
      const store = transaction.objectStore(TEXTURE_CACHE.STORE_NAME);

      // Store the texture
      const request = store.put(entry);

      request.onsuccess = () => {
        // Check if we need to evict old entries
        evictIfNeeded(database);
        resolve();
      };

      request.onerror = () => {
        console.warn('[TextureCache] Failed to cache texture:', request.error);
        resolve();
      };
    } catch (error) {
      console.warn('[TextureCache] Transaction error:', error);
      resolve();
    }
  });
}

/**
 * Evict oldest entries if cache exceeds MAX_ENTRIES
 * Non-blocking background operation
 */
function evictIfNeeded(database: IDBDatabase): void {
  try {
    const transaction = database.transaction(TEXTURE_CACHE.STORE_NAME, 'readwrite');
    const store = transaction.objectStore(TEXTURE_CACHE.STORE_NAME);
    const countRequest = store.count();

    countRequest.onsuccess = () => {
      const count = countRequest.result;
      if (count > TEXTURE_CACHE.MAX_ENTRIES) {
        // Evict oldest entries
        const entriesToRemove = count - TEXTURE_CACHE.MAX_ENTRIES + 10; // Remove 10 extra for headroom
        const index = store.index('timestamp');
        const cursorRequest = index.openCursor();

        let removed = 0;
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor && removed < entriesToRemove) {
            store.delete(cursor.primaryKey);
            removed++;
            cursor.continue();
          }
        };
      }
    };
  } catch {
    // Ignore eviction errors
  }
}

/**
 * Convert canvas to PNG blob
 */
export async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Failed to convert canvas to blob'));
        }
      },
      'image/png',
      1.0 // Maximum quality
    );
  });
}

/**
 * Convert blob to ImageBitmap (for creating Three.js texture)
 */
export async function blobToImageBitmap(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob);
}

/**
 * Clear all cached textures
 */
export async function clearTextureCache(): Promise<void> {
  const database = await initDB();
  if (!database) {
    return;
  }

  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(TEXTURE_CACHE.STORE_NAME, 'readwrite');
      const store = transaction.objectStore(TEXTURE_CACHE.STORE_NAME);
      const request = store.clear();

      request.onsuccess = () => {
        console.log('[TextureCache] Cache cleared');
        resolve();
      };

      request.onerror = () => {
        console.warn('[TextureCache] Failed to clear cache:', request.error);
        resolve();
      };
    } catch (error) {
      console.warn('[TextureCache] Transaction error:', error);
      resolve();
    }
  });
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<{
  enabled: boolean;
  count: number;
  sizeBytes: number;
} | null> {
  const database = await initDB();
  if (!database) {
    return { enabled: false, count: 0, sizeBytes: 0 };
  }

  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(TEXTURE_CACHE.STORE_NAME, 'readonly');
      const store = transaction.objectStore(TEXTURE_CACHE.STORE_NAME);
      const countRequest = store.count();

      let totalSize = 0;
      const cursorRequest = store.openCursor();

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          const entry = cursor.value as CachedTexture;
          totalSize += entry.blob.size;
          cursor.continue();
        }
      };

      countRequest.onsuccess = () => {
        transaction.oncomplete = () => {
          resolve({
            enabled: true,
            count: countRequest.result,
            sizeBytes: totalSize,
          });
        };
      };

      countRequest.onerror = () => {
        resolve({ enabled: true, count: 0, sizeBytes: 0 });
      };
    } catch (error) {
      console.warn('[TextureCache] Stats error:', error);
      resolve({ enabled: true, count: 0, sizeBytes: 0 });
    }
  });
}

/**
 * Check if texture caching is enabled
 */
export function isTextureCacheEnabled(): boolean {
  return TEXTURE_CACHE.ENABLED;
}
