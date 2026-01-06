/**
 * GPU-based terrain displacement shader
 *
 * Uses onBeforeCompile to inject custom vertex displacement into MeshStandardMaterial.
 * This preserves all standard material features (stencil, lighting, PBR) while
 * moving elevation displacement to the GPU.
 *
 * Benefits:
 * - No CPU vertex loop (was ~256+ iterations per tile)
 * - No CPU normal computation
 * - Displacement computed per-fragment for smoother terrain
 * - Normals computed from elevation gradient for proper lighting
 */

import * as THREE from 'three';

/**
 * Configuration for GPU terrain displacement
 */
export interface TerrainShaderConfig {
  /** Elevation data texture (Float32, single channel) */
  elevationTexture: THREE.DataTexture;
  /** Vertical exaggeration factor */
  verticalExaggeration: number;
  /** Tile bounds for UV mapping */
  bounds: {
    west: number;
    east: number;
    north: number;
    south: number;
  };
  /** World position of tile center */
  tileCenter: THREE.Vector3;
  /** Original tile dimensions (without overlap) */
  tileDimensions: {
    width: number;
    height: number;
  };
}

/**
 * GLSL code for vertex displacement
 * Samples elevation texture and displaces vertex position
 */
const vertexDisplacementPars = /* glsl */ `
  uniform sampler2D uElevationMap;
  uniform float uVerticalExaggeration;
  uniform vec4 uTileBounds; // west, east, north, south
  uniform vec2 uTileCenter;
  uniform vec2 uTileDimensions;

  // Sample elevation from texture
  float sampleElevation(vec2 worldPos) {
    // Convert world position to normalized tile coordinates (0-1)
    // Account for tile center offset
    vec2 localPos = worldPos - uTileCenter;
    vec2 normalizedPos = (localPos / uTileDimensions) + 0.5;

    // Clamp to prevent edge artifacts
    normalizedPos = clamp(normalizedPos, 0.001, 0.999);

    // Sample elevation
    float elevation = texture2D(uElevationMap, normalizedPos).r;
    return elevation * uVerticalExaggeration;
  }

  // Compute normal from elevation gradient
  vec3 computeTerrainNormal(vec2 worldPos, float elevation) {
    // Sample neighbors for gradient
    float texelSize = 1.0 / 256.0 * max(uTileDimensions.x, uTileDimensions.y);
    float hL = sampleElevation(worldPos + vec2(-texelSize, 0.0));
    float hR = sampleElevation(worldPos + vec2(texelSize, 0.0));
    float hD = sampleElevation(worldPos + vec2(0.0, -texelSize));
    float hU = sampleElevation(worldPos + vec2(0.0, texelSize));

    // Compute gradient
    float dX = (hR - hL) / (2.0 * texelSize);
    float dZ = (hU - hD) / (2.0 * texelSize);

    // Normal from gradient (Y-up coordinate system)
    vec3 normal = normalize(vec3(-dX, 1.0, -dZ));
    return normal;
  }
`;

const vertexDisplacementMain = /* glsl */ `
  // Get world position for elevation sampling
  vec3 worldPos3 = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vec2 worldPos2 = vec2(worldPos3.x, worldPos3.z);

  // Sample elevation and displace
  float elevation = sampleElevation(worldPos2);
  transformed.y = elevation;

  // Compute terrain normal
  objectNormal = computeTerrainNormal(worldPos2, elevation);
`;

/**
 * Apply GPU terrain displacement to a MeshStandardMaterial
 * Uses onBeforeCompile to inject custom vertex shader code
 */
export function applyTerrainShader(
  material: THREE.MeshStandardMaterial,
  config: TerrainShaderConfig
): void {
  // Store original onBeforeCompile if any
  const originalOnBeforeCompile = material.onBeforeCompile;

  material.onBeforeCompile = (shader) => {
    // Call original if exists
    if (originalOnBeforeCompile) {
      originalOnBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
    }

    // Add uniforms
    shader.uniforms.uElevationMap = { value: config.elevationTexture };
    shader.uniforms.uVerticalExaggeration = { value: config.verticalExaggeration };
    shader.uniforms.uTileBounds = {
      value: new THREE.Vector4(
        config.bounds.west,
        config.bounds.east,
        config.bounds.north,
        config.bounds.south
      )
    };
    shader.uniforms.uTileCenter = {
      value: new THREE.Vector2(config.tileCenter.x, config.tileCenter.z)
    };
    shader.uniforms.uTileDimensions = {
      value: new THREE.Vector2(config.tileDimensions.width, config.tileDimensions.height)
    };

    // Inject vertex shader code
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
${vertexDisplacementPars}`
    );

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
${vertexDisplacementMain}`
    );
  };

  // Force shader recompilation
  material.needsUpdate = true;
}

/**
 * Create elevation DataTexture from height data
 * Optimized for GPU shader sampling
 */
export function createElevationDataTexture(
  heights: Float32Array,
  size: number
): THREE.DataTexture {
  // Create texture directly from height data
  const texture = new THREE.DataTexture(
    heights,
    size,
    size,
    THREE.RedFormat,
    THREE.FloatType
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
 * Update elevation texture data (e.g., when elevation tile loads)
 */
export function updateElevationTexture(
  texture: THREE.DataTexture,
  heights: Float32Array
): void {
  texture.image.data = heights;
  texture.needsUpdate = true;
}
