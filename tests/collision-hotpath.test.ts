import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaneState } from '../src/plane.js';
import type { BuildingColliderBounds } from '../src/workers/types.js';

vi.mock('../src/elevation.js', () => ({
  getTerrainHeight: () => 0,
}));

vi.mock('../src/scene.js', () => ({
  geoToWorld: (lng: number, lat: number, altitude: number) => ({
    x: lng,
    y: altitude,
    z: lat,
  }),
}));

import {
  checkCollisionDetailed,
  clearBuildingColliders,
  registerBuildingColliders,
  resetCollisionSweep,
  segmentIntersectsAABB,
} from '../src/collision.js';

const SEGMENT_EPSILON = 1e-9;

function referenceSegmentIntersectsAABB(
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
  bounds: BuildingColliderBounds
): boolean {
  let tMin = 0;
  let tMax = 1;
  const axes = [
    { start: start.x, end: end.x, min: bounds.minX, max: bounds.maxX },
    { start: start.y, end: end.y, min: bounds.minY, max: bounds.maxY },
    { start: start.z, end: end.z, min: bounds.minZ, max: bounds.maxZ },
  ];

  for (const axis of axes) {
    const delta = axis.end - axis.start;
    if (Math.abs(delta) < SEGMENT_EPSILON) {
      if (axis.start < axis.min || axis.start > axis.max) return false;
      continue;
    }
    let entry = (axis.min - axis.start) / delta;
    let exit = (axis.max - axis.start) / delta;
    if (entry > exit) [entry, exit] = [exit, entry];
    tMin = Math.max(tMin, entry);
    tMax = Math.min(tMax, exit);
    if (tMin > tMax) return false;
  }
  return true;
}

function randomValues(count: number): number[] {
  const values: number[] = [];
  let state = 0x13579bdf;
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
    values.push((state >>> 0) / 0x1_0000_0000);
  }
  return values;
}

function planeState(lng: number, lat: number, altitude: number): PlaneState {
  return {
    id: 'test',
    lng,
    lat,
    altitude,
    heading: 0,
    pitch: 0,
    roll: 0,
    speed: 0,
    color: '#fff',
    name: 'test',
  };
}

function rectangle(
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  maxY: number
): BuildingColliderBounds {
  return {
    minX,
    minY: 0,
    minZ,
    maxX,
    maxY,
    maxZ,
    outerRing: [minX, minZ, maxX, minZ, maxX, maxZ, minX, maxZ],
    holes: [],
  };
}

afterEach(() => {
  clearBuildingColliders();
  resetCollisionSweep();
});

describe('collision hot path equivalence', () => {
  it('matches the allocation-heavy slab reference for randomized segments', () => {
    const random = randomValues(120_000);
    const expected: boolean[] = [];
    const actual: boolean[] = [];

    for (let i = 0; i < random.length; i += 12) {
      const minX = random[i] * 400 - 200;
      const minY = random[i + 1] * 100 - 50;
      const minZ = random[i + 2] * 400 - 200;
      const bounds = rectangle(
        minX,
        minZ,
        minX + random[i + 3] * 80,
        minZ + random[i + 4] * 80,
        minY + random[i + 5] * 100
      );
      bounds.minY = minY;
      const start = {
        x: random[i + 6] * 600 - 300,
        y: random[i + 7] * 200 - 100,
        z: random[i + 8] * 600 - 300,
      };
      const end = i % 48 === 0
        ? { ...start }
        : {
            x: random[i + 9] * 600 - 300,
            y: random[i + 10] * 200 - 100,
            z: random[i + 11] * 600 - 300,
          };

      expected.push(referenceSegmentIntersectsAABB(start, end, bounds));
      actual.push(segmentIntersectsAABB(start, end, bounds));
    }

    expect(actual).toEqual(expected);
  });

  it('preserves parallel, reversed, touching, and epsilon-boundary behavior', () => {
    const bounds = rectangle(0, 0, 10, 10, 20);
    const segments = [
      [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }],
      [{ x: -5, y: 10, z: 5 }, { x: 15, y: 10, z: 5 }],
      [{ x: 15, y: 10, z: 5 }, { x: -5, y: 10, z: 5 }],
      [{ x: -5, y: 20, z: 10 }, { x: 0, y: 20, z: 10 }],
      [{ x: -1e-10, y: 10, z: 5 }, { x: -1e-10, y: 11, z: 5 }],
      [{ x: -1e-8, y: 10, z: 5 }, { x: -1e-8, y: 11, z: 5 }],
    ] as const;

    for (const [start, end] of segments) {
      expect(segmentIntersectsAABB(start, end, bounds)).toBe(
        referenceSegmentIntersectsAABB(start, end, bounds)
      );
    }
  });

  it('preserves first-hit ordering across spatial cells', () => {
    // Registration order favors the later cell, but traversal order has always
    // encountered and returned the earlier cell first.
    registerBuildingColliders('ordering', [
      rectangle(260, 0, 270, 10, 30),
      rectangle(10, 0, 20, 10, 40),
    ]);

    expect(checkCollisionDetailed(planeState(0, 5, 10)).collided).toBe(false);
    expect(checkCollisionDetailed(planeState(300, 5, 10))).toMatchObject({
      collided: true,
      type: 'building',
      height: 40,
    });
  });
});
