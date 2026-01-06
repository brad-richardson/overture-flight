/**
 * Tile loading performance profiler
 * Uses Performance API for Chrome DevTools visibility
 * Only active when VITE_PROFILING=true
 */

import { PROFILING } from '../constants.js';

// Metric types for categorization
export type MetricCategory =
  | 'fetch'      // Network fetches
  | 'parse'      // MVT parsing
  | 'render'     // Canvas rendering
  | 'elevation'  // Elevation processing
  | 'gpu'        // GPU operations
  | 'tile';      // Overall tile processing

export interface TileMetrics {
  tileKey: string;
  startTime: number;
  endTime?: number;
  phases: {
    fetch?: PhaseMetric;
    parse?: PhaseMetric;
    neighborFetch?: PhaseMetric;
    canvasRender?: PhaseMetric;
    gpuUpload?: PhaseMetric;
    terrainElevation?: PhaseMetric;
  };
  featureCounts?: {
    base: number;
    transport: number;
    total: number;
  };
}

interface PhaseMetric {
  start: number;
  end: number;
  duration: number;
}

// Track active tile operations
const activeTiles = new Map<string, TileMetrics>();

// Aggregate stats for summary
const stats = {
  tilesProcessed: 0,
  totalFetchTime: 0,
  totalParseTime: 0,
  totalRenderTime: 0,
  totalElevationTime: 0,
  totalTileTime: 0,
  minTileTime: Infinity,
  maxTileTime: 0,
  // Cache metrics
  textureCacheHits: 0,
  textureCacheMisses: 0,
  // Network vs CPU breakdown
  totalNetworkTime: 0,  // Pure network time (response received)
  totalDecodeTime: 0,   // CPU time for MVT parsing
};

/**
 * Check if profiling is enabled
 */
export function isProfilingEnabled(): boolean {
  return PROFILING.ENABLED;
}

/**
 * Start tracking a tile operation
 */
export function startTile(tileKey: string): void {
  if (!PROFILING.ENABLED) return;

  const now = performance.now();
  activeTiles.set(tileKey, {
    tileKey,
    startTime: now,
    phases: {},
  });

  // Performance mark for DevTools
  performance.mark(`tile:start:${tileKey}`);
}

/**
 * End tracking a tile operation
 */
export function endTile(tileKey: string): TileMetrics | null {
  if (!PROFILING.ENABLED) return null;

  const metrics = activeTiles.get(tileKey);
  if (!metrics) return null;

  const now = performance.now();
  metrics.endTime = now;
  const duration = now - metrics.startTime;

  // Performance marks for DevTools
  performance.mark(`tile:end:${tileKey}`);
  performance.measure(`tile:total:${tileKey}`, `tile:start:${tileKey}`, `tile:end:${tileKey}`);

  // Update aggregate stats
  stats.tilesProcessed++;
  stats.totalTileTime += duration;
  stats.minTileTime = Math.min(stats.minTileTime, duration);
  stats.maxTileTime = Math.max(stats.maxTileTime, duration);

  // Aggregate phase times
  if (metrics.phases.fetch) stats.totalFetchTime += metrics.phases.fetch.duration;
  if (metrics.phases.parse) stats.totalParseTime += metrics.phases.parse.duration;
  if (metrics.phases.canvasRender) stats.totalRenderTime += metrics.phases.canvasRender.duration;
  if (metrics.phases.terrainElevation) stats.totalElevationTime += metrics.phases.terrainElevation.duration;

  activeTiles.delete(tileKey);

  // Log individual tile metrics if verbose
  if (PROFILING.VERBOSE) {
    console.log(`[Profiler] Tile ${tileKey}: ${duration.toFixed(1)}ms`, metrics.phases);
  }

  return metrics;
}

/**
 * Start a phase within a tile operation
 */
export function startPhase(tileKey: string, phase: keyof TileMetrics['phases']): void {
  if (!PROFILING.ENABLED) return;

  const metrics = activeTiles.get(tileKey);
  if (!metrics) return;

  const now = performance.now();
  metrics.phases[phase] = { start: now, end: 0, duration: 0 };

  performance.mark(`tile:${phase}:start:${tileKey}`);
}

/**
 * End a phase within a tile operation
 */
export function endPhase(tileKey: string, phase: keyof TileMetrics['phases']): number {
  if (!PROFILING.ENABLED) return 0;

  const metrics = activeTiles.get(tileKey);
  if (!metrics || !metrics.phases[phase]) return 0;

  const now = performance.now();
  const phaseMetric = metrics.phases[phase]!;
  phaseMetric.end = now;
  phaseMetric.duration = now - phaseMetric.start;

  performance.mark(`tile:${phase}:end:${tileKey}`);
  performance.measure(`tile:${phase}:${tileKey}`, `tile:${phase}:start:${tileKey}`, `tile:${phase}:end:${tileKey}`);

  return phaseMetric.duration;
}

/**
 * Record feature counts for a tile
 */
export function recordFeatureCounts(tileKey: string, base: number, transport: number): void {
  if (!PROFILING.ENABLED) return;

  const metrics = activeTiles.get(tileKey);
  if (!metrics) return;

  metrics.featureCounts = {
    base,
    transport,
    total: base + transport,
  };
}

/**
 * Record a texture cache hit
 */
export function recordCacheHit(): void {
  if (!PROFILING.ENABLED) return;
  stats.textureCacheHits++;
}

/**
 * Record a texture cache miss
 */
export function recordCacheMiss(): void {
  if (!PROFILING.ENABLED) return;
  stats.textureCacheMisses++;
}

/**
 * Record network vs decode time for a fetch+parse operation
 * Call this from tile-manager when you have separate network and parse timings
 */
export function recordFetchTiming(networkMs: number, decodeMs: number): void {
  if (!PROFILING.ENABLED) return;
  stats.totalNetworkTime += networkMs;
  stats.totalDecodeTime += decodeMs;
}

/**
 * Time an async operation with automatic phase tracking
 */
export async function timeAsync<T>(
  tileKey: string,
  phase: keyof TileMetrics['phases'],
  operation: () => Promise<T>
): Promise<T> {
  if (!PROFILING.ENABLED) {
    return operation();
  }

  startPhase(tileKey, phase);
  try {
    return await operation();
  } finally {
    endPhase(tileKey, phase);
  }
}

/**
 * Time a sync operation with automatic phase tracking
 */
export function timeSync<T>(
  tileKey: string,
  phase: keyof TileMetrics['phases'],
  operation: () => T
): T {
  if (!PROFILING.ENABLED) {
    return operation();
  }

  startPhase(tileKey, phase);
  try {
    return operation();
  } finally {
    endPhase(tileKey, phase);
  }
}

/**
 * Generic timing function for standalone operations
 */
export function mark(name: string): void {
  if (!PROFILING.ENABLED) return;
  performance.mark(name);
}

export function measure(name: string, startMark: string, endMark?: string): void {
  if (!PROFILING.ENABLED) return;
  if (endMark) {
    performance.measure(name, startMark, endMark);
  } else {
    performance.measure(name, startMark);
  }
}

/**
 * Get aggregate stats
 */
export function getStats(): typeof stats & { avgTileTime: number } {
  return {
    ...stats,
    avgTileTime: stats.tilesProcessed > 0 ? stats.totalTileTime / stats.tilesProcessed : 0,
  };
}

/**
 * Reset aggregate stats
 */
export function resetStats(): void {
  stats.tilesProcessed = 0;
  stats.totalFetchTime = 0;
  stats.totalParseTime = 0;
  stats.totalRenderTime = 0;
  stats.totalElevationTime = 0;
  stats.totalTileTime = 0;
  stats.minTileTime = Infinity;
  stats.maxTileTime = 0;
  stats.textureCacheHits = 0;
  stats.textureCacheMisses = 0;
  stats.totalNetworkTime = 0;
  stats.totalDecodeTime = 0;
}

/**
 * Log a summary of profiling stats to console
 */
export function logSummary(): void {
  if (!PROFILING.ENABLED) return;

  const s = getStats();
  const cacheTotal = s.textureCacheHits + s.textureCacheMisses;
  const cacheHitRate = cacheTotal > 0 ? (100 * s.textureCacheHits / cacheTotal).toFixed(1) : 'N/A';

  console.log(`
[Tile Profiler Summary]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Tiles Processed: ${s.tilesProcessed}
Total Tile Time: ${s.totalTileTime.toFixed(1)}ms
Avg Tile Time:   ${s.avgTileTime.toFixed(1)}ms
Min Tile Time:   ${s.minTileTime === Infinity ? 'N/A' : s.minTileTime.toFixed(1) + 'ms'}
Max Tile Time:   ${s.maxTileTime.toFixed(1)}ms

Cache Stats:
  Hits:          ${s.textureCacheHits}
  Misses:        ${s.textureCacheMisses}
  Hit Rate:      ${cacheHitRate}%

Phase Breakdown (total):
  Fetch:         ${s.totalFetchTime.toFixed(1)}ms (${(100 * s.totalFetchTime / s.totalTileTime || 0).toFixed(1)}%)
  Parse:         ${s.totalParseTime.toFixed(1)}ms (${(100 * s.totalParseTime / s.totalTileTime || 0).toFixed(1)}%)
  Canvas Render: ${s.totalRenderTime.toFixed(1)}ms (${(100 * s.totalRenderTime / s.totalTileTime || 0).toFixed(1)}%)
  Elevation:     ${s.totalElevationTime.toFixed(1)}ms (${(100 * s.totalElevationTime / s.totalTileTime || 0).toFixed(1)}%)

Network vs CPU (fetch operations):
  Network:       ${s.totalNetworkTime.toFixed(1)}ms
  Decode (CPU):  ${s.totalDecodeTime.toFixed(1)}ms
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

/**
 * Export current data for external analysis
 */
export function exportMetrics(): {
  stats: ReturnType<typeof getStats>;
  activeCount: number;
} {
  return {
    stats: getStats(),
    activeCount: activeTiles.size,
  };
}
