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

// Event listener references for cleanup
let escapeKeyHandler: ((e: KeyboardEvent) => void) | null = null;

// Rate limiting for Nominatim API (max 1 request per second)
let lastSearchTime = 0;
const SEARCH_RATE_LIMIT_MS = 1000;

// Focusable elements for focus trap
let focusableElements: HTMLElement[] = [];
let firstFocusable: HTMLElement | null = null;
let lastFocusable: HTMLElement | null = null;

/**
 * Creates the plane marker element with a nested rotation container.
 * Uses a nested element for rotation to avoid conflicts with MapLibre's
 * positioning transforms on the parent element.
 *
 * @returns The marker container element
 */
function createPlaneMarkerElement(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'minimap-plane-marker';

  // Use a nested element for rotation to avoid transform conflicts
  const rotator = document.createElement('div');
  rotator.className = 'minimap-plane-rotator';
  container.appendChild(rotator);

  return container;
}

/**
 * Creates the target marker element for teleport destination.
 *
 * @returns The target marker element with pulse animation
 */
function createTargetMarkerElement(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'minimap-target-marker';
  return el;
}

/**
 * Updates the lock/unlock button appearance based on current following state.
 * Changes icon, text, and styling to reflect whether the map is following
 * the plane or unlocked for manual panning.
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
 * Updates the coordinates display with labeled lat/lng values.
 *
 * @param lng - Longitude in decimal degrees
 * @param lat - Latitude in decimal degrees
 */
function updateCoordsDisplay(lng: number, lat: number): void {
  if (!coordsDisplay) return;
  coordsDisplay.textContent = `Lat: ${lat.toFixed(5)}, Lon: ${lng.toFixed(5)}`;
}

/**
 * Performs geocoding search using the Nominatim API.
 *
 * Nominatim has a rate limit of 1 request per second. This function
 * implements client-side rate limiting to prevent API throttling.
 *
 * @param query - The location search query string
 * @throws Displays user-friendly error messages for various failure modes
 *
 * @see https://nominatim.org/release-docs/latest/api/Search/
 */
async function searchLocation(query: string): Promise<void> {
  if (!query.trim() || !map) return;

  // Rate limiting check
  const now = Date.now();
  const timeSinceLastSearch = now - lastSearchTime;
  if (timeSinceLastSearch < SEARCH_RATE_LIMIT_MS) {
    const waitTime = Math.ceil((SEARCH_RATE_LIMIT_MS - timeSinceLastSearch) / 1000);
    alert(`Please wait ${waitTime} second${waitTime > 1 ? 's' : ''} before searching again.`);
    return;
  }
  lastSearchTime = now;

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`,
      {
        headers: {
          'User-Agent': 'FlightSimulator/1.0 (https://github.com/overture-flight)',
        },
      }
    );

    if (!response.ok) {
      if (response.status === 429) {
        alert('Too many requests. Please wait a moment before searching again.');
        return;
      }
      throw new Error(`HTTP ${response.status}`);
    }

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
      alert(`No results found for "${query}". Try a different search term.`);
    }
  } catch (e) {
    console.error('Geocoding failed:', e);
    if (e instanceof TypeError && e.message.includes('fetch')) {
      alert('Network error. Please check your internet connection.');
    } else {
      alert('Search failed due to a server error. Please try again later.');
    }
  }
}

/**
 * Shows the target marker at the specified location.
 * Removes any existing target marker before creating a new one.
 *
 * @param lng - Longitude for the marker position
 * @param lat - Latitude for the marker position
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
 * Hides and removes the target marker from the map.
 */
function hideTargetMarker(): void {
  if (targetMarker) {
    targetMarker.remove();
    targetMarker = null;
  }
}

/**
 * Handles click events on the map for teleportation.
 * Shows a target marker and teleports the plane after a brief delay
 * for visual feedback.
 *
 * @param e - The MapLibre mouse event containing click coordinates
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
 * Sets up focus trap for the modal to ensure keyboard users
 * cannot tab out to background elements (WCAG compliance).
 */
function setupFocusTrap(): void {
  if (!modal) return;

  // Find all focusable elements within the modal
  const focusableSelectors = [
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(', ');

  focusableElements = Array.from(modal.querySelectorAll<HTMLElement>(focusableSelectors));

  if (focusableElements.length > 0) {
    firstFocusable = focusableElements[0];
    lastFocusable = focusableElements[focusableElements.length - 1];
  }
}

/**
 * Handles keyboard navigation within the modal for focus trapping.
 *
 * @param e - The keyboard event
 */
function handleFocusTrap(e: KeyboardEvent): void {
  if (e.key !== 'Tab' || !isOpen) return;

  if (e.shiftKey) {
    // Shift+Tab: if on first element, wrap to last
    if (document.activeElement === firstFocusable) {
      e.preventDefault();
      lastFocusable?.focus();
    }
  } else {
    // Tab: if on last element, wrap to first
    if (document.activeElement === lastFocusable) {
      e.preventDefault();
      firstFocusable?.focus();
    }
  }
}

/**
 * Opens the minimap modal and sets up focus management.
 * Resets to following mode and centers on the plane position.
 */
function openModal(): void {
  if (!modal || !map) return;

  isOpen = true;
  modal.classList.add('minimap-modal-open');

  // Reset to following mode when opening
  isFollowing = true;
  updateLockButton();
  hideTargetMarker();

  // Setup focus trap
  setupFocusTrap();

  // Focus first focusable element
  setTimeout(() => {
    firstFocusable?.focus();
  }, 100);

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
 * Closes the minimap modal and cleans up state.
 */
function closeModal(): void {
  if (!modal) return;

  isOpen = false;
  modal.classList.remove('minimap-modal-open');
  hideTargetMarker();
}

/**
 * Initializes the minimap modal with MapLibre GL.
 *
 * Sets up the map instance, markers, event listeners, and UI controls.
 * This function should be called once during application initialization.
 *
 * @param onTeleport - Callback function invoked when user selects a teleport location.
 *                     Receives latitude and longitude as parameters.
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

  // Click outside to close (check if click is directly on backdrop)
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });

  // Remove existing escape handler if present (prevents duplicates during HMR)
  if (escapeKeyHandler) {
    document.removeEventListener('keydown', escapeKeyHandler);
  }

  // Create and store escape key handler
  escapeKeyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && isOpen) {
      closeModal();
    }
    // Handle focus trap
    handleFocusTrap(e);
  };
  document.addEventListener('keydown', escapeKeyHandler);

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
 * Updates the minimap with the current plane state.
 *
 * This function is called every frame from the game loop to keep
 * the plane marker position and rotation synchronized. When in
 * following mode, the map center is also updated to track the plane.
 *
 * @param planeState - The current plane state containing position and heading
 */
export function updateMinimap(planeState: PlaneState): void {
  currentPlaneState = planeState;

  if (!map || !planeMarker || !isOpen) return;

  // Update plane marker position
  planeMarker.setLngLat([planeState.lng, planeState.lat]);

  // Rotate the nested rotator element to avoid transform conflicts
  const markerEl = planeMarker.getElement();
  const rotator = markerEl?.querySelector('.minimap-plane-rotator') as HTMLElement | null;
  if (rotator) {
    rotator.style.transform = `rotate(${planeState.heading}deg)`;
  }

  // Follow plane if locked
  if (isFollowing) {
    map.setCenter([planeState.lng, planeState.lat]);
    updateCoordsDisplay(planeState.lng, planeState.lat);
  }
}

/**
 * Checks if the minimap modal is currently open.
 *
 * @returns True if the modal is open, false otherwise
 */
export function isMinimapOpen(): boolean {
  return isOpen;
}
