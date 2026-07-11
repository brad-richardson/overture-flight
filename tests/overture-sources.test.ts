import { describe, expect, it } from 'vitest';
import {
  isUnavailableOvertureSource,
} from '../src/overture-sources.js';

describe('Overture sources', () => {
  it('recognizes only the deterministic unavailable-source sentinel', () => {
    expect(isUnavailableOvertureSource(
      'data:application/vnd.pmtiles;base64,#overture-unavailable-buildings'
    )).toBe(true);
    expect(isUnavailableOvertureSource('https://tiles.example/buildings.pmtiles')).toBe(false);
  });
});
