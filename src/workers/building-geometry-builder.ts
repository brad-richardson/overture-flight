/**
 * Building geometry builder for web workers
 * Creates 3D building geometry without Three.js ExtrudeGeometry dependency
 * Uses earcut for polygon triangulation (roof) and manual wall quad generation
 *
 * Known trade-offs vs main thread implementation:
 * - Material uniformity: All buildings share the same vertexColorMaterial properties
 *   (roughness=0.75, metalness=0.1). Main thread can use category-specific materials.
 *   Color variation is preserved via vertex colors from the shared palette.
 * - Data transfer: Feature data is structured-cloned to worker. For tiles with many
 *   buildings, this can cause brief main thread overhead before worker processing begins.
 * - Floating origin: Geometry is generated relative to the scene origin at request time.
 *   If origin shifts during async processing, geometry may be slightly misaligned.
 *   This is acceptable for typical flight sim movement speeds.
 */

import earcut from 'earcut';
import type {
  SceneOrigin,
  BuildingFeatureInput,
  CreateBuildingGeometryPayload,
  CreateBuildingGeometryResult,
  BuildingGeometryBuffers,
} from './types.js';
import { getBuildingColor as getColor } from '../building-colors.js';

// LOD level (must match buildings.ts) - used for skipping small buildings and holes at far distances
const LOD_LOW = 2;

const BUILDING_TERRAIN_OFFSET = 0.5;
const SLOPE_COMPENSATION_FACTOR = 0.3;
const MIN_BUILDING_AREA_FAR = 50; // m^2

/**
 * Convert geographic coordinates to world coordinates
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
 * Calculate signed area of a 2D polygon
 * Positive = clockwise, Negative = counter-clockwise
 */
function calculatePolygonArea(points: { x: number; z: number }[]): number {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j].x + points[i].x) * (points[j].z - points[i].z);
  }
  return area / 2;
}

/**
 * Get building height from properties
 */
function getBuildingHeight(
  properties: BuildingFeatureInput['properties'],
  defaultHeight: number
): number {
  // Try explicit height first
  if (typeof properties.height === 'number' && properties.height > 0) {
    return properties.height;
  }

  // Calculate from floors (3m per floor is typical)
  if (typeof properties.num_floors === 'number' && properties.num_floors > 0) {
    return properties.num_floors * 3;
  }

  return defaultHeight;
}

/**
 * Get building color from feature using shared color logic
 * Uses deterministic seeded random for consistent colors
 */
function getBuildingColor(feature: BuildingFeatureInput): number {
  return getColor({
    type: feature.type,
    coordinates: feature.coordinates,
    properties: feature.properties,
  });
}

/**
 * Generate building geometry for a single polygon
 * Returns null for invalid/too-small geometries
 */
function generateBuildingGeometry(
  coordinates: number[][][],
  height: number,
  minHeight: number,
  color: number,
  lodLevel: number,
  terrainHeight: number,
  terrainSlope: number,
  verticalExaggeration: number,
  origin: SceneOrigin
): {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
} | null {
  if (!coordinates || coordinates.length === 0) return null;

  const outerRing = coordinates[0];
  if (!outerRing || outerRing.length < 3) return null;

  // Convert to world coordinates
  // Main thread uses Vector2(world.x, -world.z) then rotateX(-PI/2) which gives final z = world.z
  // Worker builds geometry directly in 3D, so we use world.z directly (no rotation step)
  let points: { x: number; z: number }[] = [];
  for (const coord of outerRing) {
    const world = geoToWorld(coord[0], coord[1], 0, origin);
    points.push({ x: world.x, z: world.z });
  }

  // Remove duplicate last point if present
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.abs(first.x - last.x) < 0.01 && Math.abs(first.z - last.z) < 0.01) {
      points.pop();
    }
  }

  if (points.length < 3) return null;

  // Calculate area
  const area = calculatePolygonArea(points);
  if (Math.abs(area) < 1) return null;

  // Skip small buildings at far distances
  if (lodLevel === LOD_LOW && Math.abs(area) < MIN_BUILDING_AREA_FAR) {
    return null;
  }

  // Simplification disabled - caused visual artifacts (jagged edges)
  // Modern GPUs handle the extra vertices fine

  if (points.length < 3) return null;

  // Recalculate area
  const finalArea = calculatePolygonArea(points);
  if (Math.abs(finalArea) < 1) return null;

  // Ensure counter-clockwise winding (for correct normals when viewed from +Y)
  // Worker uses z = world.z directly, while main thread uses y = -world.z
  // This inverts the sign of the shoelace formula, so:
  // - Main thread: area < 0 means CW, reverse to get CCW
  // - Worker: area > 0 means CW (opposite sign), reverse to get CCW
  if (finalArea > 0) {
    points.reverse();
  }

  // Calculate base and top Y positions
  const baseY = terrainHeight * verticalExaggeration + BUILDING_TERRAIN_OFFSET - terrainSlope * SLOPE_COMPENSATION_FACTOR;
  const topY = baseY + height;
  const bottomY = baseY + minHeight; // For buildings with min_height (floating bases)

  // Flatten points for earcut (x, z format)
  const flatCoords: number[] = [];
  for (const p of points) {
    flatCoords.push(p.x, p.z);
  }

  // Process holes (skip for LOW LOD)
  // Track hole start indices and vertex counts for wall generation
  const holes: number[] = [];
  const holeVertexCounts: number[] = [];
  if (lodLevel !== LOD_LOW && coordinates.length > 1) {
    for (let i = 1; i < coordinates.length; i++) {
      const holeRing = coordinates[i];
      if (!holeRing || holeRing.length < 3) continue;

      holes.push(flatCoords.length / 2); // Start index of hole

      // Use world.z directly (same as outer ring - no rotation in worker)
      let holePoints: { x: number; z: number }[] = [];
      for (const coord of holeRing) {
        const world = geoToWorld(coord[0], coord[1], 0, origin);
        holePoints.push({ x: world.x, z: world.z });
      }

      // Remove duplicate last point
      if (holePoints.length > 1) {
        const first = holePoints[0];
        const last = holePoints[holePoints.length - 1];
        if (Math.abs(first.x - last.x) < 0.01 && Math.abs(first.z - last.z) < 0.01) {
          holePoints.pop();
        }
      }

      // Holes should be clockwise (opposite winding from outer ring which is CCW)
      // Same sign inversion as outer ring: worker uses z directly, main thread uses -z
      // So worker reverses when area < 0 (opposite of main thread's > 0 check)
      const holeArea = calculatePolygonArea(holePoints);
      if (holeArea < 0) {
        holePoints.reverse();
      }

      // Track actual vertex count after processing
      holeVertexCounts.push(holePoints.length);

      for (const p of holePoints) {
        flatCoords.push(p.x, p.z);
      }
    }
  }

  // Triangulate roof using earcut
  const roofIndices = earcut(flatCoords, holes, 2);
  if (roofIndices.length === 0) return null;

  // Extract vertex positions from flatCoords
  const vertexCount = flatCoords.length / 2;
  const roofVertices: { x: number; z: number }[] = [];
  for (let i = 0; i < vertexCount; i++) {
    roofVertices.push({
      x: flatCoords[i * 2],
      z: flatCoords[i * 2 + 1],
    });
  }

  // Build geometry buffers
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // Extract RGB from hex color
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;

  // === ROOF (top face) ===
  const roofStartIndex = positions.length / 3;
  for (const v of roofVertices) {
    positions.push(v.x, topY, v.z);
    normals.push(0, 1, 0); // Up
    colors.push(r, g, b);
  }
  // Reverse triangle winding for correct face culling when viewed from above
  // Earcut produces CCW triangles in 2D (x,z), but Three.js needs them reversed
  // for front-face visibility when looking down from +Y
  for (let i = 0; i < roofIndices.length; i += 3) {
    indices.push(roofStartIndex + roofIndices[i]);
    indices.push(roofStartIndex + roofIndices[i + 2]);
    indices.push(roofStartIndex + roofIndices[i + 1]);
  }

  // === BOTTOM (base face, if minHeight > 0 for floating buildings) ===
  if (minHeight > 0) {
    const bottomStartIndex = positions.length / 3;
    for (const v of roofVertices) {
      positions.push(v.x, bottomY, v.z);
      normals.push(0, -1, 0); // Down
      colors.push(r * 0.7, g * 0.7, b * 0.7); // Darker
    }
    // Reverse winding for bottom face
    for (let i = roofIndices.length - 1; i >= 0; i--) {
      indices.push(bottomStartIndex + roofIndices[i]);
    }
  }

  // === WALLS ===
  // Use only outer ring points for walls (index 0 to points.length)
  const outerPointCount = points.length;
  const wallDarkening = 0.85; // Slightly darker walls

  for (let i = 0; i < outerPointCount; i++) {
    const p0 = points[i];
    const p1 = points[(i + 1) % outerPointCount];

    // Calculate wall normal (perpendicular to wall segment)
    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.01) continue; // Skip degenerate segments

    // Normal pointing outward: perpendicular to travel direction, 90° clockwise
    // For CCW polygon (when viewed from +Y), this points outward
    // 90° clockwise rotation of (dx, dz) is (dz, -dx)
    const nx = dz / len;
    const nz = -dx / len;

    const wallStartIndex = positions.length / 3;

    // Four vertices per wall quad: bottom-left, bottom-right, top-right, top-left
    // Using bottomY for base (or baseY if no minHeight)
    const wallBaseY = minHeight > 0 ? bottomY : baseY;

    positions.push(p0.x, wallBaseY, p0.z); // 0: bottom-left
    positions.push(p1.x, wallBaseY, p1.z); // 1: bottom-right
    positions.push(p1.x, topY, p1.z);      // 2: top-right
    positions.push(p0.x, topY, p0.z);      // 3: top-left

    for (let j = 0; j < 4; j++) {
      normals.push(nx, 0, nz);
      colors.push(r * wallDarkening, g * wallDarkening, b * wallDarkening);
    }

    // Two triangles with CCW winding when viewed from outside: (0,3,2) and (0,2,1)
    indices.push(wallStartIndex + 0, wallStartIndex + 3, wallStartIndex + 2);
    indices.push(wallStartIndex + 0, wallStartIndex + 2, wallStartIndex + 1);
  }

  // Add walls for holes (only for higher LOD)
  // Use tracked hole vertex counts from earcut setup (after simplification/dedup)
  if (lodLevel !== LOD_LOW && holeVertexCounts.length > 0) {
    let holeStartIdx = outerPointCount;
    for (let h = 0; h < holeVertexCounts.length; h++) {
      const holeVertexCount = holeVertexCounts[h];

      for (let i = 0; i < holeVertexCount; i++) {
        const idx0 = holeStartIdx + i;
        const idx1 = holeStartIdx + ((i + 1) % holeVertexCount);
        if (idx0 >= roofVertices.length || idx1 >= roofVertices.length) break;

        const p0 = roofVertices[idx0];
        const p1 = roofVertices[idx1];

        const dx = p1.x - p0.x;
        const dz = p1.z - p0.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len < 0.01) continue;

        // Normal pointing inward for holes (opposite of outer walls)
        // Holes are CW when viewed from above, so 90° CCW rotation points inward
        // 90° counter-clockwise rotation of (dx, dz) is (-dz, dx)
        const nx = -dz / len;
        const nz = dx / len;

        const wallStartIndex = positions.length / 3;
        const wallBaseY = minHeight > 0 ? bottomY : baseY;

        positions.push(p0.x, wallBaseY, p0.z);
        positions.push(p1.x, wallBaseY, p1.z);
        positions.push(p1.x, topY, p1.z);
        positions.push(p0.x, topY, p0.z);

        for (let j = 0; j < 4; j++) {
          normals.push(nx, 0, nz);
          colors.push(r * wallDarkening, g * wallDarkening, b * wallDarkening);
        }

        // Two triangles with CCW winding when viewed from inside (hole walls face inward)
        indices.push(wallStartIndex + 0, wallStartIndex + 3, wallStartIndex + 2);
        indices.push(wallStartIndex + 0, wallStartIndex + 2, wallStartIndex + 1);
      }

      holeStartIdx += holeVertexCount;
    }
  }

  return { positions, normals, colors, indices };
}

/**
 * Build geometry for all buildings in a tile
 * Returns geometry buffers ready for GPU upload
 */
export function buildBuildingGeometry(
  payload: CreateBuildingGeometryPayload
): CreateBuildingGeometryResult {
  const {
    features,
    origin,
    lodLevel,
    defaultHeight,
    terrainHeights,
    verticalExaggeration,
  } = payload;

  const allPositions: number[] = [];
  const allNormals: number[] = [];
  const allColors: number[] = [];
  const allIndices: number[] = [];
  let vertexOffset = 0;

  let buildingsProcessed = 0;
  let buildingsSkipped = 0;

  for (let i = 0; i < features.length; i++) {
    const feature = features[i];

    // Skip underground buildings
    if (feature.properties.is_underground) {
      buildingsSkipped++;
      continue;
    }

    // Skip main building footprints that have parts - only render the parts
    // This prevents z-fighting between main footprint and building_part features
    if (feature.properties.has_parts === true) {
      buildingsSkipped++;
      continue;
    }

    // Get polygon coordinates
    const polygons = feature.type === 'Polygon'
      ? [feature.coordinates as number[][][]]
      : feature.coordinates as number[][][][];

    // Get building properties
    const height = getBuildingHeight(feature.properties, defaultHeight);
    const minHeight = typeof feature.properties.min_height === 'number'
      ? feature.properties.min_height : 0;
    const color = getBuildingColor(feature);

    // Get terrain height
    const terrainData = terrainHeights?.[i];
    const terrainHeight = terrainData ? terrainData[0] : 0;
    const terrainSlope = terrainData ? (terrainData[1] - terrainData[0]) : 0;

    for (const polygon of polygons) {
      if (!polygon || !polygon[0] || polygon[0].length < 3) continue;

      try {
        const geom = generateBuildingGeometry(
          polygon,
          height,
          minHeight,
          color,
          lodLevel,
          terrainHeight,
          terrainSlope,
          verticalExaggeration,
          origin
        );

        if (geom) {
          // Append positions
          for (const v of geom.positions) {
            allPositions.push(v);
          }

          // Append normals
          for (const n of geom.normals) {
            allNormals.push(n);
          }

          // Append colors
          for (const c of geom.colors) {
            allColors.push(c);
          }

          // Append indices with offset
          for (const idx of geom.indices) {
            allIndices.push(idx + vertexOffset);
          }

          vertexOffset += geom.positions.length / 3;
          buildingsProcessed++;
        } else {
          buildingsSkipped++;
        }
      } catch {
        buildingsSkipped++;
      }
    }
  }


  // Create result
  if (allPositions.length === 0) {
    return {
      geometry: null,
      stats: {
        buildingsProcessed: 0,
        buildingsSkipped: buildingsSkipped,
        totalVertices: 0,
        totalTriangles: 0,
      },
    };
  }

  const geometry: BuildingGeometryBuffers = {
    positions: new Float32Array(allPositions),
    normals: new Float32Array(allNormals),
    colors: new Float32Array(allColors),
    indices: new Uint32Array(allIndices),
  };

  return {
    geometry,
    stats: {
      buildingsProcessed,
      buildingsSkipped,
      totalVertices: allPositions.length / 3,
      totalTriangles: allIndices.length / 3,
    },
  };
}

/**
 * Get transferable buffers from building geometry result
 * Note: TypedArray.buffer returns ArrayBufferLike, cast needed for transfer list
 */
export function getBuildingTransferables(result: CreateBuildingGeometryResult): ArrayBuffer[] {
  if (!result.geometry) return [];

  return [
    result.geometry.positions.buffer as ArrayBuffer,
    result.geometry.normals.buffer as ArrayBuffer,
    result.geometry.colors.buffer as ArrayBuffer,
    result.geometry.indices.buffer as ArrayBuffer,
  ];
}
