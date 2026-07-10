import { IS_MOBILE, WORKERS } from '../constants.js';

export const WORKER_POOL_KINDS = [
  'geometry',
  'mvt',
  'elevation',
  'buildingGeometry',
  'fullPipeline',
  'treeProcessing',
] as const;

export type WorkerPoolKind = (typeof WORKER_POOL_KINDS)[number];

export interface WorkerBudgetPlan {
  /** Browser-reported logical processors, or the conservative fallback used. */
  hardwareConcurrency: number;
  /** Whether mobile resource limits were applied. */
  isMobile: boolean;
  /** Maximum number of workers created if every lazy pool is initialized. */
  total: number;
  /** Per-pool maximums; all worker-pool constructors consume these defaults. */
  allocations: Readonly<Record<WorkerPoolKind, number>>;
  /** Whether VITE_WORKER_BUDGET supplied the total. */
  source: 'automatic' | 'environment';
}

const MINIMUM_BUDGET = WORKER_POOL_KINDS.length;
const MOBILE_BUDGET_CAP = 6;
const DESKTOP_BUDGET_CAP = 8;

// Extra capacity follows application throughput priorities. Every pool gets one
// worker before this order is applied, preserving all currently enabled paths.
const EXTRA_CAPACITY_PRIORITY: readonly WorkerPoolKind[] = [
  'fullPipeline',
  'buildingGeometry',
  'mvt',
  'geometry',
  'treeProcessing',
  'elevation',
];

function readHardwareConcurrency(): number {
  if (typeof navigator === 'undefined') return 4;
  const reported = navigator.hardwareConcurrency;
  return Number.isFinite(reported) && reported > 0 ? Math.floor(reported) : 4;
}

function createWorkerBudgetPlan(): WorkerBudgetPlan {
  const hardwareConcurrency = readHardwareConcurrency();
  const configuredBudget = WORKERS.TOTAL_BUDGET;
  const source = configuredBudget > 0 ? 'environment' : 'automatic';
  const deviceCap = IS_MOBILE ? MOBILE_BUDGET_CAP : DESKTOP_BUDGET_CAP;
  const automaticBudget = Math.min(
    deviceCap,
    Math.max(MINIMUM_BUDGET, hardwareConcurrency - 1)
  );

  // The six pools run distinct protocols and cannot safely share Worker instances.
  // Keep one slot for each; undersized overrides are raised to this compatibility floor.
  const total = Math.max(MINIMUM_BUDGET, configuredBudget || automaticBudget);
  const allocations: Record<WorkerPoolKind, number> = {
    geometry: 1,
    mvt: 1,
    elevation: 1,
    buildingGeometry: 1,
    fullPipeline: 1,
    treeProcessing: 1,
  };

  for (let index = MINIMUM_BUDGET; index < total; index += 1) {
    const pool = EXTRA_CAPACITY_PRIORITY[(index - MINIMUM_BUDGET) % EXTRA_CAPACITY_PRIORITY.length];
    allocations[pool] += 1;
  }

  return Object.freeze({
    hardwareConcurrency,
    isMobile: IS_MOBILE,
    total,
    allocations: Object.freeze(allocations),
    source,
  });
}

const workerBudgetPlan = createWorkerBudgetPlan();
let diagnosticsLogged = false;

export function getWorkerBudgetPlan(): WorkerBudgetPlan {
  return workerBudgetPlan;
}

export function getWorkerPoolSize(pool: WorkerPoolKind): number {
  if (!diagnosticsLogged) {
    diagnosticsLogged = true;
    const allocationSummary = WORKER_POOL_KINDS
      .map((kind) => `${kind}=${workerBudgetPlan.allocations[kind]}`)
      .join(', ');
    console.info(
      `[Workers] Shared ${workerBudgetPlan.source} budget: ` +
      `${workerBudgetPlan.total} total (${allocationSummary}); ` +
      `hardwareConcurrency=${workerBudgetPlan.hardwareConcurrency}, mobile=${workerBudgetPlan.isMobile}`
    );
  }

  return workerBudgetPlan.allocations[pool];
}
