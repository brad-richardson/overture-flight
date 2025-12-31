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

- [ ] Add rate limiting protection on PartyKit server
- [ ] Only send position updates if position actually changed
- [ ] Add connection error handling UI (show reconnecting status)

### Collision Detection

- [ ] Add building collision detection using Three.js raycasting
- [ ] Add brief invulnerability period after crash reset
- [ ] Add collision prediction for fast-moving planes

### UI Improvements

- [ ] Add geocoding rate limiting for location search
- [ ] Add coordinate validation for teleport locations
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

- [ ] Deploy PartyKit (`npx partykit deploy`)
- [ ] Configure production PartyKit URL via VITE_PARTYKIT_HOST
- [ ] Deploy frontend to Vercel/Netlify
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
