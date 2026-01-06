import { getGroundHeight } from './collision.js';
import type { PlaneState } from './plane.js';

let crashMessageTimeout: ReturnType<typeof setTimeout> | null = null;
let connectionStatus: 'connected' | 'disconnected' | 'connecting' = 'connecting';
let autopilotIndicator: HTMLDivElement | null = null;

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

// Callback for teleporting to a player's location
let teleportToPlayerCallback: ((lat: number, lng: number) => void) | null = null;

/**
 * Set the callback for teleporting to a player's location
 */
export function setTeleportToPlayerCallback(callback: (lat: number, lng: number) => void): void {
  teleportToPlayerCallback = callback;
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
    const isLocal = id === localId;
    const shortId = id.slice(-4);
    const displayName = player.name || (isLocal ? `You (${shortId})` : `Player ${shortId}`);

    // Create color dot
    const colorDot = document.createElement('span');
    colorDot.className = 'color-dot';
    colorDot.style.background = player.color;

    // Create name span
    const nameSpan = document.createElement('span');
    nameSpan.textContent = displayName;

    // Make non-local players clickable to teleport
    if (!isLocal) {
      li.className = 'clickable-player';
      li.title = `Click to teleport to ${displayName}`;
      li.addEventListener('click', () => {
        if (teleportToPlayerCallback) {
          teleportToPlayerCallback(player.lat, player.lng);
        }
      });
    }

    li.appendChild(colorDot);
    li.appendChild(nameSpan);
    list.appendChild(li);
  }

  // Show at least "1 player" if no one else
  if (players.size === 0) {
    const li = document.createElement('li');
    const colorDot = document.createElement('span');
    colorDot.className = 'color-dot';
    colorDot.style.background = '#3b82f6';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = 'You';
    li.appendChild(colorDot);
    li.appendChild(nameSpan);
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
 * Initialize autopilot indicator
 */
function initAutopilotIndicator(): void {
  if (autopilotIndicator) return;

  autopilotIndicator = document.createElement('div');
  autopilotIndicator.id = 'autopilot-indicator';
  autopilotIndicator.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(34, 197, 94, 0.85);
    color: white;
    padding: 8px 16px;
    border-radius: 20px;
    font-size: 14px;
    font-weight: 500;
    z-index: 1000;
    display: none;
    pointer-events: none;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  `;
  autopilotIndicator.textContent = '✈ AUTOPILOT';
  document.body.appendChild(autopilotIndicator);
}

/**
 * Update autopilot indicator visibility
 */
export function updateAutopilotIndicator(isActive: boolean): void {
  if (!autopilotIndicator) {
    initAutopilotIndicator();
  }
  if (autopilotIndicator) {
    autopilotIndicator.style.display = isActive ? 'block' : 'none';
  }
}

