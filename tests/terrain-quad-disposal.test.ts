import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { TerrainQuad } from '../src/ground-texture/terrain-quad.js';

const bounds = {
  west: 11.25,
  east: 11.26,
  north: 43.78,
  south: 43.77,
};

describe('TerrainQuad disposal ownership', () => {
  it('disposes elevation exactly once while preserving cache-owned albedo', () => {
    const quad = new TerrainQuad(bounds, 1);
    quad.applyGPUDisplacement(new Float32Array([1, 2, 3, 4]), 2, bounds);

    const elevationTexture = (
      quad as unknown as { elevationTexture: THREE.DataTexture }
    ).elevationTexture;
    const albedo = new THREE.Texture() as THREE.CanvasTexture;
    const elevationDispose = vi.spyOn(elevationTexture, 'dispose');
    const albedoDispose = vi.spyOn(albedo, 'dispose');

    quad.setTexture(albedo);
    quad.dispose({ disposeColorTexture: false });
    quad.dispose({ disposeColorTexture: false });

    expect(elevationDispose).toHaveBeenCalledTimes(1);
    expect(albedoDispose).not.toHaveBeenCalled();
    expect((quad.getMaterial() as THREE.MeshStandardMaterial).map).toBeNull();
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
