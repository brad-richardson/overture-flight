import PartySocket from 'partysocket';
import { PARTYKIT_HOST, NETWORK } from './constants.js';

let socket = null;
let lastSendTime = 0;

/**
 * @typedef {Object} NetworkCallbacks
 * @property {function(Object): void} onWelcome - Called when server sends welcome message
 * @property {function(Object): void} onSync - Called when server sends plane sync
 * @property {function(string): void} onPlayerLeft - Called when a player leaves
 * @property {function(Object): void} onPlayerJoined - Called when a player joins
 */

/**
 * Connect to the PartyKit server
 * @param {string} roomId - Room to join
 * @param {NetworkCallbacks} callbacks - Event callbacks
 * @returns {Object} Connection interface
 */
export function createConnection(roomId, callbacks) {
  socket = new PartySocket({
    host: PARTYKIT_HOST,
    room: roomId,
  });

  socket.addEventListener('open', () => {
    console.log('Connected to server');
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
    console.log('Disconnected from server');
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

      if (socket && socket.readyState === WebSocket.OPEN) {
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
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'teleport',
          data: { lat, lng },
        }));
      }
    },

    /**
     * Close the connection
     */
    close: () => {
      if (socket) {
        socket.close();
        socket = null;
      }
    },
  };
}
