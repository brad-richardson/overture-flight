import * as THREE from 'three';
import { getScene, geoToWorld, worldToGeo, BufferGeometryUtils, getSceneOriginForWorker } from './scene.js';
import { loadBaseTile, loadWaterPolygonsFromLowerZooms } from './tile-manager.js';
import { getTerrainHeight } from './elevation.js';
import { ELEVATION, WORKERS } from './constants.js';
import { storeFeatures, removeStoredFeatures } from './feature-picker.js';
import type { StoredFeature } from './feature-picker.js';
import { getGeometryWorkerPool } from './workers/index.js';
import type { GeometryBufferGroup, LineGeometryBufferGroup } from './workers/types.js';

// Types
interface ParsedFeature {
  type: string;
  coordinates: number[] | number[][] | number[][][] | number[][][][];
  properties: Record<string, unknown>;
  layer: string;
}

interface FeatureGroup {
  color: number;
  layer: string;
  features: ParsedFeature[];
}

// Colors for different feature types (Overture-inspired, darkened for flight sim)
const COLORS: Record<string, number> = {
  // Water types - blue tones
  ocean: 0x1e5f8a,
  sea: 0x1e5f8a,
  lake: 0x2a7ab0,
  reservoir: 0x2a7ab0,
  pond: 0x3388bb,
  river: 0x2a7ab0,
  stream: 0x3388bb,
  canal: 0x2a7ab0,
  water: 0x1e5f8a,

  // Bathymetry - depth-based colors (set via getBathymetryColor function)
  bathymetry: 0x1e5f8a,

  // Land cover types from Overture schema - distinct colors for each
  // https://docs.overturemaps.org/schema/reference/base/land_cover/
  forest: 0x1a4d2e,     // Deep forest green
  wood: 0x1e5530,       // Dense woodland green (similar to forest)
  grass: 0x5a8f4a,      // Bright meadow green
  shrub: 0x3a7a38,      // Green scrubland (brighter green)
  crop: 0x8fa858,       // Golden agricultural fields
  barren: 0xa08060,     // Sandy/rocky brown
  wetland: 0x3a6848,    // Swampy green (more green, less teal)
  swamp: 0x3a6848,      // Alias for wetland
  mangrove: 0x2a5040,   // Dark muddy green
  moss: 0x6a8a50,       // Yellow-green moss
  snow: 0xe8f0f8,       // Bright snow white
  urban: 0x6a6a6a,      // Urban gray

  // Additional land cover variations
  park: 0x4a8050,       // Park green (slightly brighter)
  meadow: 0x5a8f4a,     // Same as grass
  farmland: 0x8fa858,   // Same as crop

  // Urban/developed areas - gray tones (land_use layer)
  residential: 0x707070,
  commercial: 0x787878,
  industrial: 0x606060,

  // Default land - greenish-gray that blends with forest/grass areas
  land: 0x8fa880,
  default: 0x8fa880,

  // Terrain mesh base color - greenish-gray that blends with forest/grass areas
  terrain: 0x8fa880
};

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

// Render order for proper layering (higher = rendered later = on top)
const RENDER_ORDER: Record<string, number> = {
  terrain: 0,
  bathymetry: 1,
  land: 2,
  land_cover: 3,
  land_use: 4,
  water: 5,
  water_lines: 6,
  default: 3
};

// Layers that should follow terrain elevation
// Water bodies (lakes, ponds) follow terrain; land is a fixed base fill layer
const TERRAIN_FOLLOWING_LAYERS = ['land_cover', 'land_use', 'water'];

// Layers to skip rendering entirely
const SKIP_LAYERS: string[] = [];

// Bathymetry depth color stops (depth in meters -> color)
// Lighter colors for shallow waters, darker for deep
// Note: Overture Maps bathymetry uses positive depth values representing
// magnitude below sea level (e.g., 2000 = 2000m deep), not negative elevations
const BATHYMETRY_COLORS = [
  { depth: 0, color: { r: 0x4a, g: 0xb0, b: 0xd0 } },      // Very shallow: light cyan-blue
  { depth: 200, color: { r: 0x3a, g: 0x9a, b: 0xc0 } },    // Shallow: cyan-blue
  { depth: 1000, color: { r: 0x2a, g: 0x80, b: 0xb0 } },   // Medium: ocean blue
  { depth: 2000, color: { r: 0x1e, g: 0x5f, b: 0x8a } },   // Deep: standard ocean
  { depth: 4000, color: { r: 0x15, g: 0x45, b: 0x70 } },   // Very deep: dark blue
  { depth: 6000, color: { r: 0x0d, g: 0x30, b: 0x55 } },   // Abyssal: very dark blue
  { depth: 10000, color: { r: 0x08, g: 0x20, b: 0x40 } },  // Hadal: near-black blue
];

/**
 * Get color for bathymetry feature based on depth
 * Uses linear interpolation between color stops
 * @param depth - Positive depth value in meters below sea level (0-10000)
 */
function getBathymetryColor(depth: number): number {
  // Clamp depth to our range
  const clampedDepth = Math.max(0, Math.min(depth, 10000));

  // Find the two color stops to interpolate between
  let lowerStop = BATHYMETRY_COLORS[0];
  let upperStop = BATHYMETRY_COLORS[BATHYMETRY_COLORS.length - 1];

  for (let i = 0; i < BATHYMETRY_COLORS.length - 1; i++) {
    if (clampedDepth >= BATHYMETRY_COLORS[i].depth && clampedDepth <= BATHYMETRY_COLORS[i + 1].depth) {
      lowerStop = BATHYMETRY_COLORS[i];
      upperStop = BATHYMETRY_COLORS[i + 1];
      break;
    }
  }

  // Calculate interpolation factor
  const range = upperStop.depth - lowerStop.depth;
  const t = range > 0 ? (clampedDepth - lowerStop.depth) / range : 0;

  // Linearly interpolate each color component
  const r = Math.round(lowerStop.color.r + t * (upperStop.color.r - lowerStop.color.r));
  const g = Math.round(lowerStop.color.g + t * (upperStop.color.g - lowerStop.color.g));
  const b = Math.round(lowerStop.color.b + t * (upperStop.color.b - lowerStop.color.b));

  return (r << 16) | (g << 8) | b;
}

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
 * Get color for a feature based on its layer and subtype
 * Uses Overture Maps schema properties for accurate styling
 */
function getColorForFeature(layer: string, properties: Record<string, unknown>): number {
  // Try multiple possible property names for subtype
  const subtype = (
    properties.subtype ||
    properties.class ||
    properties.type ||
    properties.category ||
    ''
  ) as string;
  const type = subtype.toLowerCase();

  // Handle bathymetry layer with depth-based coloring
  if (layer === 'bathymetry') {
    const depth = typeof properties.depth === 'number' ? properties.depth : 0;
    return getBathymetryColor(depth);
  }

  // For land_cover, check the type against our colors
  if (layer === 'land_cover') {
    // Return color if we have it, otherwise fall back to grass
    if (COLORS[type]) {
      return COLORS[type];
    }
    return COLORS.grass;
  }

  // Check for specific subtype first (works for all layers)
  if (COLORS[type]) {
    return COLORS[type];
  }

  // Layer-specific handling
  if (layer === 'water') {
    return COLORS.water;
  }

  if (layer === 'land') {
    // Base land polygons
    return COLORS.land;
  }

  if (layer === 'land_use') {
    // Try to map land use types to appropriate colors
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

  // Track if we found covering water polygons - if so, we'll skip rendering river LineStrings
  let hasLowerZoomWaterPolygons = false;

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
      hasLowerZoomWaterPolygons = true;
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
    // Try worker-based geometry creation first (better parallelism)
    const workerHandled = await tryWorkerGeometry(features, group, tileX, tileY, tileZ);

    if (!workerHandled) {
      // Fallback: Main thread geometry creation
      // Group polygon features by color AND layer for proper z-fighting prevention
      // Key format: "color-layer" to separate water from land even if same color
      const featuresByColorAndLayer = new Map<string, FeatureGroup>();
      // Group line features (rivers, streams) by color
      const lineFeaturesByColor = new Map<number, ParsedFeature[]>();

      for (const feature of features) {
        const layer = feature.layer || 'default';

        // Skip layers that are redundant with terrain mesh
        if (SKIP_LAYERS.includes(layer)) {
          continue;
        }

        const color = getColorForFeature(layer, feature.properties);

        if (feature.type === 'Polygon' || feature.type === 'MultiPolygon') {
          // Skip ocean-type water features - bathymetry layer already covers these areas
          // Also skip river/stream polygons - we render these as lines instead to avoid double-render
          // Keep all other water types (including unknown subtypes) to ensure inland water renders
          if (layer === 'water') {
            const subtype = String(feature.properties?.subtype || feature.properties?.class || '').toLowerCase();
            // Skip only explicitly ocean types (covered by bathymetry)
            if (OCEAN_WATER_TYPES.includes(subtype)) {
              continue;
            }
            // Skip river/stream polygons UNLESS they come from lower zoom levels
            // Lower zoom polygons represent the actual water body extent (bank to bank)
            // while high-zoom river polygons are often just centerline buffers
            const isFromLowerZoom = feature.properties?._fromLowerZoom === true;
            if (LINEAR_WATER_TYPES.includes(subtype) && !isFromLowerZoom) {
              continue;
            }
            // All other water types (lakes, ponds, unknown subtypes, untyped) are kept
            // as are river polygons from lower zoom levels (full water body extent)
          }

          const key = `${color}-${layer}`;
          if (!featuresByColorAndLayer.has(key)) {
            featuresByColorAndLayer.set(key, { color, layer, features: [] });
          }
          featuresByColorAndLayer.get(key)!.features.push(feature);
        } else if (feature.type === 'LineString' || feature.type === 'MultiLineString') {
          // Process line features for water - only rivers, streams, and canals
          // Skip coastlines and shorelines which create artifacts around islands
          // Also skip if we have covering water polygons from lower zoom levels
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

    // Layers that should NOT be merged (render individually to prevent z-fighting artifacts)
    // Only water and bathymetry need individual rendering (overlapping ocean polygons)
    // land_cover and land_use can be merged for better performance since they don't overlap within themselves
    const NO_MERGE_LAYERS = ['water', 'bathymetry'];

    // Create geometry for each color+layer combination (polygons)
    for (const [, { color, layer, features: layerFeatures }] of featuresByColorAndLayer) {
      const geometries: THREE.BufferGeometry[] = [];
      const isTerrainFollowing = TERRAIN_FOLLOWING_LAYERS.includes(layer);
      const shouldMerge = !NO_MERGE_LAYERS.includes(layer);
      const yOffset = LAYER_DEPTHS[layer] ?? LAYER_DEPTHS.default;

      for (const feature of layerFeatures) {
        try {
          if (feature.type === 'Polygon') {
            const geom = createPolygonGeometry(feature.coordinates as number[][][], layer, yOffset);
            if (geom) geometries.push(geom);
          } else if (feature.type === 'MultiPolygon') {
            for (const polygon of feature.coordinates as number[][][][]) {
              const geom = createPolygonGeometry(polygon, layer, yOffset);
              if (geom) geometries.push(geom);
            }
          }
        } catch {
          // Skip invalid geometries
          continue;
        }
      }

      if (geometries.length > 0) {
        // For terrain-following layers, Y is already set in geometry vertices
        // For other layers, use mesh position.y to set layer height
        const yPosition = isTerrainFollowing ? 0 : yOffset;
        const material = getMaterial(color, layer);
        const renderOrder = RENDER_ORDER[layer] ?? RENDER_ORDER.default;

        if (shouldMerge) {
          // Merge geometries for land layers (better performance)
          try {
            const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
            if (merged) {
              const mesh = new THREE.Mesh(merged, material);
              mesh.receiveShadow = true;
              mesh.position.y = yPosition;
              mesh.renderOrder = renderOrder;
              mesh.name = `features-${layer}`;
              group.add(mesh);
            }
          } catch {
            // Fallback: add individually
            for (const geom of geometries) {
              const mesh = new THREE.Mesh(geom, material);
              mesh.receiveShadow = true;
              mesh.position.y = yPosition;
              mesh.renderOrder = renderOrder;
              group.add(mesh);
            }
          }
          // Clean up individual geometries (merged created new geometry)
          for (const geom of geometries) {
            geom.dispose();
          }
        } else {
          // Don't merge water/bathymetry - render individually to prevent z-fighting
          // Each polygon gets its own mesh to avoid overlapping merged geometry artifacts
          for (const geom of geometries) {
            const mesh = new THREE.Mesh(geom, material);
            mesh.receiveShadow = true;
            mesh.position.y = yPosition;
            mesh.renderOrder = renderOrder;
            mesh.name = `${layer}-polygon`;
            group.add(mesh);
          }
          // Don't dispose - geometries are in use by meshes
        }
      }
    }

    // Create line geometries for water features (rivers, streams)
    for (const [color, lineFeatures] of lineFeaturesByColor) {
      const geometries: THREE.BufferGeometry[] = [];

      for (const feature of lineFeatures) {
        try {
          if (feature.type === 'LineString') {
            const geom = createWaterLineGeometry(feature.coordinates as number[][]);
            if (geom) geometries.push(geom);
          } else if (feature.type === 'MultiLineString') {
            for (const line of feature.coordinates as number[][][]) {
              const geom = createWaterLineGeometry(line);
              if (geom) geometries.push(geom);
            }
          }
        } catch {
          continue;
        }
      }

      if (geometries.length > 0) {
        const waterLineRenderOrder = RENDER_ORDER.water_lines;
        try {
          const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
          if (merged) {
            // Use LineSegments instead of Line to render discrete segments
            // This prevents merged geometries from drawing connecting lines between features
            // Note: Y position is computed per-vertex in geometry for terrain-following
            const line = new THREE.LineSegments(merged, getLineMaterial(color));
            line.renderOrder = waterLineRenderOrder;
            line.name = 'water-lines';
            group.add(line);
          }
        } catch {
          // Fallback: add individually
          // Note: Y position is computed per-vertex in geometry for terrain-following
          for (const geom of geometries) {
            const line = new THREE.LineSegments(geom, getLineMaterial(color));
            line.renderOrder = waterLineRenderOrder;
            group.add(line);
          }
        }

        // Clean up
        for (const geom of geometries) {
          geom.dispose();
        }
      }
    }
    } // end if (!workerHandled)
  }

  scene.add(group);
  return group;
}

/**
 * Create line segment geometry for water features (rivers, streams)
 * Uses segment pairs (v0-v1, v1-v2, v2-v3) instead of polyline (v0-v1-v2-v3)
 * This allows merging geometries without creating connecting lines between features
 * Rivers follow terrain elevation for correct positioning on hills/mountains
 */
function createWaterLineGeometry(coordinates: number[][]): THREE.BufferGeometry | null {
  if (!coordinates || coordinates.length < 2) return null;

  // Water line offset relative to terrain (slightly below surface like rivers in valleys)
  const waterLineTerrainOffset = LAYER_DEPTHS.water_lines;

  // Convert coordinates to world positions with terrain elevation
  const worldPoints: THREE.Vector3[] = [];
  for (const coord of coordinates) {
    const lng = coord[0];
    const lat = coord[1];
    const world = geoToWorld(lng, lat, 0);

    // Get terrain height at this position for terrain-following
    let y = waterLineTerrainOffset;
    if (ELEVATION.TERRAIN_ENABLED) {
      let terrainHeight = getTerrainHeight(lng, lat);
      if (Number.isNaN(terrainHeight)) {
        terrainHeight = 0;
      }
      terrainHeight *= ELEVATION.VERTICAL_EXAGGERATION;
      y = LAYER_DEPTHS.terrain + terrainHeight + waterLineTerrainOffset;
    }

    worldPoints.push(new THREE.Vector3(world.x, y, world.z));
  }

  if (worldPoints.length < 2) return null;

  // Create segment pairs: for polyline v0-v1-v2-v3, we need pairs [v0,v1], [v1,v2], [v2,v3]
  // This is for use with THREE.LineSegments which draws each pair as a separate line
  const segmentPoints: THREE.Vector3[] = [];
  for (let i = 0; i < worldPoints.length - 1; i++) {
    segmentPoints.push(worldPoints[i]);
    segmentPoints.push(worldPoints[i + 1]);
  }

  const geometry = new THREE.BufferGeometry().setFromPoints(segmentPoints);
  return geometry;
}

/**
 * Create polygon geometry, optionally following terrain elevation
 * @param coordinates - Polygon coordinates [outer ring, ...holes]
 * @param layer - Layer name to determine if terrain-following should be applied
 * @param yOffset - Y offset to apply (for terrain-following, this is added to terrain height)
 */
function createPolygonGeometry(
  coordinates: number[][][],
  layer: string,
  yOffset: number
): THREE.BufferGeometry | null {
  if (!coordinates || coordinates.length === 0) return null;

  const outerRing = coordinates[0];
  if (!outerRing || outerRing.length < 3) return null;

  const isTerrainFollowing = TERRAIN_FOLLOWING_LAYERS.includes(layer) && ELEVATION.TERRAIN_ENABLED;

  // Convert outer ring to Three.js points (2D for shape creation)
  const points: THREE.Vector2[] = [];

  for (const coord of outerRing) {
    const world = geoToWorld(coord[0], coord[1], 0);
    // Note: We negate world.z because rotateX(-PI/2) will negate it again
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
  if (Math.abs(area) < 1) return null; // Skip tiny polygons

  // Ensure counter-clockwise winding for Three.js
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

      if (holePoints.length >= 3) {
        // Holes need clockwise winding (opposite of outer ring)
        const holeArea = calculatePolygonArea(holePoints);
        if (holeArea < 0) {
          holePoints.reverse();
        }
        shape.holes.push(new THREE.Path(holePoints));
      }
    }

    const geometry = new THREE.ShapeGeometry(shape);

    // Rotate so it lies flat on XZ plane (Y up)
    geometry.rotateX(-Math.PI / 2);

    // Apply terrain-following elevation if applicable
    // Uses O(n) complexity by converting world coords back to geo coords directly
    if (isTerrainFollowing) {
      const positions = geometry.attributes.position;

      for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i);
        const z = positions.getZ(i);

        // Convert world position back to geographic coordinates
        // Note: worldToGeo expects (x, y, z) where y is altitude
        const geo = worldToGeo(x, 0, z);

        // Get terrain height at this geographic position
        let terrainHeight = getTerrainHeight(geo.lng, geo.lat);
        if (Number.isNaN(terrainHeight)) {
          terrainHeight = 0;
        }
        terrainHeight *= ELEVATION.VERTICAL_EXAGGERATION;

        // Position relative to terrain base + terrain height + layer offset
        const y = LAYER_DEPTHS.terrain + terrainHeight + yOffset;
        positions.setY(i, y);
      }

      positions.needsUpdate = true;
      geometry.computeVertexNormals();
    }

    return geometry;
  } catch {
    return null;
  }
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
 * Try to use geometry workers for base layer creation
 * Returns true if workers handled the geometry, false to fall back to main thread
 */
async function tryWorkerGeometry(
  features: ParsedFeature[],
  group: THREE.Group,
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<boolean> {
  if (!WORKERS.GEOMETRY_ENABLED) {
    return false;
  }

  try {
    const pool = getGeometryWorkerPool();
    const isSupported = await pool.isWorkerSupported();

    if (!isSupported) {
      return false;
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

    return true;
  } catch (error) {
    console.warn('Worker geometry creation failed, falling back to main thread:', error);
    return false;
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
