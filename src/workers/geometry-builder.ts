/**
 * Geometry builder for web workers
 * Creates geometry buffers from parsed features without WebGL dependencies
 * Three.js geometry classes work in workers - they don't require WebGL context
 */

import * as THREE from 'three';
import type {
  ParsedFeature,
  SceneOrigin,
  GeometryBufferGroup,
  LineGeometryBufferGroup,
  BaseGeometryResult,
} from './types.js';

// Colors for different feature types (must match base-layer.ts)
const COLORS: Record<string, number> = {
  // Water types
  ocean: 0x1e5f8a,
  sea: 0x1e5f8a,
  lake: 0x2a7ab0,
  reservoir: 0x2a7ab0,
  pond: 0x3388bb,
  river: 0x2a7ab0,
  stream: 0x3388bb,
  canal: 0x2a7ab0,
  water: 0x1e5f8a,
  bathymetry: 0x1e5f8a,

  // Land cover types
  forest: 0x1a4d2e,
  wood: 0x1e5530,
  grass: 0x5a8f4a,
  shrub: 0x3a7a38,
  crop: 0x8fa858,
  barren: 0xa08060,
  wetland: 0x3a6848,
  swamp: 0x3a6848,
  mangrove: 0x2a5040,
  moss: 0x6a8a50,
  snow: 0xe8f0f8,
  urban: 0x6a6a6a,
  park: 0x4a8050,
  meadow: 0x5a8f4a,
  farmland: 0x8fa858,

  // Urban areas
  residential: 0x707070,
  commercial: 0x787878,
  industrial: 0x606060,

  // Defaults
  land: 0x8fa880,
  default: 0x8fa880,
  terrain: 0x8fa880,
};

// Layer configuration (must match base-layer.ts)
const LAYER_DEPTHS: Record<string, number> = {
  terrain: -5.0,
  bathymetry: -4.5,
  land: -4.0,
  land_cover: 0.3,
  land_use: 0.8,
  water: 1.0,
  water_lines: 1.5,
  default: 0.3,
};

const RENDER_ORDER: Record<string, number> = {
  terrain: 0,
  bathymetry: 1,
  land: 2,
  land_cover: 3,
  land_use: 4,
  water: 5,
  water_lines: 6,
  default: 3,
};

// Layers that follow terrain elevation
const TERRAIN_FOLLOWING_LAYERS = ['land_cover', 'land_use', 'water'];

// Water types to skip (covered by bathymetry)
const OCEAN_WATER_TYPES = ['ocean', 'sea', 'bay', 'strait', 'gulf', 'sound'];

// Linear water feature types
const LINEAR_WATER_TYPES = ['river', 'stream', 'canal', 'drain', 'ditch', 'waterway'];

// Bathymetry color stops
const BATHYMETRY_COLORS = [
  { depth: 0, color: { r: 0x4a, g: 0xb0, b: 0xd0 } },
  { depth: 200, color: { r: 0x3a, g: 0x9a, b: 0xc0 } },
  { depth: 1000, color: { r: 0x2a, g: 0x80, b: 0xb0 } },
  { depth: 2000, color: { r: 0x1e, g: 0x5f, b: 0x8a } },
  { depth: 4000, color: { r: 0x15, g: 0x45, b: 0x70 } },
  { depth: 6000, color: { r: 0x0d, g: 0x30, b: 0x55 } },
  { depth: 10000, color: { r: 0x08, g: 0x20, b: 0x40 } },
];

/**
 * Convert geographic coordinates to world coordinates
 * Matches scene.ts geoToWorld() logic
 */
function geoToWorld(
  lng: number,
  lat: number,
  altitude: number,
  origin: SceneOrigin
): { x: number; y: number; z: number } {
  const x = (lng - origin.lng) * origin.metersPerDegLng;
  const z = -(lat - origin.lat) * origin.metersPerDegLat;
  const y = altitude;
  return { x, y, z };
}

/**
 * Get bathymetry color based on depth
 */
function getBathymetryColor(depth: number): number {
  const clampedDepth = Math.max(0, Math.min(depth, 10000));

  let lowerStop = BATHYMETRY_COLORS[0];
  let upperStop = BATHYMETRY_COLORS[BATHYMETRY_COLORS.length - 1];

  for (let i = 0; i < BATHYMETRY_COLORS.length - 1; i++) {
    if (clampedDepth >= BATHYMETRY_COLORS[i].depth && clampedDepth <= BATHYMETRY_COLORS[i + 1].depth) {
      lowerStop = BATHYMETRY_COLORS[i];
      upperStop = BATHYMETRY_COLORS[i + 1];
      break;
    }
  }

  const range = upperStop.depth - lowerStop.depth;
  const t = range > 0 ? (clampedDepth - lowerStop.depth) / range : 0;

  const r = Math.round(lowerStop.color.r + t * (upperStop.color.r - lowerStop.color.r));
  const g = Math.round(lowerStop.color.g + t * (upperStop.color.g - lowerStop.color.g));
  const b = Math.round(lowerStop.color.b + t * (upperStop.color.b - lowerStop.color.b));

  return (r << 16) | (g << 8) | b;
}

/**
 * Get color for a feature based on layer and properties
 */
function getColorForFeature(layer: string, properties: Record<string, unknown>): number {
  const subtype = (
    properties.subtype ||
    properties.class ||
    properties.type ||
    properties.category ||
    ''
  ) as string;
  const type = subtype.toLowerCase();

  if (layer === 'bathymetry') {
    const depth = typeof properties.depth === 'number' ? properties.depth : 0;
    return getBathymetryColor(depth);
  }

  if (layer === 'land_cover') {
    return COLORS[type] ?? COLORS.grass;
  }

  if (type in COLORS) {
    return COLORS[type];
  }

  if (layer === 'water') return COLORS.water;
  if (layer === 'land') return COLORS.land;

  if (layer === 'land_use') {
    if (type.includes('forest') || type.includes('wood')) return COLORS.forest;
    if (type.includes('park') || type.includes('recreation')) return COLORS.park;
    if (type.includes('grass') || type.includes('green') || type.includes('meadow')) return COLORS.grass;
    if (type.includes('farm') || type.includes('orchard') || type.includes('vineyard')) return COLORS.crop;
    if (type.includes('water') || type.includes('basin')) return COLORS.water;
    if (type.includes('residential')) return COLORS.residential;
    if (type.includes('commercial') || type.includes('retail')) return COLORS.commercial;
    if (type.includes('industrial')) return COLORS.industrial;
    if (type.includes('cemetery') || type.includes('grave')) return COLORS.grass;
    return COLORS.land;
  }

  return COLORS.default;
}

/**
 * Calculate signed area of a 2D polygon
 */
function calculatePolygonArea(points: THREE.Vector2[]): number {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  }
  return area / 2;
}

/**
 * Create polygon geometry and extract buffers
 * Returns null for invalid geometries
 */
function createPolygonBuffers(
  coordinates: number[][][],
  layer: string,
  yOffset: number,
  origin: SceneOrigin
): { positions: Float32Array; indices: Uint32Array; normals: Float32Array } | null {
  if (!coordinates || coordinates.length === 0) return null;

  const outerRing = coordinates[0];
  if (!outerRing || outerRing.length < 3) return null;

  // Convert outer ring to 2D points for shape creation
  const points: THREE.Vector2[] = [];
  for (const coord of outerRing) {
    const world = geoToWorld(coord[0], coord[1], 0, origin);
    points.push(new THREE.Vector2(world.x, -world.z));
  }

  // Remove duplicate last point
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.abs(first.x - last.x) < 0.01 && Math.abs(first.y - last.y) < 0.01) {
      points.pop();
    }
  }

  if (points.length < 3) return null;

  // Check for valid area
  const area = calculatePolygonArea(points);
  if (Math.abs(area) < 1) return null;

  // Ensure counter-clockwise winding
  if (area > 0) {
    points.reverse();
  }

  try {
    const shape = new THREE.Shape(points);

    // Add holes
    for (let i = 1; i < coordinates.length; i++) {
      const holeRing = coordinates[i];
      if (!holeRing || holeRing.length < 3) continue;

      const holePoints: THREE.Vector2[] = [];
      for (const coord of holeRing) {
        const world = geoToWorld(coord[0], coord[1], 0, origin);
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

      if (holePoints.length >= 3) {
        const holeArea = calculatePolygonArea(holePoints);
        if (holeArea < 0) {
          holePoints.reverse();
        }
        shape.holes.push(new THREE.Path(holePoints));
      }
    }

    // Create geometry
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);

    // For non-terrain-following layers, set Y directly
    // For terrain-following, Y will be adjusted on main thread
    const isTerrainFollowing = TERRAIN_FOLLOWING_LAYERS.includes(layer);
    if (!isTerrainFollowing) {
      const positions = geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        positions.setY(i, yOffset);
      }
      positions.needsUpdate = true;
    }

    geometry.computeVertexNormals();

    // Extract typed arrays
    const posArray = geometry.attributes.position.array as Float32Array;
    const normArray = geometry.attributes.normal.array as Float32Array;
    const indexArray = geometry.index?.array as Uint32Array | Uint16Array;

    // Convert to Uint32Array if needed
    const indices = indexArray instanceof Uint32Array
      ? new Uint32Array(indexArray)
      : new Uint32Array(indexArray);

    // Clone arrays (geometry will be disposed)
    const positions = new Float32Array(posArray);
    const normals = new Float32Array(normArray);

    geometry.dispose();

    return { positions, indices, normals };
  } catch {
    return null;
  }
}

/**
 * Create water line geometry buffers
 */
function createWaterLineBuffers(
  coordinates: number[][],
  yOffset: number,
  origin: SceneOrigin
): Float32Array | null {
  if (!coordinates || coordinates.length < 2) return null;

  // Convert to world positions
  const worldPoints: { x: number; y: number; z: number }[] = [];
  for (const coord of coordinates) {
    const world = geoToWorld(coord[0], coord[1], 0, origin);
    worldPoints.push({ x: world.x, y: yOffset, z: world.z });
  }

  if (worldPoints.length < 2) return null;

  // Create segment pairs for LineSegments
  const positions: number[] = [];
  for (let i = 0; i < worldPoints.length - 1; i++) {
    const p1 = worldPoints[i];
    const p2 = worldPoints[i + 1];
    positions.push(p1.x, p1.y, p1.z);
    positions.push(p2.x, p2.y, p2.z);
  }

  return new Float32Array(positions);
}

/**
 * Feature group for batching
 */
interface FeatureGroup {
  color: number;
  layer: string;
  features: ParsedFeature[];
}

/**
 * Build all geometry for base layer features
 * Returns transferable typed arrays for each geometry group
 */
export function buildBaseGeometry(
  features: ParsedFeature[],
  origin: SceneOrigin
): BaseGeometryResult {
  const polygonGroups: GeometryBufferGroup[] = [];
  const lineGroups: LineGeometryBufferGroup[] = [];

  // Check if we have lower zoom water polygons (which cover full river width)
  // If present, skip rendering thin water line strings to avoid z-fighting
  const hasLowerZoomWaterPolygons = features.some(
    (f) =>
      (f.type === 'Polygon' || f.type === 'MultiPolygon') &&
      f.layer === 'water' &&
      f.properties?._fromLowerZoom === true
  );

  // Group features by color+layer
  const featuresByColorAndLayer = new Map<string, FeatureGroup>();
  const lineFeaturesByColor = new Map<number, ParsedFeature[]>();

  for (const feature of features) {
    const layer = feature.layer || 'default';
    const color = getColorForFeature(layer, feature.properties);

    if (feature.type === 'Polygon' || feature.type === 'MultiPolygon') {
      // Skip ocean types (covered by bathymetry)
      if (layer === 'water') {
        const subtype = String(feature.properties?.subtype || feature.properties?.class || '').toLowerCase();
        if (OCEAN_WATER_TYPES.includes(subtype)) continue;
        // Skip river polygons unless from lower zoom
        const isFromLowerZoom = feature.properties?._fromLowerZoom === true;
        if (LINEAR_WATER_TYPES.includes(subtype) && !isFromLowerZoom) continue;
      }

      const key = `${color}-${layer}`;
      if (!featuresByColorAndLayer.has(key)) {
        featuresByColorAndLayer.set(key, { color, layer, features: [] });
      }
      featuresByColorAndLayer.get(key)!.features.push(feature);
    } else if (feature.type === 'LineString' || feature.type === 'MultiLineString') {
      // Only process water lines if we don't have lower zoom polygons
      if (layer === 'water' && !hasLowerZoomWaterPolygons) {
        const subtype = String(feature.properties?.subtype || feature.properties?.class || '').toLowerCase();
        if (LINEAR_WATER_TYPES.includes(subtype)) {
          if (!lineFeaturesByColor.has(color)) {
            lineFeaturesByColor.set(color, []);
          }
          lineFeaturesByColor.get(color)!.push(feature);
        }
      }
    }
  }

  // Process polygon groups
  for (const [, { color, layer, features: layerFeatures }] of featuresByColorAndLayer) {
    const allPositions: number[] = [];
    const allIndices: number[] = [];
    const allNormals: number[] = [];
    let vertexOffset = 0;

    const yOffset = LAYER_DEPTHS[layer] ?? LAYER_DEPTHS.default;

    for (const feature of layerFeatures) {
      try {
        const coords =
          feature.type === 'Polygon'
            ? [feature.coordinates as number[][][]]
            : (feature.coordinates as number[][][][]);

        for (const polygon of coords) {
          const buffers = createPolygonBuffers(polygon, layer, yOffset, origin);
          if (buffers) {
            // Append positions
            for (let i = 0; i < buffers.positions.length; i++) {
              allPositions.push(buffers.positions[i]);
            }

            // Append indices with offset
            for (let i = 0; i < buffers.indices.length; i++) {
              allIndices.push(buffers.indices[i] + vertexOffset);
            }

            // Append normals
            for (let i = 0; i < buffers.normals.length; i++) {
              allNormals.push(buffers.normals[i]);
            }

            vertexOffset += buffers.positions.length / 3;
          }
        }
      } catch {
        // Skip invalid geometries
      }
    }

    if (allPositions.length > 0) {
      polygonGroups.push({
        layer,
        color,
        positions: new Float32Array(allPositions),
        indices: new Uint32Array(allIndices),
        normals: new Float32Array(allNormals),
        terrainFollowing: TERRAIN_FOLLOWING_LAYERS.includes(layer),
        yOffset,
        renderOrder: RENDER_ORDER[layer] ?? RENDER_ORDER.default,
      });
    }
  }

  // Process line groups
  for (const [color, lineFeatures] of lineFeaturesByColor) {
    const allPositions: number[] = [];
    const yOffset = LAYER_DEPTHS.water_lines;

    for (const feature of lineFeatures) {
      try {
        const coords =
          feature.type === 'LineString'
            ? [feature.coordinates as number[][]]
            : (feature.coordinates as number[][][]);

        for (const line of coords) {
          const positions = createWaterLineBuffers(line, yOffset, origin);
          if (positions) {
            for (let i = 0; i < positions.length; i++) {
              allPositions.push(positions[i]);
            }
          }
        }
      } catch {
        // Skip invalid geometries
      }
    }

    if (allPositions.length > 0) {
      lineGroups.push({
        layer: 'water_lines',
        color,
        positions: new Float32Array(allPositions),
        yOffset,
        renderOrder: RENDER_ORDER.water_lines,
      });
    }
  }

  return { polygonGroups, lineGroups };
}

/**
 * Get all transferable buffers from a geometry result
 * Used for zero-copy transfer via postMessage
 */
export function getTransferableBuffers(result: BaseGeometryResult): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];

  for (const group of result.polygonGroups) {
    // Validate that buffer properties are actually ArrayBuffers before adding
    if (group.positions.buffer instanceof ArrayBuffer) {
      buffers.push(group.positions.buffer);
    }
    if (group.indices.buffer instanceof ArrayBuffer) {
      buffers.push(group.indices.buffer);
    }
    if (group.normals.buffer instanceof ArrayBuffer) {
      buffers.push(group.normals.buffer);
    }
  }

  for (const group of result.lineGroups) {
    if (group.positions.buffer instanceof ArrayBuffer) {
      buffers.push(group.positions.buffer);
    }
  }

  return buffers;
}
