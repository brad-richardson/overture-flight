import { describe, expect, it, vi } from 'vitest';
import {
  LazyMinimapController,
  type MinimapModule,
  type MinimapLoadStatus,
} from '../src/minimap-loader.js';
import type { PlaneState } from '../src/plane.js';

const plane = (lat: number): PlaneState => ({
  id: 'local',
  lat,
  lng: 11.25,
  altitude: 500,
  heading: 45,
  pitch: 0,
  roll: 0,
  speed: 80,
  color: '#fff',
  name: '',
});

function fakeModule(): MinimapModule & {
  initMinimap: ReturnType<typeof vi.fn>;
  updateMinimap: ReturnType<typeof vi.fn>;
  openMinimap: ReturnType<typeof vi.fn>;
} {
  return {
    initMinimap: vi.fn(),
    updateMinimap: vi.fn(),
    openMinimap: vi.fn(),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('lazy minimap controller', () => {
  it('imports and initializes once, then opens once per activation', async () => {
    const module = fakeModule();
    const loadModule = vi.fn(async () => module);
    const controller = new LazyMinimapController({ loadModule, onTeleport: vi.fn() });
    const initialPlane = plane(43.77);
    controller.updatePlaneState(initialPlane);

    await controller.activate();
    await controller.activate();

    expect(loadModule).toHaveBeenCalledTimes(1);
    expect(module.initMinimap).toHaveBeenCalledTimes(1);
    expect(module.updateMinimap).toHaveBeenCalledWith(initialPlane);
    expect(module.openMinimap).toHaveBeenCalledTimes(2);
    expect(controller.getStatus()).toBe('ready');
  });

  it('forwards the newest state received while the import is pending', async () => {
    const pending = deferred<MinimapModule>();
    const module = fakeModule();
    const controller = new LazyMinimapController({
      loadModule: () => pending.promise,
      onTeleport: vi.fn(),
    });
    controller.updatePlaneState(plane(1));
    const activation = controller.activate();
    const latestPlane = plane(2);
    controller.updatePlaneState(latestPlane);

    pending.resolve(module);
    await activation;

    expect(module.updateMinimap).toHaveBeenCalledTimes(1);
    expect(module.updateMinimap).toHaveBeenCalledWith(latestPlane);
  });

  it('coalesces double activation while loading', async () => {
    const pending = deferred<MinimapModule>();
    const module = fakeModule();
    const loadModule = vi.fn(() => pending.promise);
    const controller = new LazyMinimapController({ loadModule, onTeleport: vi.fn() });

    const first = controller.activate();
    const second = controller.activate();
    expect(second).toBe(first);
    expect(controller.getStatus()).toBe('loading');

    pending.resolve(module);
    await Promise.all([first, second]);
    expect(loadModule).toHaveBeenCalledTimes(1);
    expect(module.openMinimap).toHaveBeenCalledTimes(1);
  });

  it('reports an error and retries after an import failure', async () => {
    const module = fakeModule();
    const statuses: MinimapLoadStatus[] = [];
    const loadModule = vi.fn()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValueOnce(module);
    const controller = new LazyMinimapController({
      loadModule,
      onTeleport: vi.fn(),
      onStatusChange: status => statuses.push(status),
    });

    await expect(controller.activate()).rejects.toThrow('chunk failed');
    expect(controller.getStatus()).toBe('error');
    await expect(controller.activate()).resolves.toBeUndefined();

    expect(loadModule).toHaveBeenCalledTimes(2);
    expect(module.initMinimap).toHaveBeenCalledTimes(1);
    expect(module.openMinimap).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['loading', 'error', 'loading', 'ready']);
  });

  it('retries initialization failure without retaining a half-ready module', async () => {
    const module = fakeModule();
    module.initMinimap
      .mockRejectedValueOnce(new Error('missing DOM'))
      .mockResolvedValueOnce(undefined);
    const loadModule = vi.fn(async () => module);
    const controller = new LazyMinimapController({ loadModule, onTeleport: vi.fn() });

    await expect(controller.activate()).rejects.toThrow('missing DOM');
    await expect(controller.activate()).resolves.toBeUndefined();

    expect(loadModule).toHaveBeenCalledTimes(2);
    expect(module.initMinimap).toHaveBeenCalledTimes(2);
    expect(module.openMinimap).toHaveBeenCalledTimes(1);
  });
});
