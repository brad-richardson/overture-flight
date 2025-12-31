import * as THREE from 'three';
import { getScene, geoToWorld, BufferGeometryUtils } from './scene.js';
import { loadBaseTile, tileToBounds, lngLatToTile } from './tile-manager.js';
import { getElevationDataForTile, isElevationTileLoaded } from './elevation.js';
import { ELEVATION } from './constants.js';

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
  default: 0x4a6a4a,

  // Terrain mesh base color
  terrain: 0x5a7a5a
};

// Layer depth configuration to prevent z-fighting
// Layers are separated by Y position - sufficient gaps prevent depth conflicts
const LAYER_DEPTHS = {
  terrain: -3.0,      // Terrain mesh at lowest position
  water: -2.0,        // Water above terrain
  land: -1.0,         // Base land above water
  land_cover: -0.5,   // Land cover (forests, etc.) above base land
  land_use: -0.25,    // Land use (parks, etc.) at highest ground level
  default: -0.5
};

// Materials cache
const materials = new Map();

// Terrain material with vertex colors
let terrainMaterial = null;

/**
 * Get or create terrain material
 */
function getTerrainMaterial() {
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
 * @param {number} color
 * @returns {THREE.MeshStandardMaterial}
 */
function getMaterial(color) {
  if (!materials.has(color)) {
    materials.set(color, new THREE.MeshStandardMaterial({
      color: color,
      roughness: 0.9,
      metalness: 0.0,
      side: THREE.DoubleSide
    }));
  }
  return materials.get(color);
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
 * Create a terrain mesh with elevation data for a tile
 * @param {number} tileX - Tile X (at building zoom level 14)
 * @param {number} tileY - Tile Y (at building zoom level 14)
 * @param {number} tileZ - Tile zoom (typically 14)
 * @returns {Promise<THREE.Mesh|null>}
 */
async function createTerrainMesh(tileX, tileY, tileZ) {
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

      // Map to elevation tile coordinates
      const elevRelX = (lng - elevBounds.west) / (elevBounds.east - elevBounds.west);
      const elevRelY = (elevBounds.north - lat) / (elevBounds.north - elevBounds.south);

      // Sample from elevation grid with bilinear interpolation
      const gridX = elevRelX * (ELEVATION.TILE_SIZE - 1);
      const gridY = elevRelY * (ELEVATION.TILE_SIZE - 1);

      const x0 = Math.floor(gridX);
      const y0 = Math.floor(gridY);
      const x1 = Math.min(x0 + 1, ELEVATION.TILE_SIZE - 1);
      const y1 = Math.min(y0 + 1, ELEVATION.TILE_SIZE - 1);

      // Clamp to valid range
      const sx0 = Math.max(0, Math.min(ELEVATION.TILE_SIZE - 1, x0));
      const sy0 = Math.max(0, Math.min(ELEVATION.TILE_SIZE - 1, y0));
      const sx1 = Math.max(0, Math.min(ELEVATION.TILE_SIZE - 1, x1));
      const sy1 = Math.max(0, Math.min(ELEVATION.TILE_SIZE - 1, y1));

      const fx = gridX - x0;
      const fy = gridY - y0;

      const h00 = heights[sy0 * ELEVATION.TILE_SIZE + sx0];
      const h10 = heights[sy0 * ELEVATION.TILE_SIZE + sx1];
      const h01 = heights[sy1 * ELEVATION.TILE_SIZE + sx0];
      const h11 = heights[sy1 * ELEVATION.TILE_SIZE + sx1];

      let elevation =
        h00 * (1 - fx) * (1 - fy) +
        h10 * fx * (1 - fy) +
        h01 * (1 - fx) * fy +
        h11 * fx * fy;

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
function createFlatTerrainMesh(tileX, tileY, tileZ) {
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
    for (const [, { color, layer, features: layerFeatures }] of featuresByColorAndLayer) {
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
        // Y position separates layers to prevent z-fighting (0.25m+ gaps between layers)
        const yPosition = LAYER_DEPTHS[layer] ?? LAYER_DEPTHS.default;

        try {
          const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
          if (merged) {
            const mesh = new THREE.Mesh(merged, getMaterial(color));
            mesh.receiveShadow = true;
            mesh.position.y = yPosition;
            mesh.name = `features-${layer}`;
            group.add(mesh);
          }
        } catch (e) {
          // Fallback: add individually
          for (const geom of geometries) {
            const mesh = new THREE.Mesh(geom, getMaterial(color));
            mesh.receiveShadow = true;
            mesh.position.y = yPosition;
            group.add(mesh);
          }
        }

        // Clean up individual geometries
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
