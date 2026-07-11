const GEOCODER_BASE_URL = 'https://geocoder.bradr.dev';
const GEOCODER_TIMEOUT_MS = 30_000;

export interface GeocoderSearchResult {
  lat: number;
  lon: number;
}

export interface GeocoderSearchOptions {
  limit?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class GeocoderTimeoutError extends Error {
  constructor(timeoutMs: number, options?: ErrorOptions) {
    super(`Geocoding request timed out after ${timeoutMs}ms`, options);
    this.name = 'GeocoderTimeoutError';
  }
}

export class GeocoderNetworkError extends Error {
  constructor(options?: ErrorOptions) {
    super('Geocoding request failed due to a network error', options);
    this.name = 'GeocoderNetworkError';
  }
}

export class GeocoderHttpError extends Error {
  constructor(readonly status: number, readonly statusText: string) {
    super(`Geocoding request failed: ${status} ${statusText}`.trim());
    this.name = 'GeocoderHttpError';
  }
}

export class GeocoderResponseError extends Error {
  constructor(options?: ErrorOptions) {
    super('Geocoding service returned invalid JSON', options);
    this.name = 'GeocoderResponseError';
  }
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSearchResults(payload: unknown): GeocoderSearchResult[] {
  const items = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === 'object' && 'results' in payload
      ? (payload as { results?: unknown }).results
      : [];
  if (!Array.isArray(items)) return [];

  const results: GeocoderSearchResult[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const lat = toFiniteNumber(record.lat);
    const lon = toFiniteNumber(record.lon);
    if (
      lat !== null && lat >= -90 && lat <= 90
      && lon !== null && lon >= -180 && lon <= 180
    ) {
      results.push({ lat, lon });
    }
  }
  return results;
}

/** Search the production Overture geocoder's Nominatim-compatible endpoint. */
export async function searchGeocoder(
  query: string,
  options: GeocoderSearchOptions = {}
): Promise<GeocoderSearchResult[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? GEOCODER_TIMEOUT_MS;
  const limit = Math.min(Math.max(1, options.limit || 10), 40);
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: String(limit),
  });
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new GeocoderTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  const request = async (): Promise<GeocoderSearchResult[]> => {
    let response: Response;
    try {
      response = await fetchImpl(`${GEOCODER_BASE_URL}/search?${params}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GeocoderTimeoutError(timeoutMs, { cause: error });
      }
      throw new GeocoderNetworkError({ cause: error });
    }

    if (!response.ok) {
      throw new GeocoderHttpError(response.status, response.statusText);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GeocoderTimeoutError(timeoutMs, { cause: error });
      }
      throw new GeocoderResponseError({ cause: error });
    }
    return parseSearchResults(payload);
  };

  try {
    return await Promise.race([request(), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
