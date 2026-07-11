import { describe, expect, it } from 'vitest';
import {
  createOvertureCacheNamespace,
  isUnavailableOvertureSource,
  type OvertureSources,
} from '../src/overture-sources.js';

const sources: OvertureSources = {
  release: '2026-07-01.0',
  buildings: 'https://tiles.example/2026-07-01.0/buildings.pmtiles',
  base: 'https://tiles.example/2026-07-01.0/base.pmtiles',
  transportation: 'https://tiles.example/2026-07-01.0/transportation.pmtiles',
  divisions: 'https://tiles.example/2026-07-01.0/divisions.pmtiles',
};

describe('Overture source cache namespace', () => {
  it('is stable for identical runtime source identities', () => {
    expect(createOvertureCacheNamespace(sources)).toBe(
      createOvertureCacheNamespace({ ...sources, release: 'another-label' })
    );
  });

  it('changes when any source URL changes', () => {
    const original = createOvertureCacheNamespace(sources);

    for (const key of ['buildings', 'base', 'transportation', 'divisions'] as const) {
      expect(createOvertureCacheNamespace({
        ...sources,
        [key]: `${sources[key]}?revision=2`,
      })).not.toBe(original);
    }
  });

  it('recognizes only the deterministic unavailable-source sentinel', () => {
    expect(isUnavailableOvertureSource(
      'data:application/vnd.pmtiles;base64,#overture-unavailable-buildings'
    )).toBe(true);
    expect(isUnavailableOvertureSource('https://tiles.example/buildings.pmtiles')).toBe(false);
  });
});
