/**
 * Runtime Overture PMTiles source discovery.
 *
 * Overture only retains a limited window of published tile releases, so a
 * release URL baked into the application eventually expires. Resolve the
 * current stable release once during each application startup instead.
 */

export interface OvertureSources {
  /** Resolved official release, or null when only overrides/placeholders are available. */
  release: string | null;
  buildings: string;
  base: string;
  transportation: string;
  divisions: string;
}

const STAC_CATALOG_URL = 'https://stac.overturemaps.org/catalog.json';
const PMTILES_ROOT = 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles';
const CACHED_RELEASE_KEY = 'overture-flight:last-stable-release';
const STAC_REQUEST_TIMEOUT_MS = 5000;
const UNAVAILABLE_SOURCE_PREFIX = 'data:application/vnd.pmtiles;base64,#overture-unavailable-';
const RELEASE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/;

const overrides = {
  buildings: import.meta.env.VITE_PMTILES_URL?.trim(),
  base: import.meta.env.VITE_BASE_PMTILES_URL?.trim(),
  transportation: import.meta.env.VITE_TRANSPORTATION_PMTILES_URL?.trim(),
  divisions: import.meta.env.VITE_DIVISIONS_PMTILES_URL?.trim(),
};

let sources: Readonly<OvertureSources> | null = null;
let initialization: Promise<Readonly<OvertureSources>> | null = null;

function isRelease(value: unknown): value is string {
  return typeof value === 'string' && RELEASE_PATTERN.test(value);
}

function readCachedRelease(): string | null {
  try {
    const release = localStorage.getItem(CACHED_RELEASE_KEY);
    return isRelease(release) ? release : null;
  } catch {
    // Storage can be unavailable in privacy modes. A cache miss is harmless.
    return null;
  }
}

function cacheRelease(release: string): void {
  try {
    localStorage.setItem(CACHED_RELEASE_KEY, release);
  } catch {
    // Source discovery must not fail just because local storage is unavailable.
  }
}

async function fetchLatestRelease(): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STAC_REQUEST_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(STAC_CATALOG_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Overture STAC catalog timed out after ${STAC_REQUEST_TIMEOUT_MS}ms`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`Overture STAC catalog returned HTTP ${response.status}`);
  }

  const catalog: unknown = await response.json();
  const latest = typeof catalog === 'object' && catalog !== null && 'latest' in catalog
    ? (catalog as { latest?: unknown }).latest
    : undefined;

  if (!isRelease(latest)) {
    throw new Error('Overture STAC catalog did not contain a valid latest release');
  }

  return latest;
}

function officialThemeUrl(release: string, theme: string): string {
  return `${PMTILES_ROOT}/${release}/${theme}.pmtiles`;
}

/**
 * Produce a deterministic URL that PMTiles rejects locally and immediately.
 * This keeps unrelated application systems and configured themes running when
 * release discovery is unavailable, without baking another expiring release.
 */
function unavailableThemeUrl(theme: string): string {
  return `${UNAVAILABLE_SOURCE_PREFIX}${theme}`;
}

export function isUnavailableOvertureSource(url: string): boolean {
  return url.startsWith(UNAVAILABLE_SOURCE_PREFIX);
}

/**
 * Resolve all Overture sources before any tile subsystem starts.
 *
 * The STAC catalog is attempted on every page startup. A previously discovered
 * release is only used as a network-failure fallback; it is never maintained in
 * source code. Per-theme environment overrides still take precedence.
 */
export function initializeOvertureSources(): Promise<Readonly<OvertureSources>> {
  if (initialization) return initialization;

  const attempt = (async () => {
    const hasAllOverrides = Object.values(overrides).every(Boolean);
    if (hasAllOverrides) {
      console.info('[Overture] Using configured PMTiles sources');
      sources = Object.freeze({
        release: null,
        buildings: overrides.buildings!,
        base: overrides.base!,
        transportation: overrides.transportation!,
        divisions: overrides.divisions!,
      });
      return sources;
    }

    let release: string | null = null;

    try {
      release = await fetchLatestRelease();
      cacheRelease(release);
      console.info(`[Overture] Using latest stable release ${release}`);
    } catch (error) {
      const cachedRelease = readCachedRelease();
      if (cachedRelease) {
        release = cachedRelease;
        console.warn(
          `[Overture] Latest release lookup failed; using cached release ${release}`,
          error
        );
      } else {
        console.warn(
          '[Overture] Latest release lookup failed and no cached release is available; ' +
          'unconfigured Overture themes will be unavailable for this session',
          error
        );
      }
    }

    sources = Object.freeze({
      release,
      buildings: overrides.buildings || (release
        ? officialThemeUrl(release, 'buildings')
        : unavailableThemeUrl('buildings')),
      base: overrides.base || (release
        ? officialThemeUrl(release, 'base')
        : unavailableThemeUrl('base')),
      transportation: overrides.transportation || (release
        ? officialThemeUrl(release, 'transportation')
        : unavailableThemeUrl('transportation')),
      divisions: overrides.divisions || (release
        ? officialThemeUrl(release, 'divisions')
        : unavailableThemeUrl('divisions')),
    });

    return sources;
  })();

  // Do not permanently poison the singleton if an unexpected programming or
  // platform error escapes the deliberately non-fatal discovery path.
  initialization = attempt.catch((error) => {
    initialization = null;
    throw error;
  });

  return initialization;
}

/**
 * Get resolved sources after application bootstrap.
 */
export function getOvertureSources(): Readonly<OvertureSources> {
  if (!sources) {
    throw new Error('Overture sources were used before initializeOvertureSources() completed');
  }

  return sources;
}
