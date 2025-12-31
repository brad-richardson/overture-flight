import * as THREE from 'three';
import { getScene, geoToWorld, BufferGeometryUtils } from './scene.js';
import { loadBuildingTile, tileToWorldBounds } from './tile-manager.js';
import {
  getBuildingColor,
  getRoofColor,
  groupFeaturesByCategory,
  createCategoryMaterial,
  BUILDING_PALETTES
} from './building-materials.js';

// Default building height when not specified
const DEFAULT_BUILDING_HEIGHT = 10;

// Material cache by category for performance
const materialCache = new Map();

/**
 * Get or create a material for a building category
 */
function getCategoryMaterial(category) {
  if (!materialCache.has(category)) {
    materialCache.set(category, createCategoryMaterial(category));
  }
  return materialCache.get(category);
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
 * Create building meshes from tile features with realistic textures
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

  // Group features by category for better material batching
  const categoryGroups = groupFeaturesByCategory(features);
  let totalGeometries = 0;

  // Process each category separately
  for (const [category, categoryFeatures] of Object.entries(categoryGroups)) {
    const geometries = [];

    for (const feature of categoryFeatures) {
      if (feature.type !== 'Polygon' && feature.type !== 'MultiPolygon') {
        continue;
      }

      const height = feature.properties?.height ||
                     (feature.properties?.num_floors ? feature.properties.num_floors * 3 : 0) ||
                     DEFAULT_BUILDING_HEIGHT;

      // Get building-specific color
      const buildingColor = getBuildingColor(feature);

      try {
        if (feature.type === 'Polygon') {
          const geom = createBuildingGeometry(feature.coordinates, height, buildingColor);
          if (geom) geometries.push(geom);
        } else if (feature.type === 'MultiPolygon') {
          for (const polygon of feature.coordinates) {
            const geom = createBuildingGeometry(polygon, height, buildingColor);
            if (geom) geometries.push(geom);
          }
        }
      } catch (e) {
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
      console.warn(`Failed to merge ${category} buildings for ${tileZ}/${tileX}/${tileY}:`, e.message);
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

  console.log(`Buildings ${tileZ}/${tileX}/${tileY}: ${totalGeometries} geometries in ${Object.keys(categoryGroups).length} categories`);

  if (group.children.length === 0) {
    return null;
  }

  scene.add(group);
  console.log(`Buildings group added to scene: ${group.children.length} meshes`);
  return group;
}

/**
 * Create extruded geometry for a building polygon with vertex colors
 * @param {Array} coordinates - GeoJSON polygon coordinates [outer ring, ...holes]
 * @param {number} height - Building height in meters
 * @param {number} color - Hex color for the building
 * @returns {THREE.BufferGeometry|null}
 */
function createBuildingGeometry(coordinates, height, color = 0x888899) {
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

    // Add vertex colors for individual building variation
    addVertexColors(geometry, color, height);

    return geometry;
  } catch (e) {
    // Shape creation can fail for invalid polygons
    return null;
  }
}

/**
 * Add vertex colors to a building geometry
 * Applies the base color with optional height-based variation
 * @param {THREE.BufferGeometry} geometry
 * @param {number} hexColor - Base hex color
 * @param {number} height - Building height for gradient effects
 */
function addVertexColors(geometry, hexColor, height) {
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
 * Add window-like patterns to building facades (experimental)
 * This modifies vertex colors to create lighter rectangular patterns
 */
function addWindowPattern(colors, positions, count, height, baseR, baseG, baseB) {
  const windowColor = { r: 0.7, g: 0.8, b: 0.9 }; // Light blue-ish for windows
  const floorHeight = 3; // meters per floor
  const windowSpacing = 4; // meters between windows

  for (let i = 0; i < count; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);

    // Determine if this vertex should be a "window"
    const floorLevel = y % floorHeight;
    const isWindowLevel = floorLevel > 0.5 && floorLevel < 2.5;

    const horizontalPos = (x + z) % windowSpacing;
    const isWindowColumn = horizontalPos > 0.5 && horizontalPos < 2.5;

    if (isWindowLevel && isWindowColumn && y > 2) {
      // Apply window color (blend with base)
      const blend = 0.4;
      colors[i * 3] = baseR * (1 - blend) + windowColor.r * blend;
      colors[i * 3 + 1] = baseG * (1 - blend) + windowColor.g * blend;
      colors[i * 3 + 2] = baseB * (1 - blend) + windowColor.b * blend;
    }
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
      if (child.material) {
        // Dispose material if it's unique to this mesh
        if (!materialCache.has(child.material)) {
          child.material.dispose();
        }
      }
    }
  });
}

/**
 * Get statistics about loaded building categories
 */
export function getBuildingStats() {
  return {
    materialCacheSize: materialCache.size,
    categories: Array.from(materialCache.keys())
  };
}
