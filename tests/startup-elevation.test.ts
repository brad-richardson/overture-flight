import { describe, expect, it, vi } from 'vitest';
import { StartupElevationCoordinator } from '../src/startup-elevation.js';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('startup elevation coordinator', () => {
  it('awaits one center load before allowing the first frame', async () => {
    const center = deferred();
    const preload = vi.fn(() => center.promise);
    const requestFrame = vi.fn();
    const coordinator = new StartupElevationCoordinator({
      lng: 11.2531,
      lat: 43.768,
      preload,
      requestFrame,
      onWarmupError: vi.fn(),
    });

    const firstLoad = coordinator.loadCenter();
    expect(coordinator.loadCenter()).toBe(firstLoad);
    expect(preload).toHaveBeenCalledOnce();
    expect(preload).toHaveBeenCalledWith(11.2531, 43.768, 0);
    expect(() => coordinator.scheduleFirstFrame(vi.fn())).toThrow(
      'Center elevation must finish loading before the first frame'
    );

    center.resolve();
    await firstLoad;
    coordinator.scheduleFirstFrame(vi.fn());
    expect(requestFrame).toHaveBeenCalledOnce();
  });

  it('runs the first frame before starting one radius-2 warmup', async () => {
    const events: string[] = [];
    const preload = vi.fn(async (_lng: number, _lat: number, radius: number) => {
      events.push(`preload:${radius}`);
    });
    let frameCallback: FrameRequestCallback | null = null;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      events.push('frame:scheduled');
      frameCallback = callback;
      return 1;
    });
    const coordinator = new StartupElevationCoordinator({
      lng: -71.0704,
      lat: 42.3541,
      preload,
      requestFrame,
      onWarmupError: vi.fn(),
    });

    await coordinator.loadCenter();
    const firstFrame = vi.fn(() => events.push('frame:ran'));
    coordinator.scheduleFirstFrame(firstFrame);
    coordinator.scheduleFirstFrame(firstFrame);

    expect(events).toEqual(['preload:0', 'frame:scheduled']);
    expect(frameCallback).not.toBeNull();
    frameCallback!(16);
    await Promise.resolve();

    expect(events).toEqual([
      'preload:0',
      'frame:scheduled',
      'frame:ran',
      'preload:2',
    ]);
    expect(preload).toHaveBeenCalledTimes(2);
    expect(preload).toHaveBeenNthCalledWith(2, -71.0704, 42.3541, 2);
    expect(requestFrame).toHaveBeenCalledOnce();
  });

  it('reports a rejected background warmup without rejecting initialization', async () => {
    const failure = new Error('warmup failed');
    const preload = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure);
    let frameCallback: FrameRequestCallback | null = null;
    const onWarmupError = vi.fn();
    const coordinator = new StartupElevationCoordinator({
      lng: 139.6503,
      lat: 35.6762,
      preload,
      requestFrame: callback => {
        frameCallback = callback;
        return 1;
      },
      onWarmupError,
    });

    await coordinator.loadCenter();
    coordinator.scheduleFirstFrame(vi.fn());
    frameCallback!(16);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(onWarmupError).toHaveBeenCalledOnce();
    expect(onWarmupError).toHaveBeenCalledWith(failure);
  });
});
