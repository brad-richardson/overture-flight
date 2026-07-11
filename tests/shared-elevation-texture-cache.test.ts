import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  acquireSharedElevationTexture,
  RefCountedIdentityCache,
} from '../src/ground-texture/shared-elevation-texture-cache.js';

interface FakeResource {
  readonly id: number;
}

describe('RefCountedIdentityCache', () => {
  it('creates once for shared owners and disposes exactly after the last release', () => {
    const dispose = vi.fn<(resource: FakeResource) => void>();
    const create = vi.fn(() => ({ id: 1 }));
    const cache = new RefCountedIdentityCache<object, FakeResource>(dispose);
    const source = {};

    const first = cache.acquire(source, 'webgl:size-256', create);
    const second = cache.acquire(source, 'webgl:size-256', create);

    expect(first.resource).toBe(second.resource);
    expect(create).toHaveBeenCalledTimes(1);

    first.release();
    first.release();
    expect(dispose).not.toHaveBeenCalled();

    second.release();
    second.release();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(first.resource);
  });

  it('never reacquires a resource already queued for deferred disposal', () => {
    const deferredDisposals: FakeResource[] = [];
    let nextId = 0;
    const cache = new RefCountedIdentityCache<object, FakeResource>((resource) => {
      deferredDisposals.push(resource);
    });
    const source = {};

    const first = cache.acquire(source, 'webgpu:size-256', () => ({ id: ++nextId }));
    first.release();
    const second = cache.acquire(source, 'webgpu:size-256', () => ({ id: ++nextId }));

    expect(deferredDisposals).toEqual([first.resource]);
    expect(second.resource).not.toBe(first.resource);
    expect(second.resource.id).toBe(2);

    // Flushing the deferred queue can only affect the retired first resource.
    deferredDisposals.splice(0).forEach(resource => expect(resource).toBe(first.resource));
    second.release();
    expect(deferredDisposals).toEqual([second.resource]);
  });

  it('cleans up failed async construction and does not cache factory failures', async () => {
    const dispose = vi.fn<(resource: FakeResource) => void>();
    const cache = new RefCountedIdentityCache<object, FakeResource>(dispose);
    const source = {};

    expect(() => cache.acquire(source, 'webgl:size-256', () => {
      throw new Error('texture creation failed');
    })).toThrow('texture creation failed');

    const lease = cache.acquire(source, 'webgl:size-256', () => ({ id: 1 }));
    await expect((async () => {
      try {
        await Promise.resolve();
        throw new Error('quad construction failed');
      } finally {
        lease.release();
      }
    })()).rejects.toThrow('quad construction failed');

    expect(dispose).toHaveBeenCalledTimes(1);
    const reacquired = cache.acquire(source, 'webgl:size-256', () => ({ id: 2 }));
    expect(reacquired.resource.id).toBe(2);
    reacquired.release();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('keeps source identities and texture variants independent', () => {
    const dispose = vi.fn<(resource: FakeResource) => void>();
    const cache = new RefCountedIdentityCache<object, FakeResource>(dispose);
    const firstSource = {};
    const secondSource = {};
    let nextId = 0;
    const create = () => ({ id: ++nextId });

    const webgl = cache.acquire(firstSource, 'webgl-float32:size-256', create);
    const webgpu = cache.acquire(firstSource, 'webgpu-float16:size-256', create);
    const otherSize = cache.acquire(firstSource, 'webgl-float32:size-512', create);
    const otherSource = cache.acquire(secondSource, 'webgl-float32:size-256', create);

    expect(new Set([
      webgl.resource,
      webgpu.resource,
      otherSize.resource,
      otherSource.resource,
    ]).size).toBe(4);

    webgl.release();
    webgpu.release();
    otherSize.release();
    otherSource.release();
    expect(dispose).toHaveBeenCalledTimes(4);
  });
});

describe('shared elevation texture variants', () => {
  it('separates WebGL and WebGPU textures for the same source identity', () => {
    const heights = new Float32Array([1, 2, 3, 4]);
    const webglTexture = new THREE.DataTexture();
    const webgpuTexture = new THREE.DataTexture();
    const webgl = acquireSharedElevationTexture(
      heights,
      2,
      'webgl-float32',
      () => webglTexture
    );
    const webgpu = acquireSharedElevationTexture(
      heights,
      2,
      'webgpu-float16',
      () => webgpuTexture
    );

    expect(webgl.resource).toBe(webglTexture);
    expect(webgpu.resource).toBe(webgpuTexture);
    expect(webgpu.resource).not.toBe(webgl.resource);

    webgl.release();
    webgpu.release();
  });
});
