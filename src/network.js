import PartySocket from 'partysocket';
import { PARTYKIT_HOST, NETWORK } from './constants.js';

// WebSocket readyState constants (not available in ES modules)
const WS_OPEN = 1;

let socket = null;
let lastSendTime = 0;
let isConnected = false;

/**
 * @typedef {Object} NetworkCallbacks
 * @property {function(Object): void} onWelcome - Called when server sends welcome message
 * @property {function(Object): void} onSync - Called when server sends plane sync
 * @property {function(string): void} onPlayerLeft - Called when a player leaves
 * @property {function(Object): void} onPlayerJoined - Called when a player joins
 * @property {function(): void} [onDisconnect] - Called when connection is lost
 * @property {function(): void} [onReconnect] - Called when connection is restored
 */

/**
 * Connect to the PartyKit server
 * @param {string} roomId - Room to join
 * @param {NetworkCallbacks} callbacks - Event callbacks
 * @returns {Object} Connection interface
 */
export function createConnection(roomId, callbacks) {
  if (!PARTYKIT_HOST) {
    console.error('PartyKit host not configured');
    return createDisconnectedInterface();
  }

  socket = new PartySocket({
    host: PARTYKIT_HOST,
    room: roomId,
  });

  socket.addEventListener('open', () => {
    const wasConnected = isConnected;
    isConnected = true;
    console.log('Connected to server');
    if (wasConnected === false && callbacks.onReconnect) {
      callbacks.onReconnect();
    }
  });

  socket.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'welcome':
          callbacks.onWelcome(msg);
          break;
        case 'sync':
          callbacks.onSync(msg.planes);
          break;
        case 'playerJoined':
          callbacks.onPlayerJoined(msg.player);
          break;
        case 'playerLeft':
          callbacks.onPlayerLeft(msg.id);
          break;
      }
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  });

  socket.addEventListener('close', () => {
    const wasConnected = isConnected;
    isConnected = false;
    console.log('Disconnected from server');
    if (wasConnected && callbacks.onDisconnect) {
      callbacks.onDisconnect();
    }
    // PartySocket auto-reconnects by default
  });

  socket.addEventListener('error', (e) => {
    console.error('WebSocket error:', e);
  });

  return {
    /**
     * Send position update to server (throttled)
     * @param {Object} planeState - Current plane state
     */
    sendPosition: (planeState) => {
      const now = Date.now();
      if (now - lastSendTime < NETWORK.UPDATE_RATE) return;
      lastSendTime = now;

      if (socket && socket.readyState === WS_OPEN) {
        socket.send(JSON.stringify({
          type: 'position',
          data: {
            lat: planeState.lat,
            lng: planeState.lng,
            altitude: planeState.altitude,
            heading: planeState.heading,
            pitch: planeState.pitch,
            roll: planeState.roll,
            speed: planeState.speed,
          },
        }));
      }
    },

    /**
     * Send teleport notification
     * @param {number} lat
     * @param {number} lng
     */
    sendTeleport: (lat, lng) => {
      if (socket && socket.readyState === WS_OPEN) {
        socket.send(JSON.stringify({
          type: 'teleport',
          data: { lat, lng },
        }));
      }
    },

    /**
     * Check if connected
     * @returns {boolean}
     */
    isConnected: () => isConnected,

    /**
     * Close the connection
     */
    close: () => {
      if (socket) {
        socket.close();
        socket = null;
        isConnected = false;
      }
    },
  };
}

/**
 * Create a disconnected interface for when server is not configured
 * @returns {Object} Stub connection interface
 */
function createDisconnectedInterface() {
  return {
    sendPosition: () => {},
    sendTeleport: () => {},
    isConnected: () => false,
    close: () => {},
  };
}
