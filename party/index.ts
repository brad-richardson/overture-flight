import type * as Party from "partykit/server";

interface PlaneState {
  id: string;
  lat: number;
  lng: number;
  altitude: number;
  heading: number;
  pitch: number;
  roll: number;
  speed: number;
  color: string;
  name?: string;
}

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

export default class FlightServer implements Party.Server {
  options: Party.ServerOptions = { hibernate: true };
  planes: Map<string, PlaneState> = new Map();
  colorIndex: number = 0;

  constructor(readonly room: Party.Room) {}

  onConnect(conn: Party.Connection) {
    const color = COLORS[this.colorIndex % COLORS.length];
    this.colorIndex++;
    const id = conn.id;

    // Create initial plane state
    const initialPlane: PlaneState = {
      id,
      lat: 40.7128,
      lng: -74.006,
      altitude: 500,
      heading: 0,
      pitch: 0,
      roll: 0,
      speed: 80,
      color,
    };
    this.planes.set(id, initialPlane);

    // Send welcome with assigned ID, color, and existing planes
    conn.send(JSON.stringify({
      type: 'welcome',
      id,
      color,
      planes: Object.fromEntries(this.planes),
    }));

    // Notify others about the new player
    this.room.broadcast(
      JSON.stringify({
        type: 'playerJoined',
        player: initialPlane,
      }),
      [conn.id]
    );
  }

  onMessage(message: string, sender: Party.Connection) {
    try {
      const msg = JSON.parse(message);

      if (msg.type === 'position') {
        const existing = this.planes.get(sender.id);
        const plane: PlaneState = {
          ...msg.data,
          id: sender.id,
          color: existing?.color || '#888',
          name: existing?.name,
        };
        this.planes.set(sender.id, plane);

        // Broadcast updated state to all clients
        this.room.broadcast(
          JSON.stringify({
            type: 'sync',
            planes: Object.fromEntries(this.planes),
          })
        );
      }

      if (msg.type === 'teleport') {
        const existing = this.planes.get(sender.id);
        if (existing) {
          existing.lat = msg.data.lat;
          existing.lng = msg.data.lng;
          existing.altitude = 500;
          existing.heading = 0;
          existing.pitch = 0;
          existing.roll = 0;
          this.planes.set(sender.id, existing);
        }
      }

      if (msg.type === 'setName') {
        const existing = this.planes.get(sender.id);
        if (existing) {
          existing.name = msg.data.name;
          this.planes.set(sender.id, existing);
        }
      }
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  }

  onClose(conn: Party.Connection) {
    this.planes.delete(conn.id);
    this.room.broadcast(
      JSON.stringify({
        type: 'playerLeft',
        id: conn.id,
      })
    );
  }
}
