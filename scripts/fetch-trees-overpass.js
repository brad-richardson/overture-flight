#!/usr/bin/env node
/**
 * Fetch tree data from Overpass API and generate tile density file
 *
 * This script queries Overpass API for tree data in specified regions
 * and generates the same binary format as generate-tree-tiles.js.
 *
 * WARNING: Fetching the entire world via Overpass API is not practical.
 * Use this for specific regions or testing. For global data, use
 * generate-tree-tiles.js with the OSM planet file.
 *
 * Usage:
 *   node scripts/fetch-trees-overpass.js [options]
 *
 * Options:
 *   --region <name>     Predefined region (europe, usa, asia, etc.)
 *   --bbox <s,w,n,e>    Custom bounding box
 *   --output <file>     Output file (default: public/tree-tiles.bin)
 *   --append            Append to existing file instead of overwriting
 */

import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';

const ZOOM_LEVEL = 11;

// Predefined regions with bounding boxes [south, west, north, east]
const REGIONS = {
  // Small test regions
  'san-francisco': [37.7, -122.5, 37.85, -122.35],
  'london': [51.4, -0.3, 51.6, 0.1],
  'berlin': [52.4, 13.2, 52.6, 13.6],
  'tokyo': [35.5, 139.5, 35.8, 139.9],
  'new-york': [40.6, -74.1, 40.9, -73.8],

  // Larger regions (will be split into chunks)
  'germany': [47.2, 5.8, 55.1, 15.1],
  'france': [41.3, -5.2, 51.1, 9.6],
  'uk': [49.9, -8.2, 60.9, 1.8],
  'california': [32.5, -124.5, 42.0, -114.0],
  'northeast-usa': [38.0, -80.0, 45.0, -66.9],
};

// Overpass API endpoints (round-robin)
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

let endpointIndex = 0;

/**
 * Convert lat/lon to tile coordinates
 */
function latLonToTile(lat, lon, zoom) {
  const x = Math.floor((lon + 180) / 360 * (1 << zoom));
  const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * (1 << zoom));
  return {
    x: Math.max(0, Math.min(x, (1 << zoom) - 1)),
    y: Math.max(0, Math.min(y, (1 << zoom) - 1))
  };
}

/**
 * Check if a tree is a conifer
 */
function isConifer(tags) {
  if (!tags) return null;

  const leafType = tags.leaf_type;
  if (leafType === 'needleleaved') return true;
  if (leafType === 'broadleaved') return false;

  const genus = (tags.genus || '').toLowerCase();
  const coniferGenera = ['pinus', 'picea', 'abies', 'larix', 'cedrus', 'juniperus', 'thuja', 'cupressus'];
  if (coniferGenera.some(g => genus.includes(g))) return true;

  return null;
}

/**
 * Fetch trees from Overpass API for a bounding box
 */
async function fetchTrees(bbox, retries = 3) {
  const [south, west, north, east] = bbox;
  const query = `[out:json][timeout:180];node["natural"="tree"](${south},${west},${north},${east});out;`;

  for (let attempt = 0; attempt < retries; attempt++) {
    const endpoint = ENDPOINTS[endpointIndex];
    endpointIndex = (endpointIndex + 1) % ENDPOINTS.length;

    try {
      console.log(`  Fetching bbox [${south.toFixed(2)}, ${west.toFixed(2)}, ${north.toFixed(2)}, ${east.toFixed(2)}]...`);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      });

      if (response.status === 429 || response.status === 503) {
        console.log(`  Rate limited, waiting ${(attempt + 1) * 5}s...`);
        await sleep((attempt + 1) * 5000);
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      return data.elements || [];
    } catch (error) {
      console.log(`  Error: ${error.message}, retrying...`);
      await sleep(2000);
    }
  }

  console.log(`  Failed to fetch bbox after ${retries} attempts`);
  return [];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Split a large bounding box into smaller chunks
 */
function splitBbox(bbox, maxDegrees = 2) {
  const [south, west, north, east] = bbox;
  const chunks = [];

  for (let lat = south; lat < north; lat += maxDegrees) {
    for (let lon = west; lon < east; lon += maxDegrees) {
      chunks.push([
        lat,
        lon,
        Math.min(lat + maxDegrees, north),
        Math.min(lon + maxDegrees, east)
      ]);
    }
  }

  return chunks;
}

/**
 * Process trees and aggregate into tiles
 */
function aggregateTrees(trees, tileData) {
  let added = 0;

  for (const node of trees) {
    if (node.lat === undefined || node.lon === undefined) continue;

    const tile = latLonToTile(node.lat, node.lon, ZOOM_LEVEL);
    const key = `${tile.x},${tile.y}`;

    if (!tileData.has(key)) {
      tileData.set(key, { total: 0, conifers: 0, deciduous: 0 });
    }

    const data = tileData.get(key);
    data.total++;
    added++;

    const conifer = isConifer(node.tags);
    if (conifer === true) data.conifers++;
    else if (conifer === false) data.deciduous++;
  }

  return added;
}

/**
 * Write binary output
 */
async function writeBinaryOutput(outputPath, tileData) {
  const tiles = Array.from(tileData.entries()).map(([key, data]) => {
    const [x, y] = key.split(',').map(Number);
    const known = data.conifers + data.deciduous;
    const coniferRatio = known > 0 ? data.conifers / known : 0.3;
    return { x, y, count: data.total, coniferRatio };
  });

  tiles.sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);

  const headerSize = 10;
  const tileSize = 7;
  const buffer = Buffer.alloc(headerSize + tiles.length * tileSize);
  let offset = 0;

  buffer.write('TREE', offset); offset += 4;
  buffer.writeUInt8(2, offset); offset += 1;
  buffer.writeUInt8(ZOOM_LEVEL, offset); offset += 1;
  buffer.writeUInt32LE(tiles.length, offset); offset += 4;

  for (const tile of tiles) {
    buffer.writeUInt16LE(tile.x, offset); offset += 2;
    buffer.writeUInt16LE(tile.y, offset); offset += 2;
    buffer.writeUInt16LE(Math.min(tile.count, 65535), offset); offset += 2;
    buffer.writeUInt8(Math.round(tile.coniferRatio * 255), offset); offset += 1;
  }

  await writeFile(outputPath, buffer);
  return tiles.length;
}

/**
 * Read existing binary file
 */
async function readExistingData(filePath) {
  const tileData = new Map();

  if (!existsSync(filePath)) return tileData;

  try {
    const buffer = await readFile(filePath);
    if (buffer.toString('utf8', 0, 4) !== 'TREE') return tileData;

    const version = buffer.readUInt8(4);
    const zoom = buffer.readUInt8(5);

    if (zoom !== ZOOM_LEVEL) {
      console.log(`Warning: Existing file has zoom ${zoom}, expected ${ZOOM_LEVEL}`);
      return tileData;
    }

    let offset, count;
    if (version === 1) {
      count = buffer.readUInt16LE(6);
      offset = 8;
    } else {
      count = buffer.readUInt32LE(6);
      offset = 10;
    }

    for (let i = 0; i < count; i++) {
      const x = buffer.readUInt16LE(offset); offset += 2;
      const y = buffer.readUInt16LE(offset); offset += 2;
      const total = buffer.readUInt16LE(offset); offset += 2;
      const coniferRatio = buffer.readUInt8(offset) / 255; offset += 1;

      const conifers = Math.round(total * coniferRatio);
      tileData.set(`${x},${y}`, {
        total,
        conifers,
        deciduous: total - conifers
      });
    }

    console.log(`Loaded ${count} existing tiles from ${filePath}`);
  } catch (error) {
    console.log(`Could not read existing file: ${error.message}`);
  }

  return tileData;
}

async function main() {
  const args = process.argv.slice(2);
  let region = 'san-francisco';
  let customBbox = null;
  let outputPath = 'public/tree-tiles.bin';
  let append = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--region' && args[i + 1]) {
      region = args[++i];
    } else if (args[i] === '--bbox' && args[i + 1]) {
      customBbox = args[++i].split(',').map(Number);
    } else if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[++i];
    } else if (args[i] === '--append') {
      append = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node scripts/fetch-trees-overpass.js [options]

Options:
  --region <name>     Predefined region: ${Object.keys(REGIONS).join(', ')}
  --bbox <s,w,n,e>    Custom bounding box (south,west,north,east)
  --output <file>     Output file (default: public/tree-tiles.bin)
  --append            Append to existing file

Examples:
  node scripts/fetch-trees-overpass.js --region san-francisco
  node scripts/fetch-trees-overpass.js --bbox 37.7,-122.5,37.85,-122.35
  node scripts/fetch-trees-overpass.js --region germany --append
`);
      process.exit(0);
    }
  }

  const bbox = customBbox || REGIONS[region];
  if (!bbox) {
    console.error(`Unknown region: ${region}`);
    console.error(`Available: ${Object.keys(REGIONS).join(', ')}`);
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('Overpass Tree Fetcher');
  console.log('='.repeat(60));
  console.log(`Region: ${customBbox ? 'custom' : region}`);
  console.log(`Bbox: [${bbox.join(', ')}]`);
  console.log(`Output: ${outputPath}`);
  console.log('');

  // Load existing data if appending
  const tileData = append ? await readExistingData(outputPath) : new Map();

  // Split into chunks if needed
  const chunks = splitBbox(bbox, 1); // 1 degree chunks
  console.log(`Fetching ${chunks.length} chunks...`);

  let totalTrees = 0;
  for (let i = 0; i < chunks.length; i++) {
    const trees = await fetchTrees(chunks[i]);
    const added = aggregateTrees(trees, tileData);
    totalTrees += added;
    console.log(`  Chunk ${i + 1}/${chunks.length}: ${trees.length} trees`);

    // Rate limiting
    if (i < chunks.length - 1) {
      await sleep(1000);
    }
  }

  // Write output
  const tileCount = await writeBinaryOutput(outputPath, tileData);

  console.log('\n' + '='.repeat(60));
  console.log('Results:');
  console.log(`  Total trees: ${totalTrees.toLocaleString()}`);
  console.log(`  Tiles with trees: ${tileCount.toLocaleString()}`);
  console.log(`  Output: ${outputPath}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
