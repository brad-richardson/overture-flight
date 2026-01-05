import { getGroundHeight } from './collision.js';
import type { PlaneState } from './plane.js';

let crashMessageTimeout: ReturnType<typeof setTimeout> | null = null;
let connectionStatus: 'connected' | 'disconnected' | 'connecting' = 'connecting';

/**
 * Update connection status indicator
 */
export function updateConnectionStatus(status: 'connected' | 'disconnected' | 'connecting'): void {
  connectionStatus = status;
  const indicator = document.getElementById('connection-status');
  if (!indicator) return;

  const dot = indicator.querySelector('.status-dot') as HTMLElement;
  const text = indicator.querySelector('.status-text') as HTMLElement;

  // Update CSS class for animation state
  if (status === 'connected') {
    indicator.classList.add('connected');
  } else {
    indicator.classList.remove('connected');
  }

  if (dot && text) {
    switch (status) {
      case 'connected':
        dot.style.background = '#22c55e';
        text.textContent = 'Online';
        break;
      case 'disconnected':
        dot.style.background = '#ef4444';
        text.textContent = 'Offline';
        break;
      case 'connecting':
        dot.style.background = '#f97316';
        text.textContent = 'Connecting...';
        break;
    }
  }
}

/**
 * Get current connection status
 */
export function getConnectionStatus(): 'connected' | 'disconnected' | 'connecting' {
  return connectionStatus;
}

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

