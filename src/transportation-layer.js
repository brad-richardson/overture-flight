import * as THREE from 'three';
import { getScene, geoToWorld, BufferGeometryUtils } from './scene.js';
import { loadTransportationTile } from './tile-manager.js';

// Road styling based on Overture road class
// Colors are muted to not distract from the flight sim
const ROAD_STYLES = {
  // Major roads - lighter colors, wider lines
  motorway: { color: 0xd4a574, width: 3.0 },
  trunk: { color: 0xc4956a, width: 2.5 },
  primary: { color: 0xb4855a, width: 2.0 },
  secondary: { color: 0xa4754a, width: 1.5 },
  tertiary: { color: 0x94653a, width: 1.2 },

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

// Materials cache
const materials = new Map();

/**
 * Get or create line material for a road style
 * @param {number} color
 * @returns {THREE.LineBasicMaterial}
 */
function getMaterial(color) {
  if (!materials.has(color)) {
    materials.set(color, new THREE.LineBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.8
    }));
  }
  return materials.get(color);
}

/**
 * Get road style based on feature properties
 * @param {Object} properties
 * @returns {{color: number, width: number}}
 */
function getRoadStyle(properties) {
  // Null safety check for properties
  if (!properties) {
    return ROAD_STYLES.default;
  }

  // Overture uses 'class' for road type
  const roadClass = properties.class || properties.subtype || '';
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
 * @param {number} tileX
 * @param {number} tileY
 * @param {number} tileZ
 * @returns {Promise<THREE.Group>}
 */
export async function createTransportationForTile(tileX, tileY, tileZ) {
  const scene = getScene();
  if (!scene) {
    console.warn('Scene not initialized');
    return null;
  }

  const features = await loadTransportationTile(tileX, tileY, tileZ);
  console.log(`Transportation tile ${tileZ}/${tileX}/${tileY}: ${features.length} features`);
  if (features.length === 0) {
    return null;
  }

  const group = new THREE.Group();
  group.name = `transportation-${tileZ}/${tileX}/${tileY}`;

  // Group features by color for batching
  const featuresByStyle = new Map();

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

    const style = getRoadStyle(feature.properties);
    const key = `${style.color}_${style.width}`;

    if (!featuresByStyle.has(key)) {
      featuresByStyle.set(key, { style, features: [] });
    }
    featuresByStyle.get(key).features.push(feature);
  }

  // Create line geometries for each style
  for (const { style, features: styleFeatures } of featuresByStyle.values()) {
    const geometries = [];

    for (const feature of styleFeatures) {
      try {
        if (feature.type === 'LineString') {
          const geom = createLineGeometry(feature.coordinates, style.width);
          if (geom) geometries.push(geom);
        } else if (feature.type === 'MultiLineString') {
          for (const line of feature.coordinates) {
            const geom = createLineGeometry(line, style.width);
            if (geom) geometries.push(geom);
          }
        }
      } catch (e) {
        // Skip invalid geometries
        continue;
      }
    }

    if (geometries.length > 0) {
      let mergeSucceeded = false;
      try {
        const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
        if (merged) {
          const mesh = new THREE.Line(merged, getMaterial(style.color));
          // Roads sit just above the ground to avoid z-fighting with base layer
          mesh.position.y = 0.1;
          group.add(mesh);
          mergeSucceeded = true;
        }
      } catch (e) {
        // Fallback: add individually (geometries are still in use, don't dispose)
        for (const geom of geometries) {
          const mesh = new THREE.Line(geom, getMaterial(style.color));
          mesh.position.y = 0.1;
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
 * Create line geometry from coordinates
 * @param {Array} coordinates - Array of [lng, lat] coordinates
 * @param {number} width - Line width (for future use with tubes/ribbons)
 * @returns {THREE.BufferGeometry|null}
 */
function createLineGeometry(coordinates, width) {
  if (!coordinates || coordinates.length < 2) return null;

  const points = [];
  for (const coord of coordinates) {
    const world = geoToWorld(coord[0], coord[1], 0);
    points.push(new THREE.Vector3(world.x, 0, world.z));
  }

  if (points.length < 2) return null;

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  return geometry;
}

/**
 * Remove transportation layer meshes for a tile
 * @param {THREE.Group} group
 */
export function removeTransportationGroup(group) {
  if (!group) return;

  const scene = getScene();
  if (scene) {
    scene.remove(group);
  }

  // Dispose of geometries
  group.traverse((child) => {
    if (child.isLine) {
      if (child.geometry) child.geometry.dispose();
    }
  });
}
