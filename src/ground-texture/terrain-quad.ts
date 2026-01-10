import * as THREE from 'three';
import type { TileBounds } from './types.js';
import { geoToWorld } from '../scene.js';
import { GROUND_TEXTURE, ELEVATION } from '../constants.js';
import { applyTerrainShader, createElevationDataTexture } from './terrain-shader.js';
import { disposeTexture } from '../renderer/texture-disposal.js';

// Type for material - can be standard or node-based
type TerrainMaterialType = 'standard' | 'node';

/**
 * Creates a terrain-following quad mesh for rendering ground textures
 */
export class TerrainQuad {
  private geometry: THREE.PlaneGeometry;
  private material: THREE.Material;
  private mesh: THREE.Mesh;
  private overlap: number;
  private originalWidth: number;
  private originalHeight: number;
  private elevationTexture: THREE.DataTexture | null = null;
  private materialType: TerrainMaterialType = 'standard';
  private setColorTextureCallback: ((texture: THREE.Texture) => void) | null = null;

  constructor(bounds: TileBounds, segments: number = GROUND_TEXTURE.TERRAIN_QUAD_SEGMENTS) {
    // Calculate world dimensions
    const nw = geoToWorld(bounds.west, bounds.north, 0);
    const se = geoToWorld(bounds.east, bounds.south, 0);

    const width = se.x - nw.x;
    const height = se.z - nw.z; // Note: z increases going south

    // Store original dimensions for UV calculation
    this.originalWidth = Math.abs(width);
    this.originalHeight = Math.abs(height);

    // Add small overlap (2 meters) to prevent gaps between tiles
    this.overlap = 2.0;

    // Create subdivided plane with overlap
    this.geometry = new THREE.PlaneGeometry(
      this.originalWidth + this.overlap * 2,
      this.originalHeight + this.overlap * 2,
      segments,
      segments
    );

    // Rotate to lie flat on XZ plane (Y-up)
    this.geometry.rotateX(-Math.PI / 2);

    // Position at tile center
    const centerX = (nw.x + se.x) / 2;
    const centerZ = (nw.z + se.z) / 2;

    // Create material
    this.material = new THREE.MeshStandardMaterial({
      roughness: 0.9,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });

    // Create mesh
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.position.set(centerX, 0, centerZ);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;

    // Adjust UV mapping for overlap
    this.setupUVs();
  }

  /**
   * Set up UV coordinates for the quad
   * Adjusts UVs so the texture maps to the original tile bounds,
   * with overlap region using clamped edge pixels
   */
  private setupUVs(): void {
    const uvs = this.geometry.attributes.uv;
    const expandedWidth = this.originalWidth + this.overlap * 2;
    const expandedHeight = this.originalHeight + this.overlap * 2;

    // Calculate UV offset and scale to map original bounds to 0-1
    // Overlap areas will have UVs slightly outside 0-1, clamped to edge pixels
    const uScale = expandedWidth / this.originalWidth;
    const vScale = expandedHeight / this.originalHeight;
    const uOffset = this.overlap / this.originalWidth;
    const vOffset = this.overlap / this.originalHeight;

    for (let i = 0; i < uvs.count; i++) {
      const u = uvs.getX(i);
      const v = uvs.getY(i);
      // Flip V coordinate: After rotateX(-PI/2), geometry UV V=0 ends up at south,
      // but texture has V=0 at north. Flipping V aligns them correctly.
      const flippedV = 1 - v;
      // Remap: original 0-1 spans the expanded geometry
      // We want the center (original tile) to map to 0-1
      uvs.setXY(i, u * uScale - uOffset, flippedV * vScale - vOffset);
    }
    uvs.needsUpdate = true;
  }

  /**
   * Apply GPU-based terrain displacement using vertex shader
   * @param heights Elevation data as Float32Array (from elevation tile)
   * @param textureSize Size of the elevation texture (e.g., 256)
   * @param elevationBounds Bounds of the elevation tile (Z12) - NOT the ground tile
   * @param verticalExaggeration Multiplier for elevation values
   */
  applyGPUDisplacement(
    heights: Float32Array,
    textureSize: number,
    elevationBounds: TileBounds,
    verticalExaggeration: number = ELEVATION.VERTICAL_EXAGGERATION
  ): void {
    // Create elevation texture from height data
    this.elevationTexture = createElevationDataTexture(heights, textureSize);

    // Calculate elevation tile's world position and dimensions
    // The elevation tile (Z12) covers a larger area than the ground tile (Z14)
    const elevNW = geoToWorld(elevationBounds.west, elevationBounds.north, 0);
    const elevSE = geoToWorld(elevationBounds.east, elevationBounds.south, 0);
    const elevCenterX = (elevNW.x + elevSE.x) / 2;
    const elevCenterZ = (elevNW.z + elevSE.z) / 2;
    const elevWidth = Math.abs(elevSE.x - elevNW.x);
    const elevHeight = Math.abs(elevSE.z - elevNW.z);

    // Apply terrain shader to material (WebGL path uses onBeforeCompile)
    applyTerrainShader(this.material as THREE.MeshStandardMaterial, {
      elevationTexture: this.elevationTexture,
      verticalExaggeration,
      bounds: elevationBounds,
      tileCenter: new THREE.Vector3(elevCenterX, 0, elevCenterZ),
      tileDimensions: {
        width: elevWidth,
        height: elevHeight,
      },
    });

    // Expand bounding sphere to account for GPU displacement
    // Without this, Three.js frustum culling uses the flat plane bounds
    // and incorrectly culls tiles when camera is close or turning
    this.expandBoundingSphere(heights, verticalExaggeration);
  }

  /**
   * Apply GPU-based terrain displacement using TSL nodes (WebGPU path)
   * This is an async method because it dynamically imports TSL modules
   *
   * @param heights Elevation data as Float32Array (from elevation tile)
   * @param textureSize Size of the elevation texture (e.g., 256)
   * @param elevationBounds Bounds of the elevation tile (Z12) - NOT the ground tile
   * @param verticalExaggeration Multiplier for elevation values
   */
  async applyGPUDisplacementWebGPU(
    heights: Float32Array,
    textureSize: number,
    elevationBounds: TileBounds,
    verticalExaggeration: number = ELEVATION.VERTICAL_EXAGGERATION
  ): Promise<void> {
    // Dynamically import TSL terrain shader to avoid bundling in WebGL build
    const { createTSLTerrainMaterial, createElevationDataTextureWebGPU } = await import('./terrain-shader-tsl.js');

    // Create elevation texture using HalfFloatType for wider WebGPU compatibility
    this.elevationTexture = createElevationDataTextureWebGPU(heights, textureSize);

    // Calculate elevation tile's world position and dimensions
    const elevNW = geoToWorld(elevationBounds.west, elevationBounds.north, 0);
    const elevSE = geoToWorld(elevationBounds.east, elevationBounds.south, 0);
    const elevCenterX = (elevNW.x + elevSE.x) / 2;
    const elevCenterZ = (elevNW.z + elevSE.z) / 2;
    const elevWidth = Math.abs(elevSE.x - elevNW.x);
    const elevHeight = Math.abs(elevSE.z - elevNW.z);

    // Get existing color texture if any
    const existingColorTexture = (this.material as THREE.MeshStandardMaterial).map ?? undefined;

    // Create TSL terrain material
    const { material: newMaterial, setColorTexture } = await createTSLTerrainMaterial({
      elevationTexture: this.elevationTexture,
      verticalExaggeration,
      tileCenter: new THREE.Vector3(elevCenterX, 0, elevCenterZ),
      tileDimensions: {
        width: elevWidth,
        height: elevHeight,
      },
      colorTexture: existingColorTexture,
    });

    // Dispose old material and replace
    this.material.dispose();
    this.material = newMaterial;
    this.mesh.material = newMaterial;
    this.materialType = 'node';
    this.setColorTextureCallback = setColorTexture;

    // Expand bounding sphere to account for GPU displacement
    this.expandBoundingSphere(heights, verticalExaggeration);
  }

  /**
   * Expand bounding sphere to account for GPU vertex displacement
   * This prevents incorrect frustum culling when terrain is displaced
   */
  private expandBoundingSphere(heights: Float32Array, verticalExaggeration: number): void {
    // Find min/max elevation (cannot use Math.max(...heights) - 65k items would overflow call stack)
    let minElevation = Infinity;
    let maxElevation = -Infinity;
    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];
      if (h < minElevation) minElevation = h;
      if (h > maxElevation) maxElevation = h;
    }
    minElevation *= verticalExaggeration;
    maxElevation *= verticalExaggeration;

    // Compute bounding sphere if not already done
    this.geometry.computeBoundingSphere();

    if (this.geometry.boundingSphere) {
      // Lift sphere center to middle of elevation range for tighter culling
      const elevationMid = (minElevation + maxElevation) / 2;
      const elevationRange = Math.max(
        Math.abs(minElevation - elevationMid),
        Math.abs(maxElevation - elevationMid)
      );

      this.geometry.boundingSphere.center.y = elevationMid;

      // Expand sphere radius to include full elevation range
      const originalRadius = this.geometry.boundingSphere.radius;
      this.geometry.boundingSphere.radius = Math.sqrt(
        originalRadius * originalRadius + elevationRange * elevationRange
      );
    }
  }

  /**
   * Set the ground color texture
   * Handles both WebGL (MeshStandardMaterial.map) and WebGPU (colorNode) paths
   */
  setTexture(texture: THREE.CanvasTexture): void {
    if (this.materialType === 'node' && this.setColorTextureCallback) {
      // WebGPU path: use colorNode via callback
      this.setColorTextureCallback(texture);
    } else {
      // WebGL path: use standard material .map property
      (this.material as THREE.MeshStandardMaterial).map = texture;
      this.material.needsUpdate = true;
    }
  }

  /**
   * Get the Three.js mesh
   */
  getMesh(): THREE.Mesh {
    return this.mesh;
  }

  /**
   * Get the geometry
   */
  getGeometry(): THREE.PlaneGeometry {
    return this.geometry;
  }

  /**
   * Get the material
   */
  getMaterial(): THREE.Material {
    return this.material;
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();

    // Dispose color texture if present (WebGL path only - node materials handle this differently)
    if (this.materialType === 'standard') {
      const stdMaterial = this.material as THREE.MeshStandardMaterial;
      if (stdMaterial.map) {
        // Use deferred disposal for WebGPU compatibility
        disposeTexture(stdMaterial.map);
      }
    }

    if (this.elevationTexture) {
      // Use deferred disposal for WebGPU compatibility
      disposeTexture(this.elevationTexture);
      this.elevationTexture = null;
    }

    // Clear callback reference
    this.setColorTextureCallback = null;
  }
}
