export const MULTIPLAYER_LIMITS = {
  MAX_INBOUND_BYTES: 2_048,
  MAX_ID_LENGTH: 128,
  MAX_NAME_LENGTH: 20,
  LAT_MIN: -90,
  LAT_MAX: 90,
  ALTITUDE_MIN: 0,
  ALTITUDE_MAX: 10_000,
  SPEED_MIN: 0,
  SPEED_MAX: 500,
  PITCH_MIN: -90,
  PITCH_MAX: 90,
  ROLL_MIN: -180,
  ROLL_MAX: 180,
} as const;

export const MULTIPLAYER_RATE_LIMIT = {
  WINDOW_MS: 1_000,
  MAX_MESSAGES: 30,
  MAX_STRIKES: 3,
} as const;

export interface PlaneSnapshot {
  id: string;
  lat: number;
  lng: number;
  altitude: number;
  heading: number;
  pitch: number;
  roll: number;
  speed: number;
  color: string;
  name: string;
}

export type PositionData = Pick<
  PlaneSnapshot,
  'lat' | 'lng' | 'altitude' | 'heading' | 'pitch' | 'roll' | 'speed'
>;

export type ClientMessage =
  | { type: 'position'; data: PositionData }
  | { type: 'teleport'; data: Pick<PositionData, 'lat' | 'lng'> }
  | { type: 'setName'; data: { name: string } };

export type ServerMessage =
  | { type: 'welcome'; id: string; color: string; planes: Record<string, PlaneSnapshot> }
  | { type: 'sync'; planes: Record<string, PlaneSnapshot> }
  | { type: 'playerJoined'; player: PlaneSnapshot }
  | { type: 'playerUpdated'; player: PlaneSnapshot }
  | { type: 'playerLeft'; id: string }
  | { type: 'error'; message: string };

export interface FixedWindowRateState {
  windowStartedAt: number;
  messageCount: number;
  strikes: number;
  windowViolated: boolean;
}

export interface RateLimitDecision {
  allowed: boolean;
  shouldClose: boolean;
  state: FixedWindowRateState;
}

export interface ConnectionProtocolState {
  plane: PlaneSnapshot;
  rate: FixedWindowRateState;
}

interface ConnectionStateView {
  id: string;
  state: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeLongitude(value: number): number {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function normalizeHeading(value: number): number {
  return ((value % 360) + 360) % 360;
}

function boundedString(value: unknown, maximumLength: number): string | null {
  return typeof value === 'string' && value.length <= maximumLength ? value : null;
}

function parsePositionData(value: unknown): PositionData | null {
  if (!isPlainObject(value)) return null;

  const lat = finiteNumber(value.lat);
  const lng = finiteNumber(value.lng);
  const altitude = finiteNumber(value.altitude);
  const heading = finiteNumber(value.heading);
  const pitch = finiteNumber(value.pitch);
  const roll = finiteNumber(value.roll);
  const speed = finiteNumber(value.speed);
  if (
    lat === null || lng === null || altitude === null || heading === null ||
    pitch === null || roll === null || speed === null
  ) return null;

  return {
    lat: clamp(lat, MULTIPLAYER_LIMITS.LAT_MIN, MULTIPLAYER_LIMITS.LAT_MAX),
    lng: normalizeLongitude(lng),
    altitude: clamp(
      altitude,
      MULTIPLAYER_LIMITS.ALTITUDE_MIN,
      MULTIPLAYER_LIMITS.ALTITUDE_MAX
    ),
    heading: normalizeHeading(heading),
    pitch: clamp(pitch, MULTIPLAYER_LIMITS.PITCH_MIN, MULTIPLAYER_LIMITS.PITCH_MAX),
    roll: clamp(roll, MULTIPLAYER_LIMITS.ROLL_MIN, MULTIPLAYER_LIMITS.ROLL_MAX),
    speed: clamp(speed, MULTIPLAYER_LIMITS.SPEED_MIN, MULTIPLAYER_LIMITS.SPEED_MAX),
  };
}

function parsePlaneSnapshot(value: unknown): PlaneSnapshot | null {
  if (!isPlainObject(value)) return null;
  const id = boundedString(value.id, MULTIPLAYER_LIMITS.MAX_ID_LENGTH);
  const color = boundedString(value.color, 32);
  const name = value.name === undefined
    ? ''
    : boundedString(value.name, MULTIPLAYER_LIMITS.MAX_NAME_LENGTH);
  const position = parsePositionData(value);
  if (id === null || id.length === 0 || color === null || name === null || position === null) {
    return null;
  }
  return { id, color, name, ...position };
}

function parsePlaneRecord(value: unknown): Record<string, PlaneSnapshot> | null {
  if (!isPlainObject(value)) return null;
  const planes: Record<string, PlaneSnapshot> = {};
  for (const planeValue of Object.values(value)) {
    const plane = parsePlaneSnapshot(planeValue);
    if (!plane) return null;
    planes[plane.id] = plane;
  }
  return planes;
}

export function getInboundByteLength(message: string | ArrayBuffer | ArrayBufferView): number {
  if (typeof message === 'string') return new TextEncoder().encode(message).byteLength;
  return message.byteLength;
}

export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isPlainObject(value) || typeof value.type !== 'string') return null;

  if (value.type === 'position') {
    const data = parsePositionData(value.data);
    return data ? { type: 'position', data } : null;
  }

  if (value.type === 'teleport') {
    if (!isPlainObject(value.data)) return null;
    const lat = finiteNumber(value.data.lat);
    const lng = finiteNumber(value.data.lng);
    if (lat === null || lng === null) return null;
    return {
      type: 'teleport',
      data: {
        lat: clamp(lat, MULTIPLAYER_LIMITS.LAT_MIN, MULTIPLAYER_LIMITS.LAT_MAX),
        lng: normalizeLongitude(lng),
      },
    };
  }

  if (value.type === 'setName') {
    if (!isPlainObject(value.data) || typeof value.data.name !== 'string') return null;
    return {
      type: 'setName',
      data: { name: value.data.name.trim().slice(0, MULTIPLAYER_LIMITS.MAX_NAME_LENGTH) },
    };
  }

  return null;
}

export function parseServerMessage(value: unknown): ServerMessage | null {
  if (!isPlainObject(value) || typeof value.type !== 'string') return null;

  if (value.type === 'welcome') {
    const id = boundedString(value.id, MULTIPLAYER_LIMITS.MAX_ID_LENGTH);
    const color = boundedString(value.color, 32);
    const planes = parsePlaneRecord(value.planes);
    return id && color !== null && planes ? { type: 'welcome', id, color, planes } : null;
  }
  if (value.type === 'sync') {
    const planes = parsePlaneRecord(value.planes);
    return planes ? { type: 'sync', planes } : null;
  }
  if (value.type === 'playerJoined' || value.type === 'playerUpdated') {
    const player = parsePlaneSnapshot(value.player);
    return player ? { type: value.type, player } : null;
  }
  if (value.type === 'playerLeft') {
    const id = boundedString(value.id, MULTIPLAYER_LIMITS.MAX_ID_LENGTH);
    return id && id.length > 0 ? { type: 'playerLeft', id } : null;
  }
  if (value.type === 'error') {
    const message = boundedString(value.message, 256);
    return message === null ? null : { type: 'error', message };
  }
  return null;
}

export function createRateLimitState(now: number): FixedWindowRateState {
  return {
    windowStartedAt: Number.isFinite(now) ? now : 0,
    messageCount: 0,
    strikes: 0,
    windowViolated: false,
  };
}

export function checkFixedWindowRateLimit(
  previous: FixedWindowRateState,
  now: number
): RateLimitDecision {
  const safeNow = Number.isFinite(now) ? Math.max(now, previous.windowStartedAt) : previous.windowStartedAt;
  const elapsed = safeNow - previous.windowStartedAt;
  const elapsedWindows = Math.floor(elapsed / MULTIPLAYER_RATE_LIMIT.WINDOW_MS);
  const rolledWindow = elapsedWindows >= 1;
  const state: FixedWindowRateState = rolledWindow
    ? {
        windowStartedAt: safeNow,
        messageCount: 0,
        strikes: elapsedWindows > 1
          ? 0
          : previous.windowViolated
            ? previous.strikes
            : Math.max(0, previous.strikes - 1),
        windowViolated: false,
      }
    : { ...previous };

  state.messageCount++;
  if (state.messageCount <= MULTIPLAYER_RATE_LIMIT.MAX_MESSAGES) {
    return { allowed: true, shouldClose: false, state };
  }

  if (!state.windowViolated) {
    state.windowViolated = true;
    state.strikes++;
  }
  return {
    allowed: false,
    shouldClose: state.strikes >= MULTIPLAYER_RATE_LIMIT.MAX_STRIKES,
    state,
  };
}

export function reconstructPlaneRecord(
  connections: Iterable<ConnectionStateView>
): Record<string, PlaneSnapshot> {
  const planes: Record<string, PlaneSnapshot> = {};
  for (const connection of connections) {
    if (!isPlainObject(connection.state)) continue;
    const plane = parsePlaneSnapshot(connection.state.plane);
    if (plane && plane.id === connection.id) planes[plane.id] = plane;
  }
  return planes;
}
