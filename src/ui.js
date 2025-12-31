import { teleportPlane } from './plane.js';
import { LOCATIONS } from './constants.js';

let crashMessageTimeout = null;

/**
 * Update HUD display with current plane state
 * @param {Object} planeState - Current plane state
 */
export function updateHUD(planeState) {
  // Speed (convert m/s to km/h)
  const speedKmh = Math.round(planeState.speed * 3.6);
  document.getElementById('speed-value').textContent = `${speedKmh} km/h`;

  // Altitude
  const altitude = Math.round(planeState.altitude);
  document.getElementById('altitude-value').textContent = `${altitude} m`;

  // Heading
  const heading = Math.round(planeState.heading);
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const dirIndex = Math.round(heading / 45) % 8;
  document.getElementById('heading-value').textContent = `${heading}° ${directions[dirIndex]}`;
}

/**
 * Update player list display
 * @param {Map<string, Object>} players - Map of player states
 * @param {string} localId - Local player's ID
 */
export function updatePlayerList(players, localId) {
  const list = document.getElementById('player-list');
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
export function showCrashMessage() {
  const msg = document.getElementById('crash-message');
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
 * @param {function(number, number): void} onTeleport - Callback when teleporting
 */
export function initLocationPicker(onTeleport) {
  const searchInput = document.getElementById('location-search');
  const teleportBtn = document.getElementById('teleport-btn');

  // Add preset location dropdown
  const picker = document.getElementById('location-picker');
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
    const key = e.target.value;
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
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`
      );
      const results = await response.json();

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
