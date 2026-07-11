import type { ParsedFeature } from './types.js';

interface VectorTileFeatureLike {
  properties: Record<string, unknown>;
  toGeoJSON(tileX: number, tileY: number, zoom: number): {
    geometry: {
      type: string;
      coordinates: ParsedFeature['coordinates'];
    };
  };
}

interface VectorTileLayerLike {
  length: number;
  feature(index: number): VectorTileFeatureLike;
}

/**
 * Predicate to keep a feature before its geometry is decoded. Returning false
 * skips the (comparatively expensive) `toGeoJSON` call entirely, so a layer that
 * carries mostly unwanted features can be decoded down to just the ones we draw.
 */
export type FeaturePredicate = (
  layerName: string,
  properties: Record<string, unknown>
) => boolean;

/**
 * Decode selected MVT layers while retaining the tile's layer and feature order.
 * A null selection is the explicit opt-in for decoding every layer. An optional
 * `keepFeature` predicate filters features within a layer before geometry decode.
 */
export function parseVectorTileLayers(
  layers: Record<string, VectorTileLayerLike>,
  tileX: number,
  tileY: number,
  zoom: number,
  requestedLayerNames: readonly string[] | null,
  keepFeature?: FeaturePredicate
): ParsedFeature[] {
  const requested = requestedLayerNames === null
    ? null
    : new Set(requestedLayerNames);
  const features: ParsedFeature[] = [];

  for (const name of Object.keys(layers)) {
    if (requested && !requested.has(name)) continue;

    const layer = layers[name];
    if (!layer) continue;

    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      if (keepFeature && !keepFeature(name, feature.properties)) continue;
      const geojson = feature.toGeoJSON(tileX, tileY, zoom);

      features.push({
        type: geojson.geometry.type,
        coordinates: geojson.geometry.coordinates,
        properties: feature.properties,
        layer: name,
      });
    }
  }

  return features;
}
