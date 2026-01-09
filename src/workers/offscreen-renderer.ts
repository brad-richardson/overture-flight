/**
 * Pure canvas rendering logic for tile textures
 * Works with both HTMLCanvasElement (main thread) and OffscreenCanvas (worker)
 */

import type { TileBounds, ParsedFeature } from './types.js';

/**
 * Road style configuration
 */
interface RoadStyle {
  color: number;
  width: number;
}

/**
 * Canvas type that works in both contexts
 */
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type AnyContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Colors for different feature types
 */
const COLORS: Record<string, number> = {
  // Water types - blue tones
  ocean: 0x1e5f8a,
  sea: 0x1e5f8a,
  lake: 0x2a7ab0,
  reservoir: 0x2a7ab0,
  pond: 0x3388bb,
  river: 0x2a7ab0,
  stream: 0x3388bb,
  canal: 0x2a7ab0,
  water: 0x1e5f8a,

  // Bathymetry
  bathymetry: 0x1e5f8a,

  // Land cover types
  forest: 0x1a4d2e,
  wood: 0x1e5530,
  grass: 0x5a8f4a,
  shrub: 0x3a7a38,
  crop: 0x8fa858,
  barren: 0xa08060,
  wetland: 0x3a6848,
  swamp: 0x3a6848,
  mangrove: 0x2a5040,
  moss: 0x6a8a50,
  snow: 0xe8f0f8,
  urban: 0x6a6a6a,

  // Additional land cover
  park: 0x4a8050,
  meadow: 0x5a8f4a,
  farmland: 0x8fa858,

  // Urban/developed (land_use)
  residential: 0x707070,
  commercial: 0x787878,
  industrial: 0x606060,

  // Default land - greenish-gray that blends with forest/grass areas
  land: 0x8fa880,
  default: 0x8fa880,
};

/**
 * Road styles
 */
const ROAD_STYLES: Record<string, RoadStyle> = {
  motorway: { color: 0xa8a090, width: 3.0 },
  trunk: { color: 0x9a9488, width: 2.5 },
  primary: { color: 0x8c8880, width: 2.0 },
  secondary: { color: 0x7e7a74, width: 1.5 },
  tertiary: { color: 0x706c68, width: 1.2 },
  residential: { color: 0x666666, width: 0.8 },
  unclassified: { color: 0x555555, width: 0.6 },
  service: { color: 0x444444, width: 0.4 },
  living_street: { color: 0x555555, width: 0.6 },
  pedestrian: { color: 0x888888, width: 0.5 },
  footway: { color: 0x777777, width: 0.3 },
  path: { color: 0x666666, width: 0.3 },
  cycleway: { color: 0x5a8a5a, width: 0.4 },
  rail: { color: 0x333333, width: 1.0 },
  subway: { color: 0x333333, width: 0.8 },
  tram: { color: 0x333333, width: 0.6 },
  default: { color: 0x555555, width: 0.5 },
};

/**
 * Bathymetry depth color stops
 */
const BATHYMETRY_COLORS = [
  { depth: 0, color: { r: 0x4a, g: 0xb0, b: 0xd0 } },
  { depth: 200, color: { r: 0x3a, g: 0x9a, b: 0xc0 } },
  { depth: 1000, color: { r: 0x2a, g: 0x80, b: 0xb0 } },
  { depth: 2000, color: { r: 0x1e, g: 0x5f, b: 0x8a } },
  { depth: 4000, color: { r: 0x15, g: 0x45, b: 0x70 } },
  { depth: 6000, color: { r: 0x0d, g: 0x30, b: 0x55 } },
  { depth: 10000, color: { r: 0x08, g: 0x20, b: 0x40 } },
];

/**
 * Linear water types to render as lines (not polygons)
 */
const LINEAR_WATER_TYPES = ['river', 'stream', 'canal', 'drain', 'ditch', 'waterway'];

/**
 * Ocean/sea subtypes that indicate coastal water
 */
const OCEAN_SUBTYPES = ['ocean', 'sea', 'bay', 'strait', 'gulf', 'sound', 'harbour', 'harbor'];

/**
 * Road priority for layering (lower = drawn first/underneath)
 */
const ROAD_PRIORITY: Record<string, number> = {
  service: 0,
  path: 1,
  footway: 2,
  cycleway: 3,
  pedestrian: 4,
  unclassified: 5,
  living_street: 6,
  residential: 7,
  tertiary: 8,
  secondary: 9,
  primary: 10,
  trunk: 11,
  motorway: 12,
};

/**
 * Convert hex color to CSS string
 */
function hexToCSS(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
}

/**
 * Get bathymetry color based on depth
 */
function getBathymetryColor(depth: number): number {
  const clampedDepth = Math.max(0, Math.min(depth, 10000));

  let lowerStop = BATHYMETRY_COLORS[0];
  let upperStop = BATHYMETRY_COLORS[BATHYMETRY_COLORS.length - 1];

  for (let i = 0; i < BATHYMETRY_COLORS.length - 1; i++) {
    if (clampedDepth >= BATHYMETRY_COLORS[i].depth && clampedDepth <= BATHYMETRY_COLORS[i + 1].depth) {
      lowerStop = BATHYMETRY_COLORS[i];
      upperStop = BATHYMETRY_COLORS[i + 1];
      break;
    }
  }

  const range = upperStop.depth - lowerStop.depth;
  const t = range > 0 ? (clampedDepth - lowerStop.depth) / range : 0;

  const r = Math.round(lowerStop.color.r + t * (upperStop.color.r - lowerStop.color.r));
  const g = Math.round(lowerStop.color.g + t * (upperStop.color.g - lowerStop.color.g));
  const b = Math.round(lowerStop.color.b + t * (upperStop.color.b - lowerStop.color.b));

  return (r << 16) | (g << 8) | b;
}

/**
 * Get color for a feature based on layer and properties
 */
function getColorForFeature(layer: string, properties: Record<string, unknown>): number {
  const subtype = (
    properties.subtype ||
    properties.class ||
    properties.type ||
    properties.category ||
    ''
  ) as string;
  const type = subtype.toLowerCase();

  if (layer === 'bathymetry') {
    const depth = typeof properties.depth === 'number' ? properties.depth : 0;
    return getBathymetryColor(depth);
  }

  if (layer === 'land_cover') {
    return COLORS[type] ?? COLORS.grass;
  }

  if (COLORS[type]) {
    return COLORS[type];
  }

  if (layer === 'water') {
    return COLORS.water;
  }

  if (layer === 'land') {
    return COLORS.land;
  }

  if (layer === 'land_use') {
    if (type.includes('forest') || type.includes('wood')) return COLORS.forest;
    if (type.includes('park') || type.includes('recreation')) return COLORS.park;
    if (type.includes('grass') || type.includes('green') || type.includes('meadow')) return COLORS.grass;
    if (type.includes('farm') || type.includes('orchard') || type.includes('vineyard')) return COLORS.crop;
    if (type.includes('water') || type.includes('basin')) return COLORS.water;
    if (type.includes('residential')) return COLORS.residential;
    if (type.includes('commercial') || type.includes('retail')) return COLORS.commercial;
    if (type.includes('industrial')) return COLORS.industrial;
    if (type.includes('cemetery') || type.includes('grave')) return COLORS.grass;
    return COLORS.land;
  }

  return COLORS.default;
}

/**
 * Get road style based on feature properties
 */
function getRoadStyle(properties: Record<string, unknown> | null): RoadStyle {
  if (!properties) return ROAD_STYLES.default;

  const roadClass = (properties.class || properties.road_class || properties.highway || '') as string;
  const type = roadClass.toLowerCase();

  return ROAD_STYLES[type] ?? ROAD_STYLES.default;
}

/**
 * Create coordinate transform function for tile bounds
 */
function createGeoToCanvas(bounds: TileBounds, size: number): (lng: number, lat: number) => { x: number; y: number } {
  const lngRange = bounds.east - bounds.west;
  const latRange = bounds.north - bounds.south;

  return (lng: number, lat: number) => ({
    x: ((lng - bounds.west) / lngRange) * size,
    y: ((bounds.north - lat) / latRange) * size,
  });
}

/**
 * Draw a single polygon with holes
 */
function drawSinglePolygon(
  ctx: AnyContext,
  coords: number[][][],
  geoToCanvas: (lng: number, lat: number) => { x: number; y: number }
): void {
  if (!coords || coords.length === 0) return;

  ctx.beginPath();

  // Outer ring
  const outer = coords[0];
  if (!outer || outer.length === 0) return;

  const start = geoToCanvas(outer[0][0], outer[0][1]);
  ctx.moveTo(start.x, start.y);

  for (let i = 1; i < outer.length; i++) {
    const pt = geoToCanvas(outer[i][0], outer[i][1]);
    ctx.lineTo(pt.x, pt.y);
  }
  ctx.closePath();

  // Holes (inner rings) - use evenodd fill rule
  for (let h = 1; h < coords.length; h++) {
    const hole = coords[h];
    if (!hole || hole.length === 0) continue;

    const holeStart = geoToCanvas(hole[0][0], hole[0][1]);
    ctx.moveTo(holeStart.x, holeStart.y);

    for (let i = 1; i < hole.length; i++) {
      const pt = geoToCanvas(hole[i][0], hole[i][1]);
      ctx.lineTo(pt.x, pt.y);
    }
    ctx.closePath();
  }
}

/**
 * Draw a polygon (with holes) on canvas
 */
function drawPolygon(
  ctx: AnyContext,
  coordinates: number[][][] | number[][][][],
  featureType: string,
  geoToCanvas: (lng: number, lat: number) => { x: number; y: number }
): void {
  if (featureType === 'Polygon') {
    drawSinglePolygon(ctx, coordinates as number[][][], geoToCanvas);
  } else if (featureType === 'MultiPolygon') {
    for (const polygon of coordinates as number[][][][]) {
      drawSinglePolygon(ctx, polygon, geoToCanvas);
    }
  }
}

/**
 * Draw a single line
 */
function drawSingleLine(
  ctx: AnyContext,
  coords: number[][],
  geoToCanvas: (lng: number, lat: number) => { x: number; y: number }
): void {
  if (!coords || coords.length < 2) return;

  ctx.beginPath();
  const start = geoToCanvas(coords[0][0], coords[0][1]);
  ctx.moveTo(start.x, start.y);

  for (let i = 1; i < coords.length; i++) {
    const pt = geoToCanvas(coords[i][0], coords[i][1]);
    ctx.lineTo(pt.x, pt.y);
  }

  ctx.stroke();
}

/**
 * Draw a line string on canvas
 */
function drawLineString(
  ctx: AnyContext,
  coordinates: number[][] | number[][][],
  featureType: string,
  geoToCanvas: (lng: number, lat: number) => { x: number; y: number }
): void {
  if (featureType === 'LineString') {
    drawSingleLine(ctx, coordinates as number[][], geoToCanvas);
  } else if (featureType === 'MultiLineString') {
    for (const line of coordinates as number[][][]) {
      drawSingleLine(ctx, line, geoToCanvas);
    }
  }
}

/**
 * Render all features for a tile to a canvas
 * Works with both HTMLCanvasElement and OffscreenCanvas
 */
export function renderTileTextureToCanvas(
  canvas: AnyCanvas,
  baseFeatures: ParsedFeature[],
  transportFeatures: ParsedFeature[],
  bounds: TileBounds
): void {
  const size = canvas.width;
  const ctx = canvas.getContext('2d') as AnyContext;
  if (!ctx) return;

  // Enable antialiasing
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const geoToCanvas = createGeoToCanvas(bounds, size);

  // Calculate meters per pixel for road width scaling
  const tileSizeMeters = (bounds.east - bounds.west) * 111320 * Math.cos(((bounds.north + bounds.south) / 2) * Math.PI / 180);
  const metersPerPixel = tileSizeMeters / size;

  // Separate features by layer first to determine base color
  const landFeatures: ParsedFeature[] = [];
  const landUseFeatures: ParsedFeature[] = [];
  const landCoverFeatures: ParsedFeature[] = [];
  const waterLineFeatures: ParsedFeature[] = [];
  const waterBodyFeatures: ParsedFeature[] = [];
  const oceanFeatures: ParsedFeature[] = [];

  for (const feature of baseFeatures) {
    const layer = feature.layer;
    const subtype = ((feature.properties.subtype || feature.properties.class || '') as string).toLowerCase();

    if (layer === 'land') {
      if (feature.type === 'Polygon' || feature.type === 'MultiPolygon') {
        landFeatures.push(feature);
      }
    } else if (layer === 'land_use') {
      landUseFeatures.push(feature);
    } else if (layer === 'land_cover') {
      landCoverFeatures.push(feature);
    } else if (layer === 'water') {
      if (feature.type === 'LineString' || feature.type === 'MultiLineString') {
        if (LINEAR_WATER_TYPES.includes(subtype)) {
          waterLineFeatures.push(feature);
        }
      } else if (feature.type === 'Polygon' || feature.type === 'MultiPolygon') {
        const isFromLowerZoom = feature.properties._fromLowerZoom === true;
        if (OCEAN_SUBTYPES.includes(subtype) || isFromLowerZoom) {
          oceanFeatures.push(feature);
        } else {
          waterBodyFeatures.push(feature);
        }
      }
    }
  }

  // Detect if this is an open ocean tile
  const isOpenOceanTile = oceanFeatures.length > 0 && landFeatures.length < 10;

  // === Layer 0: Base fill ===
  if (isOpenOceanTile) {
    ctx.fillStyle = hexToCSS(COLORS.water);
    ctx.fillRect(0, 0, size, size);
  } else {
    ctx.fillStyle = hexToCSS(COLORS.land);
    ctx.fillRect(0, 0, size, size);
  }

  // === Layer 1: Land polygons (for open ocean tiles) ===
  if (isOpenOceanTile && landFeatures.length > 0) {
    ctx.save();
    ctx.fillStyle = hexToCSS(COLORS.land);
    for (const feature of landFeatures) {
      drawPolygon(ctx, feature.coordinates as number[][][] | number[][][][], feature.type, geoToCanvas);
      ctx.fill('evenodd');
    }
    ctx.restore();
  }

  // === Layer 2: Land use ===
  ctx.save();
  for (const feature of landUseFeatures) {
    if (feature.type !== 'Polygon' && feature.type !== 'MultiPolygon') continue;

    const color = getColorForFeature('land_use', feature.properties);
    ctx.fillStyle = hexToCSS(color);
    drawPolygon(ctx, feature.coordinates as number[][][] | number[][][][], feature.type, geoToCanvas);
    ctx.fill('evenodd');
  }
  ctx.restore();

  // === Layer 3: Land cover ===
  ctx.save();
  for (const feature of landCoverFeatures) {
    if (feature.type !== 'Polygon' && feature.type !== 'MultiPolygon') continue;

    const color = getColorForFeature('land_cover', feature.properties);
    ctx.fillStyle = hexToCSS(color);
    drawPolygon(ctx, feature.coordinates as number[][][] | number[][][][], feature.type, geoToCanvas);
    ctx.fill('evenodd');
  }
  ctx.restore();

  // === Layer 4: Water lines (rivers/streams) ===
  // Render with wider strokes since river polygons often don't exist at lower zoom levels
  ctx.save();
  ctx.strokeStyle = hexToCSS(COLORS.river);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const feature of waterLineFeatures) {
    // Use subtype to determine line width: rivers are wider than streams
    const subtype = ((feature.properties.subtype || feature.properties.class || '') as string).toLowerCase();
    let widthMeters = 8; // Default river width
    if (subtype === 'stream' || subtype === 'drain' || subtype === 'ditch') {
      widthMeters = 3;
    } else if (subtype === 'canal') {
      widthMeters = 12;
    } else if (subtype === 'river') {
      widthMeters = 20; // Major rivers
    }
    ctx.lineWidth = Math.max(2, widthMeters / metersPerPixel);
    drawLineString(ctx, feature.coordinates as number[][] | number[][][], feature.type, geoToCanvas);
  }
  ctx.restore();

  // === Layer 5: Water bodies (ocean + inland) ===
  ctx.save();
  for (const feature of oceanFeatures) {
    ctx.fillStyle = hexToCSS(COLORS.water);
    drawPolygon(ctx, feature.coordinates as number[][][] | number[][][][], feature.type, geoToCanvas);
    ctx.fill('evenodd');
  }
  for (const feature of waterBodyFeatures) {
    const color = getColorForFeature('water', feature.properties);
    ctx.fillStyle = hexToCSS(color);
    drawPolygon(ctx, feature.coordinates as number[][][] | number[][][][], feature.type, geoToCanvas);
    ctx.fill('evenodd');
  }
  ctx.restore();

  // === Layer 6: Roads ===
  const roadFeatures = transportFeatures
    .filter(f => {
      if (f.layer === 'connector') return false;
      if (f.layer !== 'segment') return false;
      if (f.type !== 'LineString' && f.type !== 'MultiLineString') return false;
      if (f.properties?.subtype !== 'road') return false;

      const props = f.properties as Record<string, unknown>;

      // Check road_flags for is_tunnel
      if (typeof props.road_flags === 'string') {
        try {
          const flags = JSON.parse(props.road_flags) as Array<{ values?: string[] }>;
          const hasTunnel = flags.some(flag => flag.values?.includes('is_tunnel'));
          if (hasTunnel) return false;
        } catch {
          // Ignore parse errors
        }
      }

      // Check level_rules for negative levels
      if (typeof props.level_rules === 'string') {
        try {
          const rules = JSON.parse(props.level_rules) as Array<{ value?: number }>;
          const hasNegativeLevel = rules.length > 0 && rules.every(rule =>
            typeof rule.value === 'number' && rule.value < 0
          );
          if (hasNegativeLevel) return false;
        } catch {
          // Ignore parse errors
        }
      }

      if (props.is_tunnel === true || props.is_underground === true) return false;
      if (typeof props.level === 'number' && props.level < 0) return false;

      return true;
    })
    .sort((a, b) => {
      const classA = ((a.properties?.class || 'default') as string).toLowerCase();
      const classB = ((b.properties?.class || 'default') as string).toLowerCase();
      return (ROAD_PRIORITY[classA] ?? 5) - (ROAD_PRIORITY[classB] ?? 5);
    });

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const feature of roadFeatures) {
    const style = getRoadStyle(feature.properties);
    const widthPixels = Math.max(1, (style.width * 5) / metersPerPixel);

    ctx.strokeStyle = hexToCSS(style.color);
    ctx.lineWidth = widthPixels;
    drawLineString(ctx, feature.coordinates as number[][] | number[][][], feature.type, geoToCanvas);
  }
  ctx.restore();
}

/**
 * Render simplified features for a low-detail distant tile
 * Works with both HTMLCanvasElement and OffscreenCanvas
 */
export function renderLowDetailTextureToCanvas(
  canvas: AnyCanvas,
  baseFeatures: ParsedFeature[],
  bounds: TileBounds
): void {
  const size = canvas.width;
  const ctx = canvas.getContext('2d') as AnyContext;
  if (!ctx) return;

  // Enable antialiasing
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const geoToCanvas = createGeoToCanvas(bounds, size);

  // Separate features by layer
  const landFeatures: ParsedFeature[] = [];
  const landCoverFeatures: ParsedFeature[] = [];
  const waterBodyFeatures: ParsedFeature[] = [];
  const oceanFeatures: ParsedFeature[] = [];

  for (const feature of baseFeatures) {
    const layer = feature.layer;
    const subtype = ((feature.properties.subtype || feature.properties.class || '') as string).toLowerCase();

    if (layer === 'land') {
      if (feature.type === 'Polygon' || feature.type === 'MultiPolygon') {
        landFeatures.push(feature);
      }
    } else if (layer === 'land_cover') {
      landCoverFeatures.push(feature);
    } else if (layer === 'water') {
      if (feature.type === 'Polygon' || feature.type === 'MultiPolygon') {
        const isFromLowerZoom = feature.properties._fromLowerZoom === true;
        if (OCEAN_SUBTYPES.includes(subtype) || isFromLowerZoom) {
          oceanFeatures.push(feature);
        } else {
          waterBodyFeatures.push(feature);
        }
      }
    }
  }

  // Detect if this is an open ocean tile
  const isOpenOceanTile = oceanFeatures.length > 0 && landFeatures.length < 10;

  // === Layer 0: Base fill ===
  if (isOpenOceanTile) {
    ctx.fillStyle = hexToCSS(COLORS.water);
    ctx.fillRect(0, 0, size, size);
  } else {
    ctx.fillStyle = hexToCSS(COLORS.land);
    ctx.fillRect(0, 0, size, size);
  }

  // === Layer 1: Land polygons (for open ocean tiles) ===
  if (isOpenOceanTile && landFeatures.length > 0) {
    ctx.save();
    ctx.fillStyle = hexToCSS(COLORS.land);
    for (const feature of landFeatures) {
      drawPolygon(ctx, feature.coordinates as number[][][] | number[][][][], feature.type, geoToCanvas);
      ctx.fill('evenodd');
    }
    ctx.restore();
  }

  // === Layer 2: Land cover ===
  ctx.save();
  for (const feature of landCoverFeatures) {
    if (feature.type !== 'Polygon' && feature.type !== 'MultiPolygon') continue;

    const color = getColorForFeature('land_cover', feature.properties);
    ctx.fillStyle = hexToCSS(color);
    drawPolygon(ctx, feature.coordinates as number[][][] | number[][][][], feature.type, geoToCanvas);
    ctx.fill('evenodd');
  }
  ctx.restore();

  // === Layer 3: Water bodies ===
  ctx.save();
  for (const feature of oceanFeatures) {
    ctx.fillStyle = hexToCSS(COLORS.water);
    drawPolygon(ctx, feature.coordinates as number[][][] | number[][][][], feature.type, geoToCanvas);
    ctx.fill('evenodd');
  }
  for (const feature of waterBodyFeatures) {
    const color = getColorForFeature('water', feature.properties);
    ctx.fillStyle = hexToCSS(color);
    drawPolygon(ctx, feature.coordinates as number[][][] | number[][][][], feature.type, geoToCanvas);
    ctx.fill('evenodd');
  }
  ctx.restore();
}
