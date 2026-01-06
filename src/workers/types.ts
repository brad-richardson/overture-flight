/**
 * Worker message protocol types for tile rendering
 */

/**
 * Geographic bounds of a tile
 */
export interface TileBounds {
  west: number;
  east: number;
  north: number;
  south: number;
}

/**
 * Parsed feature from vector tile
 */
export interface ParsedFeature {
  type: string;
  coordinates: number[] | number[][] | number[][][] | number[][][][];
  properties: Record<string, unknown>;
  layer: string;
}

/**
 * Payload for rendering a tile texture
 */
export interface RenderTileTexturePayload {
  baseFeatures: ParsedFeature[];
  transportFeatures: ParsedFeature[];
  bounds: TileBounds;
  textureSize: number;
}

/**
 * Payload for rendering a low-detail tile texture
 */
export interface RenderLowDetailTexturePayload {
  baseFeatures: ParsedFeature[];
  bounds: TileBounds;
  textureSize: number;
}

/**
 * Scene origin for coordinate conversion
 * Used by geometry workers to convert geo coords to world coords
 */
export interface SceneOrigin {
  lng: number;
  lat: number;
  metersPerDegLng: number;
  metersPerDegLat: number;
}

/**
 * Geometry buffer group - represents a set of geometries with same color/layer
 * All arrays are transferable (will be moved, not copied)
 */
export interface GeometryBufferGroup {
  /** Layer name (land, water, land_cover, etc.) */
  layer: string;
  /** Hex color value */
  color: number;
  /** Vertex positions (x, y, z interleaved) - Float32Array */
  positions: Float32Array;
  /** Triangle indices - Uint32Array */
  indices: Uint32Array;
  /** Vertex normals (x, y, z interleaved) - Float32Array */
  normals: Float32Array;
  /** Whether this layer follows terrain (Y values need adjustment on main thread) */
  terrainFollowing: boolean;
  /** Y offset to apply (for non-terrain-following, or base offset for terrain-following) */
  yOffset: number;
  /** Render order for this layer */
  renderOrder: number;
}

/**
 * Line geometry buffer group - for water lines (rivers, streams)
 */
export interface LineGeometryBufferGroup {
  /** Layer name */
  layer: string;
  /** Hex color value */
  color: number;
  /** Vertex positions (x, y, z interleaved) as segment pairs */
  positions: Float32Array;
  /** Y offset to apply */
  yOffset: number;
  /** Render order */
  renderOrder: number;
}

/**
 * Payload for creating base layer geometry
 */
export interface CreateBaseGeometryPayload {
  /** Parsed features from MVT */
  features: ParsedFeature[];
  /** Scene origin for coordinate conversion */
  origin: SceneOrigin;
  /** Tile coordinates (for debugging) */
  tileX: number;
  tileY: number;
  tileZ: number;
}

/**
 * Result of base layer geometry creation
 */
export interface BaseGeometryResult {
  /** Polygon geometry groups (one per color+layer combination) */
  polygonGroups: GeometryBufferGroup[];
  /** Line geometry groups (for water lines) */
  lineGroups: LineGeometryBufferGroup[];
}

/**
 * Payload for MVT parsing
 */
export interface ParseMVTPayload {
  /** Raw MVT ArrayBuffer (transferable) */
  data: ArrayBuffer;
  /** Tile coordinates */
  tileX: number;
  tileY: number;
  zoom: number;
  /** Layer name to extract (null = all layers) */
  layerName: string | null;
}

/**
 * Compact feature representation for worker transfer
 * Uses transferable typed arrays instead of nested JS arrays
 */
export interface CompactFeature {
  /** Feature type: 0=Point, 1=MultiPoint, 2=LineString, 3=MultiLineString, 4=Polygon, 5=MultiPolygon */
  typeIndex: number;
  /** Layer name */
  layer: string;
  /** Flattened coordinates [x1, y1, x2, y2, ...] - transferable */
  coords: Float64Array;
  /** Ring/part start indices (for polygons/multi-geometries) */
  ringIndices: Uint32Array;
  /** Simplified properties (only commonly used fields for styling) */
  props: {
    subtype?: string;
    class?: string;
    names?: { primary?: string };
    surface?: string;
    road_flags?: string;
    level_rules?: string;
    level?: number;
    _fromLowerZoom?: boolean;
    _sourceZoom?: number;
    // Additional styling properties
    type?: string;
    category?: string;
    depth?: number;
    road_class?: string;
    highway?: string;
    is_tunnel?: boolean;
    is_underground?: boolean;
    [key: string]: unknown;
  };
}

/**
 * Result of MVT parsing in worker
 */
export interface ParseMVTResult {
  /** Compact feature array */
  features: CompactFeature[];
  /** Feature count by layer (for profiling) */
  layerCounts: Record<string, number>;
}

/**
 * Payload for elevation tile decoding
 */
export interface DecodeElevationPayload {
  /** URL of the Terrarium PNG tile */
  url: string;
  /** Tile size (typically 256) */
  tileSize: number;
  /** Terrarium offset constant (32768) */
  terrariumOffset: number;
}

/**
 * Result of elevation tile decoding
 */
export interface DecodeElevationResult {
  /** Height values as Float32Array (tileSize * tileSize) - transferable */
  heights: Float32Array;
}

/**
 * Request types (main thread -> worker)
 */
export type WorkerRequest =
  | { type: 'RENDER_TILE_TEXTURE'; id: string; payload: RenderTileTexturePayload }
  | { type: 'RENDER_LOW_DETAIL_TEXTURE'; id: string; payload: RenderLowDetailTexturePayload }
  | { type: 'CREATE_BASE_GEOMETRY'; id: string; payload: CreateBaseGeometryPayload }
  | { type: 'PARSE_MVT'; id: string; payload: ParseMVTPayload }
  | { type: 'DECODE_ELEVATION'; id: string; payload: DecodeElevationPayload }
  | { type: 'CAPABILITY_CHECK'; id: string };

/**
 * Response types (worker -> main thread)
 */
export type WorkerResponse =
  | { type: 'RENDER_TILE_TEXTURE_RESULT'; id: string; result: ImageBitmap }
  | { type: 'RENDER_LOW_DETAIL_TEXTURE_RESULT'; id: string; result: ImageBitmap }
  | { type: 'CREATE_BASE_GEOMETRY_RESULT'; id: string; result: BaseGeometryResult }
  | { type: 'PARSE_MVT_RESULT'; id: string; result: ParseMVTResult }
  | { type: 'DECODE_ELEVATION_RESULT'; id: string; result: DecodeElevationResult }
  | { type: 'CAPABILITY_CHECK_RESULT'; id: string; supported: boolean }
  | { type: 'ERROR'; id: string; error: string };
