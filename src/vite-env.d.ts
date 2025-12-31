/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PMTILES_URL?: string;
  readonly VITE_BASE_PMTILES_URL?: string;
  readonly VITE_TRANSPORTATION_PMTILES_URL?: string;
  readonly VITE_PARTYKIT_HOST?: string;
  readonly VITE_BASE_PATH?: string;
  readonly BASE_URL: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Mapbox vector-tile types
declare module '@mapbox/vector-tile' {
  import Pbf from 'pbf';

  export interface VectorTileFeature {
    extent: number;
    type: number;
    id: number;
    properties: Record<string, unknown>;
    toGeoJSON(x: number, y: number, z: number): {
      type: string;
      geometry: {
        type: string;
        coordinates: number[] | number[][] | number[][][] | number[][][][];
      };
      properties: Record<string, unknown>;
    };
  }

  export interface VectorTileLayer {
    version: number;
    name: string;
    extent: number;
    length: number;
    feature(i: number): VectorTileFeature;
  }

  export class VectorTile {
    layers: Record<string, VectorTileLayer>;
    constructor(pbf: Pbf);
  }
}
