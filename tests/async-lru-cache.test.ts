import { describe, expect, it, vi } from 'vitest';
import { AsyncLruCache } from '../src/workers/async-lru-cache.js';
import {
  copyFeatureWithProperties,
  ParsedSourceTileCache,
  parsedSourceTileKey,
  type ParsedSourceKind,
} from '../src/workers/parsed-source-tile.js';
import type { ParsedFeature } from '../src/workers/types.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('async LRU cache', () => {
  it('reuses fulfilled values and refreshes their LRU position', async () => {
    const cache = new AsyncLruCache<string, string>(2);
    const loadA = vi.fn(async () => 'A');
    const loadB = vi.fn(async () => 'B');
    const loadC = vi.fn(async () => 'C');

    await cache.getOrLoad('a', loadA);
    await cache.getOrLoad('b', loadB);
    await expect(cache.getOrLoad('a', loadA)).resolves.toBe('A');
    await cache.getOrLoad('c', loadC);
    await expect(cache.getOrLoad('b', loadB)).resolves.toBe('B');

    expect(loadA).toHaveBeenCalledOnce();
    expect(loadB).toHaveBeenCalledTimes(2);
    expect(loadC).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent loads for the same key', async () => {
    const cache = new AsyncLruCache<string, string>(2);
    const pending = deferred<string>();
    const load = vi.fn(() => pending.promise);

    const first = cache.getOrLoad('same', load);
    const second = cache.getOrLoad('same', load);

    expect(second).toBe(first);
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
    pending.resolve('value');
    await expect(Promise.all([first, second])).resolves.toEqual(['value', 'value']);
  });

  it('removes rejected loads so the key can recover', async () => {
    const cache = new AsyncLruCache<string, string>(2);
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('parse failed'))
      .mockResolvedValueOnce('recovered');

    await expect(cache.getOrLoad('tile', load)).rejects.toThrow('parse failed');
    await expect(cache.getOrLoad('tile', load)).resolves.toBe('recovered');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('retains fulfilled empty values as bounded negative-cache hits', async () => {
    const cache = new AsyncLruCache<string, string[]>(2);
    const loadMissing = vi.fn(async () => []);

    await expect(cache.getOrLoad('missing', loadMissing)).resolves.toEqual([]);
    await expect(cache.getOrLoad('missing', loadMissing)).resolves.toEqual([]);
    expect(loadMissing).toHaveBeenCalledOnce();
  });
});

describe('parsed source tile identity', () => {
  const key = (
    sourceKind: ParsedSourceKind,
    selectedLayers: readonly string[],
    sourceIdentity = 'base.pmtiles'
  ): string => parsedSourceTileKey({
    sourceKind,
    sourceIdentity,
    z: 12,
    x: 100,
    y: 200,
    selectedLayers,
  });

  it('separates source roles, source URLs, coordinates, and exact layer sets', () => {
    const base = key('base', ['water', 'land']);

    expect(key('base', ['land', 'water'])).toBe(base);
    expect(key('lower-water', ['water', 'land'])).not.toBe(base);
    expect(key('transportation', ['water', 'land'])).not.toBe(base);
    expect(key('base', ['water'], 'base-v2.pmtiles')).not.toBe(base);
    expect(key('base', ['water'])).not.toBe(base);
    expect(parsedSourceTileKey({
      sourceKind: 'base',
      sourceIdentity: 'base.pmtiles',
      z: 12,
      x: 101,
      y: 200,
      selectedLayers: ['water', 'land'],
    })).not.toBe(base);
  });

  it('does not mutate cached features when adding consumer metadata', () => {
    const cached: ParsedFeature = {
      type: 'Polygon',
      coordinates: [[[1, 2], [3, 4], [1, 2]]],
      properties: { subtype: 'ocean' },
      layer: 'water',
    };

    const annotated = copyFeatureWithProperties(cached, {
      _fromLowerZoom: true,
      _sourceZoom: 10,
    });

    expect(annotated).not.toBe(cached);
    expect(annotated.properties).not.toBe(cached.properties);
    expect(annotated.coordinates).toBe(cached.coordinates);
    expect(cached.properties).toEqual({ subtype: 'ocean' });
    expect(annotated.properties).toEqual({
      subtype: 'ocean',
      _fromLowerZoom: true,
      _sourceZoom: 10,
    });
  });

  it('reduces 81 schedules to 25 loads in the single-worker shared-cache best case', async () => {
    const cache = new AsyncLruCache<string, string>(64);
    const load = vi.fn(async (sourceKey: string) => sourceKey);
    const requests: Promise<string>[] = [];

    for (let outputY = -1; outputY <= 1; outputY++) {
      for (let outputX = -1; outputX <= 1; outputX++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const sourceKey = parsedSourceTileKey({
              sourceKind: 'base',
              sourceIdentity: 'base.pmtiles',
              z: 14,
              x: 100 + outputX + dx,
              y: 200 + outputY + dy,
              selectedLayers: ['land', 'land_use', 'land_cover', 'water'],
            });
            requests.push(cache.getOrLoad(sourceKey, () => load(sourceKey)));
          }
        }
      }
    }

    expect(requests).toHaveLength(81);
    await Promise.all(requests);
    expect(load).toHaveBeenCalledTimes(25);
  });
});

describe('parsed source tile cache', () => {
  const identity = {
    sourceKind: 'base' as const,
    sourceIdentity: 'base.pmtiles',
    z: 14,
    x: 100,
    y: 200,
    selectedLayers: ['land'] as const,
  };
  const parsed: ParsedFeature[] = [{
    type: 'Polygon',
    coordinates: [[[1, 2], [3, 4], [1, 2]]],
    properties: { subtype: 'land' },
    layer: 'land',
  }];

  it('negative-caches a genuinely absent tile without invoking the parser', async () => {
    const cache = new ParsedSourceTileCache(2);
    const fetchData = vi.fn(async () => null);
    const parse = vi.fn(() => parsed);
    const onError = vi.fn();

    await expect(cache.load(identity, fetchData, parse, onError)).resolves.toEqual([]);
    await expect(cache.load(identity, fetchData, parse, onError)).resolves.toEqual([]);

    expect(fetchData).toHaveBeenCalledOnce();
    expect(parse).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('coalesces a failed fetch, reports once, and retries on the next call', async () => {
    const cache = new ParsedSourceTileCache(2);
    const pending = deferred<ArrayBuffer | null>();
    const failure = new Error('temporary network failure');
    const fetchData = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(new ArrayBuffer(1));
    const parse = vi.fn(() => parsed);
    const onError = vi.fn();

    const first = cache.load(identity, fetchData, parse, onError);
    const second = cache.load(identity, fetchData, parse, onError);
    await Promise.resolve();
    expect(fetchData).toHaveBeenCalledOnce();

    pending.reject(failure);
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);

    await expect(cache.load(identity, fetchData, parse, onError)).resolves.toBe(parsed);
    expect(fetchData).toHaveBeenCalledTimes(2);
    expect(parse).toHaveBeenCalledOnce();
  });

  it('does not cache parser exceptions', async () => {
    const cache = new ParsedSourceTileCache(2);
    const fetchData = vi.fn(async () => new ArrayBuffer(1));
    const failure = new Error('invalid MVT');
    const parse = vi.fn()
      .mockImplementationOnce(() => { throw failure; })
      .mockReturnValueOnce(parsed);
    const onError = vi.fn();

    await expect(cache.load(identity, fetchData, parse, onError)).resolves.toEqual([]);
    await expect(cache.load(identity, fetchData, parse, onError)).resolves.toBe(parsed);

    expect(fetchData).toHaveBeenCalledTimes(2);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
