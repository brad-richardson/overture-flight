// Ground texture rendering module
// Renders vector tiles (land, water, roads) to cached textures on terrain quads

export {
  createGroundForTile,
  removeGroundGroup,
  hasGroundTile,
  getActiveGroundTileCount,
  evictDistantGroundTextures,
  clearAllGroundTiles,
  getGroundCacheStats,
} from './ground-layer.js';

export {
  queueExpandedTile,
  createExpandedGroundForTile,
  removeExpandedTile,
  removeExpandedGroundGroup,
  promoteExpandedToCore,
  demoteFromCore,
  getExpandedTilesToLoad,
  getExpandedTilesToUnload,
  pruneExpandedQueue,
  hasExpandedTile,
  getActiveExpandedTileCount,
  getExpandedQueueLength,
  clearAllExpandedTiles,
  getExpandedCacheStats,
} from './expanded-ground-layer.js';

export { TileTextureCache, getTextureCache, initTextureCache } from './tile-texture-cache.js';
export { TerrainQuad } from './terrain-quad.js';

export type {
  TileBounds,
  ParsedFeature,
  GroundTextureConfig,
  CachedTexture,
  RenderedTile,
  LayerConfig,
  RoadStyle,
  GroundTileData,
} from './types.js';
