# Multiplayer 3D Flight Simulator - Implementation Plan

## Project Overview

Build a browser-based multiplayer flight simulator where players fly planes over 3D extruded buildings sourced from Overture Maps PMTiles. Players can see other planes in real-time but there's no physics interaction between them. Crashing into buildings or terrain resets the player to the sky. A location picker allows teleporting anywhere on the globe.

## Tech Stack

| Component              | Technology                                             | Rationale                                                                      |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **3D Map Rendering**   | MapLibre GL JS                                         | Native PMTiles support, fill-extrusion for 2.5D buildings, good camera control |
| **Building Data**      | Overture Maps Buildings PMTiles                        | Open data, includes height attributes, global coverage                         |
| **Multiplayer**        | PartyKit                                               | Simple WebSocket rooms, runs on Cloudflare edge, free tier sufficient          |
| **Frontend Framework** | Vanilla JS or lightweight (Preact optional)            | Keep bundle small, MapLibre is the heavy lifting                               |
| **Build Tool**         | Vite                                                   | Fast dev server, good for this scale                                           |
| **Deployment**         | Vercel/Netlify (frontend) + PartyKit managed (backend) | Simple, free tiers                                                             |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser Client                          │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   Game      │  │  MapLibre   │  │    PartyKit Client      │  │
│  │   Loop      │──│  GL JS      │  │    (PartySocket)        │  │
│  │  (60fps)    │  │  + PMTiles  │  │                         │  │
│  └──────┬──────┘  └──────┬──────┘  └────────────┬────────────┘  │
│         │                │                      │               │
│         ▼                ▼                      ▼               │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Local State                              ││
│  │  - myPlane: {lat, lng, alt, heading, pitch, roll, speed}   ││
│  │  - otherPlanes: Map<id, PlaneState>                        ││
│  │  - camera: {orbitAngle, orbitPitch, distance}              ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ WebSocket (position updates ~20Hz)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PartyKit Server (per room)                   │
├─────────────────────────────────────────────────────────────────┤
│  - Receives position updates from each client                   │
│  - Broadcasts all plane positions to all clients                │
│  - Handles join/leave (assigns plane colors/ids)                │
│  - No physics, no validation (trust clients)                    │
│  - Uses Hibernation for cost efficiency                         │
└─────────────────────────────────────────────────────────────────┘
```

## Data Structures

### PlaneState (shared between client and server)

```typescript
interface PlaneState {
  id: string;           // unique player id
  lat: number;          // latitude in degrees
  lng: number;          // longitude in degrees
  altitude: number;     // meters above sea level
  heading: number;      // compass heading 0-360
  pitch: number;        // nose up/down in degrees
  roll: number;         // bank angle in degrees
  speed: number;        // m/s (for display, not physics)
  color: string;        // assigned plane color
  name?: string;        // optional player name
}
```

### Network Messages

```typescript
// Client -> Server
type ClientMessage =
  | { type: 'position'; data: Omit<PlaneState, 'id' | 'color'> }
  | { type: 'join'; data: { name?: string } }
  | { type: 'teleport'; data: { lat: number; lng: number } }

// Server -> Client
type ServerMessage =
  | { type: 'sync'; planes: Record<string, PlaneState> }
  | { type: 'welcome'; id: string; color: string }
  | { type: 'playerJoined'; player: PlaneState }
  | { type: 'playerLeft'; id: string }
```

## File Structure

```
flight-sim/
├── package.json
├── vite.config.js
├── index.html
├── src/
│   ├── main.js                 # Entry point, initializes everything
│   ├── map.js                  # MapLibre setup, building layer, terrain
│   ├── plane.js                # Plane physics/controls, local state
│   ├── camera.js               # Third-person camera orbiting logic
│   ├── network.js              # PartyKit client connection
│   ├── ui.js                   # HUD, location picker, player list
│   ├── collision.js            # Building/terrain collision detection
│   ├── other-planes.js         # Rendering other players' planes
│   └── constants.js            # Tuning values, PMTiles URLs
├── party/
│   └── index.ts                # PartyKit server
├── partykit.json               # PartyKit config
└── public/
    └── plane.glb               # 3D plane model (optional, can use marker)
```

## Implementation Phases

### Phase 1: Static Map with 3D Buildings

**Goal:** Get MapLibre displaying Overture buildings as 3D extrusions.

**Tasks:**

1. Initialize Vite project with MapLibre GL JS dependency
2. Set up basic HTML with full-screen map container
3. Configure MapLibre with a base style (use MapTiler free tier or OSM style)
4. Add PMTiles protocol for Overture buildings:
   - Source: `pmtiles://https://overturemaps-tiles-us-west-2-beta.s3.amazonaws.com/2024-11-13/buildings.pmtiles` (or latest)
   - Check Overture docs for current PMTiles URL
5. Add fill-extrusion layer using building height:

   ```javascript
   map.addLayer({
     id: 'buildings-3d',
     type: 'fill-extrusion',
     source: 'overture-buildings',
     'source-layer': 'building',  // verify layer name from PMTiles
     paint: {
       'fill-extrusion-color': '#aaa',
       'fill-extrusion-height': ['coalesce', ['get', 'height'], 10],
       'fill-extrusion-base': 0,
       'fill-extrusion-opacity': 0.8
     }
   });
   ```

6. Enable 3D terrain if desired (MapTiler terrain source)
7. Set initial camera to a city with good building data (NYC, SF, London)

**Deliverable:** Map loads with 3D buildings visible when pitched.

### Phase 2: Player Plane & Flight Controls

**Goal:** Fly a plane around with keyboard controls, third-person camera follows.

**Tasks:**

1. Create plane state object: `{ lat, lng, altitude, heading, pitch, roll, speed }`
2. Implement keyboard input handler:
   - W/S or Up/Down: pitch nose up/down
   - A/D or Left/Right: roll/bank (which turns the plane)
   - Q/E: rudder/yaw (optional)
   - Shift/Ctrl: throttle up/down
3. Implement simple flight physics in game loop (requestAnimationFrame):
   - Speed affects how fast lat/lng change based on heading
   - Pitch affects altitude change
   - Roll affects heading change (banking turns)
   - Add gravity pull if speed too low (stall)
   - Clamp altitude to minimum (ground level) and maximum
4. Implement third-person camera:
   - Camera position = plane position offset by distance behind/above
   - Use map.jumpTo() or map.easeTo() each frame:

     ```javascript
     map.jumpTo({
       center: [plane.lng, plane.lat],
       zoom: altitudeToZoom(plane.altitude),
       bearing: plane.heading + cameraOrbitOffset,
       pitch: cameraPitch
     });
     ```

5. Add mouse drag to orbit camera around plane:
   - Horizontal drag changes `cameraOrbitOffset` (0-360)
   - Vertical drag changes `cameraPitch` (20-85)
   - Don't interfere with map's default drag (disable it)
6. Render plane marker at current position:
   - Simple: Use MapLibre Marker with rotated icon
   - Better: Use deck.gl ScenegraphLayer with GLTF plane model
   - Simplest for now: Just a colored triangle/arrow marker

**Deliverable:** Can fly around the map with WASD, camera follows and can be orbited.

### Phase 3: Collision Detection & Reset

**Goal:** Detect when plane hits buildings or ground, reset to sky.

**Tasks:**

1. Implement ground collision:
   - If `altitude < terrainElevationAt(lat, lng)`, crash
   - Use `map.queryTerrainElevation([lng, lat])` if terrain enabled
   - Otherwise assume sea level (0) or use a DEM lookup
2. Implement building collision:
   - Query buildings at plane position: `map.queryRenderedFeatures(point, { layers: ['buildings-3d'] })`
   - Check if any returned building has height > plane altitude
   - This is approximate but good enough for arcade feel
3. Implement crash/reset behavior:
   - On collision, show brief "CRASHED" message
   - Reset plane to: same lat/lng, altitude = 500m, speed = default, level flight
   - Optional: brief invulnerability period

**Deliverable:** Flying into buildings or ground resets the plane.

### Phase 4: Location Picker / Teleport

**Goal:** UI to search and teleport to any location on Earth.

**Tasks:**

1. Add a search box UI element (top corner, over the map)
2. Integrate a geocoding service:
   - MapTiler Geocoding API (free tier)
   - Or Nominatim (OSM, free, rate limited)
   - Or just use a simple dropdown of preset cities initially
3. On location select:
   - Teleport plane to new lat/lng
   - Set altitude to safe height (500m)
   - Reset heading to north, level flight
4. Add a "random location" button for fun
5. Optional: Click on map to teleport (with confirmation)

**Deliverable:** Can search for a city and teleport there.

### Phase 5: PartyKit Server Setup

**Goal:** Create the multiplayer server that syncs plane positions.

**Tasks:**

1. Initialize PartyKit in the project:

   ```bash
   npm install partykit partysocket
   npx partykit init
   ```

2. Create `party/index.ts`:

   ```typescript
   import type * as Party from "partykit/server";

   interface PlaneState {
     id: string;
     lat: number;
     lng: number;
     altitude: number;
     heading: number;
     pitch: number;
     roll: number;
     speed: number;
     color: string;
     name?: string;
   }

   const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];

   export default class FlightServer implements Party.Server {
     options: Party.ServerOptions = { hibernate: true };
     planes: Map<string, PlaneState> = new Map();

     constructor(readonly room: Party.Room) {}

     onConnect(conn: Party.Connection) {
       const color = COLORS[this.planes.size % COLORS.length];
       const id = conn.id;

       // Send welcome with assigned ID and color
       conn.send(JSON.stringify({
         type: 'welcome',
         id,
         color,
         planes: Object.fromEntries(this.planes)
       }));

       // Notify others
       this.room.broadcast(JSON.stringify({
         type: 'playerJoined',
         player: { id, color }
       }), [conn.id]);
     }

     onMessage(message: string, sender: Party.Connection) {
       const msg = JSON.parse(message);

       if (msg.type === 'position') {
         const existing = this.planes.get(sender.id);
         const plane: PlaneState = {
           ...msg.data,
           id: sender.id,
           color: existing?.color || '#888'
         };
         this.planes.set(sender.id, plane);

         // Broadcast to all other clients
         this.room.broadcast(JSON.stringify({
           type: 'sync',
           planes: Object.fromEntries(this.planes)
         }), [sender.id]);
       }
     }

     onClose(conn: Party.Connection) {
       this.planes.delete(conn.id);
       this.room.broadcast(JSON.stringify({
         type: 'playerLeft',
         id: conn.id
       }));
     }
   }
   ```

3. Configure `partykit.json`:

   ```json
   {
     "name": "flight-sim",
     "main": "party/index.ts"
   }
   ```

4. Test locally: `npx partykit dev`

**Deliverable:** PartyKit server runs locally and handles connections.

### Phase 6: Client Networking

**Goal:** Connect client to PartyKit, send position updates, receive other planes.

**Tasks:**

1. Create `src/network.js`:

   ```javascript
   import PartySocket from 'partysocket';

   export function createConnection(roomId, onSync, onWelcome, onPlayerLeft) {
     const socket = new PartySocket({
       host: PARTYKIT_HOST, // localhost:1999 in dev
       room: roomId
     });

     socket.addEventListener('message', (e) => {
       const msg = JSON.parse(e.data);
       if (msg.type === 'welcome') onWelcome(msg);
       if (msg.type === 'sync') onSync(msg.planes);
       if (msg.type === 'playerLeft') onPlayerLeft(msg.id);
     });

     return {
       sendPosition: (planeState) => {
         socket.send(JSON.stringify({ type: 'position', data: planeState }));
       },
       close: () => socket.close()
     };
   }
   ```

2. In main game loop, send position updates:
   - Throttle to ~20 updates per second (every 50ms)
   - Only send if position actually changed
3. Store received `otherPlanes` in local state
4. Room ID strategy:
   - Default room: `'global'` (everyone together)
   - Optional: room per region or let users create named rooms

**Deliverable:** Position updates flow to server and back to other clients.

### Phase 7: Rendering Other Planes

**Goal:** Display other players' planes on the map.

**Tasks:**

1. Maintain a `Map<id, Marker>` for other plane markers
2. On each `sync` message:
   - Update existing markers' positions/rotations
   - Create markers for new planes
   - Remove markers for planes no longer in sync
3. Marker rendering options (pick one):

   **Option A: MapLibre Markers (simplest)**

   ```javascript
   const marker = new maplibregl.Marker({
     element: createPlaneElement(color),
     rotation: heading
   })
   .setLngLat([lng, lat])
   .addTo(map);
   ```

   - Create a simple arrow/triangle SVG element
   - Update marker.setLngLat() and marker.setRotation() on sync
   - Doesn't show altitude visually

   **Option B: GeoJSON Layer with Symbols**

   - Store all planes as GeoJSON FeatureCollection
   - Use symbol layer with plane icon
   - Rotate icons based on heading property
   - Better performance for many planes

   **Option C: deck.gl ScenegraphLayer (fancy)**

   - Load a GLTF plane model
   - Position/rotate in true 3D
   - More complex setup but looks best

4. Add player name labels above planes (optional)
5. Interpolate other planes between updates for smooth motion:
   - Store last 2 positions with timestamps
   - Lerp between them based on current time

**Deliverable:** See other players flying around in real-time.

### Phase 8: Polish & UI

**Goal:** Make it feel like a game.

**Tasks:**

1. HUD elements:
   - Speed indicator
   - Altitude indicator
   - Heading/compass
   - Player count
   - Minimap (optional)
2. Player list panel showing connected players
3. Improve visual feedback:
   - Plane banking animation (roll reflected in marker)
   - Speed blur effect at high speed (CSS filter on map)
   - Contrails/trails behind planes (optional, LineString layer)
4. Sound effects (optional):
   - Engine sound that varies with throttle
   - Wind sound based on speed
   - Crash sound
5. Mobile support:
   - Touch controls (virtual joystick)
   - Responsive UI layout
6. Settings panel:
   - Control sensitivity
   - Graphics quality (building detail)
   - Name customization

**Deliverable:** Polished, playable game.

### Phase 9: Deployment

**Tasks:**

1. Deploy PartyKit:

   ```bash
   npx partykit deploy
   ```

   - Note the deployed URL (e.g., `flight-sim.username.partykit.dev`)

2. Update client to use production PartyKit URL
3. Build frontend: `npm run build`
4. Deploy to Vercel/Netlify:
   - Connect GitHub repo
   - Build command: `npm run build`
   - Output directory: `dist`
5. Test multiplayer across different networks
6. Set up custom domain (optional)

**Deliverable:** Live multiplayer game accessible via URL.

## Key Technical Notes

### PMTiles Building Source

The Overture Maps PMTiles URL and layer structure may change. Check:

- https://docs.overturemaps.org/guides/pmtiles/
- Verify the exact source-layer name by inspecting the PMTiles

### MapLibre Camera Limitations

- Max pitch is ~85 degrees (can't look straight down)
- This is fine for third-person follow camera
- If you need true free camera, would need Three.js

### Performance Considerations

- Limit building render distance with minzoom/maxzoom
- Use `fill-extrusion-ambient-occlusion` carefully (expensive)
- Throttle network updates, interpolate on client
- Consider level-of-detail: fewer buildings at distance

### Collision Detection Gotchas

- `queryRenderedFeatures` only returns visible features
- For off-screen collision, may need to sample building data differently
- Terrain elevation queries require terrain source enabled
- Collision can be approximate - it's an arcade game

### PartyKit Hibernation

- Server instance may be unloaded between messages
- Don't rely on in-memory state persisting
- For this use case it's fine - planes reconnect with fresh state
- Dramatically reduces costs

## Future Enhancements (Out of Scope for MVP)

- Different plane types with varying flight characteristics
- Objectives/missions (fly through rings, races)
- Voice chat (via WebRTC)
- Replay system
- Weather simulation
- Day/night cycle
- Landing on runways
- Aerial combat mode
