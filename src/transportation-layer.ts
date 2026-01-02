import * as THREE from 'three';
import { getScene, geoToWorld, BufferGeometryUtils } from './scene.js';
import { loadTransportationTile } from './tile-manager.js';
import { getTerrainHeight } from './elevation.js';
import { ELEVATION } from './constants.js';

// Types
interface ParsedFeature {
  type: string;
  coordinates: number[] | number[][] | number[][][] | number[][][][];
  properties: Record<string, unknown> | null;
  layer: string;
}

interface RoadStyle {
  color: number;
  width: number;
}

interface StyleGroup {
  style: RoadStyle;
  features: ParsedFeature[];
}

// Road styling based on Overture road class
// Colors are muted neutral grays to not distract from the flight sim
const ROAD_STYLES: Record<string, RoadStyle> = {
  // Major roads - neutral light gray/beige tones, wider lines
  motorway: { color: 0xa8a090, width: 3.0 },   // Neutral warm gray
  trunk: { color: 0x9a9488, width: 2.5 },      // Slightly darker warm gray
  primary: { color: 0x8c8880, width: 2.0 },    // Medium warm gray
  secondary: { color: 0x7e7a74, width: 1.5 },  // Darker warm gray
  tertiary: { color: 0x706c68, width: 1.2 },   // Even darker warm gray

  // Local roads - subtle gray
  residential: { color: 0x666666, width: 0.8 },
  unclassified: { color: 0x555555, width: 0.6 },
  service: { color: 0x444444, width: 0.4 },

  // Special types
  living_street: { color: 0x555555, width: 0.6 },
  pedestrian: { color: 0x888888, width: 0.5 },
  footway: { color: 0x777777, width: 0.3 },
  path: { color: 0x666666, width: 0.3 },
  cycleway: { color: 0x5a8a5a, width: 0.4 },

  // Railway
  rail: { color: 0x333333, width: 1.0 },
  subway: { color: 0x333333, width: 0.8 },
  tram: { color: 0x333333, width: 0.6 },

  // Default
  default: { color: 0x555555, width: 0.5 }
};

// Materials cache - using MeshBasicMaterial for ribbon geometry
const materials = new Map<number, THREE.MeshBasicMaterial>();

// Height offset above terrain to prevent z-fighting (in meters)
const ROAD_TERRAIN_OFFSET = 1.0;

/**
 * Get or create mesh material for a road style
 */
function getMaterial(color: number): THREE.MeshBasicMaterial {
  if (!materials.has(color)) {
    materials.set(color, new THREE.MeshBasicMaterial({
      color: color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthWrite: false // Must be false for transparent materials to render correctly
    }));
  }
  return materials.get(color)!;
}

/**
 * Get road style based on feature properties
 */
function getRoadStyle(properties: Record<string, unknown> | null): RoadStyle {
  // Null safety check for properties
  if (!properties) {
    return ROAD_STYLES.default;
  }

  // Overture uses 'class' for road type
  const roadClass = (properties.class || properties.subtype || '') as string;
  const type = roadClass.toLowerCase();

  // Check for specific road class
  if (ROAD_STYLES[type]) {
    return ROAD_STYLES[type];
  }

  // Check by partial match
  if (type.includes('motorway')) return ROAD_STYLES.motorway;
  if (type.includes('trunk')) return ROAD_STYLES.trunk;
  if (type.includes('primary')) return ROAD_STYLES.primary;
  if (type.includes('secondary')) return ROAD_STYLES.secondary;
  if (type.includes('tertiary')) return ROAD_STYLES.tertiary;
  if (type.includes('residential')) return ROAD_STYLES.residential;
  if (type.includes('service')) return ROAD_STYLES.service;
  if (type.includes('path') || type.includes('foot')) return ROAD_STYLES.path;
  if (type.includes('cycle')) return ROAD_STYLES.cycleway;
  if (type.includes('rail')) return ROAD_STYLES.rail;

  return ROAD_STYLES.default;
}

/**
 * Create transportation layer meshes (roads, paths) from tile features
 */
export async function createTransportationForTile(
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<THREE.Group | null> {
  const scene = getScene();
  if (!scene) {
    console.warn('Scene not initialized');
    return null;
  }

  const features = await loadTransportationTile(tileX, tileY, tileZ);
  if (features.length === 0) {
    return null;
  }

  const group = new THREE.Group();
  group.name = `transportation-${tileZ}/${tileX}/${tileY}`;

  // Group features by color for batching
  const featuresByStyle = new Map<string, StyleGroup>();

  for (const feature of features) {
    // Only process line geometries (roads are LineStrings or MultiLineStrings)
    if (feature.type !== 'LineString' && feature.type !== 'MultiLineString') {
      continue;
    }

    // Skip connector layer (just junction points)
    if (feature.layer === 'connector') {
      continue;
    }

    // Only show road segments (skip rail, water, etc.)
    if (feature.properties?.subtype !== 'road') {
      continue;
    }

    // Skip underground/tunnel roads
    if (feature.properties?.is_tunnel === true ||
        feature.properties?.is_underground === true ||
        (typeof feature.properties?.level === 'number' && feature.properties.level < 0)) {
      continue;
    }

    const style = getRoadStyle(feature.properties);
    const key = `${style.color}_${style.width}`;

    if (!featuresByStyle.has(key)) {
      featuresByStyle.set(key, { style, features: [] });
    }
    featuresByStyle.get(key)!.features.push(feature);
  }

  // Create ribbon geometries for each style
  for (const { style, features: styleFeatures } of featuresByStyle.values()) {
    const geometries: THREE.BufferGeometry[] = [];

    for (const feature of styleFeatures) {
      try {
        if (feature.type === 'LineString') {
          const geom = createRoadRibbonGeometry(feature.coordinates as number[][], style.width);
          if (geom) geometries.push(geom);
        } else if (feature.type === 'MultiLineString') {
          for (const line of feature.coordinates as number[][][]) {
            const geom = createRoadRibbonGeometry(line, style.width);
            if (geom) geometries.push(geom);
          }
        }
      } catch {
        // Skip invalid geometries
        continue;
      }
    }

    if (geometries.length > 0) {
      let mergeSucceeded = false;
      try {
        const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
        if (merged) {
          // Use Mesh with ribbon geometry for proper road widths
          const mesh = new THREE.Mesh(merged, getMaterial(style.color));
          mesh.name = `roads-${style.color.toString(16)}`;
          mesh.renderOrder = 10; // Render after land layer (2), water (5), water_lines (6)
          group.add(mesh);
          mergeSucceeded = true;
        }
      } catch {
        // Fallback: add individually (geometries are still in use, don't dispose)
        for (const geom of geometries) {
          const mesh = new THREE.Mesh(geom, getMaterial(style.color));
          mesh.renderOrder = 10; // Render after land layer (2), water (5), water_lines (6)
          group.add(mesh);
        }
      }

      // Only dispose individual geometries if merge succeeded
      // (mergeGeometries creates a new geometry, so originals can be disposed)
      if (mergeSucceeded) {
        for (const geom of geometries) {
          geom.dispose();
        }
      }
    }
  }

  scene.add(group);
  return group;
}

/**
 * Create ribbon geometry from road coordinates with terrain-following elevation
 * Creates a flat ribbon (quad strip) along the road path with proper width
 */
function createRoadRibbonGeometry(
  coordinates: number[][],
  width: number
): THREE.BufferGeometry | null {
  if (!coordinates || coordinates.length < 2) return null;

  // Scale width based on road classification (width is in relative units, scale to meters)
  // Example: a motorway style width of 3.0 becomes ~15m of road when scaled
  const scaledWidth = width * 5;

  // Convert coordinates to world positions with terrain elevation
  const points: Array<{ x: number; y: number; z: number }> = [];
  for (const coord of coordinates) {
    const lng = coord[0];
    const lat = coord[1];
    const world = geoToWorld(lng, lat, 0);

    // Get terrain height at this position
    // Note: getTerrainHeight returns 0 if elevation tile isn't loaded yet.
    // Roads created before terrain data arrives will be flat, but this is
    // acceptable since tiles are recreated as the player moves around.
    let terrainHeight = 0;
    if (ELEVATION.TERRAIN_ENABLED) {
      terrainHeight = getTerrainHeight(lng, lat) * ELEVATION.VERTICAL_EXAGGERATION;
    }

    // Position road above terrain
    const y = terrainHeight + ROAD_TERRAIN_OFFSET;

    points.push({ x: world.x, y, z: world.z });
  }

  if (points.length < 2) return null;

  // Build ribbon geometry: for each point, create left and right vertices
  const vertices: number[] = [];
  const validPointIndices: number[] = []; // Track which points have valid vertices

  for (let i = 0; i < points.length; i++) {
    const curr = points[i];

    // Calculate direction vector for this point
    let dx: number, dz: number;

    if (i === 0) {
      // First point: use direction to next point
      dx = points[1].x - curr.x;
      dz = points[1].z - curr.z;
    } else if (i === points.length - 1) {
      // Last point: use direction from previous point
      dx = curr.x - points[i - 1].x;
      dz = curr.z - points[i - 1].z;
    } else {
      // Middle point: average of incoming and outgoing directions for smooth corners
      const dx1 = curr.x - points[i - 1].x;
      const dz1 = curr.z - points[i - 1].z;
      const dx2 = points[i + 1].x - curr.x;
      const dz2 = points[i + 1].z - curr.z;
      dx = dx1 + dx2;
      dz = dz1 + dz2;
    }

    // Normalize direction
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.001) {
      // Skip degenerate segments - don't add vertices
      continue;
    }

    dx /= len;
    dz /= len;

    // Perpendicular vector (rotate 90 degrees)
    const perpX = -dz;
    const perpZ = dx;

    // Create left and right vertices at half-width distance
    const halfWidth = scaledWidth / 2;

    // Track that we added vertices for this point
    validPointIndices.push(vertices.length / 6); // Current vertex pair index

    // Left vertex
    vertices.push(
      curr.x + perpX * halfWidth,
      curr.y,
      curr.z + perpZ * halfWidth
    );

    // Right vertex
    vertices.push(
      curr.x - perpX * halfWidth,
      curr.y,
      curr.z - perpZ * halfWidth
    );
  }

  // Need at least 2 valid points to form a quad
  if (validPointIndices.length < 2) return null;

  // Create triangle indices for the quad strip
  // Each pair of consecutive valid points creates 2 triangles (a quad)
  const indices: number[] = [];
  for (let i = 0; i < validPointIndices.length - 1; i++) {
    const baseIdx = i * 2;

    // First triangle (top-left, bottom-left, top-right)
    indices.push(baseIdx, baseIdx + 2, baseIdx + 1);

    // Second triangle (bottom-left, bottom-right, top-right)
    indices.push(baseIdx + 1, baseIdx + 2, baseIdx + 3);
  }

  if (vertices.length < 6 || indices.length < 3) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

/**
 * Remove transportation layer meshes for a tile and properly dispose all GPU resources
 * Note: Materials are cached globally and reused across tiles, so we only dispose geometries
 */
export function removeTransportationGroup(group: THREE.Group): void {
  if (!group) return;

  const scene = getScene();
  if (scene) {
    scene.remove(group);
  }

  let disposedGeometries = 0;

  // Dispose of geometries only - materials are cached and shared across tiles
  group.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;

      // Dispose geometry
      if (mesh.geometry) {
        mesh.geometry.dispose();
        disposedGeometries++;
      }

      // Don't dispose materials - they are cached in the materials Map
      // and shared across multiple road meshes/tiles
    }
  });

  // Clear the group's children array
  group.clear();
}
