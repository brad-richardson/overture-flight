// Mobile device detection - used to reduce texture sizes and cache limits
// Detects once at startup for consistent behavior throughout session
export const IS_MOBILE = typeof navigator !== 'undefined' &&
  /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

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

// Overture divisions theme (administrative boundaries, place names)
export const OVERTURE_DIVISIONS_PMTILES: string = import.meta.env.VITE_DIVISIONS_PMTILES_URL
  || 'https://d3c1b7bog2u1nn.cloudfront.net/2025-12-17/divisions.pmtiles';

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
  SPAWN_ALTITUDE: 400,  // meters - above most buildings
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
// Note: Client UPDATE_RATE (50ms) must be >= server rate limit (30ms in party/index.ts)
// to avoid messages being dropped. Server limit is intentionally lower to allow
// for network jitter while still protecting against flooding attacks.
export interface NetworkConfig {
  UPDATE_RATE: number;
  INTERPOLATION_SPEED: number;
}

export const NETWORK: NetworkConfig = {
  UPDATE_RATE: 50,         // ms between position updates (20Hz)
  INTERPOLATION_SPEED: 10, // interpolation speed factor (higher = faster)
};

// Location definition
export interface Location {
  lat: number;
  lng: number;
  name: string;
}

// Starting locations with good building data
export const LOCATIONS: Record<string, Location> = {
  FLORENCE: { lat: 43.7680, lng: 11.2531, name: 'Florence' },
  BOSTON: { lat: 42.3541, lng: -71.0704, name: 'Boston' },
  NYC: { lat: 40.7580, lng: -73.9855, name: 'New York City (Midtown)' },
  SF: { lat: 37.7749, lng: -122.4194, name: 'San Francisco' },
  LONDON: { lat: 51.5074, lng: -0.1278, name: 'London' },
  TOKYO: { lat: 35.6762, lng: 139.6503, name: 'Tokyo' },
  DUBAI: { lat: 25.2048, lng: 55.2708, name: 'Dubai' },
  CHICAGO: { lat: 41.8781, lng: -87.6298, name: 'Chicago' },
};

export const DEFAULT_LOCATION: Location = LOCATIONS.FLORENCE;

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
  GPU_DISPLACEMENT: boolean;  // Use GPU shader for terrain displacement (experimental)
}

export const ELEVATION: ElevationConfig = {
  // AWS S3 Terrarium tiles endpoint
  TERRARIUM_URL: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  TERRARIUM_OFFSET: 32768.0,  // Offset for Terrarium height decoding
  TILE_SIZE: 256,             // Terrarium tiles are 256x256 pixels
  ZOOM: 12,                   // Zoom level for elevation tiles
  TERRAIN_SEGMENTS: 32,       // Subdivisions per terrain mesh (reduced for perf)
  TERRAIN_ENABLED: true,      // Enable/disable terrain elevation
  VERTICAL_EXAGGERATION: 1.0, // Multiply elevation values (1.0 = realistic)
  GPU_DISPLACEMENT: import.meta.env.VITE_GPU_TERRAIN === 'true', // GPU shader for displacement (experimental)
};

// Ground texture rendering settings
// Renders vector tiles (land, water, roads) to cached textures
export interface GroundTextureConfig {
  TEXTURE_SIZE: number;           // Texture resolution (width and height in pixels)
  CACHE_MAX_SIZE: number;         // Maximum number of textures to cache
  CACHE_DISPOSE_THRESHOLD: number; // Start evicting when cache reaches this size
  TERRAIN_QUAD_SEGMENTS: number;  // Subdivisions for terrain-following quads
  ENABLED: boolean;               // Enable/disable texture-based ground rendering
}

export const GROUND_TEXTURE: GroundTextureConfig = {
  TEXTURE_SIZE: IS_MOBILE ? 1024 : 2048,              // Half resolution on mobile to reduce GPU memory
  CACHE_MAX_SIZE: IS_MOBILE ? 30 : 100,               // Fewer cached textures on mobile
  CACHE_DISPOSE_THRESHOLD: IS_MOBILE ? 20 : 80,       // Earlier eviction on mobile
  TERRAIN_QUAD_SEGMENTS: IS_MOBILE ? 8 : 16,          // Simpler terrain mesh on mobile
  ENABLED: true,
};

// Low-detail terrain settings (Z10 background layer)
// Renders distant terrain with simplified features for extended visibility
// Enable via VITE_ENABLE_Z10_RENDERING=true environment variable (disabled by default)
export interface LowDetailTerrainConfig {
  ENABLED: boolean;               // Enable/disable low-detail distant terrain (env: VITE_ENABLE_Z10_RENDERING)
  ZOOM: number;                   // Zoom level for low-detail tiles
  TILE_RADIUS: number;            // Radius of tiles to load (2 = 5x5 grid)
  TEXTURE_SIZE: number;           // Lower resolution texture
  TERRAIN_QUAD_SEGMENTS: number;  // Fewer subdivisions for distant terrain
  Y_OFFSET: number;               // Y offset below Z14 tiles (meters)
  UNLOAD_DISTANCE: number;        // Chebyshev distance for tile unloading
}

export const LOW_DETAIL_TERRAIN: LowDetailTerrainConfig = {
  ENABLED: import.meta.env.VITE_ENABLE_Z10_RENDERING === 'true',
  ZOOM: 10,                       // Z10 covers 16x16 Z14 tiles (~24km x 24km)
  TILE_RADIUS: 2,                 // 5x5 grid = ~120km x 120km coverage
  TEXTURE_SIZE: IS_MOBILE ? 512 : 1024,              // Even lower resolution on mobile
  TERRAIN_QUAD_SEGMENTS: IS_MOBILE ? 4 : 8,          // Simpler mesh on mobile
  Y_OFFSET: -0.5,                 // 0.5m below Z14 layer (small offset, stencil does the real masking)
  UNLOAD_DISTANCE: 4,             // Chebyshev distance for unloading
};

// Expanded terrain settings (Z14 terrain-only outer ring)
// Loads a larger area of terrain/texture without buildings for extended visibility
// Helps avoid "edge of world" when flying
export interface ExpandedTerrainConfig {
  ENABLED: boolean;               // Enable/disable expanded terrain loading
  TILE_RADIUS: number;            // Radius for expanded terrain (4 = 9x9 grid total)
  CORE_RADIUS: number;            // Core radius with buildings (1 = 3x3 grid)
  MAX_CONCURRENT: number;         // Max expanded tiles to process at once
  UNLOAD_DISTANCE: number;        // Chebyshev distance for unloading expanded tiles
  CACHE_MAX_SIZE: number;         // Dedicated cache size for expanded tiles
  TEXTURE_SIZE: number;           // Texture resolution for expanded tiles
}

export const EXPANDED_TERRAIN: ExpandedTerrainConfig = {
  ENABLED: true,
  TILE_RADIUS: 4,                 // 9x9 grid total (2*4+1 = 9)
  CORE_RADIUS: 1,                 // 3x3 core with buildings (2*1+1 = 3)
  MAX_CONCURRENT: 1,              // Process only 1 expanded tile at a time
  UNLOAD_DISTANCE: 6,             // Slightly beyond load radius for hysteresis
  CACHE_MAX_SIZE: IS_MOBILE ? 40 : 80, // Dedicated cache for expanded tiles
  TEXTURE_SIZE: IS_MOBILE ? 512 : 1024, // Lower resolution for distant tiles
};

// Web Worker settings for tile rendering
// Offloads CPU-intensive work to background threads
export interface WorkersConfig {
  ENABLED: boolean;               // Enable/disable texture worker rendering
  GEOMETRY_ENABLED: boolean;      // Enable/disable geometry worker creation
  MVT_ENABLED: boolean;           // Enable/disable MVT parsing worker (uses zero-copy ArrayBuffer transfer)
  ELEVATION_ENABLED: boolean;     // Enable/disable elevation decoding worker (uses OffscreenCanvas)
  FULL_PIPELINE_ENABLED: boolean; // Enable/disable full pipeline workers (fetch+parse+render in worker)
  POOL_SIZE: number;              // Number of workers (0 = auto based on cores)
}

export const WORKERS: WorkersConfig = {
  ENABLED: false,                 // Texture workers: Disabled (structured clone overhead negates benefit)
  GEOMETRY_ENABLED: true,         // Geometry workers: Enabled (uses zero-copy ArrayBuffer transfer)
  MVT_ENABLED: import.meta.env.VITE_MVT_WORKERS !== 'false', // MVT parsing workers: Enabled by default
  ELEVATION_ENABLED: import.meta.env.VITE_ELEVATION_WORKERS !== 'false', // Elevation workers: Enabled by default
  FULL_PIPELINE_ENABLED: import.meta.env.VITE_FULL_PIPELINE_WORKERS === 'true', // Full pipeline workers: Disabled by default (experimental)
  POOL_SIZE: 0,                   // 0 = auto (cores - 1, min 2, max 4)
};

// Loading gate settings for initial tile loading
// Stalls plane movement until minimum tiles are rendered
export interface LoadingGateConfig {
  ENABLED: boolean;               // Enable/disable loading gate
  MIN_TILES: number;              // Minimum tiles before starting
  MAX_WAIT_MS: number;            // Maximum wait time (fallback timeout)
}

export const LOADING_GATE: LoadingGateConfig = {
  ENABLED: true,
  MIN_TILES: 1,                   // Wait for center tile only
  MAX_WAIT_MS: 5000,              // 5 second timeout
};

// Tile loading concurrency settings
// Limits parallel tile processing to maintain 60fps during loading
// Override with VITE_TILE_CONCURRENCY env variable
export interface TileConcurrencyConfig {
  ENABLED: boolean;               // Enable/disable concurrency limiter
  MAX_CONCURRENT: number;         // Maximum tiles processing at once
}

const defaultTileConcurrency = IS_MOBILE ? 2 : 3;
const tileConcurrencyEnv = import.meta.env.VITE_TILE_CONCURRENCY;
const parsedTileConcurrency = tileConcurrencyEnv ? parseInt(tileConcurrencyEnv, 10) : NaN;
export const TILE_CONCURRENCY: TileConcurrencyConfig = {
  ENABLED: tileConcurrencyEnv !== '0',
  MAX_CONCURRENT: Number.isNaN(parsedTileConcurrency) ? defaultTileConcurrency : parsedTileConcurrency,
};

// Network fetch concurrency settings
// Limits parallel HTTP requests to prevent flooding and improve prioritization
// Override with VITE_FETCH_CONCURRENCY env variable
export interface FetchConcurrencyConfig {
  ENABLED: boolean;               // Enable/disable fetch concurrency limiter
  MAX_CONCURRENT: number;         // Maximum concurrent network requests
}

const defaultFetchConcurrency = IS_MOBILE ? 4 : 6;
const fetchConcurrencyEnv = import.meta.env.VITE_FETCH_CONCURRENCY;
const parsedFetchConcurrency = fetchConcurrencyEnv ? parseInt(fetchConcurrencyEnv, 10) : NaN;
export const FETCH_CONCURRENCY: FetchConcurrencyConfig = {
  ENABLED: fetchConcurrencyEnv !== '0',
  MAX_CONCURRENT: Number.isNaN(parsedFetchConcurrency) ? defaultFetchConcurrency : parsedFetchConcurrency,
};

// Performance profiling settings
// Enable via VITE_PROFILING=true for Chrome DevTools visibility
export interface ProfilingConfig {
  ENABLED: boolean;               // Enable/disable profiling instrumentation
  VERBOSE: boolean;               // Log individual tile metrics to console
}

export const PROFILING: ProfilingConfig = {
  ENABLED: import.meta.env.VITE_PROFILING === 'true',
  VERBOSE: import.meta.env.VITE_PROFILING_VERBOSE === 'true',
};

// Process chaining optimization settings
// Controls how tile loading is sequenced for better initial load performance
export interface ProcessChainingConfig {
  DEFER_LOW_ZOOM_WATER: boolean;  // Defer z8/z6 water loading to background (keep z10 in critical path)
  PRIORITIZE_CENTER_TILE: boolean; // Load center tile before neighbors
}

export const PROCESS_CHAINING: ProcessChainingConfig = {
  DEFER_LOW_ZOOM_WATER: true,     // Skip z8/z6 initially, load in background (reduces initial requests ~30%)
  PRIORITIZE_CENTER_TILE: true,   // Center tile gets processed first
};

// IndexedDB persistent texture caching
// Caches rendered textures for faster repeat visits
// Disabled by default in dev/PR builds, enabled in prod
// Override with VITE_TEXTURE_CACHE env variable
export interface TextureCacheConfig {
  ENABLED: boolean;               // Enable/disable IndexedDB texture caching
  DB_NAME: string;                // IndexedDB database name
  STORE_NAME: string;             // Object store name for textures
  MAX_ENTRIES: number;            // Maximum cached textures (LRU eviction)
  VERSION: number;                // Cache version (increment to invalidate)
  TTL_MS: number;                 // Time-to-live in milliseconds (0 = no expiry)
}

// Determine if caching should be enabled:
// - Explicitly set via VITE_TEXTURE_CACHE=true/false
// - Otherwise: disabled in dev mode, enabled in prod
const textureCacheDefault = !import.meta.env.DEV;
const textureCacheEnv = import.meta.env.VITE_TEXTURE_CACHE;
const textureCacheEnabled = textureCacheEnv !== undefined
  ? textureCacheEnv === 'true'
  : textureCacheDefault;

export const TEXTURE_CACHE: TextureCacheConfig = {
  ENABLED: textureCacheEnabled,
  DB_NAME: 'overture-flight-textures',
  STORE_NAME: 'textures',
  MAX_ENTRIES: IS_MOBILE ? 50 : 200,  // Fewer entries on mobile
  VERSION: 1,                         // Increment to invalidate cache
  TTL_MS: 24 * 60 * 60 * 1000,        // 1 day (allows quick iteration on rendering bugs)
};
