/**
 * Worker pool manager for tile texture rendering
 * Manages a pool of web workers for parallel texture rendering
 */

import type {
  WorkerRequest,
  WorkerResponse,
  RenderTileTexturePayload,
  RenderLowDetailTexturePayload,
  CreateBaseGeometryPayload,
  CreateBuildingGeometryPayload,
  ParseMVTPayload,
  DecodeElevationPayload,
  TileBounds,
  ParsedFeature,
  SceneOrigin,
  BaseGeometryResult,
  ParseMVTResult,
  DecodeElevationResult,
  BuildingFeatureInput,
  CreateBuildingGeometryResult,
} from './types.js';
import { WORKERS } from '../constants.js';

// Re-export types for convenience
export type { TileBounds, ParsedFeature, SceneOrigin, BaseGeometryResult, GeometryBufferGroup, LineGeometryBufferGroup, ParseMVTResult, CompactFeature, BuildingFeatureInput, CreateBuildingGeometryResult, BuildingGeometryBuffers } from './types.js';

/**
 * Get optimal worker pool size based on device capabilities and config
 */
function getOptimalPoolSize(): number {
  // Use configured size if > 0, otherwise auto-detect
  if (WORKERS.POOL_SIZE > 0) {
    return WORKERS.POOL_SIZE;
  }
  const cores = navigator.hardwareConcurrency || 4;
  // Use cores - 1 (leave one for main thread), minimum 2, maximum 4
  return Math.max(2, Math.min(cores - 1, 4));
}

/**
 * Pending task tracking
 */
interface PendingTask {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  workerIndex: number;
  timeoutId: ReturnType<typeof setTimeout>;
  /** Whether this task incremented pendingCount (false for capability checks) */
  countIncremented?: boolean;
}

/**
 * Worker state tracking
 */
interface WorkerState {
  worker: Worker;
  ready: boolean;
  pendingCount: number;
}

/**
 * Default task timeout (10 seconds)
 */
const TASK_TIMEOUT_MS = 10000;

/**
 * Worker pool for tile texture rendering
 */
export class WorkerPool {
  private workers: WorkerState[] = [];
  private pendingTasks = new Map<string, PendingTask>();
  private isSupported = true;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(private poolSize: number = getOptimalPoolSize()) {}

  /**
   * Initialize the worker pool
   * Must be called before using any rendering methods
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return this.isSupported;

    if (this.initPromise) {
      await this.initPromise;
      return this.isSupported;
    }

    this.initPromise = this.doInitialize();
    await this.initPromise;
    return this.isSupported;
  }

  private async doInitialize(): Promise<void> {
    // Create workers
    for (let i = 0; i < this.poolSize; i++) {
      try {
        const worker = new Worker(
          new URL('./tile-texture.worker.ts', import.meta.url),
          { type: 'module' }
        );

        const state: WorkerState = {
          worker,
          ready: false,
          pendingCount: 0,
        };

        // Set up message handler
        worker.onmessage = (event) => this.handleMessage(i, event);
        worker.onerror = (event) => this.handleError(i, event);
        worker.onmessageerror = () => this.handleMessageError(i);

        this.workers.push(state);
      } catch (error) {
        console.warn(`Failed to create worker ${i}:`, error);
      }
    }

    if (this.workers.length === 0) {
      console.warn('No workers could be created, falling back to main thread');
      this.isSupported = false;
      this.initialized = true;
      return;
    }

    // Check capability of first worker
    try {
      const supported = await this.checkCapability(0);
      if (!supported) {
        console.warn('OffscreenCanvas not supported in workers, falling back to main thread');
        this.isSupported = false;
        this.terminate();
      }
    } catch (error) {
      console.warn('Worker capability check failed:', error);
      this.isSupported = false;
      this.terminate();
    }

    this.initialized = true;
  }

  /**
   * Check if a worker supports OffscreenCanvas
   */
  private checkCapability(workerIndex: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pendingTasks.delete(id);
        reject(new Error('Capability check timeout'));
      }, 5000);

      this.pendingTasks.set(id, {
        resolve: (result) => resolve(result as boolean),
        reject,
        workerIndex,
        timeoutId: timeout,
      });

      const request: WorkerRequest = { type: 'CAPABILITY_CHECK', id };
      this.workers[workerIndex].worker.postMessage(request);
    });
  }

  /**
   * Handle messages from workers
   */
  private handleMessage(workerIndex: number, event: MessageEvent<WorkerResponse | { type: 'READY' }>): void {
    const data = event.data;

    // Handle ready signal
    if (data.type === 'READY') {
      this.workers[workerIndex].ready = true;
      return;
    }

    const response = data as WorkerResponse;

    // Handle capability check result
    if (response.type === 'CAPABILITY_CHECK_RESULT') {
      const task = this.pendingTasks.get(response.id);
      if (task) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(response.id);
        task.resolve(response.supported);
      }
      return;
    }

    // Handle render results
    if (response.type === 'RENDER_TILE_TEXTURE_RESULT' || response.type === 'RENDER_LOW_DETAIL_TEXTURE_RESULT') {
      const task = this.pendingTasks.get(response.id);
      if (task) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(response.id);
        this.workers[task.workerIndex].pendingCount--;
        task.resolve(response.result);
      }
      return;
    }

    // Handle errors
    if (response.type === 'ERROR') {
      const task = this.pendingTasks.get(response.id);
      if (task) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(response.id);
        this.workers[task.workerIndex].pendingCount--;
        task.reject(new Error(response.error));
      }
      return;
    }
  }

  /**
   * Handle worker errors
   */
  private handleError(workerIndex: number, event: ErrorEvent): void {
    console.error(`Worker ${workerIndex} error:`, event.message);

    // Reject all pending tasks for this worker
    for (const [id, task] of this.pendingTasks) {
      if (task.workerIndex === workerIndex) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(id);
        task.reject(new Error(`Worker error: ${event.message}`));
      }
    }

    // Try to replace the crashed worker
    this.replaceWorker(workerIndex);
  }

  /**
   * Handle worker message errors
   */
  private handleMessageError(workerIndex: number): void {
    console.error(`Worker ${workerIndex} message error`);

    // Reject all pending tasks for this worker
    for (const [id, task] of this.pendingTasks) {
      if (task.workerIndex === workerIndex) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(id);
        this.workers[task.workerIndex].pendingCount--;
        task.reject(new Error('Worker message error'));
      }
    }
  }

  /**
   * Replace a crashed worker
   */
  private replaceWorker(workerIndex: number): void {
    try {
      // Terminate old worker if still exists
      this.workers[workerIndex]?.worker.terminate();

      // Create new worker
      const worker = new Worker(
        new URL('./tile-texture.worker.ts', import.meta.url),
        { type: 'module' }
      );

      const state: WorkerState = {
        worker,
        ready: false,
        pendingCount: 0,
      };

      worker.onmessage = (event) => this.handleMessage(workerIndex, event);
      worker.onerror = (event) => this.handleError(workerIndex, event);
      worker.onmessageerror = () => this.handleMessageError(workerIndex);

      this.workers[workerIndex] = state;
    } catch (error) {
      console.error(`Failed to replace worker ${workerIndex}:`, error);
    }
  }

  /**
   * Get the index of the least loaded worker
   */
  private getLeastLoadedWorker(): number {
    let minLoad = Infinity;
    let minIndex = 0;

    for (let i = 0; i < this.workers.length; i++) {
      const state = this.workers[i];
      if (state.ready && state.pendingCount < minLoad) {
        minLoad = state.pendingCount;
        minIndex = i;
      }
    }

    return minIndex;
  }

  /**
   * Send a request to a worker
   */
  private sendRequest<T>(request: WorkerRequest): Promise<T> {
    if (!this.isSupported || this.workers.length === 0) {
      return Promise.reject(new Error('Worker pool not available'));
    }

    return new Promise((resolve, reject) => {
      const workerIndex = this.getLeastLoadedWorker();
      const state = this.workers[workerIndex];

      // Set up timeout
      const timeoutId = setTimeout(() => {
        this.pendingTasks.delete(request.id);
        state.pendingCount--;
        reject(new Error('Task timeout'));
      }, TASK_TIMEOUT_MS);

      // Track task
      this.pendingTasks.set(request.id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        workerIndex,
        timeoutId,
        countIncremented: true,
      });

      state.pendingCount++;
      state.worker.postMessage(request);
    });
  }

  /**
   * Render a tile texture using a worker
   */
  async renderTileTexture(
    baseFeatures: ParsedFeature[],
    transportFeatures: ParsedFeature[],
    bounds: TileBounds,
    textureSize: number
  ): Promise<ImageBitmap> {
    await this.initialize();

    if (!this.isSupported) {
      throw new Error('Worker pool not supported');
    }

    const payload: RenderTileTexturePayload = {
      baseFeatures,
      transportFeatures,
      bounds,
      textureSize,
    };

    const request: WorkerRequest = {
      type: 'RENDER_TILE_TEXTURE',
      id: crypto.randomUUID(),
      payload,
    };

    return this.sendRequest<ImageBitmap>(request);
  }

  /**
   * Render a low-detail tile texture using a worker
   */
  async renderLowDetailTexture(
    baseFeatures: ParsedFeature[],
    bounds: TileBounds,
    textureSize: number
  ): Promise<ImageBitmap> {
    await this.initialize();

    if (!this.isSupported) {
      throw new Error('Worker pool not supported');
    }

    const payload: RenderLowDetailTexturePayload = {
      baseFeatures,
      bounds,
      textureSize,
    };

    const request: WorkerRequest = {
      type: 'RENDER_LOW_DETAIL_TEXTURE',
      id: crypto.randomUUID(),
      payload,
    };

    return this.sendRequest<ImageBitmap>(request);
  }

  /**
   * Check if worker rendering is supported
   */
  async isWorkerSupported(): Promise<boolean> {
    await this.initialize();
    return this.isSupported;
  }

  /**
   * Terminate all workers
   */
  terminate(): void {
    // Reject all pending tasks
    for (const [_id, task] of this.pendingTasks) {
      clearTimeout(task.timeoutId);
      task.reject(new Error('Worker pool terminated'));
    }
    this.pendingTasks.clear();

    // Terminate workers
    for (const state of this.workers) {
      state.worker.terminate();
    }
    this.workers = [];
  }

  /**
   * Get pool statistics for debugging
   */
  getStats(): { workerCount: number; pendingTasks: number; isSupported: boolean } {
    return {
      workerCount: this.workers.length,
      pendingTasks: this.pendingTasks.size,
      isSupported: this.isSupported,
    };
  }
}

// Singleton instance
let poolInstance: WorkerPool | null = null;

/**
 * Get the global worker pool instance
 */
export function getWorkerPool(): WorkerPool {
  if (!poolInstance) {
    poolInstance = new WorkerPool();
  }
  return poolInstance;
}

/**
 * Reset the worker pool (for testing)
 */
export function resetWorkerPool(): void {
  if (poolInstance) {
    poolInstance.terminate();
    poolInstance = null;
  }
}

/**
 * Geometry worker pool for base layer geometry creation
 * Separate pool from texture workers - uses different worker file
 */
export class GeometryWorkerPool {
  private workers: WorkerState[] = [];
  private pendingTasks = new Map<string, PendingTask>();
  private isSupported = true;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(private poolSize: number = getOptimalPoolSize()) {}

  /**
   * Initialize the geometry worker pool
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return this.isSupported;

    if (this.initPromise) {
      await this.initPromise;
      return this.isSupported;
    }

    this.initPromise = this.doInitialize();
    await this.initPromise;
    return this.isSupported;
  }

  private async doInitialize(): Promise<void> {
    // Create geometry workers
    for (let i = 0; i < this.poolSize; i++) {
      try {
        const worker = new Worker(
          new URL('./geometry.worker.ts', import.meta.url),
          { type: 'module' }
        );

        const state: WorkerState = {
          worker,
          ready: false,
          pendingCount: 0,
        };

        worker.onmessage = (event) => this.handleMessage(i, event);
        worker.onerror = (event) => this.handleError(i, event);
        worker.onmessageerror = () => this.handleMessageError(i);

        this.workers.push(state);
      } catch (error) {
        console.warn(`Failed to create geometry worker ${i}:`, error);
      }
    }

    if (this.workers.length === 0) {
      console.warn('No geometry workers could be created, falling back to main thread');
      this.isSupported = false;
      this.initialized = true;
      return;
    }

    // Check capability (geometry workers don't need special capabilities like OffscreenCanvas)
    try {
      const supported = await this.checkCapability(0);
      if (!supported) {
        console.warn('Geometry worker capability check failed');
        this.isSupported = false;
        this.terminate();
      }
    } catch (error) {
      console.warn('Geometry worker capability check failed:', error);
      this.isSupported = false;
      this.terminate();
    }

    this.initialized = true;
  }

  private checkCapability(workerIndex: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pendingTasks.delete(id);
        reject(new Error('Capability check timeout'));
      }, 5000);

      this.pendingTasks.set(id, {
        resolve: (result) => resolve(result as boolean),
        reject,
        workerIndex,
        timeoutId: timeout,
        countIncremented: false, // Capability checks don't increment pendingCount
      });

      const request: WorkerRequest = { type: 'CAPABILITY_CHECK', id };
      this.workers[workerIndex].worker.postMessage(request);
    });
  }

  private handleMessage(workerIndex: number, event: MessageEvent<WorkerResponse | { type: 'READY' }>): void {
    const data = event.data;

    if (data.type === 'READY') {
      this.workers[workerIndex].ready = true;
      return;
    }

    const response = data as WorkerResponse;

    if (response.type === 'CAPABILITY_CHECK_RESULT') {
      const task = this.pendingTasks.get(response.id);
      if (task) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(response.id);
        task.resolve(response.supported);
      }
      return;
    }

    if (response.type === 'CREATE_BASE_GEOMETRY_RESULT') {
      const task = this.pendingTasks.get(response.id);
      if (task) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(response.id);
        this.workers[task.workerIndex].pendingCount--;
        task.resolve(response.result);
      }
      return;
    }

    if (response.type === 'ERROR') {
      const task = this.pendingTasks.get(response.id);
      if (task) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(response.id);
        this.workers[task.workerIndex].pendingCount--;
        task.reject(new Error(response.error));
      }
      return;
    }
  }

  private handleError(workerIndex: number, event: ErrorEvent): void {
    console.error(`Geometry worker ${workerIndex} error:`, event.message);

    for (const [id, task] of this.pendingTasks) {
      if (task.workerIndex === workerIndex) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(id);
        // Only decrement if this task incremented the count (not capability checks)
        if (task.countIncremented) {
          this.workers[task.workerIndex].pendingCount--;
        }
        task.reject(new Error(`Worker error: ${event.message}`));
      }
    }

    this.replaceWorker(workerIndex);
  }

  private handleMessageError(workerIndex: number): void {
    console.error(`Geometry worker ${workerIndex} message error`);

    for (const [id, task] of this.pendingTasks) {
      if (task.workerIndex === workerIndex) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(id);
        if (task.countIncremented) {
          this.workers[task.workerIndex].pendingCount--;
        }
        task.reject(new Error('Worker message error'));
      }
    }
  }

  private replaceWorker(workerIndex: number): void {
    try {
      this.workers[workerIndex]?.worker.terminate();

      const worker = new Worker(
        new URL('./geometry.worker.ts', import.meta.url),
        { type: 'module' }
      );

      const state: WorkerState = {
        worker,
        ready: false,
        pendingCount: 0,
      };

      worker.onmessage = (event) => this.handleMessage(workerIndex, event);
      worker.onerror = (event) => this.handleError(workerIndex, event);
      worker.onmessageerror = () => this.handleMessageError(workerIndex);

      this.workers[workerIndex] = state;
    } catch (error) {
      console.error(`Failed to replace geometry worker ${workerIndex}:`, error);
    }
  }

  private getLeastLoadedWorker(): number {
    let minLoad = Infinity;
    let minIndex = 0;

    for (let i = 0; i < this.workers.length; i++) {
      const state = this.workers[i];
      if (state.ready && state.pendingCount < minLoad) {
        minLoad = state.pendingCount;
        minIndex = i;
      }
    }

    return minIndex;
  }

  private sendRequest<T>(request: WorkerRequest): Promise<T> {
    if (!this.isSupported || this.workers.length === 0) {
      return Promise.reject(new Error('Geometry worker pool not available'));
    }

    return new Promise((resolve, reject) => {
      const workerIndex = this.getLeastLoadedWorker();
      const state = this.workers[workerIndex];

      const timeoutId = setTimeout(() => {
        this.pendingTasks.delete(request.id);
        state.pendingCount--;
        reject(new Error('Task timeout'));
      }, TASK_TIMEOUT_MS);

      this.pendingTasks.set(request.id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        workerIndex,
        timeoutId,
        countIncremented: true,
      });

      state.pendingCount++;
      state.worker.postMessage(request);
    });
  }

  /**
   * Create base layer geometry using a worker
   */
  async createBaseGeometry(
    features: ParsedFeature[],
    origin: SceneOrigin,
    tileX: number,
    tileY: number,
    tileZ: number
  ): Promise<BaseGeometryResult> {
    await this.initialize();

    if (!this.isSupported) {
      throw new Error('Geometry worker pool not supported');
    }

    const payload: CreateBaseGeometryPayload = {
      features,
      origin,
      tileX,
      tileY,
      tileZ,
    };

    const request: WorkerRequest = {
      type: 'CREATE_BASE_GEOMETRY',
      id: crypto.randomUUID(),
      payload,
    };

    return this.sendRequest<BaseGeometryResult>(request);
  }

  /**
   * Check if geometry worker is supported
   */
  async isWorkerSupported(): Promise<boolean> {
    await this.initialize();
    return this.isSupported;
  }

  /**
   * Terminate all geometry workers
   */
  terminate(): void {
    for (const [_id, task] of this.pendingTasks) {
      clearTimeout(task.timeoutId);
      task.reject(new Error('Geometry worker pool terminated'));
    }
    this.pendingTasks.clear();

    for (const state of this.workers) {
      state.worker.terminate();
    }
    this.workers = [];
  }

  /**
   * Get pool statistics
   */
  getStats(): { workerCount: number; pendingTasks: number; isSupported: boolean } {
    return {
      workerCount: this.workers.length,
      pendingTasks: this.pendingTasks.size,
      isSupported: this.isSupported,
    };
  }
}

// Geometry pool singleton
let geometryPoolInstance: GeometryWorkerPool | null = null;

/**
 * Get the global geometry worker pool instance
 */
export function getGeometryWorkerPool(): GeometryWorkerPool {
  if (!geometryPoolInstance) {
    geometryPoolInstance = new GeometryWorkerPool();
  }
  return geometryPoolInstance;
}

/**
 * Reset the geometry worker pool (for testing)
 */
export function resetGeometryWorkerPool(): void {
  if (geometryPoolInstance) {
    geometryPoolInstance.terminate();
    geometryPoolInstance = null;
  }
}

/**
 * MVT parsing worker pool
 * Offloads CPU-intensive MVT decoding to workers
 * Uses transferable typed arrays for efficient coordinate transfer
 */
export class MVTWorkerPool {
  private workers: WorkerState[] = [];
  private pendingTasks = new Map<string, PendingTask>();
  private isSupported = true;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(private poolSize: number = getOptimalPoolSize()) {}

  /**
   * Initialize the MVT worker pool
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return this.isSupported;

    if (this.initPromise) {
      await this.initPromise;
      return this.isSupported;
    }

    this.initPromise = this.doInitialize();
    await this.initPromise;
    return this.isSupported;
  }

  private async doInitialize(): Promise<void> {
    // Create MVT workers
    for (let i = 0; i < this.poolSize; i++) {
      try {
        const worker = new Worker(
          new URL('./mvt-parse.worker.ts', import.meta.url),
          { type: 'module' }
        );

        const state: WorkerState = {
          worker,
          ready: false,
          pendingCount: 0,
        };

        worker.onmessage = (event) => this.handleMessage(i, event);
        worker.onerror = (event) => this.handleError(i, event);
        worker.onmessageerror = () => this.handleMessageError(i);

        this.workers.push(state);
      } catch (error) {
        console.warn(`Failed to create MVT worker ${i}:`, error);
      }
    }

    if (this.workers.length === 0) {
      console.warn('No MVT workers could be created, falling back to main thread');
      this.isSupported = false;
      this.initialized = true;
      return;
    }

    // Check capability
    try {
      const supported = await this.checkCapability(0);
      if (!supported) {
        console.warn('MVT worker capability check failed');
        this.isSupported = false;
        this.terminate();
      }
    } catch (error) {
      console.warn('MVT worker capability check failed:', error);
      this.isSupported = false;
      this.terminate();
    }

    this.initialized = true;
  }

  private checkCapability(workerIndex: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pendingTasks.delete(id);
        reject(new Error('Capability check timeout'));
      }, 5000);

      this.pendingTasks.set(id, {
        resolve: (result) => resolve(result as boolean),
        reject,
        workerIndex,
        timeoutId: timeout,
        countIncremented: false, // Capability checks don't increment pendingCount
      });

      const request: WorkerRequest = { type: 'CAPABILITY_CHECK', id };
      this.workers[workerIndex].worker.postMessage(request);
    });
  }

  private handleMessage(workerIndex: number, event: MessageEvent<WorkerResponse | { type: 'READY' }>): void {
    const data = event.data;

    if (data.type === 'READY') {
      this.workers[workerIndex].ready = true;
      return;
    }

    const response = data as WorkerResponse;

    if (response.type === 'CAPABILITY_CHECK_RESULT') {
      const task = this.pendingTasks.get(response.id);
      if (task) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(response.id);
        task.resolve(response.supported);
      }
      return;
    }

    if (response.type === 'PARSE_MVT_RESULT') {
      const task = this.pendingTasks.get(response.id);
      if (task) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(response.id);
        this.workers[task.workerIndex].pendingCount--;
        task.resolve(response.result);
      }
      return;
    }

    if (response.type === 'ERROR') {
      const task = this.pendingTasks.get(response.id);
      if (task) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(response.id);
        this.workers[task.workerIndex].pendingCount--;
        task.reject(new Error(response.error));
      }
      return;
    }
  }

  private handleError(workerIndex: number, event: ErrorEvent): void {
    console.error(`MVT worker ${workerIndex} error:`, event.message);

    for (const [id, task] of this.pendingTasks) {
      if (task.workerIndex === workerIndex) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(id);
        if (task.countIncremented) {
          this.workers[task.workerIndex].pendingCount--;
        }
        task.reject(new Error(`Worker error: ${event.message}`));
      }
    }

    this.replaceWorker(workerIndex);
  }

  private handleMessageError(workerIndex: number): void {
    console.error(`MVT worker ${workerIndex} message error`);

    for (const [id, task] of this.pendingTasks) {
      if (task.workerIndex === workerIndex) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(id);
        if (task.countIncremented) {
          this.workers[task.workerIndex].pendingCount--;
        }
        task.reject(new Error('Worker message error'));
      }
    }
  }

  private replaceWorker(workerIndex: number): void {
    try {
      this.workers[workerIndex]?.worker.terminate();

      const worker = new Worker(
        new URL('./mvt-parse.worker.ts', import.meta.url),
        { type: 'module' }
      );

      const state: WorkerState = {
        worker,
        ready: false,
        pendingCount: 0,
      };

      worker.onmessage = (event) => this.handleMessage(workerIndex, event);
      worker.onerror = (event) => this.handleError(workerIndex, event);
      worker.onmessageerror = () => this.handleMessageError(workerIndex);

      this.workers[workerIndex] = state;
    } catch (error) {
      console.error(`Failed to replace MVT worker ${workerIndex}:`, error);
    }
  }

  private getLeastLoadedWorker(): number {
    let minLoad = Infinity;
    let minIndex = 0;

    for (let i = 0; i < this.workers.length; i++) {
      const state = this.workers[i];
      if (state.ready && state.pendingCount < minLoad) {
        minLoad = state.pendingCount;
        minIndex = i;
      }
    }

    return minIndex;
  }

  private sendRequest<T>(request: WorkerRequest, transferables?: Transferable[]): Promise<T> {
    if (!this.isSupported || this.workers.length === 0) {
      return Promise.reject(new Error('MVT worker pool not available'));
    }

    return new Promise((resolve, reject) => {
      const workerIndex = this.getLeastLoadedWorker();
      const state = this.workers[workerIndex];

      const timeoutId = setTimeout(() => {
        this.pendingTasks.delete(request.id);
        state.pendingCount--;
        reject(new Error('Task timeout'));
      }, TASK_TIMEOUT_MS);

      this.pendingTasks.set(request.id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        workerIndex,
        timeoutId,
        countIncremented: true,
      });

      state.pendingCount++;
      if (transferables && transferables.length > 0) {
        state.worker.postMessage(request, transferables);
      } else {
        state.worker.postMessage(request);
      }
    });
  }

  /**
   * Parse MVT data using a worker
   * ArrayBuffer is transferred (zero-copy) to worker
   */
  async parseMVT(
    data: ArrayBuffer,
    tileX: number,
    tileY: number,
    zoom: number,
    layerName: string | null = null
  ): Promise<ParseMVTResult> {
    await this.initialize();

    if (!this.isSupported) {
      throw new Error('MVT worker pool not supported');
    }

    const payload: ParseMVTPayload = {
      data,
      tileX,
      tileY,
      zoom,
      layerName,
    };

    const request: WorkerRequest = {
      type: 'PARSE_MVT',
      id: crypto.randomUUID(),
      payload,
    };

    // Transfer the ArrayBuffer to avoid cloning
    return this.sendRequest<ParseMVTResult>(request, [data]);
  }

  /**
   * Check if MVT worker is supported
   */
  async isWorkerSupported(): Promise<boolean> {
    await this.initialize();
    return this.isSupported;
  }

  /**
   * Terminate all MVT workers
   */
  terminate(): void {
    for (const [_id, task] of this.pendingTasks) {
      clearTimeout(task.timeoutId);
      task.reject(new Error('MVT worker pool terminated'));
    }
    this.pendingTasks.clear();

    for (const state of this.workers) {
      state.worker.terminate();
    }
    this.workers = [];
  }

  /**
   * Get pool statistics
   */
  getStats(): { workerCount: number; pendingTasks: number; isSupported: boolean } {
    return {
      workerCount: this.workers.length,
      pendingTasks: this.pendingTasks.size,
      isSupported: this.isSupported,
    };
  }
}

// MVT pool singleton
let mvtPoolInstance: MVTWorkerPool | null = null;

/**
 * Get the global MVT worker pool instance
 */
export function getMVTWorkerPool(): MVTWorkerPool {
  if (!mvtPoolInstance) {
    mvtPoolInstance = new MVTWorkerPool();
  }
  return mvtPoolInstance;
}

/**
 * Reset the MVT worker pool (for testing)
 */
export function resetMVTWorkerPool(): void {
  if (mvtPoolInstance) {
    mvtPoolInstance.terminate();
    mvtPoolInstance = null;
  }
}

/**
 * Elevation decoding worker pool
 * Offloads CPU-intensive Terrarium PNG decoding to workers
 * Uses OffscreenCanvas for image processing
 */
export class ElevationWorkerPool {
  private workers: WorkerState[] = [];
  private pendingTasks = new Map<string, PendingTask>();
  private isSupported = true;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(private poolSize: number = Math.min(getOptimalPoolSize(), 2)) {
    // Use fewer workers for elevation (typically 2 is enough)
  }

  /**
   * Initialize the elevation worker pool
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return this.isSupported;

    if (this.initPromise) {
      await this.initPromise;
      return this.isSupported;
    }

    this.initPromise = this.doInitialize();
    await this.initPromise;
    return this.isSupported;
  }

  private async doInitialize(): Promise<void> {
    // Create elevation workers
    for (let i = 0; i < this.poolSize; i++) {
      try {
        const worker = new Worker(
          new URL('./elevation.worker.ts', import.meta.url),
          { type: 'module' }
        );

        const state: WorkerState = {
          worker,
          ready: false,
          pendingCount: 0,
        };

        worker.onmessage = (event) => this.handleMessage(i, event);
        worker.onerror = (event) => this.handleError(i, event);
        worker.onmessageerror = () => this.handleMessageError(i);

        this.workers.push(state);
      } catch (error) {
        console.warn(`Failed to create elevation worker ${i}:`, error);
      }
    }

    if (this.workers.length === 0) {
      console.warn('No elevation workers could be created, falling back to main thread');
      this.isSupported = false;
      this.initialized = true;
      return;
    }

    // Check capability (OffscreenCanvas support)
    try {
      const supported = await this.checkCapability(0);
      if (!supported) {
        console.warn('OffscreenCanvas not supported in elevation workers, falling back to main thread');
        this.isSupported = false;
        this.terminate();
      }
    } catch (error) {
      console.warn('Elevation worker capability check failed:', error);
      this.isSupported = false;
      this.terminate();
    }

    this.initialized = true;
  }

  private checkCapability(workerIndex: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pendingTasks.delete(id);
        reject(new Error('Capability check timeout'));
      }, 5000);

      this.pendingTasks.set(id, {
        resolve: (result) => resolve(result as boolean),
        reject,
        workerIndex,
        timeoutId: timeout,
        countIncremented: false, // Capability checks don't increment pendingCount
      });

      const request: WorkerRequest = { type: 'CAPABILITY_CHECK', id };
      this.workers[workerIndex].worker.postMessage(request);
    });
  }

  private handleMessage(workerIndex: number, event: MessageEvent<WorkerResponse | { type: 'READY' }>): void {
    const data = event.data;

    if (data.type === 'READY') {
      this.workers[workerIndex].ready = true;
      return;
    }

    const response = data as WorkerResponse;

    if (response.type === 'CAPABILITY_CHECK_RESULT') {
      const task = this.pendingTasks.get(response.id);
      if (task) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(response.id);
        task.resolve(response.supported);
      }
      return;
    }

    if (response.type === 'DECODE_ELEVATION_RESULT') {
      const task = this.pendingTasks.get(response.id);
      if (task) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(response.id);
        this.workers[task.workerIndex].pendingCount--;
        task.resolve(response.result);
      }
      return;
    }

    if (response.type === 'ERROR') {
      const task = this.pendingTasks.get(response.id);
      if (task) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(response.id);
        this.workers[task.workerIndex].pendingCount--;
        task.reject(new Error(response.error));
      }
      return;
    }
  }

  private handleError(workerIndex: number, event: ErrorEvent): void {
    console.error(`Elevation worker ${workerIndex} error:`, event.message);

    for (const [id, task] of this.pendingTasks) {
      if (task.workerIndex === workerIndex) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(id);
        if (task.countIncremented) {
          this.workers[task.workerIndex].pendingCount--;
        }
        task.reject(new Error(`Worker error: ${event.message}`));
      }
    }

    this.replaceWorker(workerIndex);
  }

  private handleMessageError(workerIndex: number): void {
    console.error(`Elevation worker ${workerIndex} message error`);

    for (const [id, task] of this.pendingTasks) {
      if (task.workerIndex === workerIndex) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(id);
        if (task.countIncremented) {
          this.workers[task.workerIndex].pendingCount--;
        }
        task.reject(new Error('Worker message error'));
      }
    }
  }

  private replaceWorker(workerIndex: number): void {
    try {
      this.workers[workerIndex]?.worker.terminate();

      const worker = new Worker(
        new URL('./elevation.worker.ts', import.meta.url),
        { type: 'module' }
      );

      const state: WorkerState = {
        worker,
        ready: false,
        pendingCount: 0,
      };

      worker.onmessage = (event) => this.handleMessage(workerIndex, event);
      worker.onerror = (event) => this.handleError(workerIndex, event);
      worker.onmessageerror = () => this.handleMessageError(workerIndex);

      this.workers[workerIndex] = state;
    } catch (error) {
      console.error(`Failed to replace elevation worker ${workerIndex}:`, error);
    }
  }

  private getLeastLoadedWorker(): number {
    let minLoad = Infinity;
    let minIndex = 0;

    for (let i = 0; i < this.workers.length; i++) {
      const state = this.workers[i];
      if (state.ready && state.pendingCount < minLoad) {
        minLoad = state.pendingCount;
        minIndex = i;
      }
    }

    return minIndex;
  }

  private sendRequest<T>(request: WorkerRequest): Promise<T> {
    if (!this.isSupported || this.workers.length === 0) {
      return Promise.reject(new Error('Elevation worker pool not available'));
    }

    return new Promise((resolve, reject) => {
      const workerIndex = this.getLeastLoadedWorker();
      const state = this.workers[workerIndex];

      const timeoutId = setTimeout(() => {
        this.pendingTasks.delete(request.id);
        state.pendingCount--;
        reject(new Error('Task timeout'));
      }, TASK_TIMEOUT_MS);

      this.pendingTasks.set(request.id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        workerIndex,
        timeoutId,
        countIncremented: true,
      });

      state.pendingCount++;
      state.worker.postMessage(request);
    });
  }

  /**
   * Decode elevation tile using a worker
   * Returns Float32Array of height values (transferred, zero-copy)
   */
  async decodeElevation(
    url: string,
    tileSize: number,
    terrariumOffset: number
  ): Promise<Float32Array> {
    await this.initialize();

    if (!this.isSupported) {
      throw new Error('Elevation worker pool not supported');
    }

    const payload: DecodeElevationPayload = {
      url,
      tileSize,
      terrariumOffset,
    };

    const request: WorkerRequest = {
      type: 'DECODE_ELEVATION',
      id: crypto.randomUUID(),
      payload,
    };

    const result = await this.sendRequest<DecodeElevationResult>(request);
    return result.heights;
  }

  /**
   * Check if elevation worker is supported
   */
  async isWorkerSupported(): Promise<boolean> {
    await this.initialize();
    return this.isSupported;
  }

  /**
   * Terminate all elevation workers
   */
  terminate(): void {
    for (const [_id, task] of this.pendingTasks) {
      clearTimeout(task.timeoutId);
      task.reject(new Error('Elevation worker pool terminated'));
    }
    this.pendingTasks.clear();

    for (const state of this.workers) {
      state.worker.terminate();
    }
    this.workers = [];
  }

  /**
   * Get pool statistics
   */
  getStats(): { workerCount: number; pendingTasks: number; isSupported: boolean } {
    return {
      workerCount: this.workers.length,
      pendingTasks: this.pendingTasks.size,
      isSupported: this.isSupported,
    };
  }
}

// Elevation pool singleton
let elevationPoolInstance: ElevationWorkerPool | null = null;

/**
 * Get the global elevation worker pool instance
 */
export function getElevationWorkerPool(): ElevationWorkerPool {
  if (!elevationPoolInstance) {
    elevationPoolInstance = new ElevationWorkerPool();
  }
  return elevationPoolInstance;
}

/**
 * Reset the elevation worker pool (for testing)
 */
export function resetElevationWorkerPool(): void {
  if (elevationPoolInstance) {
    elevationPoolInstance.terminate();
    elevationPoolInstance = null;
  }
}

// =============================================================================
// Building Geometry Worker Pool
// Offloads building extrusion to workers using earcut triangulation
// =============================================================================

export class BuildingGeometryWorkerPool {
  private workers: WorkerState[] = [];
  private pendingTasks = new Map<string, PendingTask>();
  private isSupported = true;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(private poolSize: number = getOptimalPoolSize()) {}

  /**
   * Initialize the building geometry worker pool
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return this.isSupported;

    if (this.initPromise) {
      await this.initPromise;
      return this.isSupported;
    }

    this.initPromise = this.doInitialize();
    await this.initPromise;
    return this.isSupported;
  }

  private async doInitialize(): Promise<void> {
    // Create building geometry workers
    for (let i = 0; i < this.poolSize; i++) {
      try {
        const worker = new Worker(
          new URL('./building-geometry.worker.ts', import.meta.url),
          { type: 'module' }
        );

        const state: WorkerState = {
          worker,
          ready: false,
          pendingCount: 0,
        };

        worker.onmessage = (event) => this.handleMessage(i, event);
        worker.onerror = (event) => this.handleError(i, event);
        worker.onmessageerror = () => this.handleMessageError(i);

        this.workers.push(state);
      } catch (error) {
        console.warn(`Failed to create building geometry worker ${i}:`, error);
      }
    }

    if (this.workers.length === 0) {
      console.warn('No building geometry workers could be created, falling back to main thread');
      this.isSupported = false;
      this.initialized = true;
      return;
    }

    // Check capability
    try {
      const supported = await this.checkCapability(0);
      if (!supported) {
        console.warn('Building geometry worker capability check failed');
        this.isSupported = false;
        this.terminate();
      }
    } catch (error) {
      console.warn('Building geometry worker capability check failed:', error);
      this.isSupported = false;
      this.terminate();
    }

    this.initialized = true;
  }

  private checkCapability(workerIndex: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pendingTasks.delete(id);
        reject(new Error('Capability check timeout'));
      }, 5000);

      this.pendingTasks.set(id, {
        resolve: (result) => resolve(result as boolean),
        reject,
        workerIndex,
        timeoutId: timeout,
        countIncremented: false,
      });

      const request: WorkerRequest = { type: 'CAPABILITY_CHECK', id };
      this.workers[workerIndex].worker.postMessage(request);
    });
  }

  private handleMessage(workerIndex: number, event: MessageEvent<WorkerResponse | { type: 'READY' }>): void {
    const data = event.data;

    if (data.type === 'READY') {
      this.workers[workerIndex].ready = true;
      return;
    }

    const response = data as WorkerResponse;

    if (response.type === 'CAPABILITY_CHECK_RESULT') {
      const task = this.pendingTasks.get(response.id);
      if (task) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(response.id);
        task.resolve(response.supported);
      }
      return;
    }

    if (response.type === 'CREATE_BUILDING_GEOMETRY_RESULT') {
      const task = this.pendingTasks.get(response.id);
      if (task) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(response.id);
        this.workers[task.workerIndex].pendingCount--;
        task.resolve(response.result);
      }
      return;
    }

    if (response.type === 'ERROR') {
      const task = this.pendingTasks.get(response.id);
      if (task) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(response.id);
        this.workers[task.workerIndex].pendingCount--;
        task.reject(new Error(response.error));
      }
      return;
    }
  }

  private handleError(workerIndex: number, event: ErrorEvent): void {
    console.error(`Building geometry worker ${workerIndex} error:`, event.message);

    for (const [id, task] of this.pendingTasks) {
      if (task.workerIndex === workerIndex) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(id);
        if (task.countIncremented) {
          this.workers[task.workerIndex].pendingCount--;
        }
        task.reject(new Error(`Worker error: ${event.message}`));
      }
    }

    this.replaceWorker(workerIndex);
  }

  private handleMessageError(workerIndex: number): void {
    console.error(`Building geometry worker ${workerIndex} message error`);

    for (const [id, task] of this.pendingTasks) {
      if (task.workerIndex === workerIndex) {
        clearTimeout(task.timeoutId);
        this.pendingTasks.delete(id);
        if (task.countIncremented) {
          this.workers[task.workerIndex].pendingCount--;
        }
        task.reject(new Error('Worker message error'));
      }
    }
  }

  private replaceWorker(workerIndex: number): void {
    try {
      this.workers[workerIndex]?.worker.terminate();

      const worker = new Worker(
        new URL('./building-geometry.worker.ts', import.meta.url),
        { type: 'module' }
      );

      const state: WorkerState = {
        worker,
        ready: false,
        pendingCount: 0,
      };

      worker.onmessage = (event) => this.handleMessage(workerIndex, event);
      worker.onerror = (event) => this.handleError(workerIndex, event);
      worker.onmessageerror = () => this.handleMessageError(workerIndex);

      this.workers[workerIndex] = state;
    } catch (error) {
      console.error(`Failed to replace building geometry worker ${workerIndex}:`, error);
    }
  }

  private getLeastLoadedWorker(): number {
    let minLoad = Infinity;
    let minIndex = 0;

    for (let i = 0; i < this.workers.length; i++) {
      const state = this.workers[i];
      if (state.ready && state.pendingCount < minLoad) {
        minLoad = state.pendingCount;
        minIndex = i;
      }
    }

    return minIndex;
  }

  private sendRequest<T>(request: WorkerRequest): Promise<T> {
    if (!this.isSupported || this.workers.length === 0) {
      return Promise.reject(new Error('Building geometry worker pool not available'));
    }

    return new Promise((resolve, reject) => {
      const workerIndex = this.getLeastLoadedWorker();
      const state = this.workers[workerIndex];

      const timeoutId = setTimeout(() => {
        this.pendingTasks.delete(request.id);
        state.pendingCount--;
        reject(new Error('Task timeout'));
      }, TASK_TIMEOUT_MS);

      this.pendingTasks.set(request.id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        workerIndex,
        timeoutId,
        countIncremented: true,
      });

      state.pendingCount++;
      state.worker.postMessage(request);
    });
  }

  /**
   * Create building geometry using a worker
   */
  async createBuildingGeometry(
    features: BuildingFeatureInput[],
    origin: SceneOrigin,
    tileX: number,
    tileY: number,
    tileZ: number,
    lodLevel: number,
    defaultHeight: number,
    terrainHeights: { [buildingIndex: number]: [number, number] } | undefined,
    verticalExaggeration: number
  ): Promise<CreateBuildingGeometryResult> {
    await this.initialize();

    if (!this.isSupported) {
      throw new Error('Building geometry worker pool not supported');
    }

    const payload: CreateBuildingGeometryPayload = {
      features,
      origin,
      tileX,
      tileY,
      tileZ,
      lodLevel,
      defaultHeight,
      terrainHeights,
      verticalExaggeration,
    };

    const request: WorkerRequest = {
      type: 'CREATE_BUILDING_GEOMETRY',
      id: crypto.randomUUID(),
      payload,
    };

    return this.sendRequest<CreateBuildingGeometryResult>(request);
  }

  /**
   * Check if building geometry worker is supported
   */
  async isWorkerSupported(): Promise<boolean> {
    await this.initialize();
    return this.isSupported;
  }

  /**
   * Terminate all building geometry workers
   */
  terminate(): void {
    for (const [_id, task] of this.pendingTasks) {
      clearTimeout(task.timeoutId);
      task.reject(new Error('Building geometry worker pool terminated'));
    }
    this.pendingTasks.clear();

    for (const state of this.workers) {
      state.worker.terminate();
    }
    this.workers = [];
  }

  /**
   * Get pool statistics
   */
  getStats(): { workerCount: number; pendingTasks: number; isSupported: boolean } {
    return {
      workerCount: this.workers.length,
      pendingTasks: this.pendingTasks.size,
      isSupported: this.isSupported,
    };
  }
}

// Building geometry pool singleton
let buildingGeometryPoolInstance: BuildingGeometryWorkerPool | null = null;

/**
 * Get the global building geometry worker pool instance
 */
export function getBuildingGeometryWorkerPool(): BuildingGeometryWorkerPool {
  if (!buildingGeometryPoolInstance) {
    buildingGeometryPoolInstance = new BuildingGeometryWorkerPool();
  }
  return buildingGeometryPoolInstance;
}

/**
 * Reset the building geometry worker pool (for testing)
 */
export function resetBuildingGeometryWorkerPool(): void {
  if (buildingGeometryPoolInstance) {
    buildingGeometryPoolInstance.terminate();
    buildingGeometryPoolInstance = null;
  }
}

// =============================================================================
// Full Pipeline Worker Pool
// Handles fetch -> parse -> render entirely in worker for zero structured clone
// =============================================================================

/**
 * Full pipeline request payload
 */
export interface FullPipelinePayload {
  tileX: number;
  tileY: number;
  tileZ: number;
  textureSize: number;
  basePMTilesUrl: string;
  transportationPMTilesUrl: string;
  includeNeighbors: boolean;
  includeTransportation: boolean;
}

/**
 * Worker pool for full-pipeline texture rendering
 * Handles fetch -> parse -> render in worker to avoid structured clone overhead
 */
export class FullPipelineWorkerPool {
  private workers: WorkerState[] = [];
  private pendingTasks = new Map<string, PendingTask>();
  private isSupported = true;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private pmtilesInitialized = false;
  private recoveringWorkers = new Set<number>(); // Prevent concurrent recovery of same worker

  constructor(private poolSize: number = getOptimalPoolSize()) {}

  /**
   * Initialize the full pipeline worker pool
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return this.isSupported;

    if (this.initPromise) {
      await this.initPromise;
      return this.isSupported;
    }

    this.initPromise = this.doInitialize();
    await this.initPromise;
    return this.isSupported;
  }

  private async doInitialize(): Promise<void> {
    // Create full pipeline workers
    for (let i = 0; i < this.poolSize; i++) {
      try {
        const worker = new Worker(
          new URL('./full-pipeline.worker.ts', import.meta.url),
          { type: 'module' }
        );

        const state: WorkerState = {
          worker,
          ready: false,
          pendingCount: 0,
        };

        worker.onmessage = (event) => this.handleMessage(i, event);
        worker.onerror = (event) => this.handleError(i, event);
        worker.onmessageerror = () => this.handleMessageError(i);

        this.workers.push(state);
      } catch (error) {
        console.warn(`Failed to create full-pipeline worker ${i}:`, error);
      }
    }

    if (this.workers.length === 0) {
      console.warn('Full pipeline workers not available');
      this.isSupported = false;
      this.initialized = true;
      return;
    }

    // Wait for workers to signal ready
    await new Promise<void>((resolve) => {
      let readyCount = 0;
      const originalHandlers = new Map<WorkerState, ((event: MessageEvent) => void) | null>();

      const checkReady = () => {
        readyCount++;
        if (readyCount >= this.workers.length) {
          resolve();
        }
      };

      for (const state of this.workers) {
        // Check if worker already signaled ready (race condition: READY arrived before this loop)
        if (state.ready) {
          checkReady();
          continue;
        }

        const originalHandler = state.worker.onmessage;
        originalHandlers.set(state, originalHandler);

        state.worker.onmessage = (event) => {
          if (event.data.type === 'READY') {
            state.ready = true;
            state.worker.onmessage = originalHandler;
            originalHandlers.delete(state);
            checkReady();
          }
        };
      }

      // Timeout after 5 seconds
      setTimeout(() => {
        for (const state of this.workers) {
          if (!state.ready) {
            state.ready = true; // Mark as ready even if no signal
            // Restore original handler so worker can still process messages
            const originalHandler = originalHandlers.get(state);
            if (originalHandler !== undefined) {
              state.worker.onmessage = originalHandler;
            }
          }
        }
        originalHandlers.clear();
        resolve();
      }, 5000);
    });

    // Check OffscreenCanvas support
    const firstWorker = this.workers[0];
    if (firstWorker) {
      try {
        const checkId = crypto.randomUUID();
        const supported = await new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), 3000);

          const handler = (event: MessageEvent) => {
            if (event.data.id === checkId) {
              clearTimeout(timeout);
              firstWorker.worker.removeEventListener('message', handler);
              resolve(event.data.supported ?? false);
            }
          };
          firstWorker.worker.addEventListener('message', handler);

          firstWorker.worker.postMessage({
            type: 'CAPABILITY_CHECK',
            id: checkId,
          });
        });

        if (!supported) {
          console.warn('Full pipeline workers: OffscreenCanvas not supported');
          this.isSupported = false;
        }
      } catch {
        this.isSupported = false;
      }
    }

    this.initialized = true;
  }

  /**
   * Handle message from worker
   */
  private handleMessage(workerIndex: number, event: MessageEvent): void {
    const response = event.data;

    // Handle READY signals - mark worker as ready (may arrive before init waiting loop)
    if (response?.type === 'READY') {
      if (this.workers[workerIndex]) {
        this.workers[workerIndex].ready = true;
      }
      return;
    }

    const typedResponse = response as WorkerResponse;
    const task = this.pendingTasks.get(typedResponse.id);
    if (!task) return;

    clearTimeout(task.timeoutId);
    this.pendingTasks.delete(typedResponse.id);
    // Only decrement if this task incremented the count (not capability checks)
    if (task.countIncremented) {
      this.workers[task.workerIndex].pendingCount--;
    }

    if (typedResponse.type === 'ERROR') {
      task.reject(new Error(typedResponse.error));
    } else if (typedResponse.type === 'RENDER_TILE_TEXTURE_RESULT') {
      task.resolve(typedResponse.result);
    } else if (typedResponse.type === 'CAPABILITY_CHECK_RESULT') {
      task.resolve(typedResponse.supported);
    }
  }

  /**
   * Handle worker error
   */
  private handleError(workerIndex: number, event: ErrorEvent): void {
    console.error(`Full pipeline worker ${workerIndex} error:`, event.message);
    this.recoverWorker(workerIndex);
  }

  /**
   * Handle message error
   */
  private handleMessageError(workerIndex: number): void {
    console.error(`Full pipeline worker ${workerIndex} message error`);
    this.recoverWorker(workerIndex);
  }

  /**
   * Recover a failed worker
   */
  private recoverWorker(workerIndex: number): void {
    const state = this.workers[workerIndex];
    if (!state) return;

    // Prevent concurrent recovery of the same worker
    if (this.recoveringWorkers.has(workerIndex)) {
      return;
    }
    this.recoveringWorkers.add(workerIndex);

    try {
      state.worker.terminate();

      const newWorker = new Worker(
        new URL('./full-pipeline.worker.ts', import.meta.url),
        { type: 'module' }
      );

      newWorker.onmessage = (event) => this.handleMessage(workerIndex, event);
      newWorker.onerror = (event) => this.handleError(workerIndex, event);
      newWorker.onmessageerror = () => this.handleMessageError(workerIndex);

      this.workers[workerIndex] = {
        worker: newWorker,
        ready: true,
        pendingCount: 0,
      };

      // Re-initialize PMTiles in the new worker if URLs are cached
      // Capture URLs atomically to prevent partial reads during concurrent access
      const baseUrl = this.cachedBasePMTilesUrl;
      const transportUrl = this.cachedTransportationPMTilesUrl;
      if (this.pmtilesInitialized && baseUrl && transportUrl) {
        newWorker.postMessage({
          type: 'INIT_PMTILES',
          id: crypto.randomUUID(),
          payload: {
            basePMTilesUrl: baseUrl,
            transportationPMTilesUrl: transportUrl,
          },
        });
      }
    } catch (error) {
      console.error(`Failed to recover full pipeline worker ${workerIndex}:`, error);
    } finally {
      this.recoveringWorkers.delete(workerIndex);
    }
  }

  // Cache PMTiles URLs for worker recovery
  private cachedBasePMTilesUrl: string | null = null;
  private cachedTransportationPMTilesUrl: string | null = null;

  /**
   * Select least loaded worker (returns index)
   */
  private selectWorkerIndex(): number {
    let bestIndex = -1;
    let bestCount = Infinity;

    for (let i = 0; i < this.workers.length; i++) {
      const worker = this.workers[i];
      if (worker.ready && worker.pendingCount < bestCount) {
        bestIndex = i;
        bestCount = worker.pendingCount;
      }
    }

    return bestIndex;
  }

  /**
   * Send request to worker
   */
  private sendRequest<T>(request: { type: string; id: string; payload?: unknown }): Promise<T> {
    return new Promise((resolve, reject) => {
      const workerIndex = this.selectWorkerIndex();
      if (workerIndex < 0) {
        reject(new Error('No available full pipeline workers'));
        return;
      }

      const worker = this.workers[workerIndex];

      const timeoutId = setTimeout(() => {
        this.pendingTasks.delete(request.id);
        worker.pendingCount--;
        reject(new Error('Full pipeline worker request timeout'));
      }, 60000); // 60 second timeout for full pipeline

      this.pendingTasks.set(request.id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        workerIndex,
        timeoutId,
        countIncremented: true,
      });

      worker.pendingCount++;
      worker.worker.postMessage(request);
    });
  }

  /**
   * Render a tile using the full pipeline (fetch -> parse -> render in worker)
   * Returns ImageBitmap directly
   */
  async renderTile(
    tileX: number,
    tileY: number,
    tileZ: number,
    textureSize: number,
    basePMTilesUrl: string,
    transportationPMTilesUrl: string,
    includeNeighbors: boolean = true,
    includeTransportation: boolean = true
  ): Promise<ImageBitmap> {
    await this.initialize();

    if (!this.isSupported) {
      throw new Error('Full pipeline worker pool not supported');
    }

    // Cache URLs for worker recovery
    this.cachedBasePMTilesUrl = basePMTilesUrl;
    this.cachedTransportationPMTilesUrl = transportationPMTilesUrl;
    this.pmtilesInitialized = true;

    const request = {
      type: 'RENDER_FULL_PIPELINE' as const,
      id: crypto.randomUUID(),
      payload: {
        tileX,
        tileY,
        tileZ,
        textureSize,
        basePMTilesUrl,
        transportationPMTilesUrl,
        includeNeighbors,
        includeTransportation,
      },
    };

    return this.sendRequest<ImageBitmap>(request);
  }

  /**
   * Check if full pipeline workers are supported
   */
  async isWorkerSupported(): Promise<boolean> {
    await this.initialize();
    return this.isSupported;
  }

  /**
   * Terminate all workers
   */
  terminate(): void {
    for (const [_id, task] of this.pendingTasks) {
      clearTimeout(task.timeoutId);
      task.reject(new Error('Full pipeline worker pool terminated'));
    }
    this.pendingTasks.clear();

    for (const state of this.workers) {
      state.worker.terminate();
    }
    this.workers = [];
  }

  /**
   * Get pool statistics
   */
  getStats(): { workerCount: number; pendingTasks: number; isSupported: boolean } {
    return {
      workerCount: this.workers.length,
      pendingTasks: this.pendingTasks.size,
      isSupported: this.isSupported,
    };
  }
}

// Full pipeline pool singleton
let fullPipelinePoolInstance: FullPipelineWorkerPool | null = null;

/**
 * Get the global full pipeline worker pool instance
 */
export function getFullPipelineWorkerPool(): FullPipelineWorkerPool {
  if (!fullPipelinePoolInstance) {
    fullPipelinePoolInstance = new FullPipelineWorkerPool();
  }
  return fullPipelinePoolInstance;
}

/**
 * Reset the full pipeline worker pool (for testing)
 */
export function resetFullPipelineWorkerPool(): void {
  if (fullPipelinePoolInstance) {
    fullPipelinePoolInstance.terminate();
    fullPipelinePoolInstance = null;
  }
}
