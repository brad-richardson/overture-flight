import { describe, expect, it } from 'vitest';
import {
  segmentIntersectsAABB,
  segmentIntersectsBuilding,
} from '../src/collision.js';
import {
  calculateCrashRecoveryAltitude,
  CRASH_RECOVERY,
} from '../src/plane.js';
import { FLIGHT } from '../src/constants.js';
import type { BuildingColliderBounds } from '../src/workers/types.js';

const collider: BuildingColliderBounds = {
  minX: 0,
  minY: 0,
  minZ: 0,
  maxX: 10,
  maxY: 20,
  maxZ: 10,
  outerRing: [0, 0, 10, 0, 10, 10, 0, 10],
  holes: [[3, 3, 7, 3, 7, 7, 3, 7]],
};

describe('building collision sweeps', () => {
  it('detects tunnelling through a building between frames', () => {
    const start = { x: -5, y: 10, z: 5 };
    const end = { x: 15, y: 10, z: 5 };

    expect(segmentIntersectsAABB(start, end, collider)).toBe(true);
    expect(segmentIntersectsBuilding(start, end, collider)).toBe(true);
  });

  it('rejects a broad-phase hit that remains inside a courtyard hole', () => {
    const point = { x: 5, y: 10, z: 5 };

    expect(segmentIntersectsAABB(point, point, collider)).toBe(true);
    expect(segmentIntersectsBuilding(point, point, collider)).toBe(false);
  });

  it('rejects a horizontal crossing above the building roof', () => {
    expect(segmentIntersectsBuilding(
      { x: -5, y: 21, z: 5 },
      { x: 15, y: 21, z: 5 },
      collider
    )).toBe(false);
  });
});

describe('crash recovery altitude', () => {
  it('uses the deterministic recovery range above terrain', () => {
    expect(calculateCrashRecoveryAltitude(250, 0, 0)).toBe(
      250 + CRASH_RECOVERY.MIN_RESPAWN_HEIGHT
    );
    expect(calculateCrashRecoveryAltitude(250, 0, 1)).toBe(
      250 + CRASH_RECOVERY.MAX_RESPAWN_HEIGHT
    );
  });

  it('honors obstacle clearance and the flight ceiling', () => {
    expect(calculateCrashRecoveryAltitude(100, 750, 0.5)).toBe(750);
    expect(calculateCrashRecoveryAltitude(FLIGHT.MAX_ALTITUDE - 50, 0, 0)).toBe(
      FLIGHT.MAX_ALTITUDE
    );
  });
});
