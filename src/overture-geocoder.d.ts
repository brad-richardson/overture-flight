declare module 'overture-geocoder' {
  export interface GeocoderResult {
    gers_id: string;
    display_name: string;
    lat: number;
    lon: number;
    boundingbox: [number, number, number, number];
    importance: number;
    type?: string;
    address?: AddressDetails;
  }

  export interface AddressDetails {
    house_number?: string;
    road?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
    country_code?: string;
  }

  export interface SearchOptions {
    limit?: number;
    countrycodes?: string;
    viewbox?: [number, number, number, number];
    bounded?: boolean;
    addressdetails?: boolean;
    format?: "json" | "jsonv2" | "geojson";
  }

  export interface OvertureGeocoderConfig {
    baseUrl?: string;
    timeout?: number;
    retries?: number;
    retryDelay?: number;
    headers?: Record<string, string>;
  }

  export class OvertureGeocoder {
    constructor(config?: OvertureGeocoderConfig);
    search(query: string, options?: SearchOptions): Promise<GeocoderResult[]>;
    lookup(gersIds: string | string[]): Promise<GeocoderResult[]>;
    getGeometry(gersId: string): Promise<unknown>;
    close(): Promise<void>;
  }

  export function geocode(query: string, options?: SearchOptions): Promise<GeocoderResult[]>;
  export function lookup(gersIds: string | string[]): Promise<GeocoderResult[]>;

  export default OvertureGeocoder;
}
