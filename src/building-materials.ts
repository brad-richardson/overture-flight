import * as THREE from 'three';

/**
 * Building Materials System
 *
 * Predicts appropriate building textures/colors based on Overture Maps data.
 * Inspired by the arnis project's approach to realistic building generation.
 *
 * Since Overture doesn't provide facade_color or facade_material, we infer
 * appropriate materials based on building class, subtype, height, and location.
 */

// Types
export interface BuildingFeature {
  type: string;
  coordinates: number[][][] | number[][][][];
  properties?: Record<string, unknown>;
  layer?: string;
}

interface ColorPalette {
  walls: number[];
  accents: number[];
  roofs: number[];
}

// ============================================================================
// Color Palettes by Building Type
// ============================================================================

// Predefined color palettes for different building categories
const BUILDING_PALETTES: Record<string, ColorPalette> = {
  // Residential colors - warmer, more varied
  residential: {
    walls: [
      0xE8DCC8, // cream/beige
      0xD4C4A8, // tan
      0xB8A082, // brownish beige
      0xC9B896, // warm gray-beige
      0xE5D5C0, // off-white
      0xA89070, // brown
      0x8B7355, // dark tan
      0xCD853F, // peru/terracotta
      0xBC8F8F, // rosy brown
      0xF5DEB3, // wheat
    ],
    accents: [0x8B4513, 0x654321, 0x5C4033, 0x3C2415], // browns
    roofs: [0x4A4A4A, 0x696969, 0x8B4513, 0xA0522D, 0x2F4F4F], // grays, browns
  },

  // Commercial/office - modern, glass-heavy
  commercial: {
    walls: [
      0x708090, // slate gray
      0x778899, // light slate gray
      0xA9A9A9, // dark gray
      0xC0C0C0, // silver
      0xD3D3D3, // light gray
      0x4682B4, // steel blue
      0x5F9EA0, // cadet blue
      0x87CEEB, // light blue (glass effect)
      0xB0C4DE, // light steel blue
      0xE0FFFF, // light cyan
    ],
    accents: [0x2F4F4F, 0x191970, 0x000080], // dark blues
    roofs: [0x2F2F2F, 0x3C3C3C, 0x4A4A4A], // dark grays (flat roof)
  },

  // Industrial - utilitarian colors
  industrial: {
    walls: [
      0x696969, // dim gray
      0x808080, // gray
      0xA9A9A9, // dark gray
      0x708090, // slate gray
      0x4A5568, // cool gray
      0x5C5C5C, // charcoal
      0x6B7280, // gray 500
      0x9CA3AF, // gray 400
      0xC4B998, // tan industrial
      0xD4C4A8, // beige industrial
    ],
    accents: [0xB22222, 0xCD5C5C, 0x8B0000], // reds for doors/accents
    roofs: [0x3C3C3C, 0x4A4A4A, 0x5C5C5C, 0x708090], // corrugated metal look
  },

  // Civic/government - dignified, classic
  civic: {
    walls: [
      0xD3D3D3, // light gray
      0xC0C0C0, // silver
      0xF5F5DC, // beige
      0xFAF0E6, // linen
      0xFFFAF0, // floral white
      0xE6E6FA, // lavender
      0xE0E0E0, // light gray
      0xBDB76B, // dark khaki
      0xD2B48C, // tan
      0xBC8F8F, // rosy brown
    ],
    accents: [0x2F4F4F, 0x191970, 0x8B4513], // classic accents
    roofs: [0x2F4F4F, 0x556B2F, 0x8B4513], // dark greens, browns
  },

  // Religious - varied based on tradition
  religious: {
    walls: [
      0xFFFAF0, // off-white
      0xFAF0E6, // linen
      0xD2B48C, // tan
      0xDEB887, // burlywood
      0xBC8F8F, // rosy brown
      0xF5F5DC, // beige
      0xE6E6FA, // lavender
      0xD4C4A8, // warm beige
      0x8B4513, // saddle brown
      0xCD853F, // peru
    ],
    accents: [0x8B4513, 0x654321, 0xB22222, 0x800020], // browns, burgundy
    roofs: [0x2F4F4F, 0x556B2F, 0x8B4513, 0x800000], // dark colors
  },

  // Educational - institutional
  educational: {
    walls: [
      0xCD853F, // peru (brick-like)
      0xA0522D, // sienna
      0xD2691E, // chocolate
      0x8B4513, // saddle brown
      0xD2B48C, // tan
      0xDEB887, // burlywood
      0xC0C0C0, // silver
      0xA9A9A9, // dark gray
      0xBC8F8F, // rosy brown
      0xF4A460, // sandy brown
    ],
    accents: [0xFFFFFF, 0xD3D3D3], // white trim
    roofs: [0x2F2F2F, 0x4A4A4A, 0x696969], // grays
  },

  // Healthcare - clean, clinical
  healthcare: {
    walls: [
      0xFFFFFF, // white
      0xF5F5F5, // white smoke
      0xF0F0F0, // near white
      0xE8E8E8, // light gray
      0xFAFAFA, // snow
      0xFFFAFA, // snow white
      0xE0FFFF, // light cyan
      0xB0E0E6, // powder blue
      0xADD8E6, // light blue
      0x87CEEB, // sky blue
    ],
    accents: [0x4169E1, 0x1E90FF, 0x00BFFF], // blues
    roofs: [0xE0E0E0, 0xD0D0D0, 0xC0C0C0], // light grays
  },

  // Agricultural - rustic
  agricultural: {
    walls: [
      0x8B4513, // saddle brown
      0xA0522D, // sienna
      0xCD853F, // peru
      0xD2691E, // chocolate
      0x8B0000, // dark red (barn)
      0xB22222, // firebrick (barn)
      0xDEB887, // burlywood
      0xD2B48C, // tan
      0x6B8E23, // olive drab
      0x808000, // olive
    ],
    accents: [0xFFFFFF, 0xF5F5DC], // white trim
    roofs: [0x8B4513, 0x654321, 0x2F2F2F, 0x4A4A4A], // browns, grays
  },

  // Default/unknown - neutral
  default: {
    walls: [
      0x808080, // gray
      0x909090, // light gray
      0xA0A0A0, // lighter gray
      0xB0B0B0, // even lighter
      0x888899, // blue-gray
      0x989898, // neutral gray
      0xA8A8A8, // medium gray
      0xC0C0C0, // silver
      0x778899, // light slate gray
      0x708090, // slate gray
    ],
    accents: [0x505050, 0x606060],
    roofs: [0x404040, 0x505050, 0x606060],
  }
};

// ============================================================================
// Building Class to Category Mapping
// ============================================================================

// Map Overture building classes to our palette categories
const CLASS_TO_CATEGORY: Record<string, string> = {
  // Residential
  house: 'residential',
  residential: 'residential',
  detached: 'residential',
  semidetached_house: 'residential',
  terrace: 'residential',
  apartments: 'residential',
  apartment: 'residential',
  bungalow: 'residential',
  cabin: 'residential',
  dormitory: 'residential',
  houseboat: 'residential',
  static_caravan: 'residential',
  ger: 'residential',
  hut: 'residential',

  // Commercial/Office
  commercial: 'commercial',
  office: 'commercial',
  retail: 'commercial',
  supermarket: 'commercial',
  shop: 'commercial',
  hotel: 'commercial',
  motel: 'commercial',
  kiosk: 'commercial',
  bank: 'commercial',

  // Industrial
  industrial: 'industrial',
  warehouse: 'industrial',
  factory: 'industrial',
  manufacture: 'industrial',
  hangar: 'industrial',
  storage_tank: 'industrial',
  silo: 'industrial',

  // Civic/Government
  civic: 'civic',
  public: 'civic',
  government: 'civic',
  courthouse: 'civic',
  fire_station: 'civic',
  police: 'civic',
  post_office: 'civic',
  library: 'civic',
  townhall: 'civic',

  // Religious
  church: 'religious',
  chapel: 'religious',
  cathedral: 'religious',
  mosque: 'religious',
  temple: 'religious',
  synagogue: 'religious',
  shrine: 'religious',
  religious: 'religious',

  // Educational
  school: 'educational',
  university: 'educational',
  college: 'educational',
  kindergarten: 'educational',

  // Healthcare
  hospital: 'healthcare',
  clinic: 'healthcare',

  // Agricultural
  farm: 'agricultural',
  barn: 'agricultural',
  farm_auxiliary: 'agricultural',
  cowshed: 'agricultural',
  stable: 'agricultural',
  sty: 'agricultural',
  greenhouse: 'agricultural',

  // Special
  garage: 'residential',
  garages: 'residential',
  carport: 'residential',
  shed: 'residential',
  roof: 'industrial',
  parking: 'commercial',
  stadium: 'civic',
  sports_centre: 'civic',
  train_station: 'civic',
  transportation: 'civic',
  service: 'industrial',
  construction: 'industrial',
  ruins: 'default',
};

// ============================================================================
// Seeded Random Number Generator
// ============================================================================

/**
 * Simple seeded random number generator for deterministic results
 * Uses mulberry32 algorithm
 */
function seededRandom(seed: number): () => number {
  return function(): number {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Generate a deterministic seed from feature properties
 * Uses coordinates as fallback to ensure consistent results
 */
function generateSeed(feature: BuildingFeature): number {
  // Use feature ID if available, otherwise hash coordinates
  if (feature.properties?.id) {
    let hash = 0;
    const str = String(feature.properties.id);
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  // Fallback: use first coordinate as seed (deterministic)
  if (feature.coordinates) {
    const coords = feature.type === 'MultiPolygon'
      ? (feature.coordinates as number[][][][])[0][0][0]
      : (feature.coordinates as number[][][])[0][0];
    if (coords && coords.length >= 2) {
      return Math.abs(Math.floor((coords[0] * 1000000) + (coords[1] * 1000)));
    }
  }

  // Final fallback: use a fixed seed for consistency
  return 42;
}

// ============================================================================
// Material Generation
// ============================================================================

/**
 * Get the building category based on class and subtype
 */
function getBuildingCategory(feature: BuildingFeature): string {
  const props = feature.properties || {};

  // Try class first
  const buildingClass = props.class as string | undefined;
  if (buildingClass && CLASS_TO_CATEGORY[buildingClass.toLowerCase()]) {
    return CLASS_TO_CATEGORY[buildingClass.toLowerCase()];
  }

  // Then try subtype
  const subtype = props.subtype as string | undefined;
  if (subtype) {
    const subtypeLower = subtype.toLowerCase();
    if (BUILDING_PALETTES[subtypeLower]) {
      return subtypeLower;
    }
  }

  return 'default';
}

/**
 * Create a shared material for a batch of buildings in the same category
 * (For performance when merging geometries)
 */
export function createCategoryMaterial(category: string): THREE.MeshStandardMaterial {
  const palette = BUILDING_PALETTES[category] || BUILDING_PALETTES.default;

  // Use a middle-ground color from the palette
  const midIndex = Math.floor(palette.walls.length / 2);
  const color = palette.walls[midIndex];

  return new THREE.MeshStandardMaterial({
    color: color,
    roughness: 0.7,
    metalness: 0.1,
    flatShading: false,
  });
}

/**
 * Group features by their building category for efficient batching
 */
export function groupFeaturesByCategory(features: BuildingFeature[]): Record<string, BuildingFeature[]> {
  const groups: Record<string, BuildingFeature[]> = {};

  for (const feature of features) {
    const category = getBuildingCategory(feature);
    if (!groups[category]) {
      groups[category] = [];
    }
    groups[category].push(feature);
  }

  return groups;
}

/**
 * Get a simple color for a feature (for use with merged geometry)
 * Returns a hex color value
 */
export function getBuildingColor(feature: BuildingFeature): number {
  const category = getBuildingCategory(feature);
  const palette = BUILDING_PALETTES[category] || BUILDING_PALETTES.default;

  const seed = generateSeed(feature);
  const rng = seededRandom(seed);

  const wallColorIndex = Math.floor(rng() * palette.walls.length);
  return palette.walls[wallColorIndex];
}
