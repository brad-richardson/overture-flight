import * as THREE from 'three';
import { getScene, geoToWorld, BufferGeometryUtils } from './scene.js';
import { loadBaseTile } from './tile-manager.js';

// Colors for different feature types (Overture-inspired, darkened for flight sim)
const COLORS = {
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

  // Land cover types - green/brown tones
  forest: 0x2d5a3f,
  park: 0x3a6b4a,
  grass: 0x4a7a5a,
  meadow: 0x4a7a5a,
  wetland: 0x3a6a6a,
  farmland: 0x5a7a4a,
  shrub: 0x4a6a4a,
  barren: 0x8a7a6a,
  snow: 0xddeeff,

  // Urban/developed areas - gray tones
  residential: 0x5a5a5a,
  commercial: 0x6a6a6a,
  industrial: 0x5a5555,
  urban: 0x5a5a5a,

  // Default land - muted green
  land: 0x4a6a4a,
  default: 0x4a6a4a
};

// Set of water colors for z-fighting prevention
const WATER_COLORS = new Set([
  COLORS.ocean, COLORS.sea, COLORS.lake, COLORS.reservoir,
  COLORS.pond, COLORS.river, COLORS.stream, COLORS.canal, COLORS.water
]);

// Layer depth configuration to prevent z-fighting
// Water renders below land, land_use renders above land_cover
const LAYER_DEPTHS = {
  water: -2.0,      // Water at lowest level
  land: -1.0,       // Base land
  land_cover: -0.5, // Land cover (forests, etc.) slightly above land
  land_use: -0.25,  // Land use (parks, etc.) above land_cover
  default: -0.5
};

// Materials cache
const materials = new Map();

/**
 * Get or create material for a color and layer type
 * Uses polygonOffset to prevent z-fighting between overlapping layers
 * @param {number} color
 * @param {string} layer - Layer type for depth ordering
 * @returns {THREE.MeshStandardMaterial}
 */
function getMaterial(color, layer = 'default') {
  const key = `${color}-${layer}`;
  if (!materials.has(key)) {
    // Use polygonOffset to help prevent z-fighting
    // Higher offsetFactor = renders further away (behind lower values)
    const isWater = layer === 'water' || WATER_COLORS.has(color);
    const offsetFactor = isWater ? 4 : (layer === 'land' ? 3 : (layer === 'land_cover' ? 2 : 1));

    materials.set(key, new THREE.MeshStandardMaterial({
      color: color,
      roughness: 0.9,
      metalness: 0.0,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: offsetFactor,
      polygonOffsetUnits: 1
    }));
  }
  return materials.get(key);
}

/**
 * Get color for a feature based on its layer and subtype
 * @param {string} layer
 * @param {Object} properties
 * @returns {number}
 */
function getColorForFeature(layer, properties) {
  const subtype = properties.subtype || properties.class || '';
  const type = subtype.toLowerCase();

  // Check for specific subtype first
  if (COLORS[type]) {
    return COLORS[type];
  }

  // Check by layer name
  if (layer === 'water') {
    return COLORS.water;
  }

  if (layer === 'land' || layer === 'land_cover') {
    return COLORS.land;
  }

  if (layer === 'land_use') {
    // Try to map land use types
    if (type.includes('forest') || type.includes('wood')) return COLORS.forest;
    if (type.includes('park') || type.includes('recreation')) return COLORS.park;
    if (type.includes('grass') || type.includes('green')) return COLORS.grass;
    if (type.includes('water') || type.includes('basin')) return COLORS.water;
    if (type.includes('residential')) return COLORS.residential;
    if (type.includes('commercial')) return COLORS.commercial;
    if (type.includes('industrial')) return COLORS.industrial;
    return COLORS.land;
  }

  return COLORS.default;
}

/**
 * Create base layer meshes (land, water) from tile features
 * @param {number} tileX
 * @param {number} tileY
 * @param {number} tileZ
 * @returns {Promise<THREE.Group>}
 */
export async function createBaseLayerForTile(tileX, tileY, tileZ) {
  const scene = getScene();
  if (!scene) {
    console.warn('Scene not initialized');
    return null;
  }

  const features = await loadBaseTile(tileX, tileY, tileZ);
  console.log(`Base tile ${tileZ}/${tileX}/${tileY}: ${features.length} features`);
  if (features.length === 0) {
    return null;
  }

  const group = new THREE.Group();
  group.name = `base-${tileZ}/${tileX}/${tileY}`;

  // Group features by color AND layer for proper z-fighting prevention
  // Key format: "color-layer" to separate water from land even if same color
  const featuresByColorAndLayer = new Map();

  for (const feature of features) {
    if (feature.type !== 'Polygon' && feature.type !== 'MultiPolygon') {
      continue;
    }

    const color = getColorForFeature(feature.layer, feature.properties);
    const layer = feature.layer || 'default';
    const key = `${color}-${layer}`;

    if (!featuresByColorAndLayer.has(key)) {
      featuresByColorAndLayer.set(key, { color, layer, features: [] });
    }
    featuresByColorAndLayer.get(key).features.push(feature);
  }

  // Create merged geometry for each color+layer combination
  for (const [key, { color, layer, features: layerFeatures }] of featuresByColorAndLayer) {
    const geometries = [];

    for (const feature of layerFeatures) {
      try {
        if (feature.type === 'Polygon') {
          const geom = createFlatPolygonGeometry(feature.coordinates);
          if (geom) geometries.push(geom);
        } else if (feature.type === 'MultiPolygon') {
          for (const polygon of feature.coordinates) {
            const geom = createFlatPolygonGeometry(polygon);
            if (geom) geometries.push(geom);
          }
        }
      } catch (e) {
        // Skip invalid geometries
        continue;
      }
    }

    if (geometries.length > 0) {
      // Get layer-specific depth to prevent z-fighting
      const yPosition = LAYER_DEPTHS[layer] ?? LAYER_DEPTHS.default;
      // Determine render order: water first (lowest), then land, then land_cover, then land_use
      const renderOrder = layer === 'water' ? 0 : (layer === 'land' ? 1 : (layer === 'land_cover' ? 2 : 3));

      try {
        const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
        if (merged) {
          const mesh = new THREE.Mesh(merged, getMaterial(color, layer));
          mesh.receiveShadow = true;
          mesh.position.y = yPosition;
          mesh.renderOrder = renderOrder;
          group.add(mesh);
        }
      } catch (e) {
        // Fallback: add individually
        for (const geom of geometries) {
          const mesh = new THREE.Mesh(geom, getMaterial(color, layer));
          mesh.receiveShadow = true;
          mesh.position.y = yPosition;
          mesh.renderOrder = renderOrder;
          group.add(mesh);
        }
      }

      // Clean up individual geometries
      for (const geom of geometries) {
        geom.dispose();
      }
    }
  }

  scene.add(group);
  return group;
}

/**
 * Create flat polygon geometry at Y=0
 * @param {Array} coordinates - GeoJSON polygon coordinates [outer ring, ...holes]
 * @returns {THREE.BufferGeometry|null}
 */
function createFlatPolygonGeometry(coordinates) {
  if (!coordinates || coordinates.length === 0) return null;

  const outerRing = coordinates[0];
  if (!outerRing || outerRing.length < 3) return null;

  // Convert outer ring to Three.js points
  const points = [];
  for (const coord of outerRing) {
    const world = geoToWorld(coord[0], coord[1], 0);
    points.push(new THREE.Vector2(world.x, world.z));
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

      const holePoints = [];
      for (const coord of holeRing) {
        const world = geoToWorld(coord[0], coord[1], 0);
        holePoints.push(new THREE.Vector2(world.x, world.z));
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

    return geometry;
  } catch (e) {
    return null;
  }
}

/**
 * Calculate signed area of a 2D polygon
 */
function calculatePolygonArea(points) {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  }
  return area / 2;
}

/**
 * Remove base layer meshes for a tile
 * @param {THREE.Group} group
 */
export function removeBaseLayerGroup(group) {
  if (!group) return;

  const scene = getScene();
  if (scene) {
    scene.remove(group);
  }

  // Dispose of geometries
  group.traverse((child) => {
    if (child.isMesh) {
      if (child.geometry) child.geometry.dispose();
    }
  });
}
