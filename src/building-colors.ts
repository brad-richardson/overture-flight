/**
 * Building Color System (Shared between main thread and workers)
 *
 * This module provides deterministic color selection for buildings based on
 * Overture Maps properties. It uses a seeded random number generator to ensure
 * the same building always gets the same color.
 *
 * NOTE: This module must NOT import Three.js to remain usable in workers.
 */

// ============================================================================
// Types
// ============================================================================

export interface BuildingColorInput {
  type: string;
  coordinates: number[][][] | number[][][][];
  properties?: {
    id?: string | number;
    building_id?: string; // For building parts - parent building ID
    subtype?: string;
    class?: string;
    [key: string]: unknown;
  };
}

interface ColorPalette {
  walls: number[];
}

// ============================================================================
// Color Palettes by Building Category
// ============================================================================

/**
 * Predefined wall color palettes for different building categories
 * Colors are hex values (e.g., 0xE8DCC8)
 */
export const BUILDING_PALETTES: Record<string, ColorPalette> = {
  // Residential colors - warmer, more varied
  residential: {
    walls: [
      0xe8dcc8, // cream/beige
      0xd4c4a8, // tan
      0xb8a082, // brownish beige
      0xc9b896, // warm gray-beige
      0xe5d5c0, // off-white
      0xa89070, // brown
      0x8b7355, // dark tan
      0xcd853f, // peru/terracotta
      0xbc8f8f, // rosy brown
      0xf5deb3, // wheat
    ],
  },

  // Commercial/office - modern, glass-heavy
  commercial: {
    walls: [
      0x708090, // slate gray
      0x778899, // light slate gray
      0xa9a9a9, // dark gray
      0xc0c0c0, // silver
      0xd3d3d3, // light gray
      0x5a7a8a, // muted steel blue
      0x5a7d7e, // muted cadet blue
      0x7a9aaa, // muted blue-gray (glass effect)
      0x8a9cac, // muted steel blue
      0xa0b0b8, // muted blue-gray
    ],
  },

  // Industrial - utilitarian colors
  industrial: {
    walls: [
      0x696969, // dim gray
      0x808080, // gray
      0xa9a9a9, // dark gray
      0x708090, // slate gray
      0x4a5568, // cool gray
      0x5c5c5c, // charcoal
      0x6b7280, // gray 500
      0x9ca3af, // gray 400
      0xc4b998, // tan industrial
      0xd4c4a8, // beige industrial
    ],
  },

  // Civic/government - dignified, classic
  civic: {
    walls: [
      0xd3d3d3, // light gray
      0xc0c0c0, // silver
      0xe8e0d0, // warm beige
      0xe5dcd0, // muted linen
      0xe8e4dc, // off-white
      0xd0d0d8, // muted gray with slight warmth
      0xe0e0e0, // light gray
      0xbdb76b, // dark khaki
      0xd2b48c, // tan
      0xbc8f8f, // rosy brown
    ],
  },

  // Religious - varied based on tradition
  religious: {
    walls: [
      0xf0ebe0, // muted off-white
      0xe8e0d5, // muted linen
      0xd2b48c, // tan
      0xdeb887, // burlywood
      0xbc8f8f, // rosy brown
      0xe8e4d8, // muted beige
      0xd8d4cc, // warm gray
      0xd4c4a8, // warm beige
      0x8b4513, // saddle brown
      0xcd853f, // peru
    ],
  },

  // Education - institutional
  education: {
    walls: [
      0xcd853f, // peru (brick-like)
      0xa0522d, // sienna
      0xd2691e, // chocolate
      0x8b4513, // saddle brown
      0xd2b48c, // tan
      0xdeb887, // burlywood
      0xc0c0c0, // silver
      0xa9a9a9, // dark gray
      0xbc8f8f, // rosy brown
      0xf4a460, // sandy brown
    ],
  },

  // Medical - clean, clinical
  medical: {
    walls: [
      0xf8f8f8, // near white
      0xf0f0f0, // white smoke
      0xe8e8e8, // light gray
      0xe0e0e0, // light gray
      0xf5f5f5, // near white
      0xececec, // light gray
      0xd8e0e0, // muted blue-gray
      0xc8d0d4, // muted gray-blue
      0xb8c4c8, // muted steel
      0xa0b0b8, // muted blue-gray
    ],
  },

  // Agricultural - rustic
  agricultural: {
    walls: [
      0x8b4513, // saddle brown
      0xa0522d, // sienna
      0xcd853f, // peru
      0xd2691e, // chocolate
      0x7b3f00, // chocolate brown (barn)
      0x8b5a2b, // tan brown (barn)
      0xdeb887, // burlywood
      0xd2b48c, // tan
      0x6b8e23, // olive drab
      0x808000, // olive
    ],
  },

  // Entertainment - venues, theaters, arenas
  entertainment: {
    walls: [
      0x4a4a4a, // dark gray
      0x2f4f4f, // dark slate gray
      0x3d3d5c, // muted dark blue-gray
      0x4a4a5a, // neutral dark gray-blue
      0x5a5a5a, // medium dark gray
      0x3c3c3c, // charcoal
      0x2f3f4f, // dark slate
      0x1c1c1c, // near black
      0xc0c0c0, // silver
      0x708090, // slate gray
    ],
  },

  // Military - utilitarian, secure
  military: {
    walls: [
      0x556b2f, // dark olive green
      0x6b8e23, // olive drab
      0x808000, // olive
      0x8b8b00, // dark khaki
      0x696969, // dim gray
      0x4a5568, // cool gray
      0x5f5f5f, // charcoal
      0xa0522d, // sienna
      0x8b7355, // dark tan
      0x808080, // gray
    ],
  },

  // Outbuilding - small auxiliary structures
  outbuilding: {
    walls: [
      0x8b4513, // saddle brown
      0xa0522d, // sienna
      0x696969, // dim gray
      0x808080, // gray
      0xd2b48c, // tan
      0xdeb887, // burlywood
      0x6b8e23, // olive drab
      0x8a9a9a, // muted steel (metal shed)
      0xa8a8a8, // muted silver (metal shed)
      0x708090, // slate gray
    ],
  },

  // Service - utility buildings
  service: {
    walls: [
      0x708090, // slate gray
      0x808080, // gray
      0xa9a9a9, // dark gray
      0x8a9aa8, // muted steel blue
      0xb0b0b0, // muted silver
      0xc8c8c8, // light gray
      0x4a5568, // cool gray
      0x6b7280, // gray 500
      0xd8d8d8, // gray 200
      0xe0e0e0, // gray 100
    ],
  },

  // Transportation - stations, terminals
  transportation: {
    walls: [
      0x708090, // slate gray
      0x778899, // light slate gray
      0xb0b0b0, // muted silver
      0xc8c8c8, // light gray
      0x5a7a8a, // muted steel blue
      0x5a7d7e, // muted cadet blue
      0x7a9aaa, // muted blue-gray (glass)
      0x8a9cac, // muted steel blue
      0xd8d8d8, // light gray
      0xe0d8d0, // muted linen
    ],
  },

  // Default/unknown - neutral
  default: {
    walls: [
      0x808080, // gray
      0x909090, // light gray
      0xa0a0a0, // lighter gray
      0xb0b0b0, // even lighter
      0x888899, // blue-gray
      0x989898, // neutral gray
      0xa8a8a8, // medium gray
      0xc0c0c0, // silver
      0x778899, // light slate gray
      0x708090, // slate gray
    ],
  },
};

// ============================================================================
// Building Class to Category Mapping
// ============================================================================

/**
 * Map Overture building classes to palette categories
 */
export const CLASS_TO_CATEGORY: Record<string, string> = {
  // Residential
  house: 'residential',
  residential: 'residential',
  detached: 'residential',
  semi: 'residential',
  semidetached_house: 'residential',
  terrace: 'residential',
  apartments: 'residential',
  bungalow: 'residential',
  dwelling_house: 'residential',
  stilt_house: 'residential',
  trullo: 'residential',
  cabin: 'residential',
  houseboat: 'residential',
  static_caravan: 'residential',
  ger: 'residential',
  hut: 'residential',
  beach_hut: 'residential',
  allotment_house: 'residential',
  dormitory: 'residential',
  garage: 'residential',
  garages: 'residential',
  carport: 'residential',
  boathouse: 'residential',

  // Commercial
  commercial: 'commercial',
  office: 'commercial',
  retail: 'commercial',
  supermarket: 'commercial',
  hotel: 'commercial',
  kiosk: 'commercial',
  parking: 'commercial',

  // Industrial
  industrial: 'industrial',
  warehouse: 'industrial',
  factory: 'industrial',
  manufacture: 'industrial',
  hangar: 'industrial',
  storage_tank: 'industrial',
  silo: 'industrial',
  slurry_tank: 'industrial',
  digester: 'industrial',
  transformer_tower: 'industrial',
  roof: 'industrial',
  bridge_structure: 'industrial',

  // Civic/Government
  civic: 'civic',
  public: 'civic',
  government: 'civic',
  fire_station: 'civic',
  post_office: 'civic',
  library: 'civic',
  toilets: 'civic',
  guardhouse: 'civic',
  stadium: 'civic',
  sports_centre: 'civic',
  sports_hall: 'civic',
  grandstand: 'civic',
  pavilion: 'civic',

  // Religious
  religious: 'religious',
  church: 'religious',
  chapel: 'religious',
  cathedral: 'religious',
  mosque: 'religious',
  temple: 'religious',
  synagogue: 'religious',
  shrine: 'religious',
  wayside_shrine: 'religious',
  monastery: 'religious',
  presbytery: 'religious',

  // Education
  school: 'education',
  university: 'education',
  college: 'education',
  kindergarten: 'education',

  // Medical
  hospital: 'medical',

  // Agricultural
  agricultural: 'agricultural',
  farm: 'agricultural',
  barn: 'agricultural',
  farm_auxiliary: 'agricultural',
  cowshed: 'agricultural',
  stable: 'agricultural',
  sty: 'agricultural',
  greenhouse: 'agricultural',
  glasshouse: 'agricultural',

  // Military
  military: 'military',
  bunker: 'military',

  // Outbuilding
  outbuilding: 'outbuilding',
  shed: 'outbuilding',

  // Service
  service: 'service',

  // Transportation
  transportation: 'transportation',
  train_station: 'transportation',
};

/**
 * Valid Overture subtypes that map directly to palette categories
 */
export const OVERTURE_SUBTYPES = new Set<string>([
  'agricultural',
  'civic',
  'commercial',
  'education',
  'entertainment',
  'industrial',
  'medical',
  'military',
  'outbuilding',
  'religious',
  'residential',
  'service',
  'transportation',
]);

// ============================================================================
// Seeded Random Number Generator
// ============================================================================

/**
 * Simple seeded random number generator for deterministic results
 * Uses mulberry32 algorithm
 */
function seededRandom(seed: number): () => number {
  return function (): number {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a deterministic seed from feature properties
 * For building parts, uses building_id (parent) so all parts share the same color
 * For main buildings, uses their own id
 * Falls back to coordinates if no id available
 */
function generateSeed(feature: BuildingColorInput): number {
  const props = feature.properties;

  // For building parts, use building_id so all parts of the same building share color
  // This prevents z-fighting artifacts from being visible (same color = invisible flicker)
  if (props?.building_id !== undefined) {
    let hash = 0;
    const str = String(props.building_id);
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  // Use Overture id property if available (for main buildings)
  if (props?.id !== undefined) {
    let hash = 0;
    const str = String(props.id);
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  // Fallback: use first coordinate as seed (deterministic)
  if (feature.coordinates) {
    const coords =
      feature.type === 'MultiPolygon'
        ? (feature.coordinates as number[][][][])[0][0][0]
        : (feature.coordinates as number[][][])[0][0];
    if (coords && coords.length >= 2) {
      return Math.abs(Math.floor(coords[0] * 1000000 + coords[1] * 1000));
    }
  }

  // Final fallback: use a fixed seed for consistency
  return 42;
}

// ============================================================================
// Color Selection Functions
// ============================================================================

/**
 * Get the building category based on Overture properties
 *
 * Priority order:
 * 1. Overture subtype (direct category mapping)
 * 2. Overture class (lookup in CLASS_TO_CATEGORY)
 * 3. Default category
 */
export function getBuildingCategory(feature: BuildingColorInput): string {
  const props = feature.properties;
  if (!props) {
    return 'default';
  }

  // Priority 1: Overture subtype (normalized category)
  const subtype = props.subtype;
  if (subtype) {
    const subtypeLower = String(subtype).toLowerCase();
    if (OVERTURE_SUBTYPES.has(subtypeLower)) {
      return subtypeLower;
    }
  }

  // Priority 2: Overture class (specific building type)
  const buildingClass = props.class;
  if (buildingClass) {
    const classLower = String(buildingClass).toLowerCase();
    if (CLASS_TO_CATEGORY[classLower]) {
      return CLASS_TO_CATEGORY[classLower];
    }
  }

  // Priority 3: Default fallback
  return 'default';
}

/**
 * Get a deterministic color for a building feature
 * Uses seeded random to select from the category's palette
 *
 * @param feature - Building feature with Overture properties
 * @returns Hex color value (e.g., 0xE8DCC8)
 */
export function getBuildingColor(feature: BuildingColorInput): number {
  const category = getBuildingCategory(feature);
  const palette = BUILDING_PALETTES[category] || BUILDING_PALETTES.default;

  const seed = generateSeed(feature);
  const rng = seededRandom(seed);

  const wallColorIndex = Math.floor(rng() * palette.walls.length);
  return palette.walls[wallColorIndex];
}
