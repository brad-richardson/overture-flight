import * as THREE from 'three';
import type { TileBounds } from './types.js';
import { geoToWorld, worldToGeo } from '../scene.js';
import { GROUND_TEXTURE, ELEVATION } from '../constants.js';
import { applyTerrainShader, createElevationDataTexture } from './terrain-shader.js';
import { disposeTexture } from '../renderer/texture-disposal.js';

// Spike detection: vertex must deviate more than this multiple of neighbor standard deviation
// Higher values = less aggressive smoothing, preserves more terrain features
const SPIKE_STDDEV_MULTIPLIER = 3.0;

// Minimum absolute deviation to consider as spike (meters) - prevents smoothing small variations
const SPIKE_MIN_DEVIATION_METERS = 30;

/**
 * Creates a terrain-following quad mesh for rendering ground textures
 */
export class TerrainQuad {
  private geometry: THREE.PlaneGeometry;
  private material: THREE.MeshStandardMaterial;
  private mesh: THREE.Mesh;
  private overlap: number;
  private originalWidth: number;
  private originalHeight: number;
  private elevationTexture: THREE.DataTexture | null = null;

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
   * Apply terrain elevation to vertices with spike detection and smoothing
   * @param getHeight Function that returns terrain height for a given lng/lat
   * @param verticalExaggeration Multiplier for elevation values
   */
  updateElevation(
    getHeight: (lng: number, lat: number) => number,
    verticalExaggeration: number = ELEVATION.VERTICAL_EXAGGERATION
  ): void {
    const positions = this.geometry.attributes.position;
    const meshPosition = this.mesh.position;

    // First pass: collect all heights into an array
    const heights: number[] = new Array(positions.count);

    for (let i = 0; i < positions.count; i++) {
      // Get vertex position in world space
      const localX = positions.getX(i);
      const localZ = positions.getZ(i);

      const worldX = localX + meshPosition.x;
      const worldZ = localZ + meshPosition.z;

      // Convert to geo coordinates
      const geo = worldToGeo(worldX, 0, worldZ);

      // Get terrain height
      const elevation = getHeight(geo.lng, geo.lat);
      heights[i] = elevation * verticalExaggeration;
    }

    // Second pass: detect and smooth spikes
    this.smoothTerrainSpikes(heights);

    // Third pass: apply smoothed heights
    for (let i = 0; i < positions.count; i++) {
      positions.setY(i, heights[i]);
    }

    positions.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  /**
   * Detect and smooth terrain spikes
   * A spike is a vertex that differs significantly from its neighbors
   */
  private smoothTerrainSpikes(heights: number[]): void {
    // Get grid dimensions from geometry parameters
    const params = this.geometry.parameters;
    const gridWidth = (params.widthSegments || 1) + 1;
    const gridHeight = (params.heightSegments || 1) + 1;

    // Helper to get height at grid position
    const getHeightAt = (x: number, y: number): number | null => {
      if (x < 0 || x >= gridWidth || y < 0 || y >= gridHeight) return null;
      return heights[y * gridWidth + x];
    };

    // Track which vertices are spikes (to avoid modifying while iterating)
    const spikes: { idx: number; median: number }[] = [];

    // Check each vertex (skip border vertices to maintain tile seam consistency)
    for (let gy = 0; gy < gridHeight; gy++) {
      for (let gx = 0; gx < gridWidth; gx++) {
        // Skip border vertices - they must match neighboring tiles exactly
        // Smoothing them would create seams where tiles meet
        const isEdge = gx === 0 || gx === gridWidth - 1 || gy === 0 || gy === gridHeight - 1;
        if (isEdge) continue;

        const idx = gy * gridWidth + gx;
        const height = heights[idx];

        // Skip NaN heights (missing data) - zero is valid for sea-level terrain
        if (Number.isNaN(height)) continue;

        // Get neighbor heights (8-connected neighborhood)
        const neighbors: number[] = [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const h = getHeightAt(gx + dx, gy + dy);
            if (h !== null && !Number.isNaN(h)) {
              neighbors.push(h);
            }
          }
        }

        // Need at least 3 valid neighbors for reliable spike detection
        if (neighbors.length < 3) continue;

        // Calculate mean and standard deviation of neighbors
        const mean = neighbors.reduce((a, b) => a + b, 0) / neighbors.length;
        const variance = neighbors.reduce((sum, h) => sum + (h - mean) ** 2, 0) / neighbors.length;
        const stdDev = Math.sqrt(variance);

        // Calculate how far this vertex deviates from neighbor mean
        const deviation = Math.abs(height - mean);

        // Only flag as spike if:
        // 1. Deviation exceeds minimum threshold (avoids smoothing small variations)
        // 2. Deviation is unusually large compared to neighbor variance (outlier detection)
        //    - If neighbors have high stdDev (steep terrain), threshold is higher
        //    - If neighbors are consistent (low stdDev), even small deviations are suspicious
        const dynamicThreshold = Math.max(SPIKE_MIN_DEVIATION_METERS, stdDev * SPIKE_STDDEV_MULTIPLIER);

        if (deviation > dynamicThreshold) {
          spikes.push({ idx, median: mean });
        }
      }
    }

    // Apply smoothing to detected spikes
    for (const spike of spikes) {
      heights[spike.idx] = spike.median;
    }
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

    // Apply terrain shader to material
    applyTerrainShader(this.material, {
      elevationTexture: this.elevationTexture,
      verticalExaggeration,
      bounds: elevationBounds,
      tileCenter: new THREE.Vector3(elevCenterX, 0, elevCenterZ),
      tileDimensions: {
        width: elevWidth,
        height: elevHeight,
      },
    });
  }

  /**
   * Set the ground color texture
   */
  setTexture(texture: THREE.CanvasTexture): void {
    this.material.map = texture;
    this.material.needsUpdate = true;
  }

  /**
   * Set elevation texture for GPU displacement (legacy method, prefer applyGPUDisplacement)
   * @deprecated Use applyGPUDisplacement instead
   */
  setElevationTexture(_texture: THREE.DataTexture): void {
    console.warn('setElevationTexture is deprecated. Use applyGPUDisplacement instead.');
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
  getMaterial(): THREE.MeshStandardMaterial {
    return this.material;
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    if (this.material.map) {
      // Use deferred disposal for WebGPU compatibility
      disposeTexture(this.material.map);
    }
    if (this.elevationTexture) {
      // Use deferred disposal for WebGPU compatibility
      disposeTexture(this.elevationTexture);
      this.elevationTexture = null;
    }
  }
}

/**
 * Create an elevation data texture from terrain height data
 * @param bounds Tile bounds
 * @param resolution Texture resolution
 * @param getHeight Function to get elevation at a point
 * @returns DataTexture with normalized elevation values
 */
export function createElevationTexture(
  bounds: TileBounds,
  resolution: number,
  getHeight: (lng: number, lat: number) => number
): THREE.DataTexture {
  const data = new Float32Array(resolution * resolution);

  let minElevation = Infinity;
  let maxElevation = -Infinity;

  // First pass: sample elevations and find range
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const u = x / (resolution - 1);
      const v = y / (resolution - 1);

      const lng = bounds.west + u * (bounds.east - bounds.west);
      const lat = bounds.north - v * (bounds.north - bounds.south); // V increases downward

      const elevation = getHeight(lng, lat);
      data[y * resolution + x] = elevation;

      minElevation = Math.min(minElevation, elevation);
      maxElevation = Math.max(maxElevation, elevation);
    }
  }

  // Create texture
  const texture = new THREE.DataTexture(
    data,
    resolution,
    resolution,
    THREE.RedFormat,
    THREE.FloatType
  );
  texture.needsUpdate = true;

  // Store elevation range in userData for shader use
  texture.userData = {
    minElevation,
    maxElevation,
  };

  return texture;
}
