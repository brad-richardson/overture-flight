import type { ParsedFeature } from './types.js';
import { AsyncLruCache } from './async-lru-cache.js';

export type ParsedSourceKind = 'base' | 'lower-water' | 'transportation';

export interface ParsedSourceTileIdentity {
  sourceKind: ParsedSourceKind;
  sourceIdentity: string;
  z: number;
  x: number;
  y: number;
  selectedLayers: readonly string[] | null;
}

/** Build a collision-safe key; selected layers are a set, not an ordering. */
export function parsedSourceTileKey(identity: ParsedSourceTileIdentity): string {
  const selectedLayers = identity.selectedLayers === null
    ? null
    : [...new Set(identity.selectedLayers)].sort();
  return JSON.stringify([
    identity.sourceKind,
    identity.sourceIdentity,
    identity.z,
    identity.x,
    identity.y,
    selectedLayers,
  ]);
}

/**
 * Cache parsed source tiles while treating absence and failure differently:
 * null is a cacheable missing tile; fetch/parse exceptions retry on the next call.
 */
export class ParsedSourceTileCache {
  private readonly cache: AsyncLruCache<string, ParsedFeature[]>;
  private readonly reportedFailures = new WeakSet<Promise<ParsedFeature[]>>();

  constructor(maxEntries: number) {
    this.cache = new AsyncLruCache(maxEntries);
  }

  async load(
    identity: ParsedSourceTileIdentity,
    fetchData: () => Promise<ArrayBuffer | null>,
    parse: (data: ArrayBuffer) => ParsedFeature[],
    onError: (error: unknown) => void
  ): Promise<ParsedFeature[]> {
    const request = this.cache.getOrLoad(
      parsedSourceTileKey(identity),
      async () => {
        const data = await fetchData();
        return data ? parse(data) : [];
      }
    );

    try {
      return await request;
    } catch (error) {
      // Concurrent callers share request, so report a failed attempt only once.
      if (!this.reportedFailures.has(request)) {
        this.reportedFailures.add(request);
        onError(error);
      }
      return [];
    }
  }
}

/** Copy-on-write for metadata consumers; cached feature wrappers stay unchanged. */
export function copyFeatureWithProperties(
  feature: ParsedFeature,
  properties: Record<string, unknown>
): ParsedFeature {
  return {
    ...feature,
    properties: {
      ...feature.properties,
      ...properties,
    },
  };
}
