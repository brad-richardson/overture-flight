import { describe, expect, it } from 'vitest';
import { createPersistentTextureCacheKey } from '../src/cache/indexed-db-texture-cache.js';
import {
  createGroundTextureCacheNamespace,
  GROUND_TEXTURE_RENDER_VERSION,
  type GroundTextureCacheIdentity,
} from '../src/ground-texture/persistent-cache-identity.js';
import type { OvertureSources } from '../src/overture-sources.js';

const sources: OvertureSources = {
  release: '2026-07-01.0',
  buildings: 'https://tiles.example/2026-07-01.0/buildings.pmtiles',
  base: 'https://tiles.example/2026-07-01.0/base.pmtiles',
  transportation: 'https://tiles.example/2026-07-01.0/transportation.pmtiles',
  divisions: 'https://tiles.example/2026-07-01.0/divisions.pmtiles',
};

function identityFor(
  resolvedSources: OvertureSources,
  overrides: Partial<GroundTextureCacheIdentity> = {}
): GroundTextureCacheIdentity {
  return {
    baseSource: resolvedSources.base,
    transportationSource: resolvedSources.transportation,
    textureSize: 1024,
    includeNeighbors: true,
    includeTransportation: true,
    renderVersion: GROUND_TEXTURE_RENDER_VERSION,
    ...overrides,
  };
}

describe('ground texture persistent cache identity', () => {
  it('is stable across deployments and ignores non-rendered Overture themes', () => {
    const original = createGroundTextureCacheNamespace(identityFor(sources));
    const unrelatedChanges: OvertureSources = {
      ...sources,
      release: 'another-release-label',
      buildings: `${sources.buildings}?revision=2`,
      divisions: `${sources.divisions}?revision=2`,
    };

    expect(createGroundTextureCacheNamespace(identityFor({ ...sources }))).toBe(original);
    expect(createGroundTextureCacheNamespace(identityFor(unrelatedChanges))).toBe(original);
    expect(original).not.toContain('BUILD_HASH');
  });

  it('invalidates for every input that can affect rendered pixels', () => {
    const identity = identityFor(sources);
    const original = createGroundTextureCacheNamespace(identity);
    const changes: GroundTextureCacheIdentity[] = [
      { ...identity, baseSource: `${identity.baseSource}?revision=2` },
      { ...identity, transportationSource: `${identity.transportationSource}?revision=2` },
      { ...identity, textureSize: 512 },
      { ...identity, includeNeighbors: false },
      { ...identity, includeTransportation: false },
      { ...identity, renderVersion: identity.renderVersion + 1 },
    ];

    for (const changedIdentity of changes) {
      expect(createGroundTextureCacheNamespace(changedIdentity)).not.toBe(original);
    }
  });

  it('does not alias source URLs that collide under the previous 32-bit hash', () => {
    const identity = identityFor(sources);
    const first = createGroundTextureCacheNamespace({
      ...identity,
      baseSource: 'https://b/sdernx6r1t6t',
    });
    const second = createGroundTextureCacheNamespace({
      ...identity,
      baseSource: 'https://b/6gcuqi19ochhu',
    });

    expect(first).not.toBe(second);
    expect(first).toContain('https://b/sdernx6r1t6t');
    expect(second).toContain('https://b/6gcuqi19ochhu');
  });

  it('builds stable tile keys and isolates tiles and render namespaces', () => {
    const namespace = createGroundTextureCacheNamespace(identityFor(sources));
    const tileKey = 'ground-14/8731/5942';
    const key = createPersistentTextureCacheKey(tileKey, namespace);

    expect(key).toBe(`${namespace}:${tileKey}`);
    expect(createPersistentTextureCacheKey(tileKey, namespace)).toBe(key);
    expect(createPersistentTextureCacheKey('ground-14/8732/5942', namespace)).not.toBe(key);
    expect(createPersistentTextureCacheKey(tileKey, `${namespace}-changed`)).not.toBe(key);
  });
});
