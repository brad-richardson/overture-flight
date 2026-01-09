import * as THREE from 'three';
import { getScene, worldToGeo, getSceneOriginForWorker } from './scene.js';
import { loadBaseTile, loadWaterPolygonsFromLowerZooms } from './tile-manager.js';
import { getTerrainHeight } from './elevation.js';
import { ELEVATION, WORKERS } from './constants.js';
import { storeFeatures, removeStoredFeatures } from './feature-picker.js';
import type { StoredFeature } from './feature-picker.js';
import { getGeometryWorkerPool } from './workers/index.js';
import type { GeometryBufferGroup, LineGeometryBufferGroup } from './workers/types.js';

/**
 * Validate that geometry workers are available before tile loading begins.
 * Call this during app initialization to fail fast with a clear error message
 * rather than silently failing when tiles start loading.
 *
 * @throws Error if workers are disabled or not supported by the browser
 */
export async function validateWorkerSupport(): Promise<void> {
  if (!WORKERS.GEOMETRY_ENABLED) {
    throw new Error(
      'Geometry workers are disabled in configuration. ' +
      'Set WORKERS.GEOMETRY_ENABLED = true or ensure VITE_GEOMETRY_WORKERS is not "false".'
    );
  }

  const pool = getGeometryWorkerPool();
  const isSupported = await pool.isWorkerSupported();

  if (!isSupported) {
    throw new Error(
      'Geometry workers are not supported by this browser. ' +
      'Required features: Web Workers, OffscreenCanvas, Transferable ArrayBuffers.'
    );
  }
}

// Types
interface ParsedFeature {
  type: string;
  coordinates: number[] | number[][] | number[][][] | number[][][][];
  properties: Record<string, unknown>;
  layer: string;
}

// Layer depth configuration to prevent z-fighting
// Layers are separated by Y position with moderate gaps
// Z-fighting prevention relies on combination of Y separation + polygon offset + render order
// Note: land_cover and land_use use terrain-following elevation, so their
// base offset is relative to terrain surface (added on top of terrain height)
const LAYER_DEPTHS: Record<string, number> = {
  terrain: -5.0,      // Terrain mesh at lowest position
  bathymetry: -4.5,   // Bathymetry below land (was -4.0, same as land)
  land: -4.0,         // Base land fill layer (fixed position, not terrain-following)
  land_cover: 0.3,    // Land cover offset ABOVE terrain surface (terrain-following)
  land_use: 0.8,      // Land use 0.5m above land_cover
  water: 1.0,         // Water above land_cover/land_use (lowered to reduce flooding)
  water_lines: 1.5,   // Water lines above water polygons
  default: 0.3
};

// Materials cache - keyed by "color-layer" for layer-specific material settings
const materials = new Map<string, THREE.MeshStandardMaterial>();

// Line materials cache for water lines (rivers)
const lineMaterials = new Map<number, THREE.LineBasicMaterial>();

// Polygon offset values per layer to prevent z-fighting
// Higher factor/units = pushed further back in depth buffer
// Values doubled for better depth separation between layers
const POLYGON_OFFSET: Record<string, { factor: number; units: number }> = {
  terrain: { factor: 10, units: 10 },
  bathymetry: { factor: 8, units: 8 },
  land: { factor: 6, units: 6 },
  land_cover: { factor: 4, units: 4 },
  land_use: { factor: 2, units: 2 },
  water: { factor: 0, units: 0 },
  water_lines: { factor: -2, units: -2 },
  default: { factor: 3, units: 3 }
};

// Linear water feature types to render as lines (rivers, streams, etc.)
// Coastlines and shorelines are excluded to prevent artifacts around islands
const LINEAR_WATER_TYPES = ['river', 'stream', 'canal', 'drain', 'ditch', 'waterway'];

// Ocean/sea water types that should NOT be rendered from water layer
// These are already covered by bathymetry layer - rendering both causes z-fighting
// All other water types (including unknown subtypes) are rendered to ensure inland water is visible
const OCEAN_WATER_TYPES = ['ocean', 'sea', 'bay', 'strait', 'gulf', 'sound'];

/**
 * Get or create material for a color and layer
 * Each layer gets its own material with appropriate polygon offset for z-fighting prevention
 */
function getMaterial(color: number, layer: string = 'default'): THREE.MeshStandardMaterial {
  const key = `${color}-${layer}`;
  if (!materials.has(key)) {
    const offset = POLYGON_OFFSET[layer] ?? POLYGON_OFFSET.default;
    materials.set(key, new THREE.MeshStandardMaterial({
      color: color,
      roughness: 0.9,
      metalness: 0.0,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: offset.factor,
      polygonOffsetUnits: offset.units,
    }));
  }
  return materials.get(key)!;
}

/**
 * Get or create line material for water features (rivers)
 */
function getLineMaterial(color: number): THREE.LineBasicMaterial {
  if (!lineMaterials.has(color)) {
    lineMaterials.set(color, new THREE.LineBasicMaterial({
      color: color,
      linewidth: 2
    }));
  }
  return lineMaterials.get(color)!;
}

/**
 * Create base layer meshes (land, water, land_cover, land_use) from tile features
 * Land layer provides base coverage, with land_cover/land_use on top following terrain
 */
export async function createBaseLayerForTile(
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<THREE.Group | null> {
  const scene = getScene();
  if (!scene) {
    console.warn('Scene not initialized');
    return null;
  }

  const group = new THREE.Group();
  group.name = `base-${tileZ}/${tileX}/${tileY}`;

  // Load and render base features (land, water, land_cover, land_use)
  const features = await loadBaseTile(tileX, tileY, tileZ);

  // Check if we have any water line features (rivers, streams)
  const hasWaterLines = features.some(f =>
    (f.type === 'LineString' || f.type === 'MultiLineString') &&
    f.layer === 'water' &&
    LINEAR_WATER_TYPES.includes(String(f.properties?.subtype || f.properties?.class || '').toLowerCase())
  );

  // Fetch lower zoom water if we have water lines (rivers) that need polygon fill
  // Filter out ocean/bay/sea types from lower zoom - those are bloated at low zoom and
  // should come from z14 data or bathymetry layer instead
  if (hasWaterLines) {
    const lowerZoomWaterPolygons = await loadWaterPolygonsFromLowerZooms(tileX, tileY, tileZ);
    // Filter out ocean-type water - we only want river/lake polygons from lower zoom
    const filteredPolygons = lowerZoomWaterPolygons.filter(f => {
      const subtype = String(f.properties?.subtype || f.properties?.class || '').toLowerCase();
      return !OCEAN_WATER_TYPES.includes(subtype);
    });
    if (filteredPolygons.length > 0) {
      features.push(...filteredPolygons);
    }
  }

  // Store features for click picking
  const tileKey = `base-${tileZ}/${tileX}/${tileY}`;
  const storedFeatures: StoredFeature[] = features
    .filter(f => f.type === 'Polygon' || f.type === 'MultiPolygon' ||
                 f.type === 'LineString' || f.type === 'MultiLineString')
    .map(f => ({
      type: f.type as StoredFeature['type'],
      coordinates: f.coordinates as StoredFeature['coordinates'],
      properties: f.properties || {},
      layer: f.layer || 'unknown',
      tileKey
    }));
  storeFeatures(tileKey, storedFeatures);

  if (features.length > 0) {
    // Create geometry using workers (required)
    try {
      await createWorkerGeometry(features, group, tileX, tileY, tileZ);
    } catch (error) {
      console.error(`Failed to create base layer geometry for tile ${tileZ}/${tileX}/${tileY}:`, error);
      // Continue without geometry - tile will be missing land/water features
      // This is better than crashing the entire tile loading process
    }
  }

  scene.add(group);
  return group;
}

/**
 * Create mesh from worker geometry buffer group
 * Handles terrain-following by applying elevation on main thread
 */
function createMeshFromWorkerGeometry(
  bufferGroup: GeometryBufferGroup,
  group: THREE.Group
): void {
  const geometry = new THREE.BufferGeometry();

  // Set attributes from worker-provided arrays
  geometry.setAttribute('position', new THREE.BufferAttribute(bufferGroup.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(bufferGroup.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(bufferGroup.indices, 1));

  // Apply terrain elevation for terrain-following layers
  if (bufferGroup.terrainFollowing && ELEVATION.TERRAIN_ENABLED) {
    const positions = geometry.attributes.position;

    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const z = positions.getZ(i);

      // Convert world position back to geographic coordinates
      const geo = worldToGeo(x, 0, z);

      // Get terrain height at this position
      let terrainHeight = getTerrainHeight(geo.lng, geo.lat);
      if (Number.isNaN(terrainHeight)) {
        terrainHeight = 0;
      }
      terrainHeight *= ELEVATION.VERTICAL_EXAGGERATION;

      // Set Y position: terrain base + terrain height + layer offset
      const y = LAYER_DEPTHS.terrain + terrainHeight + bufferGroup.yOffset;
      positions.setY(i, y);
    }

    positions.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  // Create material and mesh
  const material = getMaterial(bufferGroup.color, bufferGroup.layer);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.renderOrder = bufferGroup.renderOrder;
  mesh.name = `worker-${bufferGroup.layer}`;

  // Set Y position for non-terrain-following layers
  if (!bufferGroup.terrainFollowing) {
    mesh.position.y = bufferGroup.yOffset;
  }

  group.add(mesh);
}

/**
 * Create line mesh from worker line geometry buffer group
 */
function createLineFromWorkerGeometry(
  bufferGroup: LineGeometryBufferGroup,
  group: THREE.Group
): void {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(bufferGroup.positions, 3));

  const line = new THREE.LineSegments(geometry, getLineMaterial(bufferGroup.color));
  line.renderOrder = bufferGroup.renderOrder;
  line.name = 'worker-water-lines';

  group.add(line);
}

/**
 * Create geometry using workers (required)
 *
 * Workers are required for geometry creation. This function will throw if:
 * - WORKERS.GEOMETRY_ENABLED is false (disabled in config)
 * - Browser doesn't support required worker features (OffscreenCanvas, etc.)
 * - Worker pool fails to initialize
 *
 * Callers should handle errors gracefully - failed tiles will not render
 * their base layer features (land, water, terrain).
 */
async function createWorkerGeometry(
  features: ParsedFeature[],
  group: THREE.Group,
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<void> {
  if (!WORKERS.GEOMETRY_ENABLED) {
    throw new Error('Geometry workers are disabled but required');
  }

  const pool = getGeometryWorkerPool();
  const isSupported = await pool.isWorkerSupported();

  if (!isSupported) {
    throw new Error('Geometry workers not supported by browser');
  }

  // Get scene origin for coordinate conversion in worker
  const origin = getSceneOriginForWorker();

  // Create geometry in worker
  const result = await pool.createBaseGeometry(features, origin, tileX, tileY, tileZ);

  // Create meshes from worker results
  for (const polygonGroup of result.polygonGroups) {
    createMeshFromWorkerGeometry(polygonGroup, group);
  }

  for (const lineGroup of result.lineGroups) {
    createLineFromWorkerGeometry(lineGroup, group);
  }
}

/**
 * Remove base layer meshes for a tile and properly dispose all GPU resources
 */
export function removeBaseLayerGroup(group: THREE.Group): void {
  if (!group) return;

  // Remove stored features for this tile
  if (group.name) {
    const tileKey = group.name; // e.g., "base-14/8372/5739"
    removeStoredFeatures(tileKey);
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

      // Dispose geometry
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
