/**
 * Building facade shader system
 *
 * Extends MeshStandardMaterial with:
 * - Texture atlas sampling for facade materials
 * - Procedural window pattern overlay
 * - Ground floor differentiation
 *
 * Uses onBeforeCompile pattern consistent with terrain-shader.ts
 */

import * as THREE from 'three';

/**
 * Configuration for building shader
 */
export interface BuildingShaderConfig {
  /** Atlas texture containing facade tiles */
  atlasTexture: THREE.Texture;
  /** Enable procedural windows overlay */
  enableWindows?: boolean;
  /** Window emission intensity (0-1) for lit windows effect */
  windowEmission?: number;
}

/**
 * Per-building uniforms (set via userData)
 */
export interface BuildingUniforms {
  /** Number of windows per floor (horizontal) */
  windowsPerFloor: number;
  /** Number of floors */
  numFloors: number;
  /** Ground floor height in normalized UV (0-1) */
  groundFloorRatio: number;
  /** Building height in meters */
  buildingHeight: number;
}

/**
 * GLSL code for fragment shader - atlas sampling and window overlay
 */
const fragmentShaderPars = /* glsl */ `
  uniform sampler2D uBuildingAtlas;
  uniform float uWindowEmission;
  uniform float uEnableWindows;

  // Simple procedural window pattern
  float windowPattern(vec2 uv, float windowsX, float floorsY, float groundFloorRatio) {
    // Skip ground floor area (could have different treatment)
    if (uv.y < groundFloorRatio) {
      return 0.0;
    }

    // Adjust UV to exclude ground floor
    float adjustedY = (uv.y - groundFloorRatio) / (1.0 - groundFloorRatio);

    // Calculate grid position
    float cellX = fract(uv.x * windowsX);
    float cellY = fract(adjustedY * floorsY);

    // Window dimensions within cell (centered)
    float windowLeft = 0.2;
    float windowRight = 0.8;
    float windowBottom = 0.25;
    float windowTop = 0.85;

    // Check if we're inside a window
    float inWindow = step(windowLeft, cellX) * step(cellX, windowRight) *
                     step(windowBottom, cellY) * step(cellY, windowTop);

    return inWindow;
  }
`;

/**
 * Fragment shader main code - samples atlas and applies windows
 */
const fragmentShaderMain = /* glsl */ `
  // Sample the atlas texture
  vec4 atlasColor = texture2D(uBuildingAtlas, vUv);

  // Blend atlas with diffuse color (vertex colors provide tint)
  diffuseColor.rgb = mix(diffuseColor.rgb, atlasColor.rgb, 0.7);

  // Apply procedural windows if enabled
  if (uEnableWindows > 0.5) {
    // Simple window pattern based on UV
    // Using fixed values for now - per-building values would need instancing
    float windowsX = 3.0;
    float floorsY = max(1.0, vUv.y * 10.0); // Approximate floors from UV
    float groundFloorRatio = 0.1;

    float windowMask = windowPattern(vUv, windowsX, floorsY, groundFloorRatio);

    // Darken windows
    vec3 windowColor = vec3(0.15, 0.18, 0.22);
    diffuseColor.rgb = mix(diffuseColor.rgb, windowColor, windowMask * 0.8);

    // Optional: Add window emission for lit windows effect
    // totalEmissiveRadiance += windowColor * windowMask * uWindowEmission * 0.3;
  }
`;

// Cached materials for different configurations
const materialCache = new Map<string, THREE.MeshStandardMaterial>();

/**
 * Create or get a building material with shader modifications
 *
 * @param config Shader configuration
 * @returns Material with building shader applied
 */
export function createBuildingMaterial(
  config: BuildingShaderConfig
): THREE.MeshStandardMaterial {
  const cacheKey = `building-${config.enableWindows ? 'windows' : 'nowin'}`;

  if (materialCache.has(cacheKey)) {
    const cached = materialCache.get(cacheKey)!;
    // Update atlas texture in case it changed
    if (cached.userData.atlasTexture !== config.atlasTexture) {
      cached.userData.atlasTexture = config.atlasTexture;
      cached.needsUpdate = true;
    }
    return cached;
  }

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.75,
    metalness: 0.1,
    // Enable texture for atlas
    map: config.atlasTexture,
  });

  // Store config in userData for later reference
  material.userData.atlasTexture = config.atlasTexture;

  applyBuildingShader(material, config);

  materialCache.set(cacheKey, material);
  return material;
}

/**
 * Apply building shader modifications to an existing material
 * Uses onBeforeCompile to inject custom fragment shader code
 */
export function applyBuildingShader(
  material: THREE.MeshStandardMaterial,
  config: BuildingShaderConfig
): void {
  // Store original onBeforeCompile if any
  const originalOnBeforeCompile = material.onBeforeCompile;

  material.onBeforeCompile = (shader) => {
    // Call original if exists
    if (originalOnBeforeCompile) {
      originalOnBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
    }

    // Add uniforms
    shader.uniforms.uBuildingAtlas = { value: config.atlasTexture };
    shader.uniforms.uWindowEmission = { value: config.windowEmission ?? 0.0 };
    shader.uniforms.uEnableWindows = { value: config.enableWindows ? 1.0 : 0.0 };

    // Inject fragment shader uniforms
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
${fragmentShaderPars}`
    );

    // Inject fragment shader main code after map_fragment
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
${fragmentShaderMain}`
    );
  };

  // Force shader recompilation
  material.needsUpdate = true;
}

/**
 * Create a simple building material without shader modifications
 * Used for LOD.LOW where we don't need textures
 */
export function createSimpleBuildingMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.75,
    metalness: 0.1,
  });
}

/**
 * Dispose cached materials
 * Call this when cleaning up the scene
 */
export function disposeBuildingMaterials(): void {
  for (const material of materialCache.values()) {
    material.dispose();
  }
  materialCache.clear();
}
