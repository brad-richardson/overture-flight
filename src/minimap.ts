import maplibregl from 'maplibre-gl';
import { LOCATIONS } from './constants.js';
import type { PlaneState } from './plane.js';

// Minimap state
let map: maplibregl.Map | null = null;
let planeMarker: maplibregl.Marker | null = null;
let targetMarker: maplibregl.Marker | null = null;
let isFollowing = true;
let isOpen = false;
let onTeleportCallback: ((lat: number, lng: number) => void) | null = null;
let currentPlaneState: PlaneState | null = null;

// DOM elements
let modal: HTMLElement | null = null;
let lockBtn: HTMLElement | null = null;
let coordsDisplay: HTMLElement | null = null;

/**
 * Create plane marker element
 */
function createPlaneMarkerElement(heading: number = 0): HTMLElement {
  const el = document.createElement('div');
  el.className = 'minimap-plane-marker';
  el.style.transform = `rotate(${heading}deg)`;
  return el;
}

/**
 * Create target marker element
 */
function createTargetMarkerElement(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'minimap-target-marker';
  return el;
}

/**
 * Update lock button appearance
 */
function updateLockButton(): void {
  if (!lockBtn) return;

  const span = lockBtn.querySelector('span');
  const svg = lockBtn.querySelector('svg');

  if (isFollowing) {
    lockBtn.classList.remove('unlocked');
    if (span) span.textContent = 'Following';
    if (svg) {
      svg.innerHTML = '<path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>';
    }
  } else {
    lockBtn.classList.add('unlocked');
    if (span) span.textContent = 'Unlocked';
    if (svg) {
      svg.innerHTML = '<path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/>';
    }
  }
}

/**
 * Update coordinates display
 */
function updateCoordsDisplay(lng: number, lat: number): void {
  if (!coordsDisplay) return;
  coordsDisplay.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/**
 * Perform geocoding search
 */
async function searchLocation(query: string): Promise<void> {
  if (!query.trim() || !map) return;

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`,
      {
        headers: {
          'User-Agent': 'FlightSimulator/1.0 (https://github.com/overture-flight)',
        },
      }
    );
    const results = await response.json() as Array<{ lat: string; lon: string }>;

    if (results.length > 0) {
      const { lat, lon } = results[0];
      const latNum = parseFloat(lat);
      const lngNum = parseFloat(lon);

      // Fly to location on minimap
      map.flyTo({
        center: [lngNum, latNum],
        zoom: 14,
        duration: 1000
      });

      // Unlock from plane tracking
      isFollowing = false;
      updateLockButton();

      // Show target marker
      showTargetMarker(lngNum, latNum);

      // Update coords
      updateCoordsDisplay(lngNum, latNum);
    } else {
      alert('Location not found');
    }
  } catch (e) {
    console.error('Geocoding failed:', e);
    alert('Search failed. Please try again.');
  }
}

/**
 * Show target marker at a location
 */
function showTargetMarker(lng: number, lat: number): void {
  if (!map) return;

  // Remove existing target marker
  if (targetMarker) {
    targetMarker.remove();
  }

  // Create new target marker
  targetMarker = new maplibregl.Marker({
    element: createTargetMarkerElement(),
    anchor: 'center'
  })
    .setLngLat([lng, lat])
    .addTo(map);
}

/**
 * Hide target marker
 */
function hideTargetMarker(): void {
  if (targetMarker) {
    targetMarker.remove();
    targetMarker = null;
  }
}

/**
 * Handle map click for teleportation
 */
function handleMapClick(e: maplibregl.MapMouseEvent): void {
  if (!onTeleportCallback) return;

  const { lng, lat } = e.lngLat;

  // Show target marker
  showTargetMarker(lng, lat);

  // Update coords
  updateCoordsDisplay(lng, lat);

  // Teleport after short delay for visual feedback
  setTimeout(() => {
    if (onTeleportCallback) {
      onTeleportCallback(lat, lng);
    }
    // Close modal after teleport
    closeModal();
  }, 300);
}

/**
 * Open the minimap modal
 */
function openModal(): void {
  if (!modal || !map) return;

  isOpen = true;
  modal.classList.add('active');

  // Reset to following mode when opening
  isFollowing = true;
  updateLockButton();
  hideTargetMarker();

  // Resize map to fit container
  setTimeout(() => {
    if (map) {
      map.resize();

      // Center on plane if we have state
      if (currentPlaneState) {
        map.setCenter([currentPlaneState.lng, currentPlaneState.lat]);
      }
    }
  }, 100);
}

/**
 * Close the minimap modal
 */
function closeModal(): void {
  if (!modal) return;

  isOpen = false;
  modal.classList.remove('active');
  hideTargetMarker();
}

/**
 * Initialize the minimap modal
 */
export function initMinimap(onTeleport: (lat: number, lng: number) => void): void {
  onTeleportCallback = onTeleport;

  // Get DOM elements
  modal = document.getElementById('minimap-modal');
  const globeBtn = document.getElementById('globe-btn');
  const closeBtn = document.getElementById('minimap-close-btn');
  lockBtn = document.getElementById('minimap-lock-btn');
  const mapContainer = document.getElementById('minimap-map');
  const searchInput = document.getElementById('minimap-search') as HTMLInputElement | null;
  const searchBtn = document.getElementById('minimap-search-btn');
  const locationsSelect = document.getElementById('minimap-locations') as HTMLSelectElement | null;
  coordsDisplay = document.getElementById('minimap-coords');

  if (!modal || !globeBtn || !mapContainer) {
    console.warn('Minimap elements not found');
    return;
  }

  // Initialize MapLibre GL map
  map = new maplibregl.Map({
    container: mapContainer,
    style: {
      version: 8,
      sources: {
        'osm': {
          type: 'raster',
          tiles: [
            'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
            'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
            'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'
          ],
          tileSize: 256,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }
      },
      layers: [
        {
          id: 'osm-tiles',
          type: 'raster',
          source: 'osm',
          minzoom: 0,
          maxzoom: 19
        }
      ]
    },
    center: [0, 0],
    zoom: 12,
    attributionControl: false
  });

  // Add navigation controls
  map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

  // Add attribution
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');

  // Create plane marker
  planeMarker = new maplibregl.Marker({
    element: createPlaneMarkerElement(),
    anchor: 'center',
    rotationAlignment: 'map'
  })
    .setLngLat([0, 0])
    .addTo(map);

  // Handle map click
  map.on('click', handleMapClick);

  // Detect when user pans the map (unlock from following)
  map.on('dragstart', () => {
    if (isFollowing) {
      isFollowing = false;
      updateLockButton();
    }
  });

  // Globe button opens modal
  globeBtn.addEventListener('click', openModal);

  // Close button
  if (closeBtn) {
    closeBtn.addEventListener('click', closeModal);
  }

  // Click outside to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });

  // Escape key to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) {
      closeModal();
    }
  });

  // Lock/unlock button
  if (lockBtn) {
    lockBtn.addEventListener('click', () => {
      isFollowing = !isFollowing;
      updateLockButton();

      if (isFollowing && currentPlaneState && map) {
        hideTargetMarker();
        map.flyTo({
          center: [currentPlaneState.lng, currentPlaneState.lat],
          duration: 500
        });
      }
    });
  }

  // Search functionality
  if (searchInput && searchBtn) {
    searchBtn.addEventListener('click', () => {
      searchLocation(searchInput.value);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        searchLocation(searchInput.value);
      }
    });
  }

  // Populate quick locations dropdown
  if (locationsSelect) {
    for (const [key, loc] of Object.entries(LOCATIONS)) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = loc.name;
      locationsSelect.appendChild(option);
    }

    locationsSelect.addEventListener('change', (e) => {
      const key = (e.target as HTMLSelectElement).value;
      if (key && LOCATIONS[key] && map) {
        const loc = LOCATIONS[key];

        // Fly to location
        map.flyTo({
          center: [loc.lng, loc.lat],
          zoom: 14,
          duration: 1000
        });

        // Unlock and show target
        isFollowing = false;
        updateLockButton();
        showTargetMarker(loc.lng, loc.lat);
        updateCoordsDisplay(loc.lng, loc.lat);

        // Teleport after animation
        setTimeout(() => {
          if (onTeleportCallback) {
            onTeleportCallback(loc.lat, loc.lng);
          }
          closeModal();
        }, 1000);

        // Reset select
        locationsSelect.value = '';
      }
    });
  }

  console.log('Minimap initialized');
}

/**
 * Update the minimap with current plane state
 * Called every frame from the game loop
 */
export function updateMinimap(planeState: PlaneState): void {
  currentPlaneState = planeState;

  if (!map || !planeMarker || !isOpen) return;

  // Update plane marker position
  planeMarker.setLngLat([planeState.lng, planeState.lat]);

  // Rotate plane marker to match heading
  const markerEl = planeMarker.getElement();
  if (markerEl) {
    markerEl.style.transform = `rotate(${planeState.heading}deg)`;
  }

  // Follow plane if locked
  if (isFollowing) {
    map.setCenter([planeState.lng, planeState.lat]);
    updateCoordsDisplay(planeState.lng, planeState.lat);
  }
}

/**
 * Check if minimap modal is open
 */
export function isMinimapOpen(): boolean {
  return isOpen;
}
