/**
 * Web Worker for MVT parsing
 * Offloads CPU-intensive MVT decoding from the main thread
 * Uses transferable typed arrays for efficient data transfer
 */

import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type { WorkerRequest, WorkerResponse, CompactFeature, ParseMVTResult } from './types.js';

// Geometry type mapping
const GEOM_TYPE_MAP: Record<string, number> = {
  'Point': 0,
  'MultiPoint': 1,
  'LineString': 2,
  'MultiLineString': 3,
  'Polygon': 4,
  'MultiPolygon': 5,
};

/**
 * Flatten nested coordinate arrays to Float64Array
 * Returns coordinates and ring indices for reconstruction
 */
function flattenCoordinates(
  geomType: string,
  coordinates: number[] | number[][] | number[][][] | number[][][][]
): { coords: Float64Array; ringIndices: Uint32Array } {
  const flatCoords: number[] = [];
  const ringStarts: number[] = [];

  function processRing(ring: number[][]) {
    ringStarts.push(flatCoords.length / 2);
    for (const coord of ring) {
      flatCoords.push(coord[0], coord[1]);
    }
  }

  function processPolygon(polygon: number[][][]) {
    for (const ring of polygon) {
      processRing(ring);
    }
  }

  switch (geomType) {
    case 'Point':
      flatCoords.push((coordinates as number[])[0], (coordinates as number[])[1]);
      break;

    case 'MultiPoint':
    case 'LineString':
      for (const coord of coordinates as number[][]) {
        flatCoords.push(coord[0], coord[1]);
      }
      break;

    case 'MultiLineString':
      for (const line of coordinates as number[][][]) {
        ringStarts.push(flatCoords.length / 2);
        for (const coord of line) {
          flatCoords.push(coord[0], coord[1]);
        }
      }
      break;

    case 'Polygon':
      processPolygon(coordinates as number[][][]);
      break;

    case 'MultiPolygon':
      for (const polygon of coordinates as number[][][][]) {
        processPolygon(polygon);
      }
      break;
  }

  return {
    coords: new Float64Array(flatCoords),
    ringIndices: new Uint32Array(ringStarts),
  };
}

/**
 * Extract only commonly used properties to minimize transfer size
 * Includes all properties used in tile-texture-renderer.ts for styling
 */
function extractProperties(props: Record<string, unknown>): CompactFeature['props'] {
  const result: CompactFeature['props'] = {};

  // Properties used in rendering/filtering/styling
  if (props.subtype !== undefined) result.subtype = props.subtype as string;
  if (props.class !== undefined) result.class = props.class as string;
  if (props.surface !== undefined) result.surface = props.surface as string;
  if (props.road_flags !== undefined) result.road_flags = props.road_flags as string;
  if (props.level_rules !== undefined) result.level_rules = props.level_rules as string;
  if (props.level !== undefined) result.level = props.level as number;
  if (props._fromLowerZoom !== undefined) result._fromLowerZoom = props._fromLowerZoom as boolean;
  if (props._sourceZoom !== undefined) result._sourceZoom = props._sourceZoom as number;

  // Additional properties for styling (tile-texture-renderer.ts)
  if (props.type !== undefined) result.type = props.type as string;
  if (props.category !== undefined) result.category = props.category as string;
  if (props.depth !== undefined) result.depth = props.depth as number;
  if (props.road_class !== undefined) result.road_class = props.road_class as string;
  if (props.highway !== undefined) result.highway = props.highway as string;
  if (props.is_tunnel !== undefined) result.is_tunnel = props.is_tunnel as boolean;
  if (props.is_underground !== undefined) result.is_underground = props.is_underground as boolean;

  // Handle names object
  if (props.names && typeof props.names === 'object') {
    const names = props.names as Record<string, unknown>;
    if (names.primary) {
      result.names = { primary: names.primary as string };
    }
  }

  return result;
}

/**
 * Parse MVT data and return compact features
 */
function parseMVT(
  data: ArrayBuffer,
  tileX: number,
  tileY: number,
  zoom: number,
  layerName: string | null
): ParseMVTResult {
  const tile = new VectorTile(new Pbf(data));
  const features: CompactFeature[] = [];
  const layerCounts: Record<string, number> = {};

  const allLayerNames = Object.keys(tile.layers);
  const layerNames = layerName && tile.layers[layerName] ? [layerName] : allLayerNames;

  for (const name of layerNames) {
    const layer = tile.layers[name];
    if (!layer) continue;

    layerCounts[name] = layer.length;

    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      const geojson = feature.toGeoJSON(tileX, tileY, zoom);
      const geomType = geojson.geometry.type;

      // Flatten coordinates to typed arrays
      const { coords, ringIndices } = flattenCoordinates(
        geomType,
        geojson.geometry.coordinates
      );

      features.push({
        typeIndex: GEOM_TYPE_MAP[geomType] ?? -1,
        layer: name,
        coords,
        ringIndices,
        props: extractProperties(feature.properties as Record<string, unknown>),
      });
    }
  }

  return { features, layerCounts };
}

/**
 * Get transferable buffers from result
 */
function getTransferables(result: ParseMVTResult): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const feature of result.features) {
    if (feature.coords.buffer instanceof ArrayBuffer) {
      buffers.push(feature.coords.buffer);
    }
    if (feature.ringIndices.buffer instanceof ArrayBuffer) {
      buffers.push(feature.ringIndices.buffer);
    }
  }
  return buffers;
}

/**
 * Handle incoming messages from the main thread
 */
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    switch (request.type) {
      case 'CAPABILITY_CHECK': {
        const response: WorkerResponse = {
          type: 'CAPABILITY_CHECK_RESULT',
          id: request.id,
          supported: true,
        };
        self.postMessage(response);
        break;
      }

      case 'PARSE_MVT': {
        const { data, tileX, tileY, zoom, layerName } = request.payload;

        // Parse MVT
        const result = parseMVT(data, tileX, tileY, zoom, layerName);

        // Get transferable buffers for zero-copy transfer
        const transferables = getTransferables(result);

        const response: WorkerResponse = {
          type: 'PARSE_MVT_RESULT',
          id: request.id,
          result,
        };

        // Transfer ownership of buffers (zero-copy)
        self.postMessage(response, { transfer: transferables });
        break;
      }

      default: {
        const response: WorkerResponse = {
          type: 'ERROR',
          id: (request as { id?: string }).id || 'unknown',
          error: `MVT worker received unsupported request type: ${(request as { type?: string }).type}`,
        };
        self.postMessage(response);
      }
    }
  } catch (error) {
    const response: WorkerResponse = {
      type: 'ERROR',
      id: request.id,
      error: error instanceof Error ? error.message : 'Unknown error in MVT worker',
    };
    self.postMessage(response);
  }
};

// Signal that worker is ready
self.postMessage({ type: 'READY' });
