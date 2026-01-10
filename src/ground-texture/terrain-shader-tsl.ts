/**
 * TSL (Three.js Shading Language) terrain displacement for WebGPU
 *
 * Provides GPU terrain displacement using node-based materials
 * compatible with WebGPURenderer.
 *
 * This module is dynamically imported only when WebGPU is active
 * to avoid bundling WebGPU code in the WebGL build.
 */

import * as THREE from 'three';

// WebGPU module types (dynamically imported)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSLModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WebGPUModule = any;

// Cached module references
let tslModule: TSLModule | null = null;
let webgpuModule: WebGPUModule | null = null;

/**
 * Load TSL module for node shader functions
 */
async function loadTSL(): Promise<TSLModule> {
  if (!tslModule) {
    tslModule = await import('three/tsl');
  }
  return tslModule;
}

/**
 * Get cached TSL module (must call loadTSL first)
 */
export function getTSLModule(): TSLModule {
  if (!tslModule) {
    throw new Error('TSL module not loaded. Call loadTSL() first.');
  }
  return tslModule;
}

/**
 * Load WebGPU module for node materials
 */
async function loadWebGPU(): Promise<WebGPUModule> {
  if (!webgpuModule) {
    webgpuModule = await import('three/webgpu');
  }
  return webgpuModule;
}

/**
 * Configuration for TSL terrain material
 */
export interface TSLTerrainConfig {
  /** Elevation data texture (Float32 or HalfFloat, single channel) */
  elevationTexture: THREE.DataTexture;
  /** Vertical exaggeration factor */
  verticalExaggeration: number;
  /** World position of elevation tile center */
  tileCenter: THREE.Vector3;
  /** Dimensions of the elevation tile in world units */
  tileDimensions: {
    width: number;
    height: number;
  };
  /** Optional color texture to apply */
  colorTexture?: THREE.Texture;
}

/**
 * Result of creating a TSL terrain material
 */
export interface TSLTerrainMaterialResult {
  material: THREE.Material;
  /** Method to update the color texture after material creation */
  setColorTexture: (texture: THREE.Texture) => void;
}

/**
 * Create a WebGPU-compatible terrain material with elevation displacement
 *
 * Uses MeshStandardNodeMaterial for full PBR support including:
 * - Vertex position displacement based on elevation texture
 * - Terrain normals computed from elevation gradient
 * - Standard material properties (roughness, metalness, shadows)
 */
export async function createTSLTerrainMaterial(
  config: TSLTerrainConfig
): Promise<TSLTerrainMaterialResult> {
  // Load both modules - TSL for node functions, WebGPU for material classes
  const TSL = await loadTSL();
  const { MeshStandardNodeMaterial } = await loadWebGPU();

  // Create uniform nodes for elevation sampling
  const elevationMapUniform = TSL.texture(config.elevationTexture);
  const vertExaggerationUniform = TSL.uniform(config.verticalExaggeration);
  const tileCenterUniform = TSL.uniform(
    new THREE.Vector2(config.tileCenter.x, config.tileCenter.z)
  );
  const tileDimensionsUniform = TSL.uniform(
    new THREE.Vector2(config.tileDimensions.width, config.tileDimensions.height)
  );

  // Calculate texel size for normal computation (1 texel in world units)
  const texelSizeUniform = TSL.uniform(
    Math.max(config.tileDimensions.width, config.tileDimensions.height) / 256.0
  );

  // Helper function: Convert world position to normalized tile UV coordinates
  const worldToTileUV = TSL.Fn(([worldPos2]: [any]) => {
    const localPos = worldPos2.sub(tileCenterUniform);
    const normalizedPos = localPos.div(tileDimensionsUniform).add(0.5);
    // Clamp to valid texture range (ClampToEdgeWrapping handles edge pixels)
    return TSL.clamp(normalizedPos, 0.0, 1.0);
  });

  // Helper function: Sample elevation at a world position
  const sampleElevation = TSL.Fn(([worldPos2]: [any]) => {
    const uv = worldToTileUV(worldPos2);
    // Sample red channel of elevation texture
    const elevation = elevationMapUniform.uv(uv).r;
    return elevation.mul(vertExaggerationUniform);
  });

  // Helper function: Compute terrain normal from elevation gradient using finite differences
  const computeTerrainNormal = TSL.Fn(([worldPos2]: [any]) => {
    // Sample neighboring elevations
    const hL = sampleElevation(worldPos2.add(TSL.vec2(texelSizeUniform.negate(), 0.0)));
    const hR = sampleElevation(worldPos2.add(TSL.vec2(texelSizeUniform, 0.0)));
    const hD = sampleElevation(worldPos2.add(TSL.vec2(0.0, texelSizeUniform.negate())));
    const hU = sampleElevation(worldPos2.add(TSL.vec2(0.0, texelSizeUniform)));

    // Compute gradient (change in elevation per world unit)
    const dX = hR.sub(hL).div(texelSizeUniform.mul(2.0));
    const dZ = hU.sub(hD).div(texelSizeUniform.mul(2.0));

    // Normal from gradient (Y-up coordinate system)
    // The normal points in the direction perpendicular to the surface
    return TSL.normalize(TSL.vec3(dX.negate(), 1.0, dZ.negate()));
  });

  // Position node: Displaces vertex Y based on sampled elevation
  const positionNode = TSL.Fn(() => {
    const pos = TSL.positionLocal;

    // Transform to world space to get world coordinates for elevation sampling
    const worldPos = TSL.modelWorldMatrix.mul(TSL.vec4(pos, 1.0));
    const worldPos2 = TSL.vec2(worldPos.x, worldPos.z);

    // Sample elevation at this world position
    const elevation = sampleElevation(worldPos2);

    // Return displaced position (only Y changes)
    return TSL.vec3(pos.x, elevation, pos.z);
  })();

  // Normal node: Computes terrain normal from elevation gradient
  // CRITICAL: Without this, lighting will be broken on displaced terrain
  const normalNode = TSL.Fn(() => {
    const pos = TSL.positionLocal;

    // Transform to world space
    const worldPos = TSL.modelWorldMatrix.mul(TSL.vec4(pos, 1.0));
    const worldPos2 = TSL.vec2(worldPos.x, worldPos.z);

    // Compute terrain normal from elevation gradient
    return computeTerrainNormal(worldPos2);
  })();

  // Create MeshStandardNodeMaterial with displacement
  const material = new MeshStandardNodeMaterial();
  material.positionNode = positionNode;
  material.normalNode = normalNode;
  material.roughness = 0.9;
  material.metalness = 0.0;
  material.side = THREE.DoubleSide;

  // Apply color texture if provided
  let colorTextureNode: any = null;
  if (config.colorTexture) {
    colorTextureNode = TSL.texture(config.colorTexture);
    material.colorNode = colorTextureNode;
  }

  // Method to update color texture after material creation
  const setColorTexture = (texture: THREE.Texture) => {
    colorTextureNode = TSL.texture(texture);
    material.colorNode = colorTextureNode;
    material.needsUpdate = true;
  };

  return {
    material,
    setColorTexture,
  };
}

/**
 * Create elevation DataTexture from height data for WebGPU
 *
 * Uses HalfFloatType for wider WebGPU device compatibility.
 * Float32 with linear filtering requires the 'float32-filterable' feature
 * which is not universally supported.
 */
export function createElevationDataTextureWebGPU(
  heights: Float32Array,
  size: number
): THREE.DataTexture {
  // Convert Float32 to Float16 for wider WebGPU compatibility
  // HalfFloatType is universally supported with linear filtering
  const float16Data = new Uint16Array(heights.length);
  for (let i = 0; i < heights.length; i++) {
    float16Data[i] = toHalf(heights[i]);
  }

  const texture = new THREE.DataTexture(
    float16Data,
    size,
    size,
    THREE.RedFormat,
    THREE.HalfFloatType
  );

  // Configure for shader sampling
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  return texture;
}

/**
 * Convert a 32-bit float to a 16-bit float (half precision)
 * IEEE 754 half-precision format
 */
function toHalf(value: number): number {
  const floatView = new Float32Array(1);
  const int32View = new Int32Array(floatView.buffer);

  floatView[0] = value;
  const x = int32View[0];

  // Extract components
  const sign = (x >> 31) & 0x1;
  let exponent = (x >> 23) & 0xff;
  let mantissa = x & 0x7fffff;

  // Handle special cases
  if (exponent === 0xff) {
    // Inf or NaN
    return (sign << 15) | 0x7c00 | (mantissa ? 0x200 : 0);
  }

  if (exponent === 0) {
    // Zero or denormalized
    return sign << 15;
  }

  // Rebias exponent from float32 (bias 127) to float16 (bias 15)
  exponent = exponent - 127 + 15;

  if (exponent >= 31) {
    // Overflow to infinity
    return (sign << 15) | 0x7c00;
  }

  if (exponent <= 0) {
    // Underflow to zero
    return sign << 15;
  }

  // Normal number
  mantissa = mantissa >> 13;
  return (sign << 15) | (exponent << 10) | mantissa;
}
