import { describe, expect, it } from 'vitest';
import {
  calculateWorkerBudgetPlan,
  type WorkerPoolKind,
} from '../src/workers/budget.js';

const activeStreamingPools = new Set<WorkerPoolKind>([
  'mvt',
  'elevation',
  'buildingGeometry',
  'fullPipeline',
  'treeProcessing',
]);

describe('worker budget allocation', () => {
  it('caps the automatic desktop budget and reserves only active pools', () => {
    const plan = calculateWorkerBudgetPlan({
      hardwareConcurrency: 32,
      isMobile: false,
      configuredBudget: 0,
      activePools: activeStreamingPools,
    });

    expect(plan).toMatchObject({ total: 10, source: 'automatic' });
    expect(plan.allocations).toEqual({
      geometry: 0,
      mvt: 2,
      elevation: 1,
      buildingGeometry: 3,
      fullPipeline: 3,
      treeProcessing: 1,
    });
  });

  it('applies the mobile cap while keeping one slot per active protocol', () => {
    const plan = calculateWorkerBudgetPlan({
      hardwareConcurrency: 32,
      isMobile: true,
      configuredBudget: 0,
      activePools: activeStreamingPools,
    });

    expect(plan.total).toBe(6);
    expect(plan.allocations.fullPipeline).toBe(2);
    expect(Object.values(plan.allocations).reduce((sum, count) => sum + count, 0)).toBe(6);
  });

  it('raises undersized explicit overrides to the active protocol floor', () => {
    const plan = calculateWorkerBudgetPlan({
      hardwareConcurrency: 2,
      isMobile: false,
      configuredBudget: 2,
      activePools: activeStreamingPools,
    });

    expect(plan).toMatchObject({ total: 5, source: 'environment' });
    expect(Object.values(plan.allocations)).toEqual([0, 1, 1, 1, 1, 1]);
  });

  it('allocates no workers when no protocols are active', () => {
    const plan = calculateWorkerBudgetPlan({
      hardwareConcurrency: 16,
      isMobile: false,
      configuredBudget: 8,
      activePools: new Set(),
    });

    expect(plan.total).toBe(0);
    expect(Object.values(plan.allocations)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
