import * as THREE from 'three';
import { getScene, geoToWorld, getSceneOriginForWorker, BufferGeometryUtils } from './scene.js';
import { loadBuildingTile, tileToWorldBounds } from './tile-manager.js';
import { getTerrainHeight } from './elevation.js';
import { ELEVATION, WORKERS } from './constants.js';
import {
  getBuildingColor,
  getBuildingHeight,
  groupFeaturesByCategory,
  createCategoryMaterial,
  isUndergroundBuilding,
  isBuildingFeature,
  BuildingFeature,
} from './building-materials.js';
import { storeFeatures, removeStoredFeatures } from './feature-picker.js';
import type { StoredFeature } from './feature-picker.js';
import { getTileSemaphore, TilePriority } from './semaphore.js';
import { clearPendingUpdatesForTile } from './elevation-sync.js';
import { getBuildingGeometryWorkerPool } from './workers/index.js';
import type { BuildingFeatureInput } from './workers/index.js';

// Default building height when not specified
const DEFAULT_BUILDING_HEIGHT = 10;

// Height offset above terrain to prevent z-fighting with roads (in meters)
// Buildings should be slightly above roads (which use 1.0m offset)
const BUILDING_TERRAIN_OFFSET = 0.5;

// Multiplier for extending buildings into sloped terrain
// Prevents floating appearance on hillsides (0.3 = 30% of slope height)
const SLOPE_COMPENSATION_FACTOR = 0.3;

// LOD (Level of Detail) settings (aggressive performance tuning)
const LOD_NEAR_DISTANCE = 300; // meters - full detail (reduced from 500)
const LOD_MEDIUM_DISTANCE = 800; // meters - reduced detail (reduced from 2000)
const MIN_BUILDING_AREA_FAR = 50; // m² - skip small buildings at far distances (lowered to show suburban homes)

// LOD levels
export enum LODLevel {
  HIGH = 0,   // Full detail
  MEDIUM = 1, // Reduced detail (simplified geometry)
  LOW = 2     // Minimal detail (heavily simplified geometry)
}

/**
 * Calculate distance from origin (player) to tile center
 * @param tileX - Tile X coordinate
 * @param tileY - Tile Y coordinate
 * @param tileZoom - Tile zoom level (not Z coordinate)
 */
function getTileDistanceFromOrigin(tileX: number, tileY: number, tileZoom: number): number {
  const bounds = tileToWorldBounds(tileX, tileY, tileZoom);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  // Origin is at 0,0 in world coordinates
  return Math.sqrt(centerX * centerX + centerZ * centerZ);
}

/**
 * Determine LOD level based on distance from player
 */
function getLODLevel(distance: number): LODLevel {
  if (distance < LOD_NEAR_DISTANCE) {
    return LODLevel.HIGH;
  } else if (distance < LOD_MEDIUM_DISTANCE) {
    return LODLevel.MEDIUM;
  } else {
    return LODLevel.LOW;
  }
}

/**
 * Simplify polygon coordinates by reducing vertex count
 * Uses consecutive-point distance filtering to remove vertices closer than tolerance
 */
function simplifyPolygon(points: THREE.Vector2[], tolerance: number): THREE.Vector2[] {
  if (points.length <= 4) return points; // Can't simplify further

  const simplified: THREE.Vector2[] = [points[0]];
  let prevPoint = points[0];

  for (let i = 1; i < points.length - 1; i++) {
    const point = points[i];
    const distance = prevPoint.distanceTo(point);

    // Keep point if it's far enough from the previous point
    if (distance >= tolerance) {
      simplified.push(point);
      prevPoint = point;
    }
  }

  // Always include the last point to maintain polygon closure
  if (points.length > 1) {
    simplified.push(points[points.length - 1]);
  }

  // Ensure minimum 3 points for valid polygon
  if (simplified.length < 3) {
    // Return minimum valid polygon from original points
    return points.length >= 3 ? points.slice(0, 3) : points.slice();
  }

  return simplified;
}

// Material cache by category for performance
const materialCache = new Map<string, THREE.MeshStandardMaterial>();

// Track tiles currently being loaded to prevent race conditions
const loadingBuildingTiles = new Set<string>();

/**
 * Get or create a material for a building category
 */
function getCategoryMaterial(category: string): THREE.MeshStandardMaterial {
  if (!materialCache.has(category)) {
    materialCache.set(category, createCategoryMaterial(category));
  }
  return materialCache.get(category)!;
}

/**
 * Material that uses vertex colors for individual building variation
 */
const vertexColorMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.75,
  metalness: 0.1,
});

/**
 * Create building meshes from tile features with LOD-based detail reduction
 */
export async function createBuildingsForTile(
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<THREE.Group | null> {
  const scene = getScene();
  if (!scene) {
    console.warn('Scene not initialized');
    return null;
  }

  const tileKey = `buildings-${tileZ}/${tileX}/${tileY}`;

  // Check if currently loading (prevent race condition)
  if (loadingBuildingTiles.has(tileKey)) {
    return null;
  }

  // Mark as loading
  loadingBuildingTiles.add(tileKey);

  // Use semaphore to limit concurrent tile processing (maintains 60fps)
  // Buildings have lowest priority - ground tiles load first
  const semaphore = getTileSemaphore();
  try {
    if (semaphore) {
      return await semaphore.run(() => createBuildingsForTileInner(tileX, tileY, tileZ, tileKey), TilePriority.BUILDINGS);
    }
    return await createBuildingsForTileInner(tileX, tileY, tileZ, tileKey);
  } catch (error) {
    // Ensure cleanup on error to prevent permanently stuck entries
    loadingBuildingTiles.delete(tileKey);
    throw error;
  }
}

/**
 * Inner implementation of building tile creation (runs with semaphore permit)
 */
async function createBuildingsForTileInner(
  tileX: number,
  tileY: number,
  tileZ: number,
  tileKey: string
): Promise<THREE.Group | null> {
  const scene = getScene();
  if (!scene) {
    loadingBuildingTiles.delete(tileKey);
    return null;
  }

  const features = await loadBuildingTile(tileX, tileY, tileZ);
  if (features.length === 0) {
    loadingBuildingTiles.delete(tileKey);
    return null;
  }

  // Store features for click picking
  const storedFeatures: StoredFeature[] = features
    .filter(f => {
      // Only process polygon/multipolygon types using type guard
      if (!isBuildingFeature(f)) return false;
      // Skip underground buildings
      return !isUndergroundBuilding(f);
    })
    .map(f => ({
      type: f.type as 'Polygon' | 'MultiPolygon',
      coordinates: f.coordinates as number[][][] | number[][][][],
      properties: (f.properties || {}) as Record<string, unknown>,
      layer: 'building',
      tileKey
    }));
  storeFeatures(tileKey, storedFeatures);

  // Calculate LOD level based on distance from player
  const tileDistance = getTileDistanceFromOrigin(tileX, tileY, tileZ);
  const lodLevel = getLODLevel(tileDistance);

  const group = new THREE.Group();
  group.name = `buildings-${tileZ}/${tileX}/${tileY}`;
  // Store tile info for LOD updates
  group.userData = { tileX, tileY, tileZ, lodLevel, tileDistance };

  // Try worker-based building geometry generation
  // Trade-offs: Worker produces single merged mesh with uniform material properties.
  // Main thread fallback groups by category with varied materials.
  // Worker benefits: Heavy geometry computation off main thread, better frame rates.
  // Note: Origin captured here; if floating origin shifts during processing,
  // geometry may be slightly offset (acceptable for typical movement speeds).
  if (WORKERS.BUILDING_GEOMETRY_ENABLED) {
    try {
      const workerPool = getBuildingGeometryWorkerPool();
      const isSupported = await workerPool.isWorkerSupported();

      if (isSupported) {
        const origin = getSceneOriginForWorker();
        if (origin) {
          // Convert features to worker format and collect terrain heights
          const workerFeatures: BuildingFeatureInput[] = [];
          const terrainHeights: { [index: number]: [number, number] } = {};

          for (const f of features) {
            if (!isBuildingFeature(f)) continue;
            if (isUndergroundBuilding(f)) continue;

            const featureIndex = workerFeatures.length;

            // Collect terrain heights for this building if terrain is enabled
            if (ELEVATION.TERRAIN_ENABLED) {
              const coords = f.type === 'Polygon'
                ? [f.coordinates as number[][][]]
                : f.coordinates as number[][][][];

              let minHeight = Infinity;
              let maxHeight = -Infinity;
              let validCount = 0;

              for (const polygon of coords) {
                const outerRing = polygon[0];
                if (!outerRing) continue;
                for (const coord of outerRing) {
                  const h = getTerrainHeight(coord[0], coord[1]);
                  if (!Number.isNaN(h)) {
                    minHeight = Math.min(minHeight, h);
                    maxHeight = Math.max(maxHeight, h);
                    validCount++;
                  }
                }
              }

              if (validCount > 0) {
                terrainHeights[featureIndex] = [minHeight, maxHeight];
              }
            }

            workerFeatures.push({
              type: f.type as 'Polygon' | 'MultiPolygon',
              coordinates: f.coordinates as number[][][] | number[][][][],
              properties: f.properties as BuildingFeatureInput['properties'],
            });
          }

          if (workerFeatures.length > 0) {
            const result = await workerPool.createBuildingGeometry(
              workerFeatures,
              origin,
              tileX,
              tileY,
              tileZ,
              lodLevel,
              DEFAULT_BUILDING_HEIGHT,
              Object.keys(terrainHeights).length > 0 ? terrainHeights : undefined,
              ELEVATION.VERTICAL_EXAGGERATION
            );

            if (result.geometry) {
              // Create Three.js BufferGeometry from worker result
              const geometry = new THREE.BufferGeometry();
              geometry.setAttribute('position', new THREE.BufferAttribute(result.geometry.positions, 3));
              geometry.setAttribute('normal', new THREE.BufferAttribute(result.geometry.normals, 3));
              geometry.setAttribute('color', new THREE.BufferAttribute(result.geometry.colors, 3));
              geometry.setIndex(new THREE.Uint32BufferAttribute(result.geometry.indices, 1));

              const mesh = new THREE.Mesh(geometry, vertexColorMaterial.clone());
              mesh.castShadow = true;
              mesh.receiveShadow = true;
              mesh.name = 'buildings-worker';
              group.add(mesh);

              if (group.children.length > 0) {
                scene.add(group);
                loadingBuildingTiles.delete(tileKey);
                return group;
              }
            }
          }
        }
      }
    } catch (error) {
      console.warn('Building geometry worker failed, falling back to main thread:', error);
    }
  }

  // Fallback: Main thread building geometry generation
  // Group features by category for better material batching
  const categoryGroups = groupFeaturesByCategory(features as BuildingFeature[]);
  let totalGeometries = 0;
  let skippedSmall = 0;

  // Process each category separately
  for (const [category, categoryFeatures] of Object.entries(categoryGroups)) {
    const geometries: THREE.BufferGeometry[] = [];

    for (const feature of categoryFeatures) {
      if (feature.type !== 'Polygon' && feature.type !== 'MultiPolygon') {
        continue;
      }

      // Skip underground buildings (Overture is_underground property)
      if (isUndergroundBuilding(feature)) {
        continue;
      }

      // Get building height from Overture properties (height, num_floors)
      const height = getBuildingHeight(feature, DEFAULT_BUILDING_HEIGHT);

      // Get building-specific color based on Overture subtype/class
      const buildingColor = getBuildingColor(feature);

      try {
        if (feature.type === 'Polygon') {
          const geom = createBuildingGeometry(
            feature.coordinates as number[][][],
            height,
            buildingColor,
            lodLevel
          );
          if (geom) {
            geometries.push(geom);
          } else if (lodLevel === LODLevel.LOW) {
            skippedSmall++;
          }
        } else if (feature.type === 'MultiPolygon') {
          for (const polygon of feature.coordinates as number[][][][]) {
            const geom = createBuildingGeometry(polygon, height, buildingColor, lodLevel);
            if (geom) {
              geometries.push(geom);
            } else if (lodLevel === LODLevel.LOW) {
              skippedSmall++;
            }
          }
        }
      } catch {
        // Skip invalid geometries
        continue;
      }
    }

    if (geometries.length === 0) continue;

    totalGeometries += geometries.length;

    // Merge geometries for this category
    try {
      const mergedGeometry = BufferGeometryUtils.mergeGeometries(geometries, false);
      if (mergedGeometry) {
        // Use vertex colors for individual building variation
        const mesh = new THREE.Mesh(mergedGeometry, vertexColorMaterial.clone());
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = `buildings-${category}`;
        group.add(mesh);
      }
    } catch (e) {
      console.warn(`Failed to merge ${category} buildings for ${tileZ}/${tileX}/${tileY}:`, (e as Error).message);
      // Fallback: add individually with category material
      const categoryMaterial = getCategoryMaterial(category);
      for (const geom of geometries) {
        if (geom) {
          const mesh = new THREE.Mesh(geom, categoryMaterial);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          group.add(mesh);
        }
      }
    }

    // Dispose individual geometries
    for (const geom of geometries) {
      geom.dispose();
    }
  }

  if (group.children.length === 0) {
    loadingBuildingTiles.delete(tileKey);
    return null;
  }

  scene.add(group);
  loadingBuildingTiles.delete(tileKey);
  return group;
}

/**
 * Create extruded geometry for a building polygon with vertex colors and LOD support
 * Buildings follow terrain elevation using the average height of their footprint
 */
function createBuildingGeometry(
  coordinates: number[][][],
  height: number,
  color: number = 0x888899,
  lodLevel: LODLevel = LODLevel.HIGH
): THREE.BufferGeometry | null {
  if (!coordinates || coordinates.length === 0) return null;

  const outerRing = coordinates[0];
  if (!outerRing || outerRing.length < 3) return null;

  // Calculate terrain height for the building footprint
  // Use MINIMUM height to ensure building sits on ground at lowest point
  // This prevents gaps/deep shadows on sloped terrain
  let minTerrainHeight = Infinity;
  let maxTerrainHeight = -Infinity;
  let validHeightCount = 0;

  if (ELEVATION.TERRAIN_ENABLED) {
    for (const coord of outerRing) {
      const lng = coord[0];
      const lat = coord[1];
      const terrainHeight = getTerrainHeight(lng, lat);
      // Only count non-NaN heights as valid (zero is valid for sea-level terrain)
      if (!Number.isNaN(terrainHeight)) {
        minTerrainHeight = Math.min(minTerrainHeight, terrainHeight);
        maxTerrainHeight = Math.max(maxTerrainHeight, terrainHeight);
        validHeightCount++;
      }
    }
  }

  // Use minimum height (0 if no valid samples)
  // This ensures building base touches ground at lowest point
  const baseTerrainHeight = validHeightCount > 0
    ? minTerrainHeight * ELEVATION.VERTICAL_EXAGGERATION
    : 0;

  // Calculate slope for extending building height on upper side
  const terrainSlope = validHeightCount > 0
    ? (maxTerrainHeight - minTerrainHeight) * ELEVATION.VERTICAL_EXAGGERATION
    : 0;

  // Convert outer ring to Three.js points
  // Note: We negate world.z because rotateX(-PI/2) will negate it again,
  // resulting in the correct final Z position that matches roads
  let points: THREE.Vector2[] = [];
  for (const coord of outerRing) {
    const world = geoToWorld(coord[0], coord[1], 0);
    points.push(new THREE.Vector2(world.x, -world.z));
  }

  // Remove duplicate last point if present
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.abs(first.x - last.x) < 0.01 && Math.abs(first.y - last.y) < 0.01) {
      points.pop();
    }
  }

  if (points.length < 3) return null;

  // Check if polygon is valid (has area)
  const area = calculatePolygonArea(points);
  if (Math.abs(area) < 1) return null; // Skip tiny buildings

  // Skip small buildings at far distances
  if (lodLevel === LODLevel.LOW && Math.abs(area) < MIN_BUILDING_AREA_FAR) {
    return null;
  }

  // Apply polygon simplification based on LOD level
  if (lodLevel === LODLevel.MEDIUM) {
    // Medium LOD: apply moderate vertex reduction (2m tolerance)
    points = simplifyPolygon(points, 2);
  } else if (lodLevel === LODLevel.LOW) {
    // Low LOD: aggressive simplification (5m tolerance)
    points = simplifyPolygon(points, 5);
  }

  if (points.length < 3) return null;

  // Check if simplified polygon is still valid (has sufficient area)
  const finalArea = calculatePolygonArea(points);
  if (Math.abs(finalArea) < 1) return null; // Skip degenerate polygons

  // Ensure counter-clockwise winding for Three.js
  if (finalArea > 0) {
    points.reverse();
  }

  try {
    const shape = new THREE.Shape(points);

    // Add holes (skip for low LOD to reduce complexity)
    if (lodLevel !== LODLevel.LOW) {
      for (let i = 1; i < coordinates.length; i++) {
        const holeRing = coordinates[i];
        if (!holeRing || holeRing.length < 3) continue;

        let holePoints: THREE.Vector2[] = [];
        for (const coord of holeRing) {
          const world = geoToWorld(coord[0], coord[1], 0);
          holePoints.push(new THREE.Vector2(world.x, -world.z));
        }

        // Remove duplicate last point
        if (holePoints.length > 1) {
          const first = holePoints[0];
          const last = holePoints[holePoints.length - 1];
          if (Math.abs(first.x - last.x) < 0.01 && Math.abs(first.y - last.y) < 0.01) {
            holePoints.pop();
          }
        }

        // Simplify holes for medium LOD
        if (lodLevel === LODLevel.MEDIUM && holePoints.length > 4) {
          holePoints = simplifyPolygon(holePoints, 2);
        }

        if (holePoints.length >= 3) {
          // Holes need clockwise winding (opposite of outer ring)
          const holeArea = calculatePolygonArea(holePoints);
          if (holeArea < 0) {
            holePoints.reverse();
          }
          shape.holes.push(new THREE.Path(holePoints));
        }
      }
    }

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: height,
      bevelEnabled: false
    });

    // Rotate so extrusion goes up (Y) instead of out (Z)
    geometry.rotateX(-Math.PI / 2);

    // Apply terrain-following elevation using minimum height
    // This ensures building base touches ground at lowest point
    const yOffset = baseTerrainHeight + BUILDING_TERRAIN_OFFSET;
    if (yOffset !== 0) {
      geometry.translate(0, yOffset, 0);
    }

    // Extend building down into terrain on sloped ground to fill gaps
    // This prevents the building from appearing to float on the upper slope side
    if (terrainSlope > 1) {
      geometry.translate(0, -terrainSlope * SLOPE_COMPENSATION_FACTOR, 0);
    }

    // Add vertex colors for individual building variation (skip for low LOD for performance)
    if (lodLevel !== LODLevel.LOW) {
      addVertexColors(geometry, color, height);
    } else {
      // Simple flat color for low LOD
      addFlatVertexColors(geometry, color);
    }

    return geometry;
  } catch {
    // Shape creation can fail for invalid polygons
    return null;
  }
}

/**
 * Add flat vertex colors (no variation) for low LOD buildings
 */
function addFlatVertexColors(geometry: THREE.BufferGeometry, hexColor: number): void {
  const positions = geometry.attributes.position;
  const count = positions.count;
  const colors = new Float32Array(count * 3);

  // Extract RGB from hex
  const r = ((hexColor >> 16) & 0xFF) / 255;
  const g = ((hexColor >> 8) & 0xFF) / 255;
  const b = (hexColor & 0xFF) / 255;

  for (let i = 0; i < count; i++) {
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * Add vertex colors to a building geometry
 * Applies the base color with optional height-based variation
 */
function addVertexColors(
  geometry: THREE.BufferGeometry,
  hexColor: number,
  height: number
): void {
  const positions = geometry.attributes.position;
  const count = positions.count;
  const colors = new Float32Array(count * 3);

  // Extract RGB from hex
  const r = ((hexColor >> 16) & 0xFF) / 255;
  const g = ((hexColor >> 8) & 0xFF) / 255;
  const b = (hexColor & 0xFF) / 255;

  // For tall buildings, apply subtle height-based darkening at base
  const applyGradient = height > 30;

  for (let i = 0; i < count; i++) {
    const y = positions.getY(i);
    let factor = 1.0;

    if (applyGradient) {
      // Darken the lower parts slightly (0-15% based on height)
      const progress = Math.max(0, Math.min(1, y / height));
      factor = 0.85 + (progress * 0.15);
    }

    // Add slight random variation per vertex for texture
    const noise = 0.95 + Math.random() * 0.1;
    factor *= noise;

    colors[i * 3] = r * factor;
    colors[i * 3 + 1] = g * factor;
    colors[i * 3 + 2] = b * factor;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * Calculate signed area of a 2D polygon
 * Positive = clockwise, Negative = counter-clockwise
 */
function calculatePolygonArea(points: THREE.Vector2[]): number {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  }
  return area / 2;
}

/**
 * Remove building meshes for a tile and properly dispose all GPU resources
 */
export function removeBuildingsGroup(group: THREE.Group): void {
  if (!group) return;

  // Remove stored features and pending elevation updates for this tile
  if (group.name) {
    const tileKey = group.name; // e.g., "buildings-14/8372/5739"
    removeStoredFeatures(tileKey);
    clearPendingUpdatesForTile(tileKey);
  }

  const scene = getScene();
  if (scene) {
    scene.remove(group);
  }

  let disposedGeometries = 0;
  let disposedMaterials = 0;

  // Dispose of geometries and materials
  group.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;

      // Dispose geometry and all its attributes
      if (mesh.geometry) {
        mesh.geometry.dispose();
        disposedGeometries++;
      }

      // Dispose materials (handle array of materials)
      if (mesh.material) {
        if (Array.isArray(mesh.material)) {
          for (const mat of mesh.material) {
            mat.dispose();
            disposedMaterials++;
          }
        } else {
          (mesh.material as THREE.Material).dispose();
          disposedMaterials++;
        }
      }
    }
  });

  // Clear the group's children array
  group.clear();
}

/**
 * Get statistics about loaded building categories
 */
export function getBuildingStats(): { materialCacheSize: number; categories: string[] } {
  return {
    materialCacheSize: materialCache.size,
    categories: Array.from(materialCache.keys())
  };
}
