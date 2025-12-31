import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { OVERTURE_BUILDINGS_PMTILES, MAP_STYLE, DEFAULT_LOCATION } from './constants.js';

let map = null;
let terrainEnabled = false;
let deckOverlay = null;

/**
 * Initialize the MapLibre map with PMTiles support and 3D buildings
 * @returns {Promise<maplibregl.Map>}
 */
export async function initMap() {
  // Register PMTiles protocol
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);

  // Create map instance
  map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: [DEFAULT_LOCATION.lng, DEFAULT_LOCATION.lat],
    zoom: 15,
    pitch: 60,
    bearing: 0,
    antialias: true,
    maxPitch: 85,
    attributionControl: false, // We'll add custom attribution
  });

  // Add attribution control with data sources
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      customAttribution: [
        '© <a href="https://overturemaps.org" target="_blank">Overture Maps</a>',
        '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
        '© <a href="https://carto.com/attributions" target="_blank">CARTO</a>',
      ],
    }),
    'bottom-right'
  );

  // Wait for map to load
  await new Promise((resolve) => {
    map.on('load', resolve);
  });

  // Disable default map interactions (we control camera)
  map.dragPan.disable();
  map.dragRotate.disable();
  map.scrollZoom.disable();
  map.doubleClickZoom.disable();
  map.touchZoomRotate.disable();
  map.keyboard.disable();

  // Add Overture buildings source
  map.addSource('overture-buildings', {
    type: 'vector',
    url: OVERTURE_BUILDINGS_PMTILES,
  });

  // Add 3D building extrusion layer
  // Note: source-layer 'building' matches Overture PMTiles schema
  // Verify at https://docs.overturemaps.org/schema/reference/buildings/building
  map.addLayer({
    id: 'buildings-3d',
    type: 'fill-extrusion',
    source: 'overture-buildings',
    'source-layer': 'building',
    minzoom: 13,
    paint: {
      'fill-extrusion-color': [
        'interpolate',
        ['linear'],
        ['coalesce', ['get', 'height'], 10],
        0, '#444444',
        50, '#555555',
        100, '#666666',
        200, '#777777',
      ],
      'fill-extrusion-height': ['coalesce', ['get', 'height'], 10],
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.85,
    },
  });

  // Add terrain if API key is available
  // Set VITE_MAPTILER_KEY environment variable to enable terrain
  const maptilerKey = import.meta.env.VITE_MAPTILER_KEY;
  if (maptilerKey) {
    try {
      map.addSource('terrain', {
        type: 'raster-dem',
        url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${maptilerKey}`,
        tileSize: 256,
      });
      map.setTerrain({ source: 'terrain', exaggeration: 1.0 });
      terrainEnabled = true;
      console.log('Terrain enabled');
    } catch (e) {
      console.warn('Failed to enable terrain:', e);
    }
  }

  // Initialize deck.gl overlay for 3D plane rendering
  deckOverlay = new MapboxOverlay({
    interleaved: true,
    layers: [], // Layers will be set by plane-renderer
  });
  map.addControl(deckOverlay);

  return map;
}

/**
 * Get the map instance
 * @returns {maplibregl.Map}
 */
export function getMap() {
  return map;
}

/**
 * Get the deck.gl overlay for updating layers
 * @returns {MapboxOverlay}
 */
export function getDeckOverlay() {
  return deckOverlay;
}

/**
 * Update camera position to follow the plane
 * @param {Object} options
 * @param {number} options.lng - Longitude
 * @param {number} options.lat - Latitude
 * @param {number} options.bearing - Camera bearing (heading + orbit offset)
 * @param {number} options.pitch - Camera pitch angle
 * @param {number} options.zoom - Zoom level based on altitude
 */
export function updateCamera({ lng, lat, bearing, pitch, zoom }) {
  if (!map) return;

  map.jumpTo({
    center: [lng, lat],
    bearing,
    pitch,
    zoom,
  });
}

/**
 * Convert altitude to appropriate zoom level
 * @param {number} altitude - Altitude in meters
 * @returns {number} Zoom level
 */
export function altitudeToZoom(altitude) {
  // Approximate conversion: higher altitude = lower zoom
  // zoom 15 at ground level, zoom 10 at 5000m
  const minZoom = 10;
  const maxZoom = 16;
  const minAlt = 50;
  const maxAlt = 5000;

  const normalized = Math.max(0, Math.min(1, (altitude - minAlt) / (maxAlt - minAlt)));
  return maxZoom - normalized * (maxZoom - minZoom);
}

/**
 * Query buildings at a specific point
 * @param {number} lng - Longitude
 * @param {number} lat - Latitude
 * @returns {Array} Features at the point
 */
export function queryBuildingsAt(lng, lat) {
  if (!map) return [];

  const point = map.project([lng, lat]);
  return map.queryRenderedFeatures(point, { layers: ['buildings-3d'] });
}

/**
 * Get terrain elevation at a point (returns 0 if terrain not enabled)
 * @param {number} lng - Longitude
 * @param {number} lat - Latitude
 * @returns {number} Elevation in meters
 */
export function getTerrainElevation(lng, lat) {
  if (!map || !terrainEnabled) return 0;

  try {
    const elevation = map.queryTerrainElevation([lng, lat]);
    return elevation || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Check if terrain is enabled
 * @returns {boolean}
 */
export function isTerrainEnabled() {
  return terrainEnabled;
}
