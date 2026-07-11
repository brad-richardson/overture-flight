import { describe, expect, it } from 'vitest';
import {
  buildingFeatureBelongsToTile,
  lngLatToTile,
  mapTileToSourceZoom,
  tileToBounds,
  type ParsedFeature,
} from '../src/tile-manager.js';

function polygonAt(lng: number, lat: number, type: 'Polygon' | 'MultiPolygon'): ParsedFeature {
  const ring = [
    [lng, lat],
    [lng + 0.0001, lat],
    [lng, lat + 0.0001],
    [lng, lat],
  ];
  return {
    type,
    coordinates: type === 'Polygon' ? [ring] : [[ring]],
    properties: {},
    layer: 'building',
  };
}

describe('tile coordinate mapping', () => {
  it('maps requests to the highest source zoom using integer parent ownership', () => {
    expect(mapTileToSourceZoom(1237, 2046, 14, 12)).toEqual({
      x: 309,
      y: 511,
      z: 12,
    });
    expect(mapTileToSourceZoom(1237, 2046, 12, 14)).toEqual({
      x: 1237,
      y: 2046,
      z: 12,
    });
  });

  it('clamps polar rows and wraps longitude columns', () => {
    expect(lngLatToTile(-180, 90, 4)).toEqual([0, 0]);
    expect(lngLatToTile(180, -90, 4)).toEqual([0, 15]);
    expect(lngLatToTile(540, 0, 4)[0]).toBe(0);
  });
});

describe('parent building ownership', () => {
  it.each(['Polygon', 'MultiPolygon'] as const)(
    'assigns a parent-source %s to exactly one requested child',
    (featureType) => {
      const zoom = 14;
      const owningX = 4825;
      const owningY = 6162;
      const bounds = tileToBounds(owningX, owningY, zoom);
      const feature = polygonAt(
        (bounds.west + bounds.east) / 2,
        (bounds.north + bounds.south) / 2,
        featureType
      );
      const parentX = Math.floor(owningX / 4);
      const parentY = Math.floor(owningY / 4);
      const owners: string[] = [];

      for (let x = parentX * 4; x < parentX * 4 + 4; x += 1) {
        for (let y = parentY * 4; y < parentY * 4 + 4; y += 1) {
          if (buildingFeatureBelongsToTile(feature, x, y, zoom)) {
            owners.push(`${x}/${y}`);
          }
        }
      }

      expect(owners).toEqual([`${owningX}/${owningY}`]);
    }
  );
});
