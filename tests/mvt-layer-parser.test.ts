import { describe, expect, it, vi } from 'vitest';
import { parseVectorTileLayers } from '../src/workers/mvt-layer-parser.js';
import type { ParsedFeature } from '../src/workers/types.js';

interface FakeFeature {
  properties: Record<string, unknown>;
  toGeoJSON: ReturnType<typeof vi.fn>;
}

interface FakeLayer {
  length: number;
  feature: ReturnType<typeof vi.fn>;
  features: FakeFeature[];
}

function fakeLayer(
  name: string,
  coordinates: ParsedFeature['coordinates'][]
): FakeLayer {
  const features = coordinates.map((featureCoordinates, index) => ({
    properties: { name, index },
    toGeoJSON: vi.fn(() => ({
      geometry: {
        type: 'Polygon',
        coordinates: featureCoordinates,
      },
    })),
  }));

  return {
    length: features.length,
    feature: vi.fn((index: number) => features[index]),
    features,
  };
}

describe('MVT layer parser', () => {
  it('decodes only selected layers without changing source or feature order', () => {
    const unused = fakeLayer('infrastructure', [[[99, 99]]]);
    const water = fakeLayer('water', [[[1, 1]], [[2, 2]]]);
    const land = fakeLayer('land', [[[3, 3]]]);
    const landUse = fakeLayer('land_use', [[[4, 4]]]);
    const layers = { infrastructure: unused, water, land, land_use: landUse };

    const parsed = parseVectorTileLayers(
      layers,
      100,
      200,
      12,
      ['land', 'land_use', 'land_cover', 'water']
    );

    expect(parsed.map(feature => [feature.layer, feature.properties.index])).toEqual([
      ['water', 0],
      ['water', 1],
      ['land', 0],
      ['land_use', 0],
    ]);
    expect(parsed.map(feature => feature.coordinates)).toEqual([
      [[1, 1]],
      [[2, 2]],
      [[3, 3]],
      [[4, 4]],
    ]);
    expect(parsed[0].properties).toBe(water.features[0].properties);
    expect(water.features[0].toGeoJSON).toHaveBeenCalledWith(100, 200, 12);
    expect(unused.feature).not.toHaveBeenCalled();
    expect(unused.features[0].toGeoJSON).not.toHaveBeenCalled();
  });

  it('returns no features when requested layers are missing', () => {
    const infrastructure = fakeLayer('infrastructure', [[[1, 1]]]);

    const parsed = parseVectorTileLayers(
      { infrastructure },
      1,
      2,
      3,
      ['water']
    );

    expect(parsed).toEqual([]);
    expect(infrastructure.feature).not.toHaveBeenCalled();
    expect(infrastructure.features[0].toGeoJSON).not.toHaveBeenCalled();
  });

  it('retains explicit unrestricted parsing behavior', () => {
    const first = fakeLayer('first', [[[1, 1]]]);
    const second = fakeLayer('second', [[[2, 2]], [[3, 3]]]);

    const parsed = parseVectorTileLayers(
      { first, second },
      4,
      5,
      6,
      null
    );

    expect(parsed.map(feature => [feature.layer, feature.properties.index])).toEqual([
      ['first', 0],
      ['second', 0],
      ['second', 1],
    ]);
    expect(first.feature).toHaveBeenCalledOnce();
    expect(second.feature).toHaveBeenCalledTimes(2);
  });

  it('applies keepFeature before geometry decode', () => {
    const makeLayer = (props: Record<string, unknown>[]) => {
      const features = props.map((properties, index) => ({
        properties: { ...properties, index },
        toGeoJSON: vi.fn(() => ({ geometry: { type: 'LineString', coordinates: [[index, index]] } })),
      }));
      return { length: features.length, feature: vi.fn((i: number) => features[i]), features };
    };
    const infrastructure = makeLayer([
      { subtype: 'airport', class: 'runway' },
      { subtype: 'power', class: 'power_pole' },
      { subtype: 'airport', class: 'taxiway' },
    ]);

    const parsed = parseVectorTileLayers(
      { infrastructure },
      1,
      2,
      3,
      ['infrastructure'],
      (layerName, properties) => layerName !== 'infrastructure' || properties.subtype === 'airport'
    );

    expect(parsed.map(feature => feature.properties.class)).toEqual(['runway', 'taxiway']);
    // The filtered-out feature never decodes its geometry.
    expect(infrastructure.features[1].toGeoJSON).not.toHaveBeenCalled();
    expect(infrastructure.features[0].toGeoJSON).toHaveBeenCalledOnce();
  });
});
