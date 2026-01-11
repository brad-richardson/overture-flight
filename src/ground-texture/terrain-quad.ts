import * as THREE from 'three';
import type { TileBounds } from './types.js';
import { geoToWorld } from '../scene.js';
import { GROUND_TEXTURE, ELEVATION } from '../constants.js';
import { applyTerrainShader, createElevationDataTexture } from './terrain-shader.js';
import { disposeTexture } from '../renderer/texture-disposal.js';

// Type for material - can be standard or node-based
type TerrainMaterialType = 'standard' | 'node';

// Depth of terrain skirts in meters (extends below terrain to hide gaps)
const SKIRT_DEPTH = 100;

/**
 * Creates a terrain-following quad mesh for rendering ground textures
 */
export class TerrainQuad {
  private geometry: THREE.BufferGeometry;
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

    // Create geometry with terrain skirts
    this.geometry = this.createGeometryWithSkirts(segments);

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
  }

  /**
   * Create terrain geometry with skirts extending downward from edges
   * Skirts hide gaps between adjacent tiles caused by elevation mismatches
   */
  private createGeometryWithSkirts(segments: number): THREE.BufferGeometry {
    const expandedWidth = this.originalWidth + this.overlap * 2;
    const expandedHeight = this.originalHeight + this.overlap * 2;

    // Create the main plane geometry
    const planeGeom = new THREE.PlaneGeometry(
      expandedWidth,
      expandedHeight,
      segments,
      segments
    );

    // Rotate to lie flat on XZ plane (Y-up)
    planeGeom.rotateX(-Math.PI / 2);

    // Get plane attributes
    const planePositions = planeGeom.attributes.position;
    const planeUVs = planeGeom.attributes.uv;
    const planeIndices = planeGeom.index!;

    const planeVertexCount = planePositions.count;
    const vertsPerRow = segments + 1;

    // Calculate skirt vertices: 4 edges, each with (segments + 1) vertices
    // Each edge vertex has a corresponding skirt vertex below it
    const skirtVerticesPerEdge = vertsPerRow;
    const totalSkirtVertices = skirtVerticesPerEdge * 4;

    // Create arrays for combined geometry
    const totalVertices = planeVertexCount + totalSkirtVertices;
    const positions = new Float32Array(totalVertices * 3);
    const uvs = new Float32Array(totalVertices * 2);
    const normals = new Float32Array(totalVertices * 3);

    // Copy plane vertices
    for (let i = 0; i < planeVertexCount; i++) {
      positions[i * 3] = planePositions.getX(i);
      positions[i * 3 + 1] = planePositions.getY(i);
      positions[i * 3 + 2] = planePositions.getZ(i);

      // Adjust UVs for overlap (same logic as setupUVs)
      const u = planeUVs.getX(i);
      const v = planeUVs.getY(i);
      const flippedV = 1 - v;
      const uScale = expandedWidth / this.originalWidth;
      const vScale = expandedHeight / this.originalHeight;
      const uOffset = this.overlap / this.originalWidth;
      const vOffset = this.overlap / this.originalHeight;
      uvs[i * 2] = u * uScale - uOffset;
      uvs[i * 2 + 1] = flippedV * vScale - vOffset;

      // Default normal pointing up
      normals[i * 3] = 0;
      normals[i * 3 + 1] = 1;
      normals[i * 3 + 2] = 0;
    }

    // Helper to get plane vertex index from row/col
    const getPlaneVertexIndex = (row: number, col: number) => row * vertsPerRow + col;

    // Add skirt vertices and track their indices
    let skirtVertexOffset = planeVertexCount;
    const skirtIndices: number[] = [];

    // Edge indices for the 4 edges (in plane vertex space)
    // Top edge (row 0): vertices 0 to segments
    // Bottom edge (row segments): vertices segments*vertsPerRow to segments*vertsPerRow + segments
    // Left edge (col 0): vertices 0, vertsPerRow, 2*vertsPerRow, ...
    // Right edge (col segments): vertices segments, vertsPerRow+segments, ...

    // Helper to add skirt for an edge
    const addSkirtEdge = (edgeVertexIndices: number[], isHorizontal: boolean, flipWinding: boolean) => {
      const skirtStartIndex = skirtVertexOffset;

      // Add skirt vertices (below each edge vertex)
      for (const planeIdx of edgeVertexIndices) {
        const x = positions[planeIdx * 3];
        const z = positions[planeIdx * 3 + 2];

        // Skirt vertex is at same X,Z but Y = -SKIRT_DEPTH
        positions[skirtVertexOffset * 3] = x;
        positions[skirtVertexOffset * 3 + 1] = -SKIRT_DEPTH;
        positions[skirtVertexOffset * 3 + 2] = z;

        // Copy UV from edge vertex
        uvs[skirtVertexOffset * 2] = uvs[planeIdx * 2];
        uvs[skirtVertexOffset * 2 + 1] = uvs[planeIdx * 2 + 1];

        // Normal pointing outward (will be approximate)
        normals[skirtVertexOffset * 3] = 0;
        normals[skirtVertexOffset * 3 + 1] = 0;
        normals[skirtVertexOffset * 3 + 2] = isHorizontal ? (flipWinding ? 1 : -1) : 0;
        if (!isHorizontal) {
          normals[skirtVertexOffset * 3] = flipWinding ? -1 : 1;
        }

        skirtVertexOffset++;
      }

      // Create triangles connecting edge to skirt
      for (let i = 0; i < edgeVertexIndices.length - 1; i++) {
        const topLeft = edgeVertexIndices[i];
        const topRight = edgeVertexIndices[i + 1];
        const bottomLeft = skirtStartIndex + i;
        const bottomRight = skirtStartIndex + i + 1;

        if (flipWinding) {
          // Triangle 1
          skirtIndices.push(topLeft, bottomLeft, topRight);
          // Triangle 2
          skirtIndices.push(topRight, bottomLeft, bottomRight);
        } else {
          // Triangle 1
          skirtIndices.push(topLeft, topRight, bottomLeft);
          // Triangle 2
          skirtIndices.push(topRight, bottomRight, bottomLeft);
        }
      }
    };

    // Top edge (row 0, z = -expandedHeight/2)
    const topEdge = [];
    for (let col = 0; col < vertsPerRow; col++) {
      topEdge.push(getPlaneVertexIndex(0, col));
    }
    addSkirtEdge(topEdge, true, false);

    // Bottom edge (row segments, z = +expandedHeight/2)
    const bottomEdge = [];
    for (let col = 0; col < vertsPerRow; col++) {
      bottomEdge.push(getPlaneVertexIndex(segments, col));
    }
    addSkirtEdge(bottomEdge, true, true);

    // Left edge (col 0, x = -expandedWidth/2)
    const leftEdge = [];
    for (let row = 0; row < vertsPerRow; row++) {
      leftEdge.push(getPlaneVertexIndex(row, 0));
    }
    addSkirtEdge(leftEdge, false, true);

    // Right edge (col segments, x = +expandedWidth/2)
    const rightEdge = [];
    for (let row = 0; row < vertsPerRow; row++) {
      rightEdge.push(getPlaneVertexIndex(row, segments));
    }
    addSkirtEdge(rightEdge, false, false);

    // Combine plane indices with skirt indices
    const planeIndexArray = Array.from(planeIndices.array);
    const allIndices = new Uint32Array([...planeIndexArray, ...skirtIndices]);

    // Create the combined geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(allIndices, 1));

    // Clean up temporary geometry
    planeGeom.dispose();

    return geometry;
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
    // Skip NaN values which indicate missing elevation data
    let minElevation = Infinity;
    let maxElevation = -Infinity;
    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];
      if (!Number.isNaN(h)) {
        if (h < minElevation) minElevation = h;
        if (h > maxElevation) maxElevation = h;
      }
    }

    // If all heights were NaN (no valid elevation data), use 0 as fallback
    if (minElevation === Infinity || maxElevation === -Infinity) {
      minElevation = 0;
      maxElevation = 0;
    }

    minElevation *= verticalExaggeration;
    maxElevation *= verticalExaggeration;

    // Account for terrain skirts extending below the minimum elevation
    minElevation -= SKIRT_DEPTH;

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
  getGeometry(): THREE.BufferGeometry {
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
