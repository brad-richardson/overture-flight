# Multiplayer 3D Flight Simulator - TODO

## Phase 0: Scaffolding Fixes

Critical issues found in existing code that need addressing before continuing.

### Critical (Must Fix)

- [x] **constants.js**: Update PartyKit production URL from placeholder `flight-sim.your-username.partykit.dev`
- [x] **constants.js**: Consider PMTiles URL versioning strategy (currently hardcoded to `2024-11-13`)
- [x] **map.js**: Add terrain source for elevation queries (currently returns 0/null)
- [x] **map.js**: Verify `source-layer: 'building'` matches actual PMTiles layer name
- [x] **network.js**: Fix `WebSocket.OPEN` reference (not available in ES module context)
- [x] **party/index.ts**: Add input validation for position data (lat/lng ranges, altitude limits)
- [x] **party/index.ts**: Don't broadcast sync back to sender (wastes bandwidth)

### Important (Should Fix)

- [x] **vite.config.js**: Reconcile GitHub Pages base path with Vercel/Netlify deployment plan
- [x] **network.js**: Add reconnection logic for dropped connections
- [ ] **main.js**: Add error handling for network connection failures
- [x] **other-planes.js**: Implement position interpolation for smooth motion
- [ ] **ui.js**: Add proper User-Agent header for Nominatim API compliance
- [ ] **ui.js**: Add rate limiting on geocoding search requests

### Minor (Nice to Have)

- [ ] **collision.js**: Handle off-screen building collisions (queryRenderedFeatures limitation)
- [ ] **collision.js**: Add collision prediction for fast-moving planes
- [ ] **plane.js**: Make pitch/roll damping values configurable
- [ ] **plane.js**: Add maximum turn rate limiter
- [ ] **camera.js**: Add smoothing/acceleration to camera orbit
- [ ] **other-planes.js**: Add player name labels above markers
- [ ] **ui.js**: Add coordinate validation for teleport locations

---

## Phase 1: Static Map with 3D Buildings

**Goal:** Get MapLibre displaying Overture buildings as 3D extrusions.

**Status:** ~90% Complete

- [x] Initialize Vite project with MapLibre GL JS dependency
- [x] Set up basic HTML with full-screen map container
- [x] Configure MapLibre with base style
- [x] Add PMTiles protocol for Overture buildings
- [x] Add fill-extrusion layer using building height
- [x] Enable 3D terrain (MapTiler terrain source) - via VITE_MAPTILER_KEY env var
- [x] Set initial camera to NYC

---

## Phase 2: Player Plane & Flight Controls

**Goal:** Fly a plane around with keyboard controls, third-person camera follows.

**Status:** ~95% Complete

- [x] Create plane state object (lat, lng, altitude, heading, pitch, roll, speed)
- [x] Implement keyboard input handler (WASD, Shift/Ctrl)
- [x] Implement flight physics in game loop
  - [x] Speed affects position change
  - [x] Pitch affects altitude
  - [x] Roll affects heading (banking turns)
  - [x] Gravity/stall behavior
  - [x] Clamp altitude to min/max
- [x] Implement third-person camera
- [x] Add mouse drag to orbit camera around plane
- [x] Render plane marker at current position

---

## Phase 3: Collision Detection & Reset

**Goal:** Detect when plane hits buildings or ground, reset to sky.

**Status:** ~70% Complete

- [x] Implement ground collision check
- [x] Implement building collision (queryRenderedFeatures)
- [x] Implement crash/reset behavior
- [x] Show "CRASHED" message on collision
- [ ] Fix terrain elevation queries (requires terrain source)
- [ ] Handle collision for off-screen buildings
- [ ] Add brief invulnerability period after reset

---

## Phase 4: Location Picker / Teleport

**Goal:** UI to search and teleport to any location on Earth.

**Status:** ~85% Complete

- [x] Add search box UI element
- [x] Integrate Nominatim geocoding
- [x] Add preset city locations dropdown
- [x] On location select: teleport plane, reset altitude, level flight
- [ ] Add coordinate validation
- [ ] Add geocoding rate limiting
- [ ] Add proper User-Agent for Nominatim
- [ ] Add "random location" button

---

## Phase 5: PartyKit Server Setup

**Goal:** Create the multiplayer server that syncs plane positions.

**Status:** ~90% Complete

- [x] Initialize PartyKit in project
- [x] Create party/index.ts with FlightServer
- [x] Handle onConnect (assign colors, send welcome)
- [x] Handle onMessage (position updates)
- [x] Handle onClose (cleanup, broadcast playerLeft)
- [x] Configure partykit.json
- [ ] Add position data validation
- [ ] Optimize: don't broadcast to sender
- [ ] Add rate limiting protection

---

## Phase 6: Client Networking

**Goal:** Connect client to PartyKit, send/receive plane updates.

**Status:** ~85% Complete

- [x] Create network.js with PartySocket connection
- [x] Handle welcome, sync, playerLeft messages
- [x] Throttle position updates to 20Hz
- [x] Implement sendPosition and sendTeleport
- [ ] Fix WebSocket.OPEN reference
- [ ] Add reconnection logic
- [ ] Add connection error handling
- [ ] Only send if position changed

---

## Phase 7: Rendering Other Planes

**Goal:** Display other players' planes on the map.

**Status:** ~70% Complete

- [x] Create SVG plane marker elements
- [x] Maintain Map of other plane markers
- [x] Update marker positions on sync
- [x] Remove markers on playerLeft
- [ ] Interpolate positions between updates
- [ ] Add player name labels
- [ ] Show altitude visually (marker size or shadow)

---

## Phase 8: Polish & UI

**Goal:** Make it feel like a game.

**Status:** ~40% Complete

### HUD Elements
- [x] Speed indicator
- [x] Altitude indicator
- [x] Heading/compass
- [x] Player count
- [ ] Minimap

### Player List
- [x] Show connected players
- [x] Show player colors
- [ ] Show player names

### Visual Feedback
- [ ] Plane banking animation (roll in marker)
- [ ] Speed blur effect at high speed
- [ ] Contrails/trails behind planes

### Sound Effects
- [ ] Engine sound (varies with throttle)
- [ ] Wind sound based on speed
- [ ] Crash sound

### Mobile Support
- [ ] Touch controls (virtual joystick)
- [ ] Responsive UI layout

### Settings Panel
- [ ] Control sensitivity
- [ ] Graphics quality
- [ ] Name customization

---

## Phase 9: Deployment

**Goal:** Deploy live multiplayer game.

**Status:** Not Started

- [ ] Deploy PartyKit (`npx partykit deploy`)
- [ ] Update client with production PartyKit URL
- [ ] Build frontend (`npm run build`)
- [ ] Deploy to Vercel/Netlify
- [ ] Test multiplayer across different networks
- [ ] Set up custom domain (optional)

---

## Future Enhancements (Out of Scope for MVP)

- [ ] Different plane types with varying characteristics
- [ ] Objectives/missions (fly through rings, races)
- [ ] Voice chat (WebRTC)
- [ ] Replay system
- [ ] Weather simulation
- [ ] Day/night cycle
- [ ] Landing on runways
- [ ] Aerial combat mode
