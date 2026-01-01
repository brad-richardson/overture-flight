#!/usr/bin/env node
/**
 * Generate tree tile density data from OpenStreetMap PBF files
 *
 * This script processes OSM PBF files and extracts tree data (natural=tree nodes),
 * aggregating counts per z11 tile for use in procedural tree generation.
 *
 * Usage:
 *   node scripts/generate-tree-tiles.js <input.osm.pbf> [output.bin]
 *
 * Output format (binary):
 *   Header (8 bytes):
 *     - Magic: "TREE" (4 bytes)
 *     - Version: uint8 (1 byte)
 *     - Zoom level: uint8 (1 byte)
 *     - Tile count: uint16 LE (2 bytes)
 *
 *   Per tile (7 bytes each):
 *     - X coordinate: uint16 LE (2 bytes)
 *     - Y coordinate: uint16 LE (2 bytes)
 *     - Tree count: uint16 LE (2 bytes) - capped at 65535
 *     - Conifer ratio: uint8 (1 byte) - 0-255 maps to 0.0-1.0
 *
 * Download OSM data from:
 *   - Planet file: https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf
 *   - Regional extracts: https://download.geofabrik.de/
 */

import { createReadStream } from 'fs';
import { writeFile, stat } from 'fs/promises';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';

// Configuration
const ZOOM_LEVEL = 11;
const MAX_TILES = 2 ** ZOOM_LEVEL; // 2048 for z11

// Tile data structure
// Map<"x,y" => { total: number, conifers: number }>
const tileData = new Map();

// Stats
let totalTrees = 0;
let processedNodes = 0;

/**
 * Convert lat/lon to tile coordinates at given zoom level
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
 * Check if a tree is a conifer based on OSM tags
 */
function isConifer(tags) {
  if (!tags) return null; // Unknown

  // Check leaf_type tag
  const leafType = tags.leaf_type || tags['leaf_type'];
  if (leafType === 'needleleaved') return true;
  if (leafType === 'broadleaved') return false;

  // Check genus for common conifers
  const genus = (tags.genus || tags['genus'] || '').toLowerCase();
  const coniferGenera = [
    'pinus', 'picea', 'abies', 'larix', 'cedrus', 'juniperus',
    'thuja', 'cupressus', 'sequoia', 'taxus', 'tsuga', 'pseudotsuga',
    'cryptomeria', 'araucaria', 'metasequoia', 'chamaecyparis'
  ];
  if (coniferGenera.some(g => genus.includes(g))) return true;

  // Check species for common conifers
  const species = (tags.species || tags['species'] || tags.taxon || '').toLowerCase();
  if (coniferGenera.some(g => species.includes(g))) return true;

  return null; // Unknown
}

/**
 * Process a single OSM node
 */
function processNode(node) {
  processedNodes++;

  if (processedNodes % 10000000 === 0) {
    console.log(`  Processed ${(processedNodes / 1000000).toFixed(1)}M nodes, found ${totalTrees} trees in ${tileData.size} tiles...`);
  }

  // Check if this is a tree
  if (!node.tags || node.tags.natural !== 'tree') {
    return;
  }

  if (node.lat === undefined || node.lon === undefined) {
    return;
  }

  totalTrees++;

  // Get tile coordinates
  const tile = latLonToTile(node.lat, node.lon, ZOOM_LEVEL);
  const key = `${tile.x},${tile.y}`;

  // Update tile data
  if (!tileData.has(key)) {
    tileData.set(key, { total: 0, conifers: 0, deciduous: 0 });
  }

  const data = tileData.get(key);
  data.total++;

  const conifer = isConifer(node.tags);
  if (conifer === true) {
    data.conifers++;
  } else if (conifer === false) {
    data.deciduous++;
  }
}

/**
 * Parse OSM PBF format
 * PBF format: https://wiki.openstreetmap.org/wiki/PBF_Format
 */
async function parsePBF(inputPath) {
  // Dynamic import for optional dependency
  let osmpbf;
  try {
    osmpbf = await import('osm-pbf-parser');
  } catch (e) {
    console.error('Error: osm-pbf-parser not installed.');
    console.error('Run: npm install osm-pbf-parser');
    process.exit(1);
  }

  const through = (await import('through2')).default;

  console.log(`Parsing PBF file: ${inputPath}`);

  const fileStats = await stat(inputPath);
  console.log(`File size: ${(fileStats.size / 1024 / 1024 / 1024).toFixed(2)} GB`);

  return new Promise((resolve, reject) => {
    const parser = osmpbf.default ? osmpbf.default() : osmpbf();

    createReadStream(inputPath)
      .pipe(parser)
      .pipe(through.obj(function(items, enc, next) {
        for (const item of items) {
          if (item.type === 'node') {
            processNode(item);
          }
        }
        next();
      }))
      .on('finish', resolve)
      .on('error', reject);
  });
}

/**
 * Parse OSM XML format (for smaller files or testing)
 */
async function parseXML(inputPath) {
  const sax = await import('sax');
  const fs = await import('fs');

  console.log(`Parsing XML file: ${inputPath}`);

  return new Promise((resolve, reject) => {
    const parser = sax.createStream(true);
    let currentNode = null;

    parser.on('opentag', (tag) => {
      if (tag.name === 'node') {
        currentNode = {
          lat: parseFloat(tag.attributes.lat),
          lon: parseFloat(tag.attributes.lon),
          tags: {}
        };
      } else if (tag.name === 'tag' && currentNode) {
        currentNode.tags[tag.attributes.k] = tag.attributes.v;
      }
    });

    parser.on('closetag', (name) => {
      if (name === 'node' && currentNode) {
        processNode(currentNode);
        currentNode = null;
      }
    });

    parser.on('end', resolve);
    parser.on('error', reject);

    let stream = fs.createReadStream(inputPath);
    if (inputPath.endsWith('.gz')) {
      stream = stream.pipe(createGunzip());
    }
    stream.pipe(parser);
  });
}

/**
 * Write binary output file
 */
async function writeBinaryOutput(outputPath) {
  console.log(`\nWriting binary output to: ${outputPath}`);

  // Sort tiles by morton code for better compression potential
  const tiles = Array.from(tileData.entries()).map(([key, data]) => {
    const [x, y] = key.split(',').map(Number);
    // Calculate conifer ratio - if we have known types, use those; otherwise default to 0.3
    let coniferRatio;
    const known = data.conifers + data.deciduous;
    if (known > 0) {
      coniferRatio = data.conifers / known;
    } else {
      coniferRatio = 0.3; // Default assumption
    }
    return { x, y, count: data.total, coniferRatio };
  });

  // Sort by y then x for locality
  tiles.sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);

  // Calculate buffer size
  const headerSize = 8;
  const tileSize = 7;
  const bufferSize = headerSize + tiles.length * tileSize;

  const buffer = Buffer.alloc(bufferSize);
  let offset = 0;

  // Write header
  buffer.write('TREE', offset); offset += 4;           // Magic
  buffer.writeUInt8(1, offset); offset += 1;           // Version
  buffer.writeUInt8(ZOOM_LEVEL, offset); offset += 1;  // Zoom level
  buffer.writeUInt16LE(tiles.length, offset); offset += 2; // Tile count (might overflow for planet!)

  // For planet-scale data, we might have more than 65535 tiles
  // Let's use a 32-bit count instead
  // Rewrite with 32-bit count
  offset = 0;
  const bufferSizeV2 = 10 + tiles.length * tileSize;
  const bufferV2 = Buffer.alloc(bufferSizeV2);

  bufferV2.write('TREE', offset); offset += 4;           // Magic
  bufferV2.writeUInt8(2, offset); offset += 1;           // Version 2
  bufferV2.writeUInt8(ZOOM_LEVEL, offset); offset += 1;  // Zoom level
  bufferV2.writeUInt32LE(tiles.length, offset); offset += 4; // Tile count (32-bit)

  // Write tiles
  for (const tile of tiles) {
    bufferV2.writeUInt16LE(tile.x, offset); offset += 2;
    bufferV2.writeUInt16LE(tile.y, offset); offset += 2;
    bufferV2.writeUInt16LE(Math.min(tile.count, 65535), offset); offset += 2;
    bufferV2.writeUInt8(Math.round(tile.coniferRatio * 255), offset); offset += 1;
  }

  await writeFile(outputPath, bufferV2);

  console.log(`\nOutput statistics:`);
  console.log(`  Total trees: ${totalTrees.toLocaleString()}`);
  console.log(`  Tiles with trees: ${tiles.length.toLocaleString()}`);
  console.log(`  File size: ${(bufferV2.length / 1024).toFixed(2)} KB`);
  console.log(`  Average trees per tile: ${(totalTrees / tiles.length).toFixed(1)}`);

  // Print top 10 densest tiles
  const densest = [...tiles].sort((a, b) => b.count - a.count).slice(0, 10);
  console.log(`\n  Top 10 densest tiles:`);
  for (const t of densest) {
    console.log(`    z${ZOOM_LEVEL}/${t.x}/${t.y}: ${t.count} trees (${(t.coniferRatio * 100).toFixed(0)}% conifer)`);
  }
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log(`
Usage: node scripts/generate-tree-tiles.js <input> [output]

Arguments:
  input   - OSM data file (.osm.pbf, .osm, .osm.gz)
  output  - Output binary file (default: public/tree-tiles.bin)

Examples:
  # Process a regional extract
  node scripts/generate-tree-tiles.js germany-latest.osm.pbf

  # Process planet file
  node scripts/generate-tree-tiles.js planet-latest.osm.pbf public/tree-tiles.bin

Download OSM data from:
  - Planet: https://planet.openstreetmap.org/pbf/
  - Regions: https://download.geofabrik.de/
`);
    process.exit(1);
  }

  const inputPath = args[0];
  const outputPath = args[1] || 'public/tree-tiles.bin';

  console.log('='.repeat(60));
  console.log('OSM Tree Tile Generator');
  console.log('='.repeat(60));
  console.log(`Input: ${inputPath}`);
  console.log(`Output: ${outputPath}`);
  console.log(`Zoom level: ${ZOOM_LEVEL}`);
  console.log('');

  const startTime = Date.now();

  // Parse based on file extension
  if (inputPath.endsWith('.pbf')) {
    await parsePBF(inputPath);
  } else if (inputPath.endsWith('.osm') || inputPath.endsWith('.osm.gz')) {
    await parseXML(inputPath);
  } else {
    console.error(`Unsupported file format: ${inputPath}`);
    console.error('Supported formats: .osm.pbf, .osm, .osm.gz');
    process.exit(1);
  }

  // Write output
  await writeBinaryOutput(outputPath);

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\nCompleted in ${elapsed.toFixed(1)} seconds`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
