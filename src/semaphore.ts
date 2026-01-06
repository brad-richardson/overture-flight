import { TILE_CONCURRENCY, FETCH_CONCURRENCY } from './constants.js';

/**
 * Priority levels for tile processing
 * Lower number = higher priority (processed first)
 */
export enum TilePriority {
  Z14_GROUND = 1,   // High-detail ground tiles (most important)
  Z10_GROUND = 2,   // Low-detail distant terrain
  BUILDINGS = 3,    // Buildings (can wait)
}

interface WaitingItem {
  priority: TilePriority;
  resolve: () => void;
}

/**
 * Priority semaphore for limiting concurrent async operations
 * Higher priority items (lower number) get permits first
 */
export class PrioritySemaphore {
  private permits: number;
  private waiting: WaitingItem[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  /**
   * Acquire a permit with priority. Blocks if none available.
   * Higher priority (lower number) items are serviced first.
   */
  async acquire(priority: TilePriority = TilePriority.BUILDINGS): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    // Wait for a permit to become available
    return new Promise<void>((resolve) => {
      this.waiting.push({ priority, resolve });
      // Keep sorted by priority (lower number = higher priority = first)
      this.waiting.sort((a, b) => a.priority - b.priority);
    });
  }

  /**
   * Release a permit, allowing the highest priority waiting operation to proceed
   */
  release(): void {
    const next = this.waiting.shift();
    if (next) {
      // Give permit to highest priority waiting operation
      next.resolve();
    } else {
      // No one waiting, return permit to pool
      this.permits++;
    }
  }

  /**
   * Run a function with a permit, automatically releasing when done
   */
  async run<T>(fn: () => Promise<T>, priority: TilePriority = TilePriority.BUILDINGS): Promise<T> {
    await this.acquire(priority);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Get current number of available permits
   */
  getAvailable(): number {
    return this.permits;
  }

  /**
   * Get number of operations waiting for permits
   */
  getWaiting(): number {
    return this.waiting.length;
  }

  /**
   * Get count of waiting items by priority
   */
  getWaitingByPriority(): Record<TilePriority, number> {
    const counts = {
      [TilePriority.Z14_GROUND]: 0,
      [TilePriority.Z10_GROUND]: 0,
      [TilePriority.BUILDINGS]: 0,
    };
    for (const item of this.waiting) {
      counts[item.priority]++;
    }
    return counts;
  }
}

// Shared singleton for tile loading concurrency
let tileSemaphore: PrioritySemaphore | null = null;

/**
 * Get the shared tile loading semaphore
 * Returns null if concurrency limiting is disabled
 */
export function getTileSemaphore(): PrioritySemaphore | null {
  if (!TILE_CONCURRENCY.ENABLED) {
    return null;
  }
  if (!tileSemaphore) {
    tileSemaphore = new PrioritySemaphore(TILE_CONCURRENCY.MAX_CONCURRENT);
  }
  return tileSemaphore;
}

// Shared singleton for network fetch concurrency
let fetchSemaphore: PrioritySemaphore | null = null;

/**
 * Get the shared network fetch semaphore
 * Limits concurrent HTTP requests to prevent flooding
 * Returns null if concurrency limiting is disabled
 */
export function getFetchSemaphore(): PrioritySemaphore | null {
  if (!FETCH_CONCURRENCY.ENABLED) {
    return null;
  }
  if (!fetchSemaphore) {
    fetchSemaphore = new PrioritySemaphore(FETCH_CONCURRENCY.MAX_CONCURRENT);
  }
  return fetchSemaphore;
}
