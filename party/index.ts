import type * as Party from "partykit/server";
import {
  MULTIPLAYER_LIMITS,
  checkFixedWindowRateLimit,
  createRateLimitState,
  getInboundByteLength,
  parseClientMessage,
  reconstructPlaneRecord,
  type ConnectionProtocolState,
  type PlaneSnapshot,
  type ServerMessage,
} from '../src/multiplayer-protocol.js';

const COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // purple
  '#ec4899', // pink
];

// Connection limits
const MAX_CONNECTIONS = 10;

function serialize(message: ServerMessage): string {
  return JSON.stringify(message);
}

export default class FlightServer implements Party.Server {
  options: Party.ServerOptions = { hibernate: true };

  constructor(readonly room: Party.Room) {}

  onConnect(conn: Party.Connection<ConnectionProtocolState>) {
    const connections = Array.from(
      this.room.getConnections<ConnectionProtocolState>()
    ).filter((connection) => connection.id !== conn.id);

    // Check if room is full
    if (connections.length >= MAX_CONNECTIONS) {
      conn.send(serialize({
        type: 'error',
        message: 'Room is full. Please try again later.',
      }));
      conn.close(1008, 'Room is full');
      return;
    }

    const color = COLORS[connections.length % COLORS.length];
    const id = conn.id;

    // Create initial plane state
    const initialPlane: PlaneSnapshot = {
      id,
      lat: 40.7128,
      lng: -74.006,
      altitude: 500,
      heading: 0,
      pitch: 0,
      roll: 0,
      speed: 80,
      color,
      name: '',
    };
    conn.setState({ plane: initialPlane, rate: createRateLimitState(Date.now()) });

    const planes = reconstructPlaneRecord(
      this.room.getConnections<ConnectionProtocolState>()
    );

    // Send welcome with assigned ID, color, and existing planes
    conn.send(serialize({
      type: 'welcome',
      id,
      color,
      planes,
    }));

    // Notify others about the new player
    this.room.broadcast(
      serialize({
        type: 'playerJoined',
        player: initialPlane,
      }),
      [conn.id]
    );
  }

  onMessage(
    message: string | ArrayBuffer | ArrayBufferView,
    sender: Party.Connection<ConnectionProtocolState>
  ) {
    const state = sender.state;
    if (!state) {
      sender.close(1011, 'Connection state unavailable');
      return;
    }

    const rate = checkFixedWindowRateLimit(state.rate, Date.now());
    sender.setState({ plane: state.plane, rate: rate.state });
    if (!rate.allowed) {
      if (rate.shouldClose) sender.close(1008, 'Rate limit exceeded');
      return;
    }

    if (
      typeof message !== 'string' ||
      getInboundByteLength(message) > MULTIPLAYER_LIMITS.MAX_INBOUND_BYTES
    ) {
      sender.send(serialize({ type: 'error', message: 'Invalid message payload.' }));
      return;
    }

    try {
      const msg = parseClientMessage(JSON.parse(message));
      if (!msg) {
        sender.send(serialize({ type: 'error', message: 'Invalid message.' }));
        return;
      }

      if (msg.type === 'position') {
        const plane: PlaneSnapshot = { ...state.plane, ...msg.data };
        sender.setState({ plane, rate: rate.state });

        // Broadcast updated state to all OTHER clients (exclude sender)
        this.room.broadcast(
          serialize({ type: 'playerUpdated', player: plane }),
          [sender.id]
        );
        return;
      }

      if (msg.type === 'teleport') {
        const plane: PlaneSnapshot = {
          ...state.plane,
          ...msg.data,
          altitude: 500,
          heading: 0,
          pitch: 0,
          roll: 0,
        };
        sender.setState({ plane, rate: rate.state });
        this.room.broadcast(
          serialize({ type: 'playerUpdated', player: plane }),
          [sender.id]
        );
        return;
      }

      if (msg.type === 'setName') {
        const plane: PlaneSnapshot = { ...state.plane, name: msg.data.name };
        sender.setState({ plane, rate: rate.state });
        this.room.broadcast(
          serialize({ type: 'playerUpdated', player: plane }),
          [sender.id]
        );
      }
    } catch {
      sender.send(serialize({ type: 'error', message: 'Invalid JSON.' }));
    }
  }

  onClose(conn: Party.Connection<ConnectionProtocolState>) {
    this.room.broadcast(
      serialize({
        type: 'playerLeft',
        id: conn.id,
      })
    );
  }
}
