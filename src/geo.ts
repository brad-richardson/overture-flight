/** Maximum latitude representable by the Web Mercator projection. */
export const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;

const METERS_PER_DEGREE = 111_320;

/** Wrap a longitude to the canonical [-180, 180) interval. */
export function normalizeLongitude(longitude: number): number {
  if (!Number.isFinite(longitude)) return 0;
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

/** Clamp a latitude to the finite Web Mercator domain. */
export function clampMercatorLatitude(latitude: number): number {
  if (!Number.isFinite(latitude)) return 0;
  return Math.max(
    -WEB_MERCATOR_MAX_LATITUDE,
    Math.min(WEB_MERCATOR_MAX_LATITUDE, latitude)
  );
}

export function normalizeGeoCoordinates(
  longitude: number,
  latitude: number
): { lng: number; lat: number } {
  return {
    lng: normalizeLongitude(longitude),
    lat: clampMercatorLatitude(latitude),
  };
}

/** Strictly parse URL/input fields before normalizing their geographic range. */
export function parseGeoCoordinateFields(
  latitudeField: string,
  longitudeField: string
): { lng: number; lat: number } | null {
  if (latitudeField.trim() === '' || longitudeField.trim() === '') return null;
  const lat = Number(latitudeField);
  const lng = Number(longitudeField);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return normalizeGeoCoordinates(lng, lat);
}

/** Normalize only geographic fields while preserving the rest of a state object. */
export function normalizeGeoState<T extends { lng: number; lat: number }>(state: T): T {
  return {
    ...state,
    ...normalizeGeoCoordinates(state.lng, state.lat),
  };
}

/** Signed shortest longitude delta from `from` to `to`, in degrees. */
export function shortestLongitudeDelta(from: number, to: number): number {
  return normalizeLongitude(to - from);
}

/**
 * Local equirectangular distance, suitable for origin-rebase decisions and
 * cache eviction. Longitude follows the short path across the antimeridian.
 */
export function horizontalGeoDistanceMeters(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number }
): number {
  if (![from.lng, from.lat, to.lng, to.lat].every(Number.isFinite)) {
    return Number.POSITIVE_INFINITY;
  }

  const fromLat = clampMercatorLatitude(from.lat);
  const toLat = clampMercatorLatitude(to.lat);
  const meanLatitudeRadians = ((fromLat + toLat) / 2) * Math.PI / 180;
  const dx = shortestLongitudeDelta(from.lng, to.lng)
    * METERS_PER_DEGREE
    * Math.cos(meanLatitudeRadians);
  const dz = (toLat - fromLat) * METERS_PER_DEGREE;
  return Math.hypot(dx, dz);
}

export function shouldRebaseLocalOrigin(
  origin: { lng: number; lat: number },
  position: { lng: number; lat: number },
  thresholdMeters: number
): boolean {
  if (!Number.isFinite(thresholdMeters) || thresholdMeters <= 0) return false;
  const distanceMeters = horizontalGeoDistanceMeters(origin, position);
  return Number.isFinite(distanceMeters) && distanceMeters >= thresholdMeters;
}
