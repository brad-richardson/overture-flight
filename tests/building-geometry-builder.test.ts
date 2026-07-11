import { describe, expect, it } from 'vitest';
import { buildBuildingGeometry } from '../src/workers/building-geometry-builder.js';
import type {
  BuildingFeatureInput,
  CreateBuildingGeometryPayload,
  SceneOrigin,
} from '../src/workers/types.js';

const ORIGIN: SceneOrigin = {
  lng: 11.25,
  lat: 43.77,
  metersPerDegLng: 80_000,
  metersPerDegLat: 111_000,
};

// ~32m square footprint centred on (cx, cy).
function square(cx = ORIGIN.lng, cy = ORIGIN.lat, halfDeg = 0.0002): number[][][] {
  return [[
    [cx - halfDeg, cy - halfDeg],
    [cx + halfDeg, cy - halfDeg],
    [cx + halfDeg, cy + halfDeg],
    [cx - halfDeg, cy + halfDeg],
    [cx - halfDeg, cy - halfDeg],
  ]];
}

function building(
  layer: 'building' | 'building_part',
  properties: BuildingFeatureInput['properties'],
  coordinates: number[][][] = square()
): BuildingFeatureInput {
  return { type: 'Polygon', layer, coordinates, properties };
}

function build(features: BuildingFeatureInput[], defaultHeight = 10) {
  const payload: CreateBuildingGeometryPayload = {
    features,
    origin: ORIGIN,
    tileX: 0,
    tileY: 0,
    tileZ: 14,
    lodLevel: 0, // LOD_HIGH
    defaultHeight,
    verticalExaggeration: 1,
  };
  return buildBuildingGeometry(payload);
}

// baseY = terrainHeight(0) * exaggeration + BUILDING_TERRAIN_OFFSET(0.5) + slope(0) = 0.5
const BASE_Y = 0.5;

function yRange(positions: Float32Array): { minY: number; maxY: number } {
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    minY = Math.min(minY, positions[i]);
    maxY = Math.max(maxY, positions[i]);
  }
  return { minY, maxY };
}

describe('buildBuildingGeometry — has_parts landmark handling', () => {
  it('fills the shaft of a tower whose only part floats (Giotto Campanile regression)', async () => {
    // building outline (has_parts) + a single belfry part floating at 80m.
    const result = await build([
      building('building', { has_parts: true, height: 85 }),
      building('building_part', { height: 84.75, min_height: 80 }),
    ]);

    expect(result.geometry).not.toBeNull();
    const { minY, maxY } = yRange(result.geometry!.positions);
    // The shaft is now grounded rather than a slab floating at 80m.
    expect(minY).toBeLessThan(BASE_Y + 1);
    // The belfry still caps the tower near its true top.
    expect(maxY).toBeGreaterThan(84);
    expect(maxY).toBeLessThan(86);
    // Both the shaft outline and the belfry part produce geometry.
    expect(result.stats.buildingsProcessed).toBe(2);
  });

  it('keeps skipping a has_parts building whose parts reach the ground (Empire State Building)', async () => {
    const result = await build([
      building('building', { has_parts: true, height: 443 }),
      building('building_part', { height: 330 }), // grounded main mass, no min_height
      building('building_part', { height: 390, min_height: 330 }, square(ORIGIN.lng, ORIGIN.lat, 0.0001)), // setback
    ]);

    expect(result.geometry).not.toBeNull();
    const { minY, maxY } = yRange(result.geometry!.positions);
    expect(minY).toBeLessThan(BASE_Y + 1); // grounded part reaches the ground
    // The 443m outline must NOT be extruded as a solid box; tallest geometry is the 390m part.
    expect(maxY).toBeLessThan(395);
    expect(maxY).toBeGreaterThan(389);
    // Only the two parts render; the outline stays skipped.
    expect(result.stats.buildingsProcessed).toBe(2);
    expect(result.stats.buildingsSkipped).toBeGreaterThanOrEqual(1);
  });

  it('skips a has_parts building with no associated parts (conservative, unchanged)', async () => {
    const result = await build([
      building('building', { has_parts: true, height: 100 }),
    ]);
    expect(result.geometry).toBeNull();
    expect(result.stats.buildingsProcessed).toBe(0);
    expect(result.stats.buildingsSkipped).toBe(1);
  });
});

describe('buildBuildingGeometry — extrusion robustness', () => {
  it('gives a floating part with missing height a positive extent instead of inverting', async () => {
    const result = await build([
      building('building_part', { min_height: 50 }), // no height -> would invert to a slab at 50m
    ], 10);

    expect(result.geometry).not.toBeNull();
    const { minY, maxY } = yRange(result.geometry!.positions);
    // Renders from its base (50m) up to base + defaultHeight (60m), never inverted.
    expect(minY).toBeGreaterThan(BASE_Y + 49);
    expect(minY).toBeLessThan(BASE_Y + 51);
    expect(maxY).toBeGreaterThan(minY);
    expect(maxY).toBeLessThan(BASE_Y + 62);
  });

  it('leaves a normal ground-level building unchanged', async () => {
    const result = await build([
      building('building', { height: 20 }),
    ]);
    expect(result.geometry).not.toBeNull();
    const { minY, maxY } = yRange(result.geometry!.positions);
    expect(minY).toBeLessThan(BASE_Y + 0.5);
    expect(maxY).toBeGreaterThan(19.5);
    expect(maxY).toBeLessThan(21);
  });

  it('renders a legitimately floating part above its base (belfry in isolation)', async () => {
    const result = await build([
      building('building_part', { height: 84.75, min_height: 80 }),
    ]);
    expect(result.geometry).not.toBeNull();
    const { minY, maxY } = yRange(result.geometry!.positions);
    expect(minY).toBeGreaterThan(BASE_Y + 79);
    expect(maxY).toBeGreaterThan(84);
    expect(maxY).toBeLessThan(86);
  });
});
