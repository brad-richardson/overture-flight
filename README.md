# Overture Flight Simulator

[![Play Now](https://img.shields.io/badge/Play%20Now-Live%20Demo-brightgreen?logo=github)](https://brad-richardson.github.io/overture-flight/)

A multiplayer 3D flight simulator built with Three.js using real-world building and terrain data from Overture Maps. Fly over cities worldwide with realistic physics, dynamic terrain, and real-time multiplayer.

## Features

### Core Flight Experience
- **Realistic flight physics** - Pitch, roll, yaw controls with stall behavior and throttle management
- **Chase camera** - Smooth third-person camera with orbit controls
- **Autopilot** - Engages after 30 seconds of inactivity, maintains safe altitude above terrain
- **Mobile support** - Virtual joystick and throttle controls for touch devices

### World Rendering
- **Real-world 3D buildings** - Extruded building geometry from Overture Maps with LOD (Level of Detail)
- **Terrain elevation** - Real elevation data from AWS Terrarium tiles with displacement mapping
- **Land & water** - Terrain polygons from Overture base layer
- **Road networks** - Transportation layer rendering from Overture data
- **Procedural trees** - Dynamically generated trees in forest and woodland areas
- **Atmospheric sky** - Sky dome with sun, clouds, and atmosphere

### Interactive Features
- **Feature picking** - Click on buildings to view property information
- **Location search** - Jump to any city worldwide via geocoding
- **Minimap** - MapLibre-powered minimap showing position and nearby players
- **Collision detection** - Crash into buildings or terrain triggers respawn

### Multiplayer
- **Real-time sync** - Position updates at 20Hz via PartyKit WebSocket
- **Player colors** - 8 distinct colors automatically assigned to players
- **Player list** - See all connected pilots in the UI

### Performance
- **WebGPU & WebGL** - Supports both renderers with optimized shaders
- **Worker threads** - Offload geometry generation and tile parsing to background threads
- **Dynamic resolution** - Automatic quality scaling based on FPS
- **Texture caching** - IndexedDB persistent cache for faster repeat visits
- **Predictive tile loading** - Prioritizes tiles based on heading and speed

## Controls

| Key | Action |
|-----|--------|
| W / Arrow Up | Pitch down (descend) |
| S / Arrow Down | Pitch up (climb) |
| A / Arrow Left | Roll left |
| D / Arrow Right | Roll right |
| Shift | Increase throttle |
| Ctrl | Decrease throttle |
| Mouse drag | Orbit camera |
| Scroll wheel | Zoom camera |
| Click | Inspect building/feature |

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
npm install
```

### Development

Start both the Vite dev server and PartyKit server:

```bash
npm run dev
```

This runs:
- Frontend: http://localhost:3000
- PartyKit: http://localhost:1999

### Production Build

```bash
npm run build
```

## Architecture

```
src/
├── main.ts                    # Game loop and initialization
├── scene.ts                   # Three.js scene, camera, renderer
├── plane.ts                   # Flight physics, controls, autopilot
├── camera.ts                  # Chase camera logic
├── tile-manager.ts            # PMTiles loading and tile management
├── buildings.ts               # Building extrusion with LOD
├── building-materials.ts      # Procedural building materials
├── base-layer.ts              # Land/water polygons
├── transportation-layer.ts    # Roads rendering
├── tree-layer.ts              # Procedural tree generation
├── elevation.ts               # Terrain elevation from Terrarium tiles
├── collision.ts               # Ground/building collision detection
├── sky.ts                     # Sky dome and atmosphere
├── network.ts                 # PartyKit WebSocket client
├── interpolation.ts           # Smooth multiplayer movement
├── minimap.ts                 # MapLibre-based minimap
├── feature-picker.ts          # Click detection on 3D features
├── feature-modal.ts           # Property display UI
├── mobile-controls.ts         # Touch controls for mobile
├── ui.ts                      # HUD, search, player list
├── constants.ts               # Configuration values
│
├── ground-texture/            # Texture-based ground rendering
│   ├── ground-layer.ts        # Core tile texture rendering
│   ├── expanded-ground-layer.ts # Outer ring terrain tiles
│   ├── terrain-quad.ts        # Mesh with terrain displacement
│   ├── terrain-shader.ts      # WebGL terrain shader
│   ├── terrain-shader-tsl.ts  # WebGPU TSL shader nodes
│   └── tile-texture-cache.ts  # LRU texture cache
│
├── workers/                   # Web worker thread pool
│   ├── geometry.worker.ts     # Base layer geometry
│   ├── building-geometry.worker.ts # Building extrusion
│   ├── mvt-parse.worker.ts    # Vector tile parsing
│   ├── elevation.worker.ts    # Elevation decoding
│   ├── tree-processing.worker.ts # Tree generation
│   └── full-pipeline.worker.ts # Combined fetch+parse+render
│
├── cache/                     # Caching utilities
│   └── indexed-db-texture-cache.ts
│
└── renderer/                  # Renderer utilities
    └── renderer-factory.ts    # WebGL/WebGPU creation

party/
└── index.ts                   # PartyKit multiplayer server
```

## Data Sources

- **Buildings**: Overture Maps buildings theme (PMTiles)
- **Terrain**: Overture Maps base theme - land, water, land use (PMTiles)
- **Elevation**: AWS Terrain Tiles (Mapzen Terrarium format)
- **Transportation**: Overture Maps transportation theme (PMTiles)
- **Trees**: OSM-derived tree density data

See [ATTRIBUTION.md](ATTRIBUTION.md) for complete attribution and licensing information.

## Tech Stack

- [Three.js](https://threejs.org/) - 3D rendering (WebGL & WebGPU)
- [Vite](https://vitejs.dev/) - Build tool
- [TypeScript](https://www.typescriptlang.org/) - Type-safe JavaScript
- [PartyKit](https://partykit.io/) - Multiplayer infrastructure
- [PMTiles](https://protomaps.com/docs/pmtiles) - Cloud-optimized map tiles
- [Overture Maps](https://overturemaps.org/) - Open map data
- [MapLibre GL](https://maplibre.org/) - Minimap rendering

## Configuration

Key environment variables:

| Variable | Description |
|----------|-------------|
| `VITE_PMTILES_URL` | Buildings PMTiles source |
| `VITE_BASE_PMTILES_URL` | Base layer PMTiles source |
| `VITE_TRANSPORTATION_PMTILES_URL` | Roads PMTiles source |
| `VITE_PARTYKIT_HOST` | Multiplayer server host |
| `VITE_PROFILING` | Enable performance profiling |

## License

MIT
