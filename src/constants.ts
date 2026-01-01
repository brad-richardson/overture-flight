// PMTiles URLs for Overture Maps data
// Check https://docs.overturemaps.org/guides/pmtiles/ for latest releases
// Can be overridden via environment variables
export const OVERTURE_BUILDINGS_PMTILES: string = import.meta.env.VITE_PMTILES_URL
  || 'https://d3c1b7bog2u1nn.cloudfront.net/2025-12-17/buildings.pmtiles';

// Overture base theme (land, water, landuse, bathymetry)
export const OVERTURE_BASE_PMTILES: string = import.meta.env.VITE_BASE_PMTILES_URL
  || 'https://d3c1b7bog2u1nn.cloudfront.net/2025-12-17/base.pmtiles';

// Overture transportation theme (roads, paths, railways)
export const OVERTURE_TRANSPORTATION_PMTILES: string = import.meta.env.VITE_TRANSPORTATION_PMTILES_URL
  || 'https://d3c1b7bog2u1nn.cloudfront.net/2025-12-17/transportation.pmtiles';

// MapTiler style (requires API key for production)
// For development, using a free OSM-based style
export const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// PartyKit configuration
// Set VITE_PARTYKIT_HOST environment variable for production deployment
export const PARTYKIT_HOST: string | null = import.meta.env.VITE_PARTYKIT_HOST
  || (import.meta.env.DEV ? 'localhost:1999' : null);

// Validate PartyKit host is configured in production
if (!PARTYKIT_HOST && !import.meta.env.DEV) {
  console.error('VITE_PARTYKIT_HOST environment variable must be set for production builds');
}

// Flight physics constants
export interface FlightConfig {
  MIN_SPEED: number;
  MAX_SPEED: number;
  DEFAULT_SPEED: number;
  THROTTLE_RATE: number;
  PITCH_RATE: number;
  ROLL_RATE: number;
  TURN_RATE: number;
  GRAVITY: number;
  MIN_ALTITUDE: number;
  MAX_ALTITUDE: number;
  SPAWN_ALTITUDE: number;
}

export const FLIGHT: FlightConfig = {
  MIN_SPEED: 15,        // m/s - stall speed
  MAX_SPEED: 150,       // m/s
  DEFAULT_SPEED: 40,    // m/s - reduced for easier debugging
  THROTTLE_RATE: 20,    // m/s per second
  PITCH_RATE: 45,       // degrees per second
  ROLL_RATE: 60,        // degrees per second
  TURN_RATE: 0.5,       // heading change per degree of roll
  GRAVITY: 15,          // m/s descent when stalled
  MIN_ALTITUDE: 0,      // meters
  MAX_ALTITUDE: 5000,   // meters
  SPAWN_ALTITUDE: 230,  // meters - above most buildings
};

// Camera constants
export interface CameraConfig {
  DEFAULT_PITCH: number;
  MIN_PITCH: number;
  MAX_PITCH: number;
  DEFAULT_DISTANCE: number;
  ORBIT_SENSITIVITY: number;
}

export const CAMERA: CameraConfig = {
  DEFAULT_PITCH: 20,    // degrees - slight downward angle
  MIN_PITCH: 5,
  MAX_PITCH: 85,
  DEFAULT_DISTANCE: 50, // meters behind plane
  ORBIT_SENSITIVITY: 0.5,
};

// Network constants
export interface NetworkConfig {
  UPDATE_RATE: number;
  INTERPOLATION_DELAY: number;
}

export const NETWORK: NetworkConfig = {
  UPDATE_RATE: 50,      // ms between position updates (20Hz)
  INTERPOLATION_DELAY: 100, // ms delay for smooth interpolation
};

// Location definition
export interface Location {
  lat: number;
  lng: number;
  name: string;
}

// Starting locations with good building data
export const LOCATIONS: Record<string, Location> = {
  NYC: { lat: 40.7580, lng: -73.9855, name: 'New York City (Midtown)' },
  SF: { lat: 37.7749, lng: -122.4194, name: 'San Francisco' },
  LONDON: { lat: 51.5074, lng: -0.1278, name: 'London' },
  TOKYO: { lat: 35.6762, lng: 139.6503, name: 'Tokyo' },
  DUBAI: { lat: 25.2048, lng: 55.2708, name: 'Dubai' },
  CHICAGO: { lat: 41.8781, lng: -87.6298, name: 'Chicago' },
};

export const DEFAULT_LOCATION: Location = LOCATIONS.NYC;

// Player colors for multiplayer
export const PLAYER_COLORS: string[] = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // purple
  '#ec4899', // pink
];

// 3D model paths - use BASE_URL for GitHub Pages compatibility
export const PLANE_MODEL_URL: string = `${import.meta.env.BASE_URL}models/plane.glb`;

// Plane rendering settings
export interface PlaneRenderConfig {
  SCALE: number;
  MOBILE_SCALE: number;
  LOCAL_VISIBLE: boolean;
  MIN_TERRAIN_CLEARANCE: number;
}

export const PLANE_RENDER: PlaneRenderConfig = {
  SCALE: 0.25,          // Scale factor for plane model
  MOBILE_SCALE: 0.18,   // Smaller scale for mobile devices
  LOCAL_VISIBLE: true,  // show local player's plane in chase view
  MIN_TERRAIN_CLEARANCE: 50,  // Minimum altitude above terrain when teleporting (meters)
};

// Elevation/terrain settings
// Uses AWS Terrarium tiles (free, no API key required)
// Terrarium format: height = (R * 256 + G + B/256) - 32768
export interface ElevationConfig {
  TERRARIUM_URL: string;
  TERRARIUM_OFFSET: number;
  TILE_SIZE: number;
  ZOOM: number;
  TERRAIN_SEGMENTS: number;
  TERRAIN_ENABLED: boolean;
  VERTICAL_EXAGGERATION: number;
}

export const ELEVATION: ElevationConfig = {
  // AWS S3 Terrarium tiles endpoint
  TERRARIUM_URL: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  TERRARIUM_OFFSET: 32768.0,  // Offset for Terrarium height decoding
  TILE_SIZE: 256,             // Terrarium tiles are 256x256 pixels
  ZOOM: 11,                   // Zoom level for elevation tiles (reduced for perf)
  TERRAIN_SEGMENTS: 32,       // Subdivisions per terrain mesh (reduced for perf)
  TERRAIN_ENABLED: true,      // Enable/disable terrain elevation
  VERTICAL_EXAGGERATION: 1.0, // Multiply elevation values (1.0 = realistic)
};
