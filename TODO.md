# Overture Flight Simulator - TODO

## Current Status

The flight simulator has evolved from the original MapLibre-based design to a full Three.js implementation with:
- Real 3D terrain rendering using Terrarium elevation tiles
- PMTiles-based building and road data from Overture Maps
- Mobile touch controls (virtual joystick)
- Multiplayer via PartyKit

---

## Remaining Tasks

### Networking & Server

- [x] Add validated, bounded messages and rate limiting protection on the PartyKit server
- [ ] Only send position updates if position actually changed
- [x] Add connection status UI for online, offline, and reconnecting states

### Collision Detection

- [x] Add indexed building collision detection using swept bounds
- [x] Suppress repeat building collisions after respawn until the plane is clear
- [x] Sweep between frames to prevent fast-moving planes tunnelling through buildings

### UI Improvements

- [ ] Add geocoding rate limiting for location search
- [x] Add coordinate validation and normalization for teleport locations
- [ ] Add "random location" button
- [ ] Add minimap showing nearby players
- [ ] Add player name labels above planes
- [ ] Add player name customization in settings

### Visual Enhancements

- [ ] Add contrails/trails behind planes
- [ ] Add speed blur effect at high speed
- [ ] Improve plane banking animation visibility

### Audio

- [ ] Add engine sound (varies with throttle)
- [ ] Add wind sound based on speed
- [ ] Add crash sound effect

### Settings Panel

- [ ] Add control sensitivity options
- [ ] Add graphics quality settings
- [ ] Add audio volume controls

### Deployment

- [x] Deploy PartyKit and configure its production host
- [x] Configure production `VITE_PARTYKIT_HOST` in the deployment workflow
- [x] Deploy the frontend to GitHub Pages from `main`
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
