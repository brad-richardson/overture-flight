import * as THREE from 'three';
import type { TileBounds } from './types.js';
import { geoToWorld, worldToGeo } from '../scene.js';
import { GROUND_TEXTURE, ELEVATION } from '../constants.js';

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
      // Remap: original 0-1 spans the expanded geometry
      // We want the center (original tile) to map to 0-1
      uvs.setXY(i, u * uScale - uOffset, v * vScale - vOffset);
    }
    uvs.needsUpdate = true;
  }

  /**
   * Apply terrain elevation to vertices
   * @param getHeight Function that returns terrain height for a given lng/lat
   * @param verticalExaggeration Multiplier for elevation values
   */
  updateElevation(
    getHeight: (lng: number, lat: number) => number,
    verticalExaggeration: number = ELEVATION.VERTICAL_EXAGGERATION
  ): void {
    const positions = this.geometry.attributes.position;
    const meshPosition = this.mesh.position;

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
      const y = elevation * verticalExaggeration;

      positions.setY(i, y);
    }

    positions.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  /**
   * Set the ground color texture
   */
  setTexture(texture: THREE.CanvasTexture): void {
    this.material.map = texture;
    this.material.needsUpdate = true;
  }

  /**
   * Set elevation texture for future GPU displacement
   * (Placeholder for vertex shader implementation)
   */
  setElevationTexture(_texture: THREE.DataTexture): void {
    // For future GPU-based displacement:
    // this.material.displacementMap = _texture;
    // this.material.displacementScale = ELEVATION.VERTICAL_EXAGGERATION * maxElevation;
    console.log('Elevation texture set (GPU displacement not yet implemented)');
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
   * Enable stencil writing for this quad (used by Z14 tiles)
   * When enabled, this quad writes to the stencil buffer so that
   * Z10 low-detail tiles can be masked where Z14 tiles exist
   */
  enableStencilWrite(): void {
    this.material.stencilWrite = true;
    this.material.stencilRef = 1;
    this.material.stencilFunc = THREE.AlwaysStencilFunc;
    this.material.stencilFail = THREE.KeepStencilOp;
    this.material.stencilZFail = THREE.KeepStencilOp;
    this.material.stencilZPass = THREE.ReplaceStencilOp;
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    if (this.material.map) {
      this.material.map.dispose();
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
