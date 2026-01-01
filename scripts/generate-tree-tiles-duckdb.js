#!/usr/bin/env node
/**
 * Generate tree tile density data from OpenStreetMap using DuckDB and S3
 *
 * This script queries the publicly available OSM data on AWS S3 (ORC format)
 * and generates the tree-tiles.bin file with tree density per z11 tile.
 *
 * OSM data source: s3://osm-pds/
 * Reference: https://aws.amazon.com/blogs/big-data/querying-openstreetmap-with-amazon-athena/
 *
 * Usage:
 *   node scripts/generate-tree-tiles-duckdb.js [output.bin]
 *
 * Prerequisites:
 *   npm install duckdb
 *
 * The script queries the planet_node table for nodes with natural=tree tag
 * and aggregates them by z11 tile.
 */

import { writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const ZOOM_LEVEL = 11;
const OSM_S3_BUCKET = 's3://osm-pds';

/**
 * Convert lat/lon to tile coordinates at given zoom level
 * Web Mercator is only valid for ~±85.05°, clamp to avoid NaN at poles
 */
function latLonToTile(lat, lon, zoom) {
  const clampedLat = Math.max(-85.051129, Math.min(85.051129, lat));
  const x = Math.floor((lon + 180) / 360 * (1 << zoom));
  const y = Math.floor((1 - Math.log(Math.tan(clampedLat * Math.PI / 180) + 1 / Math.cos(clampedLat * Math.PI / 180)) / Math.PI) / 2 * (1 << zoom));
  return {
    x: Math.max(0, Math.min(x, (1 << zoom) - 1)),
    y: Math.max(0, Math.min(y, (1 << zoom) - 1))
  };
}

/**
 * Write binary output file
 */
async function writeBinaryOutput(outputPath, tileData) {
  console.log(`\nWriting binary output to: ${outputPath}`);

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

  console.log(`\nOutput statistics:`);
  console.log(`  Total trees: ${totalTrees.toLocaleString()}`);
  console.log(`  Tiles with trees: ${tiles.length.toLocaleString()}`);
  console.log(`  File size: ${(buffer.length / 1024).toFixed(2)} KB`);
  console.log(`  Average trees per tile: ${(totalTrees / tiles.length).toFixed(1)}`);

  return { totalTrees, tileCount: tiles.length };
}

/**
 * Main entry point using DuckDB
 */
async function main() {
  const args = process.argv.slice(2);
  const outputPath = args[0] || join(__dirname, '..', 'public', 'tree-tiles.bin');

  console.log('='.repeat(60));
  console.log('OSM Tree Tile Generator (DuckDB + S3)');
  console.log('='.repeat(60));
  console.log(`Output: ${outputPath}`);
  console.log(`Zoom level: ${ZOOM_LEVEL}`);
  console.log(`Data source: ${OSM_S3_BUCKET}`);
  console.log('');

  // Dynamic import for duckdb
  let duckdb;
  try {
    duckdb = await import('duckdb');
  } catch (e) {
    console.error('Error: duckdb not installed.');
    console.error('Run: npm install duckdb');
    console.error('');
    console.error('Note: duckdb may require specific Node.js versions.');
    console.error('See: https://duckdb.org/docs/api/nodejs/overview');
    process.exit(1);
  }

  const db = new duckdb.default.Database(':memory:');
  const conn = db.connect();

  console.log('Configuring DuckDB for S3 access...');

  // Run queries as promises
  const query = (sql) => new Promise((resolve, reject) => {
    conn.all(sql, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });

  try {
    // Install and load required extensions
    await query("INSTALL httpfs;");
    await query("LOAD httpfs;");

    // Configure S3 access (osm-pds is a public bucket)
    await query("SET s3_region='us-east-1';");

    console.log('Querying OSM data on S3...');
    console.log('This may take a while for the full planet...\n');

    // The OSM PDS data structure:
    // - planet/planet-latest.osm.orc (the main data)
    // - planet_history/ (historical data)
    //
    // The ORC files have columns like:
    // - id, type, lat, lon, tags (map), nds (array), members (array), etc.
    //
    // We need to query for nodes where tags['natural'] = 'tree'

    const startTime = Date.now();

    // Query for tree nodes, grouped by z11 tile
    // Using DuckDB's built-in functions for tile calculation
    // Clamp latitude to ±85.051129 for valid Web Mercator projection
    const sql = `
      WITH tree_nodes AS (
        SELECT
          GREATEST(-85.051129, LEAST(85.051129, lat / 10000000.0)) as lat,
          lon / 10000000.0 as lon,
          tags['leaf_type'] as leaf_type,
          tags['genus'] as genus
        FROM read_orc('${OSM_S3_BUCKET}/planet/planet-latest.osm.orc')
        WHERE type = 'node'
          AND tags['natural'] = 'tree'
          AND lat IS NOT NULL
          AND lon IS NOT NULL
      ),
      tile_coords AS (
        SELECT
          CAST(FLOOR((lon + 180.0) / 360.0 * ${1 << ZOOM_LEVEL}) AS INTEGER) as tile_x,
          CAST(FLOOR((1.0 - LN(TAN(RADIANS(lat)) + 1.0/COS(RADIANS(lat))) / PI()) / 2.0 * ${1 << ZOOM_LEVEL}) AS INTEGER) as tile_y,
          CASE
            WHEN leaf_type = 'needleleaved' THEN 1
            WHEN leaf_type = 'broadleaved' THEN 0
            WHEN genus IN ('Pinus', 'Picea', 'Abies', 'Larix', 'Cedrus', 'Juniperus', 'Thuja', 'Cupressus', 'Sequoia', 'Taxus', 'Tsuga', 'Pseudotsuga', 'Cryptomeria', 'Araucaria', 'Metasequoia', 'Chamaecyparis') THEN 1
            ELSE NULL
          END as is_conifer
        FROM tree_nodes
      )
      SELECT
        tile_x,
        tile_y,
        COUNT(*) as tree_count,
        SUM(CASE WHEN is_conifer = 1 THEN 1 ELSE 0 END) as conifers,
        SUM(CASE WHEN is_conifer = 0 THEN 1 ELSE 0 END) as deciduous
      FROM tile_coords
      WHERE tile_x >= 0 AND tile_x < ${1 << ZOOM_LEVEL}
        AND tile_y >= 0 AND tile_y < ${1 << ZOOM_LEVEL}
      GROUP BY tile_x, tile_y
      ORDER BY tile_y, tile_x
    `;

    console.log('Executing query (this may take 10-30 minutes for full planet)...');
    const results = await query(sql);

    const elapsed = (Date.now() - startTime) / 1000;
    console.log(`Query completed in ${elapsed.toFixed(1)} seconds`);
    console.log(`Found ${results.length.toLocaleString()} tiles with trees`);

    // Convert results to tile data map
    const tileData = new Map();
    for (const row of results) {
      const key = `${row.tile_x},${row.tile_y}`;
      tileData.set(key, {
        total: Number(row.tree_count),
        conifers: Number(row.conifers || 0),
        deciduous: Number(row.deciduous || 0),
      });
    }

    // Write output
    await writeBinaryOutput(outputPath, tileData);

    console.log(`\nCompleted in ${((Date.now() - startTime) / 1000).toFixed(1)} seconds`);

  } catch (error) {
    console.error('Query failed:', error.message);
    console.error('');
    console.error('If the S3 query fails, try:');
    console.error('1. Check your internet connection');
    console.error('2. The OSM S3 data structure may have changed');
    console.error('3. Try using a regional extract instead');
    process.exit(1);
  } finally {
    conn.close();
    db.close();
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
