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

// Validation constants
const LIMITS = {
  LAT_MIN: -90,
  LAT_MAX: 90,
  LNG_MIN: -180,
  LNG_MAX: 180,
  ALT_MIN: 0,
  ALT_MAX: 10000,
  SPEED_MIN: 0,
  SPEED_MAX: 500,
};

// Rate limiting constants
const RATE_LIMIT = {
  MIN_INTERVAL_MS: 30,  // Minimum ms between position messages
  MAX_VIOLATIONS: 10,   // Max violations before warning
};

/**
 * Validate and clamp position data
 */
function validatePositionData(data: Partial<PlaneState>): Partial<PlaneState> | null {
  if (typeof data.lat !== 'number' || typeof data.lng !== 'number') {
    return null;
  }

  return {
    lat: Math.max(LIMITS.LAT_MIN, Math.min(LIMITS.LAT_MAX, data.lat)),
    lng: Math.max(LIMITS.LNG_MIN, Math.min(LIMITS.LNG_MAX, data.lng)),
    altitude: Math.max(LIMITS.ALT_MIN, Math.min(LIMITS.ALT_MAX, data.altitude || 0)),
    heading: ((data.heading || 0) % 360 + 360) % 360,
    pitch: Math.max(-90, Math.min(90, data.pitch || 0)),
    roll: Math.max(-180, Math.min(180, data.roll || 0)),
    speed: Math.max(LIMITS.SPEED_MIN, Math.min(LIMITS.SPEED_MAX, data.speed || 0)),
  };
}

// Rate limit tracking per connection
interface RateLimitInfo {
  lastMessageTime: number;
  violations: number;
}

export default class FlightServer implements Party.Server {
  options: Party.ServerOptions = { hibernate: true };
  planes: Map<string, PlaneState> = new Map();
  colorIndex: number = 0;
  rateLimits: Map<string, RateLimitInfo> = new Map();

  constructor(readonly room: Party.Room) {}

  onConnect(conn: Party.Connection) {
    const color = COLORS[this.colorIndex % COLORS.length];
    this.colorIndex++;
    const id = conn.id;

    // Initialize rate limiting for this connection
    this.rateLimits.set(id, { lastMessageTime: 0, violations: 0 });

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

      // Rate limiting for position updates
      if (msg.type === 'position') {
        const now = Date.now();
        const rateInfo = this.rateLimits.get(sender.id);

        if (rateInfo) {
          const elapsed = now - rateInfo.lastMessageTime;

          if (elapsed < RATE_LIMIT.MIN_INTERVAL_MS) {
            rateInfo.violations++;
            if (rateInfo.violations === RATE_LIMIT.MAX_VIOLATIONS) {
              console.warn(`Rate limit violations from ${sender.id}: ${rateInfo.violations}`);
            }
            // Drop the message if sent too fast
            return;
          }

          // Reset violations on valid message timing
          if (rateInfo.violations > 0 && elapsed >= RATE_LIMIT.MIN_INTERVAL_MS * 2) {
            rateInfo.violations = Math.max(0, rateInfo.violations - 1);
          }
          rateInfo.lastMessageTime = now;
        }
      }

      if (msg.type === 'position') {
        const validated = validatePositionData(msg.data);
        if (!validated) {
          console.warn('Invalid position data from', sender.id);
          return;
        }

        const existing = this.planes.get(sender.id);
        const plane: PlaneState = {
          ...validated,
          id: sender.id,
          color: existing?.color || '#888',
          name: existing?.name,
        } as PlaneState;
        this.planes.set(sender.id, plane);

        // Broadcast updated state to all OTHER clients (exclude sender)
        this.room.broadcast(
          JSON.stringify({
            type: 'sync',
            planes: Object.fromEntries(this.planes),
          }),
          [sender.id]
        );
      }

      if (msg.type === 'teleport') {
        const existing = this.planes.get(sender.id);
        if (existing && typeof msg.data?.lat === 'number' && typeof msg.data?.lng === 'number') {
          existing.lat = Math.max(LIMITS.LAT_MIN, Math.min(LIMITS.LAT_MAX, msg.data.lat));
          existing.lng = Math.max(LIMITS.LNG_MIN, Math.min(LIMITS.LNG_MAX, msg.data.lng));
          existing.altitude = 500;
          existing.heading = 0;
          existing.pitch = 0;
          existing.roll = 0;
          this.planes.set(sender.id, existing);
        }
      }

      if (msg.type === 'setName') {
        const existing = this.planes.get(sender.id);
        if (existing && typeof msg.data?.name === 'string') {
          existing.name = msg.data.name.slice(0, 20); // Limit name length
          this.planes.set(sender.id, existing);
        }
      }
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  }

  onClose(conn: Party.Connection) {
    this.planes.delete(conn.id);
    this.rateLimits.delete(conn.id);
    this.room.broadcast(
      JSON.stringify({
        type: 'playerLeft',
        id: conn.id,
      })
    );
  }
}
