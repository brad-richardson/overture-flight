import * as THREE from 'three';

/**
 * Building Materials System
 *
 * Predicts appropriate building textures/colors based on Overture Maps data.
 * Inspired by the arnis project's approach to realistic building generation.
 *
 * Uses normalized Overture Maps properties (preferred over source tags):
 * - subtype: agricultural, civic, commercial, education, entertainment, industrial,
 *            medical, military, outbuilding, religious, residential, service, transportation
 * - class: 87 specific building types (house, apartments, church, school, etc.)
 * - height: Building height in meters
 * - num_floors: Total floor count
 * - num_floors_underground: Below-ground floor count
 * - is_underground: Whether structure is subterranean
 * - has_parts: Whether building has separate parts
 *
 * @see https://docs.overturemaps.org/schema/reference/buildings/building/
 */

// Types
export interface BuildingFeature {
  type: string;
  coordinates: number[][][] | number[][][][];
  properties?: BuildingProperties;
  layer?: string;
}

/**
 * Overture Maps Building Properties
 * These are the normalized properties from the Overture schema
 */
export interface BuildingProperties {
  // Overture normalized properties (preferred)
  id?: string | number;
  subtype?: BuildingSubtype;
  class?: string;
  height?: number;
  num_floors?: number;
  num_floors_underground?: number;
  is_underground?: boolean;
  has_parts?: boolean;
  level?: number;

  // Source tags (fallback only)
  [key: string]: unknown;
}

/**
 * Overture Maps Building Subtypes
 * These are the normalized building categories from the Overture schema
 */
export type BuildingSubtype =
  | 'agricultural'
  | 'civic'
  | 'commercial'
  | 'education'
  | 'entertainment'
  | 'industrial'
  | 'medical'
  | 'military'
  | 'outbuilding'
  | 'religious'
  | 'residential'
  | 'service'
  | 'transportation';

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

  // Education - institutional (Overture subtype: "education")
  education: {
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

  // Medical - clean, clinical (Overture subtype: "medical")
  medical: {
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

  // Agricultural - rustic (Overture subtype: "agricultural")
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

  // Entertainment - venues, theaters, arenas (Overture subtype: "entertainment")
  entertainment: {
    walls: [
      0x4A4A4A, // dark gray
      0x2F4F4F, // dark slate gray
      0x483D8B, // dark slate blue
      0x4B0082, // indigo
      0x800020, // burgundy
      0x8B0000, // dark red
      0x191970, // midnight blue
      0x1C1C1C, // near black
      0xC0C0C0, // silver
      0x708090, // slate gray
    ],
    accents: [0xFFD700, 0xFFA500, 0xFF4500], // gold, orange, red-orange (marquee colors)
    roofs: [0x2F2F2F, 0x1C1C1C, 0x3C3C3C], // dark roofs
  },

  // Military - utilitarian, secure (Overture subtype: "military")
  military: {
    walls: [
      0x556B2F, // dark olive green
      0x6B8E23, // olive drab
      0x808000, // olive
      0x8B8B00, // dark khaki
      0x696969, // dim gray
      0x4A5568, // cool gray
      0x5F5F5F, // charcoal
      0xA0522D, // sienna
      0x8B7355, // dark tan
      0x808080, // gray
    ],
    accents: [0x2F4F4F, 0x3C3C3C], // dark accents
    roofs: [0x556B2F, 0x4A4A4A, 0x5C5C5C], // olive and gray roofs
  },

  // Outbuilding - small auxiliary structures (Overture subtype: "outbuilding")
  outbuilding: {
    walls: [
      0x8B4513, // saddle brown
      0xA0522D, // sienna
      0x696969, // dim gray
      0x808080, // gray
      0xD2B48C, // tan
      0xDEB887, // burlywood
      0x6B8E23, // olive drab
      0xB0C4DE, // light steel blue (metal shed)
      0xC0C0C0, // silver (metal shed)
      0x708090, // slate gray
    ],
    accents: [0x654321, 0x3C3C3C], // dark browns, grays
    roofs: [0x4A4A4A, 0x696969, 0x8B4513], // grays, browns
  },

  // Service - utility buildings (Overture subtype: "service")
  service: {
    walls: [
      0x708090, // slate gray
      0x808080, // gray
      0xA9A9A9, // dark gray
      0xB0C4DE, // light steel blue
      0xC0C0C0, // silver
      0xD3D3D3, // light gray
      0x4A5568, // cool gray
      0x6B7280, // gray 500
      0xE5E7EB, // gray 200
      0xF3F4F6, // gray 100
    ],
    accents: [0x3B82F6, 0x2563EB], // blues
    roofs: [0x4A4A4A, 0x5C5C5C, 0x6B7280], // grays
  },

  // Transportation - stations, terminals (Overture subtype: "transportation")
  transportation: {
    walls: [
      0x708090, // slate gray
      0x778899, // light slate gray
      0xC0C0C0, // silver
      0xD3D3D3, // light gray
      0x4682B4, // steel blue
      0x5F9EA0, // cadet blue
      0x87CEEB, // sky blue (glass)
      0xB0C4DE, // light steel blue
      0xE0E0E0, // light gray
      0xFAF0E6, // linen
    ],
    accents: [0x2F4F4F, 0x191970, 0xFF4500], // dark blues, safety orange
    roofs: [0x2F2F2F, 0x3C3C3C, 0x708090], // dark grays, slate
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

/**
 * Map all 87 Overture building classes to palette categories
 *
 * Overture Classes (alphabetical):
 * agricultural, allotment_house, apartments, barn, beach_hut, boathouse, bridge_structure,
 * bungalow, bunker, cabin, carport, cathedral, chapel, church, civic, college, commercial,
 * cowshed, detached, digester, dormitory, dwelling_house, factory, farm, farm_auxiliary,
 * fire_station, garage, garages, ger, glasshouse, government, grandstand, greenhouse,
 * guardhouse, hangar, hospital, hotel, house, houseboat, hut, industrial, kindergarten,
 * kiosk, library, manufacture, military, monastery, mosque, office, outbuilding, parking,
 * pavilion, post_office, presbytery, public, religious, residential, retail, roof, school,
 * semi, semidetached_house, service, shed, shrine, silo, slurry_tank, sports_centre,
 * sports_hall, stable, stadium, static_caravan, stilt_house, storage_tank, sty, supermarket,
 * synagogue, temple, terrace, toilets, train_station, transformer_tower, transportation,
 * trullo, university, warehouse, wayside_shrine
 *
 * @see https://docs.overturemaps.org/schema/reference/buildings/building/
 */
const CLASS_TO_CATEGORY: Record<string, string> = {
  // ===== Residential =====
  // Traditional housing
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
  trullo: 'residential', // Traditional Apulian stone hut

  // Alternative/temporary housing
  cabin: 'residential',
  houseboat: 'residential',
  static_caravan: 'residential',
  ger: 'residential', // Mongolian yurt
  hut: 'residential',
  beach_hut: 'residential',
  allotment_house: 'residential', // Garden cottage

  // Residential auxiliary
  dormitory: 'residential',
  garage: 'residential',
  garages: 'residential',
  carport: 'residential',
  boathouse: 'residential',

  // ===== Commercial =====
  commercial: 'commercial',
  office: 'commercial',
  retail: 'commercial',
  supermarket: 'commercial',
  hotel: 'commercial',
  kiosk: 'commercial',
  parking: 'commercial',

  // ===== Industrial =====
  industrial: 'industrial',
  warehouse: 'industrial',
  factory: 'industrial',
  manufacture: 'industrial',
  hangar: 'industrial',
  storage_tank: 'industrial',
  silo: 'industrial',
  slurry_tank: 'industrial',
  digester: 'industrial', // Biogas digester
  transformer_tower: 'industrial',
  roof: 'industrial', // Roof-only structures (canopies, etc.)
  bridge_structure: 'industrial',

  // ===== Civic/Government =====
  civic: 'civic',
  public: 'civic',
  government: 'civic',
  fire_station: 'civic',
  post_office: 'civic',
  library: 'civic',
  toilets: 'civic',
  guardhouse: 'civic',

  // Sports and recreation (civic)
  stadium: 'civic',
  sports_centre: 'civic',
  sports_hall: 'civic',
  grandstand: 'civic',
  pavilion: 'civic',

  // ===== Religious =====
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
  presbytery: 'religious', // Priest's residence

  // ===== Education =====
  school: 'education',
  university: 'education',
  college: 'education',
  kindergarten: 'education',

  // ===== Medical =====
  hospital: 'medical',

  // ===== Agricultural =====
  agricultural: 'agricultural',
  farm: 'agricultural',
  barn: 'agricultural',
  farm_auxiliary: 'agricultural',
  cowshed: 'agricultural',
  stable: 'agricultural',
  sty: 'agricultural',
  greenhouse: 'agricultural',
  glasshouse: 'agricultural',

  // ===== Entertainment =====
  // (Stadium and sports venues are under civic)

  // ===== Military =====
  military: 'military',
  bunker: 'military',

  // ===== Outbuilding =====
  outbuilding: 'outbuilding',
  shed: 'outbuilding',

  // ===== Service =====
  service: 'service',

  // ===== Transportation =====
  transportation: 'transportation',
  train_station: 'transportation',
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
 * Uses Overture id property, with coordinates as fallback
 */
function generateSeed(feature: BuildingFeature): number {
  const props = feature.properties;

  // Use Overture id property if available
  if (props?.id !== undefined) {
    let hash = 0;
    const str = String(props.id);
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
 * Valid Overture subtypes that map directly to palette categories
 */
const OVERTURE_SUBTYPES = new Set<string>([
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

/**
 * Check if a building is underground (should not be rendered)
 * Uses the Overture is_underground property
 */
export function isUndergroundBuilding(feature: BuildingFeature): boolean {
  return feature.properties?.is_underground === true;
}

/**
 * Check if a building has separate parts (building_part features)
 * When has_parts is true, this building footprint may overlap with more detailed parts
 */
export function hasBuildingParts(feature: BuildingFeature): boolean {
  return feature.properties?.has_parts === true;
}

/**
 * Get the building category based on Overture properties
 *
 * Priority order (preferring normalized Overture properties):
 * 1. Overture subtype (direct category mapping)
 * 2. Overture class (lookup in CLASS_TO_CATEGORY)
 * 3. Default category
 *
 * @param feature - Building feature with Overture properties
 * @returns Category name for palette selection
 */
function getBuildingCategory(feature: BuildingFeature): string {
  const props = feature.properties;
  if (!props) {
    return 'default';
  }

  // Priority 1: Overture subtype (normalized category, maps directly to palettes)
  // This is the preferred property as it has been normalized by Overture
  // Note: toLowerCase() is used because source data may have inconsistent casing
  // even though Overture schema defines lowercase values
  const subtype = props.subtype;
  if (subtype) {
    const subtypeLower = subtype.toLowerCase();
    if (OVERTURE_SUBTYPES.has(subtypeLower)) {
      return subtypeLower;
    }
  }

  // Priority 2: Overture class (specific building type)
  // Note: toLowerCase() handles potential casing inconsistencies in source data
  const buildingClass = props.class;
  if (buildingClass) {
    const classLower = buildingClass.toLowerCase();
    if (CLASS_TO_CATEGORY[classLower]) {
      return CLASS_TO_CATEGORY[classLower];
    }
  }

  // Priority 3: Default fallback
  return 'default';
}

/**
 * Calculate building height from Overture properties
 *
 * Uses the following properties in priority order:
 * 1. height - Direct height value in meters
 * 2. num_floors - Number of floors (multiplied by floor height)
 *
 * Note: num_floors_underground is not used for visible height as underground
 * portions are not rendered. The is_underground flag indicates fully subterranean
 * buildings which should be skipped entirely.
 *
 * @param feature - Building feature with Overture properties
 * @param defaultHeight - Default height if no height data is available
 * @param floorHeight - Height per floor in meters (default: 3m)
 * @returns Building height in meters
 */
export function getBuildingHeight(
  feature: BuildingFeature,
  defaultHeight: number = 10,
  floorHeight: number = 3
): number {
  const props = feature.properties;
  if (!props) {
    return defaultHeight;
  }

  // Priority 1: Direct height value (most accurate)
  if (typeof props.height === 'number' && props.height > 0) {
    return props.height;
  }

  // Priority 2: Calculate from number of floors
  if (typeof props.num_floors === 'number' && props.num_floors > 0) {
    return props.num_floors * floorHeight;
  }

  // Priority 3: Default height
  return defaultHeight;
}

/**
 * Get the number of underground floors for a building
 * This can be useful for determining foundation depth or underground parking
 *
 * @param feature - Building feature with Overture properties
 * @returns Number of underground floors (0 if not specified)
 */
export function getUndergroundFloors(feature: BuildingFeature): number {
  const floors = feature.properties?.num_floors_underground;
  return typeof floors === 'number' && floors > 0 ? floors : 0;
}

/**
 * Get the building level (hierarchical level in complex structures)
 *
 * Level values follow standard building conventions:
 * - Positive values (1, 2, 3...): Above-ground floors
 * - Zero (0): Ground level
 * - Negative values (-1, -2...): Basement/underground levels
 *
 * This function intentionally accepts any numeric level value to support
 * the full range of building configurations.
 *
 * @param feature - Building feature with Overture properties
 * @returns Level value or undefined if not set
 */
export function getBuildingLevel(feature: BuildingFeature): number | undefined {
  const level = feature.properties?.level;
  return typeof level === 'number' ? level : undefined;
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
