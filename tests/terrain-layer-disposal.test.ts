import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

const state = vi.hoisted(() => ({
  quads: [] as Array<{
    disposeCalls: Array<{ disposeColorTexture?: boolean }>;
    elevationDisposals: number;
    albedoDisposals: number;
    albedoDisposalsByQuad: number;
  }>,
  failElevation: false,
}));

vi.mock('../src/scene.js', async () => {
  const THREE = await import('three');
  const scene = new THREE.Scene();
  return {
    getScene: () => scene,
    getRendererType: () => 'webgl',
    getOrigin: () => ({ lng: 0, lat: 0 }),
    geoToWorld: (lng: number, lat: number, alt: number) => ({ x: lng, y: alt, z: -lat }),
  };
});

vi.mock('../src/ground-texture/terrain-quad.js', async () => {
  const THREE = await import('three');

  class FakeTerrainQuad {
    readonly disposeCalls: Array<{ disposeColorTexture?: boolean }> = [];
    elevationDisposals = 0;
    albedoDisposals = 0;
    albedoDisposalsByQuad = 0;
    private readonly mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial()
    );
    private elevationOwned = false;
    private disposed = false;
    private albedo: InstanceType<typeof THREE.Texture> | null = null;

    constructor() {
      state.quads.push(this);
    }

    applyGPUDisplacement(): void {
      this.elevationOwned = true;
      if (state.failElevation) throw new Error('elevation setup failed');
    }

    async applyGPUDisplacementWebGPU(): Promise<void> {
      this.applyGPUDisplacement();
    }

    setTexture(texture: InstanceType<typeof THREE.Texture>): void {
      this.albedo = texture;
      texture.addEventListener('dispose', () => {
        this.albedoDisposals++;
      });
    }

    getMesh(): InstanceType<typeof THREE.Mesh> {
      return this.mesh;
    }

    dispose(options: { disposeColorTexture?: boolean } = {}): void {
      this.disposeCalls.push(options);
      if (this.disposed) return;
      this.disposed = true;
      if (this.elevationOwned) this.elevationDisposals++;
      if (options.disposeColorTexture !== false && this.albedo) {
        this.albedoDisposalsByQuad++;
        this.albedo.dispose();
      }
    }
  }

  return { TerrainQuad: FakeTerrainQuad };
});

vi.mock('../src/workers/index.js', () => ({
  getFullPipelineWorkerPool: () => ({
    renderTile: async () => ({ bitmap: { close: vi.fn() } }),
  }),
}));

vi.mock('../src/overture-sources.js', () => ({
  getOvertureCacheNamespace: () => 'test-sources',
  getOvertureSources: () => ({ base: 'base', transportation: 'transportation' }),
}));

vi.mock('../src/elevation.js', () => ({
  getElevationDataForTile: async () => ({
    heights: new Float32Array([1, 2, 3, 4]),
    bounds: { west: 0, east: 1, north: 1, south: 0 },
  }),
}));

vi.mock('../src/cache/indexed-db-texture-cache.js', () => ({
  getCachedTexture: vi.fn(),
  cacheTexture: vi.fn(),
  blobToImageBitmap: vi.fn(),
  isTextureCacheEnabled: () => false,
}));

vi.mock('../src/feature-picker.js', () => ({
  registerTileForLazyPicking: vi.fn(),
  unregisterTileForLazyPicking: vi.fn(),
}));

vi.mock('../src/semaphore.js', () => ({
  getTileSemaphore: () => null,
  TilePriority: { Z14_GROUND: 0, EXPANDED_TERRAIN: 1 },
}));

vi.mock('../src/profiling/tile-profiler.js', () => ({
  startTile: vi.fn(),
  endTile: vi.fn(),
  startPhase: vi.fn(),
  endPhase: vi.fn(),
  recordCacheHit: vi.fn(),
  recordCacheMiss: vi.fn(),
}));

import {
  clearAllGroundTiles,
  createGroundForTile,
  removeGroundGroup,
} from '../src/ground-texture/ground-layer.js';
import {
  clearAllExpandedTiles,
  createExpandedGroundForTile,
  removeExpandedTile,
} from '../src/ground-texture/expanded-ground-layer.js';

beforeEach(() => {
  clearAllGroundTiles();
  clearAllExpandedTiles();
  state.quads.length = 0;
  state.failElevation = false;
});

describe('terrain layer disposal paths', () => {
  it('removes a core tile without disposing its cache-owned albedo', async () => {
    const group = await createGroundForTile(10, 11, 14);
    const quad = state.quads[0];

    expect(group).not.toBeNull();
    removeGroundGroup(group!);
    removeGroundGroup(group!);

    expect(quad.disposeCalls).toEqual([{ disposeColorTexture: false }]);
    expect(quad.elevationDisposals).toBe(1);
    expect(quad.albedoDisposals).toBe(0);
    expect(quad.albedoDisposalsByQuad).toBe(0);
  });

  it('clears core tiles through the quad and lets the cache dispose albedo once', async () => {
    await createGroundForTile(20, 21, 14);
    await createGroundForTile(21, 21, 14);
    const quads = [...state.quads];

    clearAllGroundTiles();
    clearAllGroundTiles();

    for (const quad of quads) {
      expect(quad.disposeCalls).toEqual([{ disposeColorTexture: false }]);
      expect(quad.elevationDisposals).toBe(1);
      expect(quad.albedoDisposalsByQuad).toBe(0);
      expect(quad.albedoDisposals).toBe(1);
    }
  });

  it('preserves explicit uncached expanded albedo disposal on remove and clear', async () => {
    const first = await createExpandedGroundForTile(30, 31, 14);
    const firstQuad = state.quads[0];
    expect(first).not.toBeNull();

    removeExpandedTile(first!.name);
    removeExpandedTile(first!.name);
    expect(firstQuad.disposeCalls).toEqual([{ disposeColorTexture: false }]);
    expect(firstQuad.elevationDisposals).toBe(1);
    expect(firstQuad.albedoDisposalsByQuad).toBe(0);
    expect(firstQuad.albedoDisposals).toBe(1);

    await createExpandedGroundForTile(31, 31, 14);
    const secondQuad = state.quads[1];
    clearAllExpandedTiles();
    clearAllExpandedTiles();
    expect(secondQuad.disposeCalls).toEqual([{ disposeColorTexture: false }]);
    expect(secondQuad.elevationDisposals).toBe(1);
    expect(secondQuad.albedoDisposalsByQuad).toBe(0);
    expect(secondQuad.albedoDisposals).toBe(1);
  });

  it('releases quad and uncached albedo ownership when elevation setup fails', async () => {
    state.failElevation = true;
    const textureDispose = vi.spyOn(THREE.Texture.prototype, 'dispose');

    await expect(createExpandedGroundForTile(40, 41, 14)).rejects.toThrow(
      'elevation setup failed'
    );
    const quad = state.quads[0];

    expect(quad.disposeCalls).toEqual([{ disposeColorTexture: false }]);
    expect(quad.elevationDisposals).toBe(1);
    expect(quad.albedoDisposalsByQuad).toBe(0);
    expect(textureDispose).toHaveBeenCalledTimes(1);
    textureDispose.mockRestore();
  });

  it('releases a failed core quad while leaving its albedo cache-owned', async () => {
    state.failElevation = true;
    const textureDispose = vi.spyOn(THREE.Texture.prototype, 'dispose');

    await expect(createGroundForTile(50, 51, 14)).rejects.toThrow(
      'elevation setup failed'
    );
    const quad = state.quads[0];

    expect(quad.disposeCalls).toEqual([{ disposeColorTexture: false }]);
    expect(quad.elevationDisposals).toBe(1);
    expect(quad.albedoDisposalsByQuad).toBe(0);
    expect(textureDispose).not.toHaveBeenCalled();

    clearAllGroundTiles();
    expect(textureDispose).toHaveBeenCalledTimes(1);
    textureDispose.mockRestore();
  });
});
