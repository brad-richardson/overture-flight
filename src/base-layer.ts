import * as THREE from 'three';
import { getScene, geoToWorld, worldToGeo, BufferGeometryUtils } from './scene.js';
import { loadBaseTile, tileToBounds, lngLatToTile } from './tile-manager.js';
import { getElevationDataForTile, sampleElevation, getTerrainHeight } from './elevation.js';
import { ELEVATION } from './constants.js';

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
  grass: 0x5a8f4a,      // Bright meadow green
  shrub: 0x4a7045,      // Olive scrubland
  crop: 0x8fa858,       // Golden agricultural fields
  barren: 0xa08060,     // Sandy/rocky brown
  wetland: 0x3a6868,    // Teal swampy color
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

  // Default land - neutral tan/beige (allows land_cover/land_use to show through)
  land: 0xc8b8a0,
  default: 0xc8b8a0,

  // Terrain mesh base color - neutral tan/beige
  terrain: 0xc8b8a0
};

// Layer depth configuration to prevent z-fighting
// Layers are separated by Y position - sufficient gaps prevent depth conflicts
// Note: land_cover and land_use now use terrain-following elevation, so their
// base offset is relative to terrain surface (added on top of terrain height)
const LAYER_DEPTHS: Record<string, number> = {
  terrain: -3.0,      // Terrain mesh at lowest position
  land: -2.0,         // Base land above terrain (not terrain-following)
  land_cover: 0.3,    // Land cover offset ABOVE terrain surface (terrain-following)
  land_use: 0.5,      // Land use offset ABOVE terrain surface (terrain-following)
  bathymetry: -2.2,   // Bathymetry slightly below land to prevent coastal z-fighting
  water: -0.5,        // Water polygons above bathymetry
  water_lines: -0.3,  // Water lines (rivers) slightly above water polygons
  default: 0.3
};

// Layers that should follow terrain elevation
const TERRAIN_FOLLOWING_LAYERS = ['land_cover', 'land_use'];

// Layers to skip rendering entirely (redundant with terrain mesh)
// The 'land' layer creates flat green polygons that obscure terrain-following land_cover/land_use
const SKIP_LAYERS = ['land'];

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

// Materials cache
const materials = new Map<number, THREE.MeshStandardMaterial>();

// Line materials cache for water lines (rivers)
const lineMaterials = new Map<number, THREE.LineBasicMaterial>();

// Linear water feature types to render as lines (rivers, streams, etc.)
// Coastlines and shorelines are excluded to prevent artifacts around islands
const LINEAR_WATER_TYPES = ['river', 'stream', 'canal', 'drain', 'ditch', 'waterway'];

// Track logged land_cover subtypes to avoid console spam
const landCoverSubtypesLogged = new Set<string>();

// Terrain material with vertex colors
let terrainMaterial: THREE.MeshStandardMaterial | null = null;

/**
 * Get or create terrain material
 */
function getTerrainMaterial(): THREE.MeshStandardMaterial {
  if (!terrainMaterial) {
    terrainMaterial = new THREE.MeshStandardMaterial({
      color: COLORS.terrain,
      roughness: 0.9,
      metalness: 0.0,
      side: THREE.DoubleSide,
      flatShading: false, // Smooth shading for terrain
    });
  }
  return terrainMaterial;
}

/**
 * Get or create material for a color
 */
function getMaterial(color: number): THREE.MeshStandardMaterial {
  if (!materials.has(color)) {
    materials.set(color, new THREE.MeshStandardMaterial({
      color: color,
      roughness: 0.9,
      metalness: 0.0,
      side: THREE.DoubleSide
    }));
  }
  return materials.get(color)!;
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
    // Log once per subtype to debug
    if (!landCoverSubtypesLogged.has(type)) {
      landCoverSubtypesLogged.add(type);
      console.log(`land_cover subtype: "${type}" (all props: ${JSON.stringify(properties)})`);
    }
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
 * Create a terrain mesh with elevation data for a tile
 */
async function createTerrainMesh(
  tileX: number,
  tileY: number,
  tileZ: number
): Promise<THREE.Mesh | null> {
  // Get tile bounds in world coordinates
  const bounds = tileToBounds(tileX, tileY, tileZ);
  const centerLng = (bounds.west + bounds.east) / 2;
  const centerLat = (bounds.north + bounds.south) / 2;

  // Calculate the corresponding elevation tile (may be at different zoom)
  const elevZ = ELEVATION.ZOOM;
  const [elevX, elevY] = lngLatToTile(centerLng, centerLat, elevZ);

  // Get elevation data
  const elevData = await getElevationDataForTile(elevX, elevY);
  if (!elevData) {
    console.warn(`No elevation data for terrain tile ${tileZ}/${tileX}/${tileY}`);
    return createFlatTerrainMesh(tileX, tileY, tileZ);
  }

  const { heights } = elevData;
  const elevBounds = tileToBounds(elevX, elevY, elevZ);

  // Get world bounds for this building tile
  const worldMin = geoToWorld(bounds.west, bounds.south, 0);
  const worldMax = geoToWorld(bounds.east, bounds.north, 0);

  const width = worldMax.x - worldMin.x;
  const depth = worldMin.z - worldMax.z; // Z is inverted

  const segments = ELEVATION.TERRAIN_SEGMENTS;

  // Create plane geometry
  const geometry = new THREE.PlaneGeometry(width, depth, segments, segments);

  // Get position attribute
  const positions = geometry.attributes.position;

  // Sample elevation at each vertex
  for (let iy = 0; iy <= segments; iy++) {
    for (let ix = 0; ix <= segments; ix++) {
      const vertexIndex = iy * (segments + 1) + ix;

      // Get the vertex's world position
      const vx = positions.getX(vertexIndex);
      const vy = positions.getY(vertexIndex);

      // World position of this vertex (relative to geometry center)
      const worldX = worldMin.x + width / 2 + vx;
      const worldZ = worldMax.z + depth / 2 - vy; // PlaneGeometry Y maps to world Z

      // Convert back to geo coordinates to sample elevation
      // This is approximate but good enough for terrain
      const relX = (worldX - worldMin.x) / width;
      const relZ = (worldZ - worldMax.z) / depth;

      // Map to this tile's geographic bounds
      const lng = bounds.west + relX * (bounds.east - bounds.west);
      const lat = bounds.north - relZ * (bounds.north - bounds.south);

      // Map to elevation tile coordinates and sample using shared helper
      const elevRelX = (lng - elevBounds.west) / (elevBounds.east - elevBounds.west);
      const elevRelY = (elevBounds.north - lat) / (elevBounds.north - elevBounds.south);
      const gridX = elevRelX * (ELEVATION.TILE_SIZE - 1);
      const gridY = elevRelY * (ELEVATION.TILE_SIZE - 1);

      // Use shared bilinear interpolation helper
      let elevation = sampleElevation(heights, gridX, gridY, ELEVATION.TILE_SIZE);

      // Handle NaN (no data) - use 0 as fallback
      if (Number.isNaN(elevation)) {
        elevation = 0;
      }

      // Apply vertical exaggeration
      elevation *= ELEVATION.VERTICAL_EXAGGERATION;

      // Set the Z coordinate (which becomes Y after rotation)
      positions.setZ(vertexIndex, elevation);
    }
  }

  // Update geometry
  positions.needsUpdate = true;
  geometry.computeVertexNormals();

  // Rotate to XZ plane (Y-up)
  geometry.rotateX(-Math.PI / 2);

  // Create mesh
  const mesh = new THREE.Mesh(geometry, getTerrainMaterial());
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  // Position at tile center
  mesh.position.set(
    worldMin.x + width / 2,
    LAYER_DEPTHS.terrain,
    worldMax.z + depth / 2
  );

  return mesh;
}

/**
 * Create a flat terrain mesh (fallback when no elevation data)
 */
function createFlatTerrainMesh(tileX: number, tileY: number, tileZ: number): THREE.Mesh {
  const bounds = tileToBounds(tileX, tileY, tileZ);
  const worldMin = geoToWorld(bounds.west, bounds.south, 0);
  const worldMax = geoToWorld(bounds.east, bounds.north, 0);

  const width = worldMax.x - worldMin.x;
  const depth = worldMin.z - worldMax.z;

  const geometry = new THREE.PlaneGeometry(width, depth, 1, 1);
  geometry.rotateX(-Math.PI / 2);

  const mesh = new THREE.Mesh(geometry, getTerrainMaterial());
  mesh.receiveShadow = true;
  mesh.position.set(
    worldMin.x + width / 2,
    LAYER_DEPTHS.terrain,
    worldMax.z + depth / 2
  );

  return mesh;
}

/**
 * Create base layer meshes (land, water) from tile features
 * Now also includes terrain elevation mesh
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

  // Create terrain mesh with elevation (or flat if disabled)
  if (ELEVATION.TERRAIN_ENABLED) {
    try {
      const terrainMesh = await createTerrainMesh(tileX, tileY, tileZ);
      if (terrainMesh) {
        terrainMesh.name = 'terrain';
        group.add(terrainMesh);
      }
    } catch (error) {
      console.error(`Failed to create terrain mesh for ${tileZ}/${tileX}/${tileY}:`, error);
      // Add flat fallback
      const flatMesh = createFlatTerrainMesh(tileX, tileY, tileZ);
      flatMesh.name = 'terrain-flat';
      group.add(flatMesh);
    }
  } else {
    // Terrain disabled, create flat ground
    const flatMesh = createFlatTerrainMesh(tileX, tileY, tileZ);
    flatMesh.name = 'terrain-flat';
    group.add(flatMesh);
  }

  // Load and render base features (water, land cover, etc.)
  const features = await loadBaseTile(tileX, tileY, tileZ);
  console.log(`Base tile ${tileZ}/${tileX}/${tileY}: ${features.length} features`);

  if (features.length > 0) {
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
        const key = `${color}-${layer}`;
        if (!featuresByColorAndLayer.has(key)) {
          featuresByColorAndLayer.set(key, { color, layer, features: [] });
        }
        featuresByColorAndLayer.get(key)!.features.push(feature);
      } else if (feature.type === 'LineString' || feature.type === 'MultiLineString') {
        // Process line features for water - only rivers, streams, and canals
        // Skip coastlines and shorelines which create artifacts around islands
        if (layer === 'water') {
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
    // Overlapping polygons cause flickering when merged into single geometry
    const NO_MERGE_LAYERS = ['water', 'bathymetry', 'land', 'land_cover', 'land_use'];

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
        const material = getMaterial(color);

        if (shouldMerge) {
          // Merge geometries for land layers (better performance)
          try {
            const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
            if (merged) {
              const mesh = new THREE.Mesh(merged, material);
              mesh.receiveShadow = true;
              mesh.position.y = yPosition;
              mesh.name = `features-${layer}`;
              group.add(mesh);
            }
          } catch {
            // Fallback: add individually
            for (const geom of geometries) {
              const mesh = new THREE.Mesh(geom, material);
              mesh.receiveShadow = true;
              mesh.position.y = yPosition;
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
        try {
          const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
          if (merged) {
            // Use LineSegments instead of Line to render discrete segments
            // This prevents merged geometries from drawing connecting lines between features
            const line = new THREE.LineSegments(merged, getLineMaterial(color));
            line.position.y = LAYER_DEPTHS.water_lines;
            line.name = 'water-lines';
            group.add(line);
          }
        } catch {
          // Fallback: add individually
          for (const geom of geometries) {
            const line = new THREE.LineSegments(geom, getLineMaterial(color));
            line.position.y = LAYER_DEPTHS.water_lines;
            group.add(line);
          }
        }

        // Clean up
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
 * Create line segment geometry for water features (rivers, streams)
 * Uses segment pairs (v0-v1, v1-v2, v2-v3) instead of polyline (v0-v1-v2-v3)
 * This allows merging geometries without creating connecting lines between features
 */
function createWaterLineGeometry(coordinates: number[][]): THREE.BufferGeometry | null {
  if (!coordinates || coordinates.length < 2) return null;

  // Convert coordinates to world positions
  const worldPoints: THREE.Vector3[] = [];
  for (const coord of coordinates) {
    const world = geoToWorld(coord[0], coord[1], 0);
    worldPoints.push(new THREE.Vector3(world.x, 0, world.z));
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
 * Remove base layer meshes for a tile and properly dispose all GPU resources
 */
export function removeBaseLayerGroup(group: THREE.Group): void {
  if (!group) return;

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

  if (disposedGeometries > 0 || disposedMaterials > 0) {
    console.log(`Disposed base layer group ${group.name}: ${disposedGeometries} geometries, ${disposedMaterials} materials`);
  }
}
