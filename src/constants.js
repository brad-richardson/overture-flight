// PMTiles URLs for Overture Maps building data
export const OVERTURE_BUILDINGS_PMTILES = 'pmtiles://https://overturemaps-tiles-us-west-2-beta.s3.amazonaws.com/2024-11-13/buildings.pmtiles';

// MapTiler style (requires API key for production)
// For development, using a free OSM-based style
export const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// PartyKit configuration
export const PARTYKIT_HOST = import.meta.env.DEV
  ? 'localhost:1999'
  : 'flight-sim.your-username.partykit.dev'; // Update with your deployed URL

// Flight physics constants
export const FLIGHT = {
  MIN_SPEED: 20,        // m/s - stall speed
  MAX_SPEED: 200,       // m/s
  DEFAULT_SPEED: 80,    // m/s
  THROTTLE_RATE: 20,    // m/s per second
  PITCH_RATE: 45,       // degrees per second
  ROLL_RATE: 60,        // degrees per second
  TURN_RATE: 0.5,       // heading change per degree of roll
  GRAVITY: 15,          // m/s descent when stalled
  MIN_ALTITUDE: 0,      // meters
  MAX_ALTITUDE: 5000,   // meters
  SPAWN_ALTITUDE: 500,  // meters - respawn height
};

// Camera constants
export const CAMERA = {
  DEFAULT_PITCH: 60,    // degrees
  MIN_PITCH: 20,
  MAX_PITCH: 85,
  DEFAULT_DISTANCE: 500, // meters behind plane
  ORBIT_SENSITIVITY: 0.5,
};

// Network constants
export const NETWORK = {
  UPDATE_RATE: 50,      // ms between position updates (20Hz)
  INTERPOLATION_DELAY: 100, // ms delay for smooth interpolation
};

// Starting locations with good building data
export const LOCATIONS = {
  NYC: { lat: 40.7128, lng: -74.0060, name: 'New York City' },
  SF: { lat: 37.7749, lng: -122.4194, name: 'San Francisco' },
  LONDON: { lat: 51.5074, lng: -0.1278, name: 'London' },
  TOKYO: { lat: 35.6762, lng: 139.6503, name: 'Tokyo' },
  DUBAI: { lat: 25.2048, lng: 55.2708, name: 'Dubai' },
  CHICAGO: { lat: 41.8781, lng: -87.6298, name: 'Chicago' },
};

export const DEFAULT_LOCATION = LOCATIONS.NYC;

// Player colors for multiplayer
export const PLAYER_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // purple
  '#ec4899', // pink
];
