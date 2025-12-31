import * as THREE from 'three';
import { getScene, geoToWorld, BufferGeometryUtils } from './scene.js';
import { loadBuildingTile, tileToWorldBounds } from './tile-manager.js';

// Default building height when not specified
const DEFAULT_BUILDING_HEIGHT = 10;

// Building material - standard gray buildings
const buildingMaterial = new THREE.MeshStandardMaterial({
  color: 0x888899,
  roughness: 0.7,
  metalness: 0.1,
  flatShading: true
});

/**
 * Create building meshes from tile features
 * @param {number} tileX
 * @param {number} tileY
 * @param {number} tileZ
 * @returns {Promise<THREE.Group>}
 */
export async function createBuildingsForTile(tileX, tileY, tileZ) {
  const scene = getScene();
  if (!scene) {
    console.warn('Scene not initialized');
    return null;
  }

  const features = await loadBuildingTile(tileX, tileY, tileZ);
  console.log(`Buildings tile ${tileZ}/${tileX}/${tileY}: ${features.length} features`);
  if (features.length === 0) {
    return null;
  }

  const group = new THREE.Group();
  group.name = `buildings-${tileZ}/${tileX}/${tileY}`;

  // Merge geometries for better performance
  const geometries = [];

  for (const feature of features) {
    if (feature.type !== 'Polygon' && feature.type !== 'MultiPolygon') {
      continue;
    }

    const height = feature.properties.height ||
                   feature.properties.num_floors * 3 ||
                   DEFAULT_BUILDING_HEIGHT;

    try {
      if (feature.type === 'Polygon') {
        const geom = createBuildingGeometry(feature.coordinates, height);
        if (geom) geometries.push(geom);
      } else if (feature.type === 'MultiPolygon') {
        for (const polygon of feature.coordinates) {
          const geom = createBuildingGeometry(polygon, height);
          if (geom) geometries.push(geom);
        }
      }
    } catch (e) {
      // Skip invalid geometries
      continue;
    }
  }

  console.log(`Buildings ${tileZ}/${tileX}/${tileY}: ${geometries.length} geometries created`);
  if (geometries.length === 0) {
    return null;
  }

  // Use Three.js official merge utility for better performance
  try {
    const mergedGeometry = BufferGeometryUtils.mergeGeometries(geometries, false);
    if (mergedGeometry) {
      const mesh = new THREE.Mesh(mergedGeometry, buildingMaterial);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      console.log(`Buildings ${tileZ}/${tileX}/${tileY}: merged into 1 mesh`);
    }
  } catch (e) {
    console.warn(`Failed to merge buildings for ${tileZ}/${tileX}/${tileY}, adding individually:`, e.message);
    // Fallback: add individually if merge fails
    for (const geom of geometries) {
      if (geom) {
        const mesh = new THREE.Mesh(geom, buildingMaterial);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
    }
  }

  // Dispose individual geometries (merged geometry is a new object)
  for (const geom of geometries) {
    geom.dispose();
  }

  scene.add(group);
  console.log(`Buildings group added to scene: ${group.children.length} meshes`);
  return group;
}

/**
 * Create extruded geometry for a building polygon
 * @param {Array} coordinates - GeoJSON polygon coordinates [outer ring, ...holes]
 * @param {number} height - Building height in meters
 * @returns {THREE.BufferGeometry|null}
 */
function createBuildingGeometry(coordinates, height) {
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
  if (Math.abs(area) < 1) return null; // Skip tiny buildings

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

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: height,
      bevelEnabled: false
    });

    // Rotate so extrusion goes up (Y) instead of out (Z)
    geometry.rotateX(-Math.PI / 2);

    return geometry;
  } catch (e) {
    // Shape creation can fail for invalid polygons
    return null;
  }
}

/**
 * Calculate signed area of a 2D polygon
 * Positive = clockwise, Negative = counter-clockwise
 */
function calculatePolygonArea(points) {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  }
  return area / 2;
}

/**
 * Remove building meshes for a tile
 * @param {THREE.Group} group
 */
export function removeBuildingsGroup(group) {
  if (!group) return;

  const scene = getScene();
  if (scene) {
    scene.remove(group);
  }

  // Dispose of geometries and materials
  group.traverse((child) => {
    if (child.isMesh) {
      if (child.geometry) child.geometry.dispose();
    }
  });
}
