import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { OvertureGeocoder } from 'overture-geocoder';
import { LOCATIONS, OVERTURE_BASE_PMTILES, OVERTURE_BUILDINGS_PMTILES, OVERTURE_TRANSPORTATION_PMTILES, OVERTURE_DIVISIONS_PMTILES } from './constants.js';
import type { PlaneState } from './plane.js';
import { setFeaturePickerEnabled, isFeaturePickerEnabled } from './feature-picker.js';

// Initialize the Overture Geocoder client
const geocoder = new OvertureGeocoder();

// Clean up geocoder resources on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    geocoder.close();
  });
}

// PMTiles protocol instance - stored at module level for proper lifecycle management
let pmtilesProtocol: Protocol | null = null;

function ensurePMTilesProtocol(): void {
  if (!pmtilesProtocol) {
    pmtilesProtocol = new Protocol();
    maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);
    console.log('PMTiles protocol registered for minimap');
  }
}

/**
 * Cartographic color palette for the minimap.
 * Uses a light, natural color scheme inspired by traditional cartography.
 */
const CARTO_COLORS = {
  // Water
  water: '#a3c7df',         // Soft blue

  // Land and vegetation
  land: '#f5f3ed',          // Light cream
  landcover: '#d8e4c8',     // Soft green for vegetation
  forest: '#c2d6a8',        // Slightly deeper green for forests
  park: '#c8dfb0',          // Park green
  grass: '#d8e8c0',         // Light grass green

  // Urban areas
  urban: '#e8e0d4',         // Warm urban gray
  residential: '#ebe6dc',   // Light residential
  commercial: '#e5ddd0',    // Commercial/retail
  industrial: '#ddd8cc',    // Industrial gray

  // Buildings
  building: '#d4ccc0',      // Building fill
  buildingOutline: '#b8a898', // Building stroke

  // Roads - muted, subtle colors
  motorway: '#d4a0a0',      // Muted pink/mauve for highways
  motorwayOutline: '#b88080',
  primary: '#e8dcc0',       // Soft cream/tan for primary roads
  primaryOutline: '#c8b898',
  secondary: '#ffffff',     // White for secondary
  secondaryOutline: '#c8c0b0',
  tertiary: '#ffffff',      // White for tertiary
  tertiaryOutline: '#d0c8b8',
  road: '#ffffff',          // Default road
  roadOutline: '#d8d0c4',

  // Boundaries
  stateBoundary: '#9090a0', // Muted purple-gray for state lines
  countryBoundary: '#707080', // Darker for country borders

  // Text and labels
  textHalo: '#ffffff',
  cityLabel: '#404050',
  stateLabel: '#606070',
};

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
 * Performs geocoding search using the Overture Geocoder.
 *
 * Uses the Overture Maps data via the overture-geocoder client library.
 *
 * @param query - The location search query string
 * @throws Displays user-friendly error messages for various failure modes
 */
async function searchLocation(query: string): Promise<void> {
  if (!query.trim() || !map) return;

  try {
    const results = await geocoder.search(query, { limit: 1 });

    if (results.length > 0) {
      const { lat, lon } = results[0];

      // Fly to location on minimap
      map.flyTo({
        center: [lon, lat],
        zoom: 14,
        duration: 1000
      });

      // Unlock from plane tracking
      isFollowing = false;
      updateLockButton();

      // Show target marker
      showTargetMarker(lon, lat);

      // Update coords
      updateCoordsDisplay(lon, lat);
    } else {
      alert(`No results found for "${query}". Try a different search term.`);
    }
  } catch (e) {
    console.error('Geocoding failed:', e);
    if (e instanceof TypeError && e.message.includes('fetch')) {
      alert('Network error. Please check your internet connection.');
    } else {
      alert('Search failed. Please try again later.');
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

  // Ensure PMTiles protocol is registered
  ensurePMTilesProtocol();

  // Initialize MapLibre GL map with Overture PMTiles and cartographic styling
  map = new maplibregl.Map({
    container: mapContainer,
    style: {
      version: 8,
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sources: {
        'overture-base': {
          type: 'vector',
          url: `pmtiles://${OVERTURE_BASE_PMTILES}`,
          attribution: '&copy; <a href="https://overturemaps.org">Overture Maps Foundation</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        },
        'overture-buildings': {
          type: 'vector',
          url: `pmtiles://${OVERTURE_BUILDINGS_PMTILES}`
        },
        'overture-transportation': {
          type: 'vector',
          url: `pmtiles://${OVERTURE_TRANSPORTATION_PMTILES}`
        },
        'overture-divisions': {
          type: 'vector',
          url: `pmtiles://${OVERTURE_DIVISIONS_PMTILES}`
        }
      },
      layers: [
        // Background layer (ocean/default)
        {
          id: 'background',
          type: 'background',
          paint: {
            'background-color': CARTO_COLORS.water
          }
        },

        // Land areas
        {
          id: 'land',
          type: 'fill',
          source: 'overture-base',
          'source-layer': 'land',
          paint: {
            'fill-color': CARTO_COLORS.land
          }
        },

        // Land cover (vegetation, forests, etc.)
        {
          id: 'landcover',
          type: 'fill',
          source: 'overture-base',
          'source-layer': 'land_cover',
          paint: {
            'fill-color': [
              'match',
              ['get', 'subtype'],
              'forest', CARTO_COLORS.forest,
              'grass', CARTO_COLORS.grass,
              'shrub', CARTO_COLORS.landcover,
              'wetland', '#b8d4c4',
              'moss', '#c8dcc0',
              'bare', CARTO_COLORS.urban,
              'snow', '#f8f8f8',
              'crop', '#e8e4b8',
              CARTO_COLORS.landcover
            ],
            'fill-opacity': 0.7
          }
        },

        // Land use (urban areas, parks, etc.)
        {
          id: 'landuse',
          type: 'fill',
          source: 'overture-base',
          'source-layer': 'land_use',
          paint: {
            'fill-color': [
              'match',
              ['get', 'subtype'],
              'residential', CARTO_COLORS.residential,
              'commercial', CARTO_COLORS.commercial,
              'industrial', CARTO_COLORS.industrial,
              'park', CARTO_COLORS.park,
              'cemetery', '#d4dcc8',
              'golf', '#c8e0b8',
              'airport', '#e0dcd4',
              'education', '#e8e0dc',
              'hospital', '#f0e8e8',
              CARTO_COLORS.urban
            ],
            'fill-opacity': 0.6
          }
        },

        // Water bodies
        {
          id: 'water',
          type: 'fill',
          source: 'overture-base',
          'source-layer': 'water',
          paint: {
            'fill-color': CARTO_COLORS.water
          }
        },

        // Infrastructure (bridges, piers, etc.)
        {
          id: 'infrastructure',
          type: 'fill',
          source: 'overture-base',
          'source-layer': 'infrastructure',
          paint: {
            'fill-color': '#d8d4c8',
            'fill-opacity': 0.8
          }
        },

        // Roads - outline layer (drawn first, wider)
        {
          id: 'roads-outline',
          type: 'line',
          source: 'overture-transportation',
          'source-layer': 'segment',
          filter: ['==', ['geometry-type'], 'LineString'],
          layout: {
            'line-cap': 'round',
            'line-join': 'round'
          },
          paint: {
            'line-color': [
              'match',
              ['get', 'class'],
              'motorway', CARTO_COLORS.motorwayOutline,
              'primary', CARTO_COLORS.primaryOutline,
              'secondary', CARTO_COLORS.secondaryOutline,
              'tertiary', CARTO_COLORS.tertiaryOutline,
              'residential', CARTO_COLORS.roadOutline,
              'service', CARTO_COLORS.roadOutline,
              CARTO_COLORS.roadOutline
            ],
            'line-width': [
              'interpolate', ['linear'], ['zoom'],
              8, ['match', ['get', 'class'],
                'motorway', 3,
                'primary', 2,
                'secondary', 1.5,
                0.5
              ],
              14, ['match', ['get', 'class'],
                'motorway', 10,
                'primary', 7,
                'secondary', 5,
                'tertiary', 4,
                3
              ]
            ]
          }
        },

        // Roads - fill layer (drawn on top, narrower)
        {
          id: 'roads-fill',
          type: 'line',
          source: 'overture-transportation',
          'source-layer': 'segment',
          filter: ['==', ['geometry-type'], 'LineString'],
          layout: {
            'line-cap': 'round',
            'line-join': 'round'
          },
          paint: {
            'line-color': [
              'match',
              ['get', 'class'],
              'motorway', CARTO_COLORS.motorway,
              'primary', CARTO_COLORS.primary,
              'secondary', CARTO_COLORS.secondary,
              'tertiary', CARTO_COLORS.tertiary,
              'residential', CARTO_COLORS.road,
              'service', CARTO_COLORS.road,
              CARTO_COLORS.road
            ],
            'line-width': [
              'interpolate', ['linear'], ['zoom'],
              8, ['match', ['get', 'class'],
                'motorway', 2,
                'primary', 1.2,
                'secondary', 0.8,
                0.3
              ],
              14, ['match', ['get', 'class'],
                'motorway', 7,
                'primary', 5,
                'secondary', 3.5,
                'tertiary', 2.5,
                2
              ]
            ]
          }
        },

        // Buildings
        {
          id: 'buildings',
          type: 'fill',
          source: 'overture-buildings',
          'source-layer': 'building',
          minzoom: 13,
          paint: {
            'fill-color': CARTO_COLORS.building,
            'fill-opacity': [
              'interpolate', ['linear'], ['zoom'],
              13, 0.3,
              16, 0.7
            ]
          }
        },

        // Building outlines
        {
          id: 'buildings-outline',
          type: 'line',
          source: 'overture-buildings',
          'source-layer': 'building',
          minzoom: 14,
          paint: {
            'line-color': CARTO_COLORS.buildingOutline,
            'line-width': 0.5
          }
        },

        // State/region boundaries
        {
          id: 'state-boundaries',
          type: 'line',
          source: 'overture-divisions',
          'source-layer': 'division_boundary',
          paint: {
            'line-color': CARTO_COLORS.stateBoundary,
            'line-width': 1,
            'line-dasharray': [4, 2]
          }
        },

        // City/locality labels
        {
          id: 'city-labels',
          type: 'symbol',
          source: 'overture-divisions',
          'source-layer': 'division',
          filter: ['==', ['get', 'subtype'], 'locality'],
          layout: {
            'text-field': '{names.primary}',  // Try dot notation in mustache
            'text-font': ['Noto Sans Bold'],
            'text-size': [
              'interpolate', ['linear'], ['zoom'],
              4, 10,
              8, 12,
              12, 14
            ],
            'text-anchor': 'center',
            'text-max-width': 8
          },
          paint: {
            'text-color': CARTO_COLORS.cityLabel,
            'text-halo-color': CARTO_COLORS.textHalo,
            'text-halo-width': 1.5
          }
        },

        // State/region labels
        {
          id: 'state-labels',
          type: 'symbol',
          source: 'overture-divisions',
          'source-layer': 'division',
          filter: ['==', ['get', 'subtype'], 'region'],
          maxzoom: 8,
          layout: {
            'text-field': '{names.primary}',  // Try dot notation in mustache
            'text-font': ['Noto Sans Bold'],
            'text-size': [
              'interpolate', ['linear'], ['zoom'],
              3, 10,
              6, 14
            ],
            'text-transform': 'uppercase',
            'text-letter-spacing': 0.1,
            'text-anchor': 'center',
            'text-max-width': 10
          },
          paint: {
            'text-color': CARTO_COLORS.stateLabel,
            'text-halo-color': CARTO_COLORS.textHalo,
            'text-halo-width': 2
          }
        }
      ]
    },
    center: [0, 0],
    zoom: 12,
    attributionControl: false
  });

  // Add navigation controls
  map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

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

  // X-Ray mode toggle
  const xrayCheckbox = document.getElementById('xray-checkbox') as HTMLInputElement | null;
  if (xrayCheckbox) {
    // Set initial state (disabled by default)
    xrayCheckbox.checked = isFeaturePickerEnabled();

    xrayCheckbox.addEventListener('change', () => {
      setFeaturePickerEnabled(xrayCheckbox.checked);
      console.log('Feature Inspector:', xrayCheckbox.checked ? 'enabled' : 'disabled');
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
