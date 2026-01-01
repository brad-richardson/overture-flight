#!/usr/bin/env node
/**
 * Generate sample tree tile data for development and testing
 *
 * This creates a representative tree-tiles.bin file with synthetic data
 * that mimics real-world tree distribution patterns.
 *
 * For production, use generate-tree-tiles.js with actual OSM PBF data.
 *
 * Usage:
 *   node scripts/generate-sample-tree-data.js
 */

import { writeFile } from 'fs/promises';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ZOOM_LEVEL = 11;

// Seeded random number generator for reproducibility
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Convert lat/lon to tile coordinates
 * Web Mercator is only valid for ~±85.05°, clamp to avoid NaN at poles
 */
function latLonToTile(lat, lon, zoom) {
  const clampedLat = Math.max(-85.051129, Math.min(85.051129, lat));
  const x = Math.floor((lon + 180) / 360 * (1 << zoom));
  const y = Math.floor((1 - Math.log(Math.tan(clampedLat * Math.PI / 180) + 1 / Math.cos(clampedLat * Math.PI / 180)) / Math.PI) / 2 * (1 << zoom));
  return { x, y };
}

/**
 * Major cities and regions with tree data
 * [lat, lon, radius (degrees), tree density, conifer ratio]
 */
const TREE_HOTSPOTS = [
  // North America
  { lat: 37.77, lon: -122.42, radius: 0.3, density: 200, coniferRatio: 0.2, name: 'San Francisco' },
  { lat: 40.71, lon: -74.01, radius: 0.4, density: 150, coniferRatio: 0.15, name: 'New York' },
  { lat: 34.05, lon: -118.25, radius: 0.5, density: 100, coniferRatio: 0.1, name: 'Los Angeles' },
  { lat: 47.61, lon: -122.33, radius: 0.3, density: 250, coniferRatio: 0.6, name: 'Seattle' },
  { lat: 45.52, lon: -122.68, radius: 0.3, density: 300, coniferRatio: 0.7, name: 'Portland' },
  { lat: 49.28, lon: -123.12, radius: 0.3, density: 280, coniferRatio: 0.65, name: 'Vancouver' },
  { lat: 43.65, lon: -79.38, radius: 0.3, density: 180, coniferRatio: 0.3, name: 'Toronto' },
  { lat: 41.88, lon: -87.63, radius: 0.4, density: 160, coniferRatio: 0.25, name: 'Chicago' },
  { lat: 42.36, lon: -71.06, radius: 0.25, density: 200, coniferRatio: 0.35, name: 'Boston' },
  { lat: 38.91, lon: -77.04, radius: 0.3, density: 220, coniferRatio: 0.2, name: 'Washington DC' },

  // Europe
  { lat: 51.51, lon: -0.13, radius: 0.4, density: 300, coniferRatio: 0.15, name: 'London' },
  { lat: 48.86, lon: 2.35, radius: 0.35, density: 280, coniferRatio: 0.2, name: 'Paris' },
  { lat: 52.52, lon: 13.41, radius: 0.35, density: 350, coniferRatio: 0.4, name: 'Berlin' },
  { lat: 48.14, lon: 11.58, radius: 0.3, density: 400, coniferRatio: 0.5, name: 'Munich' },
  { lat: 52.37, lon: 4.90, radius: 0.25, density: 250, coniferRatio: 0.1, name: 'Amsterdam' },
  { lat: 50.85, lon: 4.35, radius: 0.2, density: 200, coniferRatio: 0.15, name: 'Brussels' },
  { lat: 48.21, lon: 16.37, radius: 0.3, density: 320, coniferRatio: 0.35, name: 'Vienna' },
  { lat: 50.08, lon: 14.44, radius: 0.25, density: 280, coniferRatio: 0.4, name: 'Prague' },
  { lat: 59.33, lon: 18.07, radius: 0.3, density: 200, coniferRatio: 0.7, name: 'Stockholm' },
  { lat: 60.17, lon: 24.94, radius: 0.25, density: 180, coniferRatio: 0.75, name: 'Helsinki' },
  { lat: 59.91, lon: 10.75, radius: 0.25, density: 220, coniferRatio: 0.7, name: 'Oslo' },
  { lat: 55.68, lon: 12.57, radius: 0.25, density: 190, coniferRatio: 0.5, name: 'Copenhagen' },
  { lat: 41.90, lon: 12.50, radius: 0.3, density: 150, coniferRatio: 0.15, name: 'Rome' },
  { lat: 40.42, lon: -3.70, radius: 0.35, density: 120, coniferRatio: 0.25, name: 'Madrid' },
  { lat: 41.39, lon: 2.17, radius: 0.25, density: 140, coniferRatio: 0.2, name: 'Barcelona' },

  // Asia
  { lat: 35.68, lon: 139.69, radius: 0.4, density: 200, coniferRatio: 0.35, name: 'Tokyo' },
  { lat: 37.57, lon: 126.98, radius: 0.3, density: 180, coniferRatio: 0.4, name: 'Seoul' },
  { lat: 31.23, lon: 121.47, radius: 0.4, density: 150, coniferRatio: 0.3, name: 'Shanghai' },
  { lat: 39.90, lon: 116.41, radius: 0.4, density: 130, coniferRatio: 0.35, name: 'Beijing' },
  { lat: 1.35, lon: 103.82, radius: 0.15, density: 400, coniferRatio: 0.05, name: 'Singapore' },
  { lat: 22.28, lon: 114.16, radius: 0.2, density: 180, coniferRatio: 0.1, name: 'Hong Kong' },
  { lat: 25.03, lon: 121.57, radius: 0.2, density: 160, coniferRatio: 0.25, name: 'Taipei' },

  // Oceania
  { lat: -33.87, lon: 151.21, radius: 0.35, density: 200, coniferRatio: 0.1, name: 'Sydney' },
  { lat: -37.81, lon: 144.96, radius: 0.35, density: 220, coniferRatio: 0.1, name: 'Melbourne' },
  { lat: -36.85, lon: 174.76, radius: 0.25, density: 180, coniferRatio: 0.15, name: 'Auckland' },

  // South America
  { lat: -23.55, lon: -46.63, radius: 0.4, density: 180, coniferRatio: 0.05, name: 'Sao Paulo' },
  { lat: -34.60, lon: -58.38, radius: 0.35, density: 150, coniferRatio: 0.1, name: 'Buenos Aires' },
  { lat: -33.45, lon: -70.67, radius: 0.3, density: 140, coniferRatio: 0.2, name: 'Santiago' },
];

/**
 * Generate tile data based on hotspots
 */
function generateTileData() {
  const tileData = new Map();
  const random = mulberry32(42); // Consistent seed

  for (const hotspot of TREE_HOTSPOTS) {
    // Generate tiles within the hotspot radius
    const minLat = hotspot.lat - hotspot.radius;
    const maxLat = hotspot.lat + hotspot.radius;
    const minLon = hotspot.lon - hotspot.radius;
    const maxLon = hotspot.lon + hotspot.radius;

    // Convert corners to tiles
    const minTile = latLonToTile(maxLat, minLon, ZOOM_LEVEL); // Note: y is inverted
    const maxTile = latLonToTile(minLat, maxLon, ZOOM_LEVEL);

    for (let y = minTile.y; y <= maxTile.y; y++) {
      for (let x = minTile.x; x <= maxTile.x; x++) {
        // Calculate distance from center (in tile space, approximate)
        const centerTile = latLonToTile(hotspot.lat, hotspot.lon, ZOOM_LEVEL);
        const dx = x - centerTile.x;
        const dy = y - centerTile.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Tiles within ~3 tile radius of center
        const maxTileRadius = hotspot.radius * (1 << ZOOM_LEVEL) / 180;
        if (dist > maxTileRadius) continue;

        // Density falls off with distance
        const falloff = 1 - (dist / maxTileRadius);
        const density = hotspot.density * falloff * falloff;

        // Add some randomness
        const count = Math.round(density * (0.5 + random() * 0.5));
        if (count < 1) continue;

        // Vary conifer ratio slightly
        const coniferRatio = Math.min(1, Math.max(0,
          hotspot.coniferRatio + (random() - 0.5) * 0.2
        ));

        const key = `${x},${y}`;
        if (tileData.has(key)) {
          const existing = tileData.get(key);
          existing.total += count;
          existing.conifers += Math.round(count * coniferRatio);
        } else {
          tileData.set(key, {
            total: count,
            conifers: Math.round(count * coniferRatio)
          });
        }
      }
    }
  }

  return tileData;
}

/**
 * Write binary output
 */
async function writeBinaryOutput(outputPath, tileData) {
  const tiles = Array.from(tileData.entries()).map(([key, data]) => {
    const [x, y] = key.split(',').map(Number);
    const coniferRatio = data.total > 0 ? data.conifers / data.total : 0.3;
    return { x, y, count: data.total, coniferRatio };
  });

  // Sort by y then x
  tiles.sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);

  const headerSize = 10;
  const tileSize = 7;
  const buffer = Buffer.alloc(headerSize + tiles.length * tileSize);
  let offset = 0;

  // Header
  buffer.write('TREE', offset); offset += 4;
  buffer.writeUInt8(2, offset); offset += 1; // Version
  buffer.writeUInt8(ZOOM_LEVEL, offset); offset += 1;
  buffer.writeUInt32LE(tiles.length, offset); offset += 4;

  // Tiles
  let totalTrees = 0;
  for (const tile of tiles) {
    buffer.writeUInt16LE(tile.x, offset); offset += 2;
    buffer.writeUInt16LE(tile.y, offset); offset += 2;
    buffer.writeUInt16LE(Math.min(tile.count, 65535), offset); offset += 2;
    buffer.writeUInt8(Math.round(tile.coniferRatio * 255), offset); offset += 1;
    totalTrees += tile.count;
  }

  await writeFile(outputPath, buffer);

  return { tileCount: tiles.length, totalTrees };
}

async function main() {
  const outputPath = join(__dirname, '..', 'public', 'tree-tiles.bin');

  console.log('='.repeat(60));
  console.log('Sample Tree Data Generator');
  console.log('='.repeat(60));
  console.log(`Output: ${outputPath}`);
  console.log(`Zoom level: ${ZOOM_LEVEL}`);
  console.log(`Hotspots: ${TREE_HOTSPOTS.length} cities`);
  console.log('');

  const tileData = generateTileData();
  const { tileCount, totalTrees } = await writeBinaryOutput(outputPath, tileData);

  console.log('Results:');
  console.log(`  Generated tiles: ${tileCount.toLocaleString()}`);
  console.log(`  Total trees: ${totalTrees.toLocaleString()}`);
  console.log(`  Average per tile: ${(totalTrees / tileCount).toFixed(1)}`);

  const stats = await import('fs/promises').then(fs => fs.stat(outputPath));
  console.log(`  File size: ${(stats.size / 1024).toFixed(2)} KB`);

  console.log('\nNote: This is sample data for development.');
  console.log('For production, use generate-tree-tiles.js with OSM PBF data.');
}

main().catch(console.error);
