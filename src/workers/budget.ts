import { GROUND_TEXTURE, IS_MOBILE, WORKERS } from '../constants.js';

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

export interface WorkerBudgetOptions {
  hardwareConcurrency: number;
  isMobile: boolean;
  configuredBudget: number;
  activePools: ReadonlySet<WorkerPoolKind>;
}

const MOBILE_BUDGET_CAP = 6;
const DESKTOP_BUDGET_CAP = 10;

const EXTRA_CAPACITY_PRIORITY: readonly WorkerPoolKind[] = [
  'fullPipeline',
  'fullPipeline',
  'buildingGeometry',
  'buildingGeometry',
  'mvt',
  'mvt',
  'geometry',
  'geometry',
  'treeProcessing',
  'elevation',
];

function readHardwareConcurrency(): number {
  if (typeof navigator === 'undefined') return 4;
  const reported = navigator.hardwareConcurrency;
  return Number.isFinite(reported) && reported > 0 ? Math.floor(reported) : 4;
}

export function calculateWorkerBudgetPlan(
  options: WorkerBudgetOptions
): WorkerBudgetPlan {
  const {
    hardwareConcurrency,
    isMobile,
    configuredBudget,
    activePools,
  } = options;
  const source = configuredBudget > 0 ? 'environment' : 'automatic';
  const deviceCap = isMobile ? MOBILE_BUDGET_CAP : DESKTOP_BUDGET_CAP;
  const minimumBudget = activePools.size;
  if (minimumBudget === 0) {
    return Object.freeze({
      hardwareConcurrency,
      isMobile,
      total: 0,
      allocations: Object.freeze({
        geometry: 0,
        mvt: 0,
        elevation: 0,
        buildingGeometry: 0,
        fullPipeline: 0,
        treeProcessing: 0,
      }),
      source,
    });
  }
  const automaticBudget = Math.min(
    deviceCap,
    Math.max(minimumBudget, hardwareConcurrency - 1)
  );

  // Active pools run distinct protocols and cannot share Worker instances.
  // Inactive legacy pools receive no reservation and remain lazily uninitialized.
  const total = Math.max(minimumBudget, configuredBudget || automaticBudget);
  const allocations: Record<WorkerPoolKind, number> = {
    geometry: activePools.has('geometry') ? 1 : 0,
    mvt: activePools.has('mvt') ? 1 : 0,
    elevation: activePools.has('elevation') ? 1 : 0,
    buildingGeometry: activePools.has('buildingGeometry') ? 1 : 0,
    fullPipeline: activePools.has('fullPipeline') ? 1 : 0,
    treeProcessing: activePools.has('treeProcessing') ? 1 : 0,
  };

  const activePriority = EXTRA_CAPACITY_PRIORITY.filter(pool => activePools.has(pool));
  for (let index = minimumBudget; index < total; index += 1) {
    const pool = activePriority[(index - minimumBudget) % activePriority.length];
    allocations[pool] += 1;
  }

  return Object.freeze({
    hardwareConcurrency,
    isMobile,
    total,
    allocations: Object.freeze(allocations),
    source,
  });
}

function createWorkerBudgetPlan(): WorkerBudgetPlan {
  const activePools = new Set<WorkerPoolKind>([
    ...(WORKERS.MVT_ENABLED ? ['mvt' as const] : []),
    ...(WORKERS.ELEVATION_ENABLED ? ['elevation' as const] : []),
    ...(WORKERS.BUILDING_GEOMETRY_ENABLED ? ['buildingGeometry' as const] : []),
    ...(GROUND_TEXTURE.ENABLED ? ['fullPipeline' as const] : []),
    ...(!GROUND_TEXTURE.ENABLED && WORKERS.GEOMETRY_ENABLED ? ['geometry' as const] : []),
    'treeProcessing',
  ]);

  return calculateWorkerBudgetPlan({
    hardwareConcurrency: readHardwareConcurrency(),
    isMobile: IS_MOBILE,
    configuredBudget: WORKERS.TOTAL_BUDGET,
    activePools,
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
