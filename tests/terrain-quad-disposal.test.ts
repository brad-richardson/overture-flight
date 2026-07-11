import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { TerrainQuad } from '../src/ground-texture/terrain-quad.js';
import {
  isDeferredDisposalEnabled,
  setDeferredDisposal,
} from '../src/renderer/texture-disposal.js';

const bounds = {
  west: 11.25,
  east: 11.26,
  north: 43.78,
  south: 43.77,
};

describe('TerrainQuad disposal ownership', () => {
  it('shares elevation and disposes it after the last quad while preserving albedo', () => {
    const heights = new Float32Array([1, 2, 3, 4]);
    const firstQuad = new TerrainQuad(bounds, 1);
    const secondQuad = new TerrainQuad(bounds, 1);
    firstQuad.applyGPUDisplacement(heights, 2, bounds);
    secondQuad.applyGPUDisplacement(heights, 2, bounds);

    const firstElevationTexture = (
      firstQuad as unknown as { elevationTextureLease: { resource: THREE.DataTexture } }
    ).elevationTextureLease.resource;
    const secondElevationTexture = (
      secondQuad as unknown as { elevationTextureLease: { resource: THREE.DataTexture } }
    ).elevationTextureLease.resource;
    const albedo = new THREE.Texture() as THREE.CanvasTexture;
    const elevationDispose = vi.spyOn(firstElevationTexture, 'dispose');
    const albedoDispose = vi.spyOn(albedo, 'dispose');

    expect(secondElevationTexture).toBe(firstElevationTexture);
    firstQuad.setTexture(albedo);
    firstQuad.dispose({ disposeColorTexture: false });
    firstQuad.dispose({ disposeColorTexture: false });

    expect(elevationDispose).not.toHaveBeenCalled();

    secondQuad.dispose({ disposeColorTexture: false });
    secondQuad.dispose({ disposeColorTexture: false });

    expect(elevationDispose).toHaveBeenCalledTimes(1);
    expect(albedoDispose).not.toHaveBeenCalled();
    expect((firstQuad.getMaterial() as THREE.MeshStandardMaterial).map).toBeNull();
  });

  it('replaces WebGL terrain injection and releases the retired elevation lease', () => {
    const previousDeferredDisposal = isDeferredDisposalEnabled();
    setDeferredDisposal(false);
    const quad = new TerrainQuad(bounds, 1);
    try {
      const material = quad.getMaterial() as THREE.MeshStandardMaterial;
      const originalOnBeforeCompile = material.onBeforeCompile;
      const firstHeights = new Float32Array([1, 2, 3, 4]);
      const secondHeights = new Float32Array([5, 6, 7, 8]);

      quad.applyGPUDisplacement(firstHeights, 2, bounds);
      const firstTexture = (
        quad as unknown as { elevationTextureLease: { resource: THREE.DataTexture } }
      ).elevationTextureLease.resource;
      const firstDispose = vi.spyOn(firstTexture, 'dispose');

      quad.applyGPUDisplacement(secondHeights, 2, bounds);
      const secondTexture = (
        quad as unknown as { elevationTextureLease: { resource: THREE.DataTexture } }
      ).elevationTextureLease.resource;
      const secondDispose = vi.spyOn(secondTexture, 'dispose');

      expect(secondTexture).not.toBe(firstTexture);
      expect(firstDispose).toHaveBeenCalledTimes(1);
      expect(secondDispose).not.toHaveBeenCalled();

      const shader = {
        uniforms: {},
        vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
      } as unknown as THREE.WebGLProgramParametersWithUniforms;
      material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);

      expect(shader.vertexShader.match(/uniform sampler2D uElevationMap;/g)).toHaveLength(1);
      expect(shader.vertexShader.match(/float sampleElevation\(/g)).toHaveLength(1);
      expect(shader.uniforms.uElevationMap.value).toBe(secondTexture);

      quad.dispose({ disposeColorTexture: false });

      expect(secondDispose).toHaveBeenCalledTimes(1);
      expect(material.onBeforeCompile).toBe(originalOnBeforeCompile);
    } finally {
      quad.dispose({ disposeColorTexture: false });
      setDeferredDisposal(previousDeferredDisposal);
    }
  });

  it('disposes node-material albedo exactly once and clears its reference', () => {
    const quad = new TerrainQuad(bounds, 1);
    const albedo = new THREE.Texture() as THREE.CanvasTexture;
    const albedoDispose = vi.spyOn(albedo, 'dispose');
    const setColorTexture = vi.fn<(texture: THREE.Texture | null) => void>();
    const internalQuad = quad as unknown as {
      materialType: 'node';
      setColorTextureCallback: (texture: THREE.Texture | null) => void;
      colorTexture: THREE.Texture | null;
    };
    internalQuad.materialType = 'node';
    internalQuad.setColorTextureCallback = setColorTexture;

    quad.setTexture(albedo);
    quad.dispose();
    quad.dispose();

    expect(setColorTexture).toHaveBeenNthCalledWith(1, albedo);
    expect(setColorTexture).toHaveBeenNthCalledWith(2, null);
    expect(setColorTexture).toHaveBeenCalledTimes(2);
    expect(albedoDispose).toHaveBeenCalledTimes(1);
    expect(internalQuad.colorTexture).toBeNull();
  });

  it('clears a node-material reference without disposing cache-owned albedo', () => {
    const quad = new TerrainQuad(bounds, 1);
    const albedo = new THREE.Texture() as THREE.CanvasTexture;
    const albedoDispose = vi.spyOn(albedo, 'dispose');
    const setColorTexture = vi.fn<(texture: THREE.Texture | null) => void>();
    const internalQuad = quad as unknown as {
      materialType: 'node';
      setColorTextureCallback: (texture: THREE.Texture | null) => void;
      colorTexture: THREE.Texture | null;
    };
    internalQuad.materialType = 'node';
    internalQuad.setColorTextureCallback = setColorTexture;

    quad.setTexture(albedo);
    quad.dispose({ disposeColorTexture: false });

    expect(setColorTexture).toHaveBeenLastCalledWith(null);
    expect(albedoDispose).not.toHaveBeenCalled();
    expect(internalQuad.colorTexture).toBeNull();
  });
});
