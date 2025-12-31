import { LOCATIONS } from './constants.js';
import { getGroundHeight } from './collision.js';
import type { PlaneState } from './plane.js';

let crashMessageTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Update HUD display with current plane state
 */
export function updateHUD(planeState: PlaneState): void {
  // Speed (convert m/s to km/h)
  const speedKmh = Math.round(planeState.speed * 3.6);
  const speedEl = document.getElementById('speed-value');
  if (speedEl) {
    speedEl.textContent = `${speedKmh} km/h`;
  }

  // Altitude
  const altitude = Math.round(planeState.altitude);
  const altEl = document.getElementById('altitude-value');
  if (altEl) {
    altEl.textContent = `${altitude} m`;
  }

  // Ground level (terrain height)
  const groundHeight = Math.round(getGroundHeight(planeState.lng, planeState.lat));
  const groundEl = document.getElementById('ground-value');
  if (groundEl) {
    groundEl.textContent = `${groundHeight} m`;
  }

  // Heading
  const heading = Math.round(planeState.heading);
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const dirIndex = Math.round(heading / 45) % 8;
  const headingEl = document.getElementById('heading-value');
  if (headingEl) {
    headingEl.textContent = `${heading}° ${directions[dirIndex]}`;
  }
}

/**
 * Update player list display
 */
export function updatePlayerList(players: Map<string, PlaneState>, localId: string): void {
  const list = document.getElementById('player-list');
  if (!list) return;

  list.innerHTML = '';

  for (const [id, player] of players) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="color-dot" style="background: ${player.color}"></span>
      <span>${player.name || (id === localId ? 'You' : `Player ${id.slice(0, 4)}`)}</span>
    `;
    list.appendChild(li);
  }

  // Show at least "1 player" if no one else
  if (players.size === 0) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="color-dot" style="background: #3b82f6"></span>
      <span>You</span>
    `;
    list.appendChild(li);
  }
}

/**
 * Show crash message briefly
 */
export function showCrashMessage(): void {
  const msg = document.getElementById('crash-message');
  if (!msg) return;

  msg.style.display = 'block';

  if (crashMessageTimeout) {
    clearTimeout(crashMessageTimeout);
  }

  crashMessageTimeout = setTimeout(() => {
    msg.style.display = 'none';
  }, 1500);
}

/**
 * Initialize location picker UI
 */
export function initLocationPicker(onTeleport: (lat: number, lng: number) => void): void {
  const searchInput = document.getElementById('location-search') as HTMLInputElement | null;
  const teleportBtn = document.getElementById('teleport-btn');
  const picker = document.getElementById('location-picker');

  if (!searchInput || !teleportBtn || !picker) return;

  // Add preset location dropdown
  const select = document.createElement('select');
  select.id = 'location-select';
  select.style.cssText = 'margin-left: 8px; padding: 8px; border-radius: 4px; border: none;';

  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'Quick Jump...';
  select.appendChild(defaultOption);

  for (const [key, loc] of Object.entries(LOCATIONS)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = loc.name;
    select.appendChild(option);
  }

  picker.appendChild(select);

  // Handle quick jump selection
  select.addEventListener('change', (e) => {
    const key = (e.target as HTMLSelectElement).value;
    if (key && LOCATIONS[key]) {
      const loc = LOCATIONS[key];
      onTeleport(loc.lat, loc.lng);
      select.value = '';
    }
  });

  // Handle search (basic geocoding placeholder)
  teleportBtn.addEventListener('click', async () => {
    const query = searchInput.value.trim();
    if (!query) return;

    try {
      // Use Nominatim for geocoding (free, rate-limited)
      // User-Agent required per Nominatim usage policy
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
        onTeleport(parseFloat(lat), parseFloat(lon));
        searchInput.value = '';
      } else {
        alert('Location not found');
      }
    } catch (e) {
      console.error('Geocoding failed:', e);
      alert('Search failed. Try using the quick jump menu.');
    }
  });

  // Handle enter key in search
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      teleportBtn.click();
    }
  });
}
