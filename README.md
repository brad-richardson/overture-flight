# Overture Flight Simulator

[![Play Now](https://img.shields.io/badge/Play%20Now-Live%20Demo-brightgreen?logo=github)](https://brad-richardson.github.io/overture-flight/)

A multiplayer 3D flight simulator built with Three.js using real-world building and terrain data from Overture Maps.

## Features

- **Real-world 3D buildings** - Extruded building geometry from Overture Maps PMTiles
- **Terrain rendering** - Land, water, and land use from Overture base layer
- **Multiplayer** - Real-time position sync via PartyKit WebSocket server
- **Flight physics** - Realistic pitch, roll, yaw controls with stall behavior
- **Chase camera** - Smooth third-person camera with orbit controls

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
├── main.ts              # Game loop and initialization
├── scene.ts             # Three.js scene, camera, renderer
├── plane.ts             # Flight physics and controls
├── camera.ts            # Chase camera logic
├── tile-manager.ts      # PMTiles loading and tile management
├── buildings.ts         # Building extrusion from Overture data
├── building-materials.ts # Procedural building materials
├── base-layer.ts        # Land/water polygons from Overture data
├── transportation-layer.ts # Roads rendering from Overture data
├── elevation.ts         # Terrain elevation from Terrarium tiles
├── collision.ts         # Ground/terrain collision detection
├── network.ts           # PartyKit WebSocket client
├── mobile-controls.ts   # Touch controls for mobile devices
├── ui.ts                # HUD and UI components
└── constants.ts         # Configuration values

party/
└── index.ts             # PartyKit multiplayer server
```

## Data Sources

- **Buildings**: Overture Maps buildings theme (PMTiles)
- **Terrain**: Overture Maps base theme - land, water, land use (PMTiles)

## Tech Stack

- [Three.js](https://threejs.org/) - 3D rendering
- [Vite](https://vitejs.dev/) - Build tool
- [PartyKit](https://partykit.io/) - Multiplayer infrastructure
- [PMTiles](https://protomaps.com/docs/pmtiles) - Cloud-optimized map tiles
- [Overture Maps](https://overturemaps.org/) - Open map data

## License

MIT
