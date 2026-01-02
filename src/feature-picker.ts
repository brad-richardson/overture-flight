import * as THREE from 'three';
import { getScene, getCamera, getRenderer, worldToGeo } from './scene.js';

/**
 * Feature Picker Module
 *
 * Handles click detection on 3D map features and lookup of feature properties.
 * Since buildings and base layer features are merged into single meshes for
 * performance, we use a spatial lookup approach:
 *
 * 1. Store feature data (geometry + properties) when loading tiles
 * 2. Raycast to find 3D world click position
 * 3. Convert to geographic coordinates
 * 4. Find features whose geometry contains/intersects that point
 */

// Feature data storage
export interface StoredFeature {
  type: 'Polygon' | 'MultiPolygon' | 'LineString' | 'MultiLineString';
  coordinates: number[][][] | number[][][][] | number[][] | number[][][];
  properties: Record<string, unknown>;
  layer: string;
  tileKey: string;
  bbox?: { minLng: number; maxLng: number; minLat: number; maxLat: number };
}

// Storage for all features by tile
const featuresByTile = new Map<string, StoredFeature[]>();

// Raycaster for click detection
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// Click callback
let onFeatureClick: ((features: StoredFeature[], worldPos: THREE.Vector3) => void) | null = null;

// State tracking
let isEnabled = false;
let isInitialized = false;
let clickStartPos: { x: number; y: number } | null = null;
const CLICK_THRESHOLD = 5; // pixels - max movement to consider a click vs drag

/**
 * Calculate bounding box for a feature
 */
function calculateBBox(
  type: string,
  coordinates: number[][][] | number[][][][] | number[][] | number[][][]
): { minLng: number; maxLng: number; minLat: number; maxLat: number } {
  let minLng = Infinity, maxLng = -Infinity;
  let minLat = Infinity, maxLat = -Infinity;

  function processCoord(coord: number[]) {
    const [lng, lat] = coord;
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }

  function processRing(ring: number[][]) {
    for (const coord of ring) {
      processCoord(coord);
    }
  }

  if (type === 'Polygon') {
    for (const ring of coordinates as number[][][]) {
      processRing(ring);
    }
  } else if (type === 'MultiPolygon') {
    for (const polygon of coordinates as number[][][][]) {
      for (const ring of polygon) {
        processRing(ring);
      }
    }
  } else if (type === 'LineString') {
    processRing(coordinates as number[][]);
  } else if (type === 'MultiLineString') {
    for (const line of coordinates as number[][][]) {
      processRing(line);
    }
  }

  return { minLng, maxLng, minLat, maxLat };
}

/**
 * Store features for a tile for later lookup
 */
export function storeFeatures(tileKey: string, features: StoredFeature[]): void {
  // Calculate bounding boxes for faster filtering
  const featuresWithBBox = features.map(f => ({
    ...f,
    tileKey,
    bbox: calculateBBox(f.type, f.coordinates)
  }));

  featuresByTile.set(tileKey, featuresWithBBox);
}

/**
 * Remove stored features for a tile
 */
export function removeStoredFeatures(tileKey: string): void {
  featuresByTile.delete(tileKey);
}

/**
 * Clear all stored features
 */
export function clearAllFeatures(): void {
  featuresByTile.clear();
}

/**
 * Check if a point is inside a polygon using ray casting algorithm
 */
function pointInPolygon(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];

    if (((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Calculate minimum distance from a point to a polygon ring (boundary)
 */
function pointToRingDistance(lng: number, lat: number, ring: number[][]): number {
  let minDist = Infinity;

  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[j];

    // Calculate distance from point to line segment
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;

    let t = 0;
    if (len2 > 0) {
      t = Math.max(0, Math.min(1, ((lng - x1) * dx + (lat - y1) * dy) / len2));
    }

    const nearestX = x1 + t * dx;
    const nearestY = y1 + t * dy;
    const dist = Math.sqrt((lng - nearestX) ** 2 + (lat - nearestY) ** 2);

    minDist = Math.min(minDist, dist);
  }

  return minDist;
}

/**
 * Check if a point is inside or near the edge of a polygon (handling holes)
 * This handles clicks on building walls where the intersection point
 * is technically just outside the footprint polygon
 */
function pointInOrNearPolygon(lng: number, lat: number, coordinates: number[][][], tolerance: number): boolean {
  const outerRing = coordinates[0];

  // First check: is point inside the polygon?
  if (pointInPolygon(lng, lat, outerRing)) {
    // Must not be inside any hole
    for (let i = 1; i < coordinates.length; i++) {
      if (pointInPolygon(lng, lat, coordinates[i])) {
        return false;
      }
    }
    return true;
  }

  // Second check: is point near the polygon boundary? (for wall clicks)
  const distToEdge = pointToRingDistance(lng, lat, outerRing);
  if (distToEdge <= tolerance) {
    // Make sure we're not near a hole's boundary from inside
    for (let i = 1; i < coordinates.length; i++) {
      if (pointInPolygon(lng, lat, coordinates[i])) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/**
 * Check if a point is inside a polygon (handling holes) - strict version
 */
function pointInPolygonWithHoles(lng: number, lat: number, coordinates: number[][][]): boolean {
  // Must be inside outer ring
  if (!pointInPolygon(lng, lat, coordinates[0])) {
    return false;
  }
  // Must not be inside any hole
  for (let i = 1; i < coordinates.length; i++) {
    if (pointInPolygon(lng, lat, coordinates[i])) {
      return false;
    }
  }
  return true;
}

/**
 * Calculate distance from a point to a line segment
 */
function pointToLineDistance(lng: number, lat: number, line: number[][]): number {
  let minDist = Infinity;

  for (let i = 0; i < line.length - 1; i++) {
    const [x1, y1] = line[i];
    const [x2, y2] = line[i + 1];

    // Calculate distance from point to line segment
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;

    let t = 0;
    if (len2 > 0) {
      t = Math.max(0, Math.min(1, ((lng - x1) * dx + (lat - y1) * dy) / len2));
    }

    const nearestX = x1 + t * dx;
    const nearestY = y1 + t * dy;
    const dist = Math.sqrt((lng - nearestX) ** 2 + (lat - nearestY) ** 2);

    minDist = Math.min(minDist, dist);
  }

  return minDist;
}

// Layer priority for sorting results (higher = more specific, shown first)
const LAYER_PRIORITY: Record<string, number> = {
  'building': 100,
  'transportation': 80,
  'water': 40,
  'land_use': 30,
  'land_cover': 20,
  'land': 10,
  'bathymetry': 5,
  'unknown': 0
};

// Background layers that should be filtered out when specific features are found
const BACKGROUND_LAYERS = new Set(['bathymetry', 'land', 'land_cover', 'land_use']);

/**
 * Find features at a geographic location
 * Returns features sorted by priority (buildings first, background layers last)
 * Filters out background layers when more specific features are found
 */
export function findFeaturesAtLocation(
  lng: number,
  lat: number,
  tolerance: number = 0.0001 // ~11m at equator
): StoredFeature[] {
  const results: StoredFeature[] = [];

  for (const features of featuresByTile.values()) {
    for (const feature of features) {
      // Quick bounding box check
      if (feature.bbox) {
        const { minLng, maxLng, minLat, maxLat } = feature.bbox;
        if (lng < minLng - tolerance || lng > maxLng + tolerance ||
            lat < minLat - tolerance || lat > maxLat + tolerance) {
          continue;
        }
      }

      // Detailed geometry check
      // Use edge-aware check for buildings (to catch wall clicks)
      // Use strict check for background layers
      const useEdgeTolerance = feature.layer === 'building';

      if (feature.type === 'Polygon') {
        const coords = feature.coordinates as number[][][];
        const isMatch = useEdgeTolerance
          ? pointInOrNearPolygon(lng, lat, coords, tolerance)
          : pointInPolygonWithHoles(lng, lat, coords);
        if (isMatch) {
          results.push(feature);
        }
      } else if (feature.type === 'MultiPolygon') {
        for (const polygon of feature.coordinates as number[][][][]) {
          const isMatch = useEdgeTolerance
            ? pointInOrNearPolygon(lng, lat, polygon, tolerance)
            : pointInPolygonWithHoles(lng, lat, polygon);
          if (isMatch) {
            results.push(feature);
            break;
          }
        }
      } else if (feature.type === 'LineString') {
        const dist = pointToLineDistance(lng, lat, feature.coordinates as number[][]);
        if (dist < tolerance) {
          results.push(feature);
        }
      } else if (feature.type === 'MultiLineString') {
        for (const line of feature.coordinates as number[][][]) {
          const dist = pointToLineDistance(lng, lat, line);
          if (dist < tolerance) {
            results.push(feature);
            break;
          }
        }
      }
    }
  }

  // Sort by layer priority (buildings first, background layers last)
  results.sort((a, b) => {
    const priorityA = LAYER_PRIORITY[a.layer] ?? 0;
    const priorityB = LAYER_PRIORITY[b.layer] ?? 0;
    return priorityB - priorityA;
  });

  // If we found specific features (buildings, transportation), filter out background layers
  const hasSpecificFeatures = results.some(f => !BACKGROUND_LAYERS.has(f.layer));
  if (hasSpecificFeatures) {
    return results.filter(f => !BACKGROUND_LAYERS.has(f.layer));
  }

  return results;
}

/**
 * Handle mouse/touch start
 */
function handlePointerDown(event: MouseEvent | TouchEvent): void {
  if (!isEnabled) return;

  // Safety check for touch events with empty touches array
  if ('touches' in event) {
    if (event.touches.length === 0) return;
    clickStartPos = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  } else {
    clickStartPos = { x: event.clientX, y: event.clientY };
  }
}

/**
 * Handle mouse/touch end - check if it was a click (not a drag)
 */
function handlePointerUp(event: MouseEvent | TouchEvent): void {
  if (!isEnabled || !clickStartPos || !onFeatureClick) return;

  // Safety check for touch events with empty changedTouches array
  let clientX: number;
  let clientY: number;
  if ('changedTouches' in event) {
    if (event.changedTouches.length === 0) {
      clickStartPos = null;
      return;
    }
    clientX = event.changedTouches[0].clientX;
    clientY = event.changedTouches[0].clientY;
  } else {
    clientX = event.clientX;
    clientY = event.clientY;
  }

  // Check if this was a click (minimal movement)
  const dx = clientX - clickStartPos.x;
  const dy = clientY - clickStartPos.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance > CLICK_THRESHOLD) {
    clickStartPos = null;
    return; // This was a drag, not a click
  }

  clickStartPos = null;

  // Perform raycast
  const renderer = getRenderer();
  const camera = getCamera();
  const scene = getScene();

  if (!renderer || !camera || !scene) return;

  // Calculate normalized device coordinates
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

  // Cast ray
  raycaster.setFromCamera(mouse, camera);

  // Intersect with all objects in the scene
  const intersects = raycaster.intersectObjects(scene.children, true);

  if (intersects.length > 0) {
    // Get the closest intersection point
    const intersection = intersects[0];
    const worldPos = intersection.point;

    // Convert world position to geographic coordinates
    const geo = worldToGeo(worldPos.x, worldPos.y, worldPos.z);

    // Find features at this location
    const features = findFeaturesAtLocation(geo.lng, geo.lat);

    if (features.length > 0) {
      onFeatureClick(features, worldPos);
    }
  }
}

/**
 * Initialize feature picker click detection
 */
export function initFeaturePicker(
  callback: (features: StoredFeature[], worldPos: THREE.Vector3) => void
): void {
  // Prevent duplicate initialization (e.g., during HMR)
  if (isInitialized) {
    console.warn('Feature picker already initialized, updating callback only');
    onFeatureClick = callback;
    return;
  }

  onFeatureClick = callback;

  const renderer = getRenderer();
  if (!renderer) {
    console.warn('Renderer not available for feature picker');
    return;
  }

  const canvas = renderer.domElement;

  // Mouse events
  canvas.addEventListener('mousedown', handlePointerDown);
  canvas.addEventListener('mouseup', handlePointerUp);

  // Touch events
  canvas.addEventListener('touchstart', handlePointerDown, { passive: true });
  canvas.addEventListener('touchend', handlePointerUp, { passive: true });

  // isEnabled defaults to false - user must enable via UI toggle
  isInitialized = true;
}

/**
 * Enable/disable feature picker
 */
export function setFeaturePickerEnabled(enabled: boolean): void {
  isEnabled = enabled;
}

/**
 * Check if feature picker is enabled
 */
export function isFeaturePickerEnabled(): boolean {
  return isEnabled;
}

/**
 * Get count of stored features (for debugging)
 */
export function getStoredFeatureCount(): { tiles: number; features: number } {
  let features = 0;
  for (const tileFeatures of featuresByTile.values()) {
    features += tileFeatures.length;
  }
  return { tiles: featuresByTile.size, features };
}
