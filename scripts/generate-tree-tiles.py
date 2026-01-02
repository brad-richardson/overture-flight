#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "osmium>=4.0.0",
# ]
# ///
"""
Generate tree tile density data from OpenStreetMap PBF files.

This script processes OSM PBF files using pyosmium (fast C++ bindings)
and generates a tree-tiles.bin file with tree density per z11 tile.

Usage:
    uv run scripts/generate-tree-tiles.py <input.osm.pbf> [output.bin]

    # Example with planet file:
    uv run scripts/generate-tree-tiles.py ~/Downloads/planet-latest.osm.pbf

Download OSM data from:
    - Planet: https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf
    - Regions: https://download.geofabrik.de/
"""

import math
import struct
import sys
import time
from pathlib import Path

import osmium

# Unbuffered output for progress visibility
sys.stdout.reconfigure(line_buffering=True)

# Configuration
ZOOM_LEVEL = 14
DEFAULT_OUTPUT = Path(__file__).parent.parent / "public" / "tree-tiles.bin"

# Conifer genera for classification (lowercase for comparison)
CONIFER_GENERA = {
    "pinus", "picea", "abies", "larix", "cedrus", "juniperus",
    "thuja", "cupressus", "sequoia", "taxus", "tsuga", "pseudotsuga",
    "cryptomeria", "araucaria", "metasequoia", "chamaecyparis"
}


def lat_lon_to_tile(lat: float, lon: float, zoom: int) -> tuple[int, int]:
    """Convert lat/lon to tile coordinates at given zoom level."""
    # Clamp latitude to valid Web Mercator range
    lat = max(-85.051129, min(85.051129, lat))
    n = 1 << zoom
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.log(math.tan(math.radians(lat)) + 1.0 / math.cos(math.radians(lat))) / math.pi) / 2.0 * n)
    return (max(0, min(x, n - 1)), max(0, min(y, n - 1)))


def is_conifer(tags) -> bool | None:
    """Check if a tree is a conifer based on OSM tags. Returns None if unknown."""
    leaf_type = tags.get("leaf_type", "")
    if leaf_type == "needleleaved":
        return True
    if leaf_type == "broadleaved":
        return False

    genus = tags.get("genus", "").lower()
    if genus and any(g in genus for g in CONIFER_GENERA):
        return True

    species = tags.get("species", tags.get("taxon", "")).lower()
    if species and any(g in species for g in CONIFER_GENERA):
        return True

    return None


class TreeHandler(osmium.SimpleHandler):
    """Handler that processes tree nodes and accumulates tile counts."""

    def __init__(self):
        super().__init__()
        self.tile_counts: dict[tuple[int, int], dict] = {}
        self.total_trees = 0
        self.processed_nodes = 0
        self.start_time = time.time()
        self.last_report = 0

    def node(self, n):
        self.processed_nodes += 1

        # Progress report every 10M nodes
        if self.processed_nodes - self.last_report >= 10_000_000:
            self.last_report = self.processed_nodes
            elapsed = time.time() - self.start_time
            print(f"  Processed {self.processed_nodes // 1_000_000}M nodes, "
                  f"found {self.total_trees:,} trees in {len(self.tile_counts):,} tiles ({elapsed:.0f}s)")

        # Check if this is a tree
        if n.tags.get("natural") != "tree":
            return

        if not n.location.valid():
            return

        self.total_trees += 1

        # Get tile coordinates
        tile = lat_lon_to_tile(n.location.lat, n.location.lon, ZOOM_LEVEL)

        # Update tile data
        if tile not in self.tile_counts:
            self.tile_counts[tile] = {"total": 0, "conifers": 0, "deciduous": 0}

        data = self.tile_counts[tile]
        data["total"] += 1

        conifer = is_conifer(n.tags)
        if conifer is True:
            data["conifers"] += 1
        elif conifer is False:
            data["deciduous"] += 1


def write_binary_output(output_path: Path, tile_counts: dict) -> None:
    """Write binary output file in the tree-tiles.bin format."""
    print(f"\nWriting binary output to: {output_path}")

    # Convert to list and calculate conifer ratios
    tiles = []
    for (tile_x, tile_y), data in tile_counts.items():
        known = data["conifers"] + data["deciduous"]
        conifer_ratio = data["conifers"] / known if known > 0 else 0.3
        tiles.append({
            "tile_x": tile_x,
            "tile_y": tile_y,
            "tree_count": data["total"],
            "conifer_ratio": conifer_ratio,
        })

    # Sort by y then x for locality
    tiles.sort(key=lambda t: (t["tile_y"], t["tile_x"]))

    # Binary format:
    # Header (10 bytes): "TREE" + version (1) + zoom (1) + tile_count (4)
    # Per tile (7 bytes): x (2) + y (2) + count (2) + conifer_ratio (1)
    header_size = 10
    tile_size = 7
    buffer = bytearray(header_size + len(tiles) * tile_size)

    # Write header
    offset = 0
    buffer[0:4] = b"TREE"
    offset += 4
    buffer[offset] = 2  # Version
    offset += 1
    buffer[offset] = ZOOM_LEVEL
    offset += 1
    struct.pack_into("<I", buffer, offset, len(tiles))
    offset += 4

    # Write tiles
    total_trees = 0
    for tile in tiles:
        struct.pack_into("<H", buffer, offset, tile["tile_x"])
        offset += 2
        struct.pack_into("<H", buffer, offset, tile["tile_y"])
        offset += 2
        count = min(tile["tree_count"], 65535)
        struct.pack_into("<H", buffer, offset, count)
        offset += 2
        buffer[offset] = round(tile["conifer_ratio"] * 255)
        offset += 1
        total_trees += tile["tree_count"]

    output_path.write_bytes(buffer)

    print(f"\nOutput statistics:")
    print(f"  Total trees: {total_trees:,}")
    print(f"  Tiles with trees: {len(tiles):,}")
    print(f"  File size: {len(buffer) / 1024:.2f} KB")
    if tiles:
        print(f"  Average trees per tile: {total_trees / len(tiles):.1f}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        print("Error: Input PBF file required")
        print("\nExample:")
        print("  uv run scripts/generate-tree-tiles.py ~/Downloads/planet-latest.osm.pbf")
        sys.exit(1)

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUTPUT

    if not input_path.exists():
        print(f"Error: Input file not found: {input_path}")
        sys.exit(1)

    print("=" * 60)
    print("OSM Tree Tile Generator (pyosmium)")
    print("=" * 60)
    print(f"Input: {input_path}")
    print(f"Output: {output_path}")
    print(f"Zoom level: {ZOOM_LEVEL}")
    file_size_gb = input_path.stat().st_size / (1024**3)
    print(f"File size: {file_size_gb:.2f} GB")
    print()

    start_time = time.time()

    # Process PBF file
    print("Processing PBF file...")
    handler = TreeHandler()
    handler.apply_file(str(input_path), locations=True)

    elapsed = time.time() - start_time
    print(f"\nProcessing completed in {elapsed:.1f} seconds")
    print(f"Processed {handler.processed_nodes:,} nodes")
    print(f"Found {handler.total_trees:,} trees in {len(handler.tile_counts):,} tiles")

    # Write output
    write_binary_output(output_path, handler.tile_counts)

    total_elapsed = time.time() - start_time
    print(f"\nCompleted in {total_elapsed:.1f} seconds")


if __name__ == "__main__":
    main()
