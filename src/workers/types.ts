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
 * Request types (main thread -> worker)
 */
export type WorkerRequest =
  | { type: 'RENDER_TILE_TEXTURE'; id: string; payload: RenderTileTexturePayload }
  | { type: 'RENDER_LOW_DETAIL_TEXTURE'; id: string; payload: RenderLowDetailTexturePayload }
  | { type: 'CREATE_BASE_GEOMETRY'; id: string; payload: CreateBaseGeometryPayload }
  | { type: 'CAPABILITY_CHECK'; id: string };

/**
 * Response types (worker -> main thread)
 */
export type WorkerResponse =
  | { type: 'RENDER_TILE_TEXTURE_RESULT'; id: string; result: ImageBitmap }
  | { type: 'RENDER_LOW_DETAIL_TEXTURE_RESULT'; id: string; result: ImageBitmap }
  | { type: 'CREATE_BASE_GEOMETRY_RESULT'; id: string; result: BaseGeometryResult }
  | { type: 'CAPABILITY_CHECK_RESULT'; id: string; supported: boolean }
  | { type: 'ERROR'; id: string; error: string };
