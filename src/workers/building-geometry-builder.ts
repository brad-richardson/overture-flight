import earcut from 'earcut';
import type {
  SceneOrigin,
  BuildingFeatureInput,
  CreateBuildingGeometryPayload,
  CreateBuildingGeometryResult,
  BuildingGeometryBuffers,
  BuildingColliderBounds,
  ElevationConfig,
} from './types.js';
import { getBuildingColor as getColor } from '../building-colors.js';

interface CachedElevationTile {
  heights: Float32Array;
  bounds: { west: number; east: number; north: number; south: number };
}
const elevationCache = new Map<string, CachedElevationTile>();

function lngLatToTile(lng: number, lat: number, zoom: number): [number, number] {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return [x, y];
}
function tileToBounds(x: number, y: number, zoom: number) {
  const n = Math.pow(2, zoom);
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * (180 / Math.PI);
  const south = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * (180 / Math.PI);
  return { west, east, north, south };
}
function decodeTerrarium(r: number, g: number, b: number, offset: number) {
  return (r * 256 + g + b / 256) - offset;
}
async function fetchElevationTile(x: number, y: number, config: ElevationConfig) {
  const key = `${config.zoom}/${x}/${y}`;
  const cached = elevationCache.get(key);
  if (cached) return cached;
  const url = config.urlTemplate.replace('{z}', config.zoom.toString()).replace('{x}', x.toString()).replace('{y}', y.toString());
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(config.tileSize, config.tileSize);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, config.tileSize, config.tileSize);
    const imageData = ctx.getImageData(0, 0, config.tileSize, config.tileSize);
    const heights = new Float32Array(config.tileSize * config.tileSize);
    for (let i = 0; i < config.tileSize * config.tileSize; i++) {
      const r = imageData.data[i * 4];
      const g = imageData.data[i * 4 + 1];
      const b = imageData.data[i * 4 + 2];
      heights[i] = decodeTerrarium(r, g, b, config.terrariumOffset);
    }
    const bounds = tileToBounds(x, y, config.zoom);
    const tile: CachedElevationTile = { heights, bounds };
    elevationCache.set(key, tile);
    return tile;
  } catch { return null; }
}
function bilinearInterpolate(heights: Float32Array, gridX: number, gridY: number, gridSize: number) {
  const clampedX = Math.max(0, Math.min(gridSize - 1, gridX));
  const clampedY = Math.max(0, Math.min(gridSize - 1, gridY));
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(x0 + 1, gridSize - 1);
  const y1 = Math.min(y0 + 1, gridSize - 1);
  const fx = clampedX - x0;
  const fy = clampedY - y0;
  const h00 = heights[y0 * gridSize + x0];
  const h10 = heights[y0 * gridSize + x1];
  const h01 = heights[y1 * gridSize + x0];
  const h11 = heights[y1 * gridSize + x1];
  const corners = [h00, h10, h01, h11];
  const validCorners = corners.filter(h => !Number.isNaN(h));
  if (validCorners.length === 0) return 0;
  if (validCorners.length < 4) {
    const avg = validCorners.reduce((a, b) => a + b, 0) / validCorners.length;
    const h00Safe = Number.isNaN(h00) ? avg : h00;
    const h10Safe = Number.isNaN(h10) ? avg : h10;
    const h01Safe = Number.isNaN(h01) ? avg : h01;
    const h11Safe = Number.isNaN(h11) ? avg : h11;
    return h00Safe * (1 - fx) * (1 - fy) + h10Safe * fx * (1 - fy) + h01Safe * (1 - fx) * fy + h11Safe * fx * fy;
  }
  return h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;
}
function getTerrainHeightFromCache(lng: number, lat: number, config: ElevationConfig) {
  const [tileX, tileY] = lngLatToTile(lng, lat, config.zoom);
  const key = `${config.zoom}/${tileX}/${tileY}`;
  const cached = elevationCache.get(key);
  if (!cached) return 0;
  const { heights, bounds } = cached;
  const relX = (lng - bounds.west) / (bounds.east - bounds.west);
  const relY = (bounds.north - lat) / (bounds.north - bounds.south);
  const gridX = relX * (config.tileSize - 1);
  const gridY = relY * (config.tileSize - 1);
  const height = bilinearInterpolate(heights, gridX, gridY, config.tileSize);
  return Number.isNaN(height) ? 0 : height;
}
async function prefetchElevationTiles(features: BuildingFeatureInput[], config: ElevationConfig) {
  const neededTiles = new Set<string>();
  for (const feature of features) {
    const polygons = feature.type === 'Polygon' ? [feature.coordinates as number[][][]] : feature.coordinates as number[][][][];
    for (const polygon of polygons) {
      const outerRing = polygon[0];
      if (!outerRing) continue;
      for (const coord of outerRing) {
        const [tileX, tileY] = lngLatToTile(coord[0], coord[1], config.zoom);
        neededTiles.add(`${tileX}/${tileY}`);
      }
    }
  }
  const fetchPromises: Promise<CachedElevationTile | null>[] = [];
  for (const tileKey of neededTiles) {
    const [x, y] = tileKey.split('/').map(Number);
    fetchPromises.push(fetchElevationTile(x, y, config));
  }
  await Promise.all(fetchPromises);
}
function computeTerrainHeights(coordinates: number[][][] | number[][][][], type: 'Polygon' | 'MultiPolygon', config: ElevationConfig): [number, number] {
  const coords = type === 'Polygon' ? [coordinates as number[][][]] : coordinates as number[][][][];
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  let validCount = 0;
  for (const polygon of coords) {
    const outerRing = polygon[0];
    if (!outerRing) continue;
    for (const coord of outerRing) {
      const h = getTerrainHeightFromCache(coord[0], coord[1], config);
      if (!Number.isNaN(h)) {
        minHeight = Math.min(minHeight, h);
        maxHeight = Math.max(maxHeight, h);
        validCount++;
      }
    }
  }
  if (validCount === 0) return [0, 0];
  return [minHeight, maxHeight];
}

const LOD_LOW = 2;
const BUILDING_TERRAIN_OFFSET = 0.5;
const SLOPE_COMPENSATION_FACTOR = 0.3;
const MIN_BUILDING_AREA_FAR = 50;

function geoToWorld(lng: number, lat: number, altitude: number, origin: SceneOrigin) {
  const x = (lng - origin.lng) * origin.metersPerDegLng;
  const z = -(lat - origin.lat) * origin.metersPerDegLat;
  const y = altitude;
  return { x, y, z };
}
function calculatePolygonArea(points: { x: number; z: number }[]): number {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j].x + points[i].x) * (points[j].z - points[i].z);
  }
  return area / 2;
}
function getBuildingHeight(props: BuildingFeatureInput['properties'], defaultHeight: number) {
  if (typeof props.height === 'number' && props.height > 0) return props.height;
  if (typeof props.num_floors === 'number' && props.num_floors > 0) return props.num_floors * 3;
  return defaultHeight;
}
function getBuildingColor(feature: BuildingFeatureInput): number {
  return getColor({
    type: feature.type,
    coordinates: feature.coordinates,
    properties: feature.properties,
  });
}

const ATLAS_TILES: Record<string, { row: number; cols: number[] }> = {
  residential: { row: 0, cols: [0, 1, 2, 3] },
  commercial: { row: 1, cols: [0, 1, 2, 3] },
  industrial: { row: 2, cols: [0, 1] },
  civic: { row: 2, cols: [2, 3] },
  religious: { row: 3, cols: [0, 1] },
  education: { row: 2, cols: [2, 3] },
  medical: { row: 1, cols: [2, 3] },
  agricultural: { row: 2, cols: [0, 1] },
  entertainment: { row: 1, cols: [0, 1] },
  military: { row: 2, cols: [0, 1] },
  outbuilding: { row: 2, cols: [0, 1] },
  service: { row: 1, cols: [2, 3] },
  transportation: { row: 1, cols: [2, 3] },
  default: { row: 1, cols: [2] },
};
function getAtlasUVs(category: string, variant: number = 0) {
  const tile = ATLAS_TILES[category] || ATLAS_TILES.default;
  const col = tile.cols[variant % tile.cols.length];
  const row = tile.row;
  const tileNorm = 1 / 4;
  return {
    u0: col * tileNorm,
    v0: 1 - (row + 1) * tileNorm,
    u1: (col + 1) * tileNorm,
    v1: 1 - row * tileNorm,
  };
}
function generateSeedFromProps(props: BuildingFeatureInput['properties']): number {
  if (props?.id !== undefined) {
    let hash = 0;
    const str = String(props.id);
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }
  return 42;
}
function getCategoryFromProps(props: BuildingFeatureInput['properties']): string {
  const facadeMaterial = (props.facade_material as string || '').toLowerCase();
  if (facadeMaterial) {
    const matMap: Record<string, string> = {
      brick: 'residential',
      glass: 'commercial',
      metal: 'commercial',
      concrete: 'industrial',
      stone: 'civic',
      wood: 'residential',
      timber_framing: 'residential',
      plaster: 'civic',
      cement_block: 'industrial',
      clay: 'residential',
    };
    if (ATLAS_TILES[matMap[facadeMaterial] || '']) return matMap[facadeMaterial];
    if (ATLAS_TILES[facadeMaterial]) return facadeMaterial;
  }

  const subtype = (props.subtype as string || '').toLowerCase();
  if (ATLAS_TILES[subtype]) return subtype;
  const cls = (props.class as string || '').toLowerCase();
  const map: Record<string, string> = {
    house: 'residential', residential: 'residential', detached: 'residential',
    apartments: 'residential', commercial: 'commercial', office: 'commercial',
    retail: 'commercial', industrial: 'industrial', warehouse: 'industrial',
    civic: 'civic', church: 'religious', school: 'education', hospital: 'medical',
  };
  return map[cls] || 'default';
}

function generateBuildingGeometry(
  coordinates: number[][][],
  height: number,
  minHeight: number,
  color: number,
  lodLevel: number,
  terrainHeight: number,
  terrainSlope: number,
  verticalExaggeration: number,
  origin: SceneOrigin,
  category: string = 'default',
  variant: number = 0,
  numFloors: number = 3
): {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
  uvs: number[];
  collider: BuildingColliderBounds;
} | null {
  void numFloors;
  if (!coordinates || coordinates.length === 0) return null;
  const outerRing = coordinates[0];
  if (!outerRing || outerRing.length < 3) return null;
  let points: { x: number; z: number }[] = [];
  for (const coord of outerRing) {
    const world = geoToWorld(coord[0], coord[1], 0, origin);
    points.push({ x: world.x, z: world.z });
  }
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.abs(first.x - last.x) < 0.01 && Math.abs(first.z - last.z) < 0.01) points.pop();
  }
  if (points.length < 3) return null;
  const area = calculatePolygonArea(points);
  if (Math.abs(area) < 1) return null;
  if (lodLevel === LOD_LOW && Math.abs(area) < MIN_BUILDING_AREA_FAR) return null;
  if (points.length < 3) return null;
  const finalArea = calculatePolygonArea(points);
  if (Math.abs(finalArea) < 1) return null;
  if (finalArea > 0) points.reverse();

  const baseY = terrainHeight * verticalExaggeration + BUILDING_TERRAIN_OFFSET + terrainSlope * SLOPE_COMPENSATION_FACTOR;
  const topY = baseY + height;
  const bottomY = baseY + minHeight;

  const flatCoords: number[] = [];
  for (const p of points) flatCoords.push(p.x, p.z);

  const holes: number[] = [];
  const holeVertexCounts: number[] = [];
  const colliderHoles: number[][] = [];
  if (lodLevel !== LOD_LOW && coordinates.length > 1) {
    for (let i = 1; i < coordinates.length; i++) {
      const holeRing = coordinates[i];
      if (!holeRing || holeRing.length < 3) continue;
      holes.push(flatCoords.length / 2);
      let holePoints: { x: number; z: number }[] = [];
      for (const coord of holeRing) {
        const world = geoToWorld(coord[0], coord[1], 0, origin);
        holePoints.push({ x: world.x, z: world.z });
      }
      if (holePoints.length > 1) {
        const first = holePoints[0];
        const last = holePoints[holePoints.length - 1];
        if (Math.abs(first.x - last.x) < 0.01 && Math.abs(first.z - last.z) < 0.01) holePoints.pop();
      }
      const holeArea = calculatePolygonArea(holePoints);
      if (holeArea < 0) holePoints.reverse();
      holeVertexCounts.push(holePoints.length);
      if (holePoints.length >= 3) colliderHoles.push(holePoints.flatMap(p => [p.x, p.z]));
      for (const p of holePoints) flatCoords.push(p.x, p.z);
    }
  }

  const roofIndices = earcut(flatCoords, holes, 2);
  if (roofIndices.length === 0) return null;

  const vertexCount = flatCoords.length / 2;
  const roofVertices: { x: number; z: number }[] = [];
  for (let i = 0; i < vertexCount; i++) {
    roofVertices.push({ x: flatCoords[i * 2], z: flatCoords[i * 2 + 1] });
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];

  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;

  const atlasUVs = getAtlasUVs(category, variant);

  const roofStartIndex = positions.length / 3;
  for (const v of roofVertices) {
    positions.push(v.x, topY, v.z);
    normals.push(0, 1, 0);
    colors.push(r, g, b);
    uvs.push((atlasUVs.u0 + atlasUVs.u1) / 2, (atlasUVs.v0 + atlasUVs.v1) / 2);
  }
  for (let i = 0; i < roofIndices.length; i += 3) {
    indices.push(roofStartIndex + roofIndices[i]);
    indices.push(roofStartIndex + roofIndices[i + 2]);
    indices.push(roofStartIndex + roofIndices[i + 1]);
  }

  if (minHeight > 0) {
    const bottomStartIndex = positions.length / 3;
    for (const v of roofVertices) {
      positions.push(v.x, bottomY, v.z);
      normals.push(0, -1, 0);
      colors.push(r * 0.7, g * 0.7, b * 0.7);
      uvs.push((atlasUVs.u0 + atlasUVs.u1) / 2, (atlasUVs.v0 + atlasUVs.v1) / 2);
    }
    for (let i = roofIndices.length - 1; i >= 0; i--) {
      indices.push(bottomStartIndex + roofIndices[i]);
    }
  }

  const outerPointCount = points.length;
  const wallDarkening = 0.85;
  for (let i = 0; i < outerPointCount; i++) {
    const p0 = points[i];
    const p1 = points[(i + 1) % outerPointCount];
    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.01) continue;
    const nx = dz / len;
    const nz = -dx / len;
    const wallStartIndex = positions.length / 3;
    const wallBaseY = minHeight > 0 ? bottomY : baseY;
    positions.push(p0.x, wallBaseY, p0.z);
    positions.push(p1.x, wallBaseY, p1.z);
    positions.push(p1.x, topY, p1.z);
    positions.push(p0.x, topY, p0.z);
    for (let j = 0; j < 4; j++) {
      normals.push(nx, 0, nz);
      colors.push(r * wallDarkening, g * wallDarkening, b * wallDarkening);
    }
    uvs.push(atlasUVs.u0, atlasUVs.v0);
    uvs.push(atlasUVs.u1, atlasUVs.v0);
    uvs.push(atlasUVs.u1, atlasUVs.v1);
    uvs.push(atlasUVs.u0, atlasUVs.v1);
    indices.push(wallStartIndex + 0, wallStartIndex + 3, wallStartIndex + 2);
    indices.push(wallStartIndex + 0, wallStartIndex + 2, wallStartIndex + 1);
  }

  if (lodLevel !== LOD_LOW && holeVertexCounts.length > 0) {
    let holeStartIdx = outerPointCount;
    for (let h = 0; h < holeVertexCounts.length; h++) {
      const holeVertexCount = holeVertexCounts[h];
      for (let i = 0; i < holeVertexCount; i++) {
        const idx0 = holeStartIdx + i;
        const idx1 = holeStartIdx + ((i + 1) % holeVertexCount);
        if (idx0 >= roofVertices.length || idx1 >= roofVertices.length) break;
        const p0 = roofVertices[idx0];
        const p1 = roofVertices[idx1];
        const dx = p1.x - p0.x;
        const dz = p1.z - p0.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len < 0.01) continue;
        const nx = -dz / len;
        const nz = dx / len;
        const wallStartIndex = positions.length / 3;
        const wallBaseY = minHeight > 0 ? bottomY : baseY;
        positions.push(p0.x, wallBaseY, p0.z);
        positions.push(p1.x, wallBaseY, p1.z);
        positions.push(p1.x, topY, p1.z);
        positions.push(p0.x, topY, p0.z);
        for (let j = 0; j < 4; j++) {
          normals.push(nx, 0, nz);
          colors.push(r * wallDarkening, g * wallDarkening, b * wallDarkening);
        }
        uvs.push(atlasUVs.u0, atlasUVs.v0);
        uvs.push(atlasUVs.u1, atlasUVs.v0);
        uvs.push(atlasUVs.u1, atlasUVs.v1);
        uvs.push(atlasUVs.u0, atlasUVs.v1);
        indices.push(wallStartIndex + 0, wallStartIndex + 3, wallStartIndex + 2);
        indices.push(wallStartIndex + 0, wallStartIndex + 2, wallStartIndex + 1);
      }
      holeStartIdx += holeVertexCount;
    }
  }

  const bounds = getGeometryBounds(positions);
  if (!bounds) return null;

  return {
    positions,
    normals,
    colors,
    indices,
    uvs,
    collider: {
      ...bounds,
      outerRing: points.flatMap(p => [p.x, p.z]),
      holes: colliderHoles,
    },
  };
}

type BuildingBounds = Omit<BuildingColliderBounds, 'outerRing' | 'holes'>;
function getGeometryBounds(positions: number[]): BuildingBounds | null {
  if (positions.length < 3) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

export async function buildBuildingGeometry(payload: CreateBuildingGeometryPayload): Promise<CreateBuildingGeometryResult> {
  const { features, origin, lodLevel, defaultHeight, elevationConfig, verticalExaggeration } = payload;
  if (elevationConfig) await prefetchElevationTiles(features, elevationConfig);
  const allPositions: number[] = [];
  const allNormals: number[] = [];
  const allColors: number[] = [];
  const allIndices: number[] = [];
  const allUvs: number[] = [];
  const colliders: BuildingColliderBounds[] = [];
  let vertexOffset = 0;
  let buildingsProcessed = 0;
  let buildingsSkipped = 0;

  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    if (feature.properties.is_underground) { buildingsSkipped++; continue; }
    if (feature.properties.has_parts === true) { buildingsSkipped++; continue; }
    const polygons = feature.type === 'Polygon' ? [feature.coordinates as number[][][]] : feature.coordinates as number[][][][];
    const height = getBuildingHeight(feature.properties, defaultHeight);
    const minHeight = typeof feature.properties.min_height === 'number' ? feature.properties.min_height : 0;
    const color = getBuildingColor(feature);
    const category = getCategoryFromProps(feature.properties);
    const seed = generateSeedFromProps(feature.properties);
    const variant = seed % 4;
    const numFloors = typeof feature.properties.num_floors === 'number' ? feature.properties.num_floors : Math.round(height / 3);
    let terrainHeight = 0;
    let terrainSlope = 0;
    if (elevationConfig) {
      const [minH, maxH] = computeTerrainHeights(feature.coordinates, feature.type, elevationConfig);
      terrainHeight = minH;
      terrainSlope = maxH - minH;
    }
    for (const polygon of polygons) {
      if (!polygon || !polygon[0] || polygon[0].length < 3) continue;
      try {
        const geom = generateBuildingGeometry(polygon, height, minHeight, color, lodLevel, terrainHeight, terrainSlope, verticalExaggeration, origin, category, variant, numFloors);
        if (geom) {
          colliders.push(geom.collider);
          for (const v of geom.positions) allPositions.push(v);
          for (const n of geom.normals) allNormals.push(n);
          for (const c of geom.colors) allColors.push(c);
          for (const u of geom.uvs) allUvs.push(u);
          for (const idx of geom.indices) allIndices.push(idx + vertexOffset);
          vertexOffset += geom.positions.length / 3;
          buildingsProcessed++;
        } else buildingsSkipped++;
      } catch { buildingsSkipped++; }
    }
  }

  if (allPositions.length === 0) {
    return { geometry: null, colliders: [], stats: { buildingsProcessed: 0, buildingsSkipped, totalVertices: 0, totalTriangles: 0 } };
  }

  const geometry: BuildingGeometryBuffers = {
    positions: new Float32Array(allPositions),
    normals: new Float32Array(allNormals),
    colors: new Float32Array(allColors),
    indices: new Uint32Array(allIndices),
    uvs: new Float32Array(allUvs),
  };

  return { geometry, colliders, stats: { buildingsProcessed, buildingsSkipped, totalVertices: allPositions.length / 3, totalTriangles: allIndices.length / 3 } };
}

export function getBuildingTransferables(result: CreateBuildingGeometryResult): ArrayBuffer[] {
  if (!result.geometry) return [];
  const buffers: ArrayBuffer[] = [
    result.geometry.positions.buffer as ArrayBuffer,
    result.geometry.normals.buffer as ArrayBuffer,
    result.geometry.colors.buffer as ArrayBuffer,
    result.geometry.indices.buffer as ArrayBuffer,
  ];
  if (result.geometry.uvs) buffers.push(result.geometry.uvs.buffer as ArrayBuffer);
  return buffers;
}
