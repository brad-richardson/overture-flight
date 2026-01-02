import PartySocket from 'partysocket';
import { PARTYKIT_HOST, NETWORK } from './constants.js';
import type { PlaneState } from './plane.js';

// WebSocket readyState constants (not available in ES modules)
const WS_OPEN = 1;

let socket: PartySocket | null = null;
let lastSendTime = 0;
let isConnected = false;

/**
 * Welcome message from server
 */
export interface WelcomeMessage {
  type: 'welcome';
  id: string;
  color: string;
  planes?: Record<string, PlaneState>;
}

/**
 * Player joined message
 */
export interface PlayerJoinedMessage {
  type: 'playerJoined';
  player: PlaneState;
}

/**
 * Player left message
 */
export interface PlayerLeftMessage {
  type: 'playerLeft';
  id: string;
}

/**
 * Sync message from server
 */
export interface SyncMessage {
  type: 'sync';
  planes: Record<string, PlaneState>;
}

/**
 * Network callbacks interface
 */
export interface NetworkCallbacks {
  onWelcome: (msg: WelcomeMessage) => void;
  onSync: (planes: Record<string, PlaneState>) => void;
  onPlayerLeft: (id: string) => void;
  onPlayerJoined: (player: PlaneState) => void;
  onDisconnect?: () => void;
  onReconnect?: () => void;
}

/**
 * Connection interface
 */
export interface Connection {
  sendPosition: (planeState: PlaneState) => void;
  sendTeleport: (lat: number, lng: number) => void;
  isConnected: () => boolean;
  close: () => void;
}

/**
 * Connect to the PartyKit server
 */
export function createConnection(roomId: string, callbacks: NetworkCallbacks): Connection {
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
    if (wasConnected === false && callbacks.onReconnect) {
      callbacks.onReconnect();
    }
  });

  socket.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data as string);

      switch (msg.type) {
        case 'welcome':
          callbacks.onWelcome(msg as WelcomeMessage);
          break;
        case 'sync':
          callbacks.onSync((msg as SyncMessage).planes);
          break;
        case 'playerJoined':
          callbacks.onPlayerJoined((msg as PlayerJoinedMessage).player);
          break;
        case 'playerLeft':
          callbacks.onPlayerLeft((msg as PlayerLeftMessage).id);
          break;
      }
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  });

  socket.addEventListener('close', () => {
    const wasConnected = isConnected;
    isConnected = false;
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
     */
    sendPosition: (planeState: PlaneState): void => {
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
     */
    sendTeleport: (lat: number, lng: number): void => {
      if (socket && socket.readyState === WS_OPEN) {
        socket.send(JSON.stringify({
          type: 'teleport',
          data: { lat, lng },
        }));
      }
    },

    /**
     * Check if connected
     */
    isConnected: (): boolean => isConnected,

    /**
     * Close the connection
     */
    close: (): void => {
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
 */
function createDisconnectedInterface(): Connection {
  return {
    sendPosition: (): void => {},
    sendTeleport: (): void => {},
    isConnected: (): boolean => false,
    close: (): void => {},
  };
}
