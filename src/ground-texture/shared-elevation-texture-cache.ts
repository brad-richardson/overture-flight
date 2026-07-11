import type * as THREE from 'three';
import { disposeTexture } from '../renderer/texture-disposal.js';

export interface RefCountedResourceLease<Resource> {
  readonly resource: Resource;
  /** Idempotently release this owner's reference. */
  release(): void;
}

interface CacheEntry<Resource> {
  readonly resource: Resource;
  refCount: number;
}

/**
 * Ref-count resources by source object identity plus an exact variant key.
 * Entries are removed before disposal, so a reacquire cannot return a resource
 * that has already entered a deferred-disposal queue.
 */
export class RefCountedIdentityCache<Source extends object, Resource> {
  private readonly entries = new WeakMap<Source, Map<string, CacheEntry<Resource>>>();

  constructor(private readonly disposeResource: (resource: Resource) => void) {}

  acquire(
    source: Source,
    variant: string,
    createResource: () => Resource
  ): RefCountedResourceLease<Resource> {
    let variants = this.entries.get(source);
    let entry = variants?.get(variant);

    if (!entry) {
      // Create before mutating the cache so a failed build leaves no entry.
      const resource = createResource();
      entry = { resource, refCount: 0 };
      if (!variants) {
        variants = new Map();
        this.entries.set(source, variants);
      }
      variants.set(variant, entry);
    }

    entry.refCount++;
    let released = false;

    return {
      resource: entry.resource,
      release: () => {
        if (released) return;
        released = true;

        entry.refCount--;
        if (entry.refCount !== 0) return;

        // Remove first: deferred disposal cannot race with a new acquisition.
        if (variants!.get(variant) === entry) {
          variants!.delete(variant);
          if (variants!.size === 0) {
            this.entries.delete(source);
          }
        }
        this.disposeResource(entry.resource);
      },
    };
  }
}

export type ElevationTextureBackend = 'webgl-float32' | 'webgpu-float16';
export type ElevationTextureLease = RefCountedResourceLease<THREE.DataTexture>;

const sharedElevationTextures = new RefCountedIdentityCache<Float32Array, THREE.DataTexture>(
  disposeTexture
);

/**
 * Acquire an immutable elevation texture shared by quads using the exact same
 * elevation source view. Backend names encode the fixed data format; size is
 * included because it changes texture interpretation and upload dimensions.
 */
export function acquireSharedElevationTexture(
  heights: Float32Array,
  size: number,
  backend: ElevationTextureBackend,
  createTexture: () => THREE.DataTexture
): ElevationTextureLease {
  const variant = `${backend}:red:linear:clamp:size-${size}`;
  return sharedElevationTextures.acquire(heights, variant, createTexture);
}
