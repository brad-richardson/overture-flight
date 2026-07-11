import { describe, expect, it } from 'vitest';
import {
  WEB_MERCATOR_MAX_LATITUDE,
  clampMercatorLatitude,
  horizontalGeoDistanceMeters,
  normalizeGeoCoordinates,
  normalizeGeoState,
  normalizeLongitude,
  parseGeoCoordinateFields,
  shortestLongitudeDelta,
  shouldRebaseLocalOrigin,
} from '../src/geo.js';
import { lerpLongitude } from '../src/interpolation.js';

describe('geographic normalization', () => {
  it('wraps longitude into a stable canonical interval', () => {
    expect(normalizeLongitude(180)).toBe(-180);
    expect(normalizeLongitude(540)).toBe(-180);
    expect(normalizeLongitude(-540)).toBe(-180);
    expect(normalizeLongitude(181)).toBe(-179);
    expect(normalizeLongitude(-181)).toBe(179);
  });

  it('clamps latitude to the finite Web Mercator domain', () => {
    expect(clampMercatorLatitude(90)).toBe(WEB_MERCATOR_MAX_LATITUDE);
    expect(clampMercatorLatitude(-90)).toBe(-WEB_MERCATOR_MAX_LATITUDE);
    expect(normalizeGeoCoordinates(541, 91)).toEqual({
      lng: -179,
      lat: WEB_MERCATOR_MAX_LATITUDE,
    });
  });

  it('normalizes geographic fields without changing flight state', () => {
    const state = {
      lng: 181,
      lat: 90,
      altitude: 1_234,
      heading: 271,
      pitch: -4,
      roll: 18,
      speed: 92,
    };

    expect(normalizeGeoState(state)).toEqual({
      ...state,
      lng: -179,
      lat: WEB_MERCATOR_MAX_LATITUDE,
    });
  });

  it('strictly rejects blank or malformed coordinate fields', () => {
    expect(parseGeoCoordinateFields('', '12')).toBeNull();
    expect(parseGeoCoordinateFields('  ', '12')).toBeNull();
    expect(parseGeoCoordinateFields('43', '\t')).toBeNull();
    expect(parseGeoCoordinateFields('43north', '12')).toBeNull();
    expect(parseGeoCoordinateFields('90', '181')).toEqual({
      lat: WEB_MERCATOR_MAX_LATITUDE,
      lng: -179,
    });
  });
});

describe('antimeridian-aware local distances', () => {
  it('uses the signed shortest longitude delta', () => {
    expect(shortestLongitudeDelta(179.9, -179.9)).toBeCloseTo(0.2, 10);
    expect(shortestLongitudeDelta(-179.9, 179.9)).toBeCloseTo(-0.2, 10);
  });

  it('measures nearby points across the antimeridian as nearby', () => {
    const distance = horizontalGeoDistanceMeters(
      { lng: 179.99, lat: 0 },
      { lng: -179.99, lat: 0 }
    );
    expect(distance).toBeCloseTo(2_226.4, 0);
  });

  it('interpolates multiplayer longitude across the short path', () => {
    expect(lerpLongitude(179, -179, 0.5)).toBe(-180);
    expect(lerpLongitude(-179, 179, 0.5)).toBe(-180);
  });
});

describe('floating-origin threshold', () => {
  const origin = { lng: 11.25, lat: 43.77 };

  it('does not rebase below the threshold', () => {
    expect(shouldRebaseLocalOrigin(origin, { lng: 11.3, lat: 43.77 }, 20_000)).toBe(false);
  });

  it('rebases at or beyond the threshold', () => {
    expect(shouldRebaseLocalOrigin(origin, { lng: 11.25, lat: 44 }, 20_000)).toBe(true);
  });

  it('does not spuriously rebase near the antimeridian', () => {
    expect(shouldRebaseLocalOrigin(
      { lng: 179.99, lat: 0 },
      { lng: -179.99, lat: 0 },
      5_000
    )).toBe(false);
  });

  it('ignores invalid positions and thresholds', () => {
    expect(shouldRebaseLocalOrigin(origin, { lng: Number.NaN, lat: 44 }, 20_000)).toBe(false);
    expect(shouldRebaseLocalOrigin(origin, { lng: 12, lat: 44 }, 0)).toBe(false);
  });
});
