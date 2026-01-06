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
  TileBounds,
  ParsedFeature,
  SceneOrigin,
  BaseGeometryResult,
} from './types.js';
import { WORKERS } from '../constants.js';

// Re-export types for convenience
export type { TileBounds, ParsedFeature, SceneOrigin, BaseGeometryResult, GeometryBufferGroup, LineGeometryBufferGroup } from './types.js';

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
        this.workers[task.workerIndex].pendingCount--;
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
        this.workers[task.workerIndex].pendingCount--;
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
