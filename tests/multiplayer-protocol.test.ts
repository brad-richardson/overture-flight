import { describe, expect, it } from 'vitest';
import {
  MULTIPLAYER_LIMITS,
  MULTIPLAYER_RATE_LIMIT,
  checkFixedWindowRateLimit,
  createRateLimitState,
  getInboundByteLength,
  parseClientMessage,
  parseServerMessage,
  reconstructPlaneRecord,
  type ConnectionProtocolState,
  type PlaneSnapshot,
} from '../src/multiplayer-protocol.js';

const plane: PlaneSnapshot = {
  id: 'player-1',
  lat: 43.77,
  lng: 11.25,
  altitude: 500,
  heading: 45,
  pitch: 2,
  roll: -3,
  speed: 80,
  color: '#ef4444',
  name: '',
};

describe('multiplayer message validation', () => {
  it('rejects non-finite position values and malformed envelopes', () => {
    expect(parseClientMessage(null)).toBeNull();
    expect(parseClientMessage({ type: 'position', data: { ...plane, lat: Number.NaN } })).toBeNull();
    expect(parseClientMessage({ type: 'position', data: [] })).toBeNull();
    expect(parseClientMessage({ type: 'unknown', data: {} })).toBeNull();
  });

  it('normalizes and clamps bounded position data', () => {
    expect(parseClientMessage({
      type: 'position',
      data: {
        ...plane,
        lat: 100,
        lng: 541,
        altitude: -10,
        heading: -10,
        pitch: 100,
        roll: -200,
        speed: 900,
      },
    })).toEqual({
      type: 'position',
      data: {
        lat: 90,
        lng: -179,
        altitude: 0,
        heading: 350,
        pitch: 90,
        roll: -180,
        speed: 500,
      },
    });
  });

  it('bounds names and identifiers', () => {
    const longName = 'x'.repeat(MULTIPLAYER_LIMITS.MAX_NAME_LENGTH + 10);
    expect(parseClientMessage({ type: 'setName', data: { name: `  ${longName}  ` } }))
      .toEqual({ type: 'setName', data: { name: 'x'.repeat(MULTIPLAYER_LIMITS.MAX_NAME_LENGTH) } });

    expect(parseServerMessage({
      type: 'playerLeft',
      id: 'x'.repeat(MULTIPLAYER_LIMITS.MAX_ID_LENGTH + 1),
    })).toBeNull();
  });

  it('measures UTF-8 payload bytes rather than string code units', () => {
    expect(getInboundByteLength('abc')).toBe(3);
    expect(getInboundByteLength('✈')).toBe(3);
  });

  it('accepts both single-player updates and legacy sync snapshots', () => {
    expect(parseServerMessage({ type: 'playerUpdated', player: plane })).toEqual({
      type: 'playerUpdated',
      player: plane,
    });
    expect(parseServerMessage({ type: 'sync', planes: { [plane.id]: plane } })).toEqual({
      type: 'sync',
      planes: { [plane.id]: plane },
    });
  });
});

describe('fixed-window message policy', () => {
  it('limits every message after the window allowance', () => {
    let state = createRateLimitState(1_000);
    for (let index = 0; index < MULTIPLAYER_RATE_LIMIT.MAX_MESSAGES; index++) {
      const decision = checkFixedWindowRateLimit(state, 1_000 + index);
      expect(decision.allowed).toBe(true);
      state = decision.state;
    }
    const denied = checkFixedWindowRateLimit(state, 1_500);
    expect(denied).toMatchObject({ allowed: false, shouldClose: false });
  });

  it('closes only after abuse continues across multiple windows', () => {
    let state = createRateLimitState(0);
    for (let strike = 0; strike < MULTIPLAYER_RATE_LIMIT.MAX_STRIKES; strike++) {
      for (let count = 0; count <= MULTIPLAYER_RATE_LIMIT.MAX_MESSAGES; count++) {
        const decision = checkFixedWindowRateLimit(state, strike * 1_000);
        state = decision.state;
        if (count === MULTIPLAYER_RATE_LIMIT.MAX_MESSAGES) {
          expect(decision.shouldClose).toBe(strike === MULTIPLAYER_RATE_LIMIT.MAX_STRIKES - 1);
        }
      }
    }
  });

  it('forgives prior strikes after a quiet window', () => {
    let state = createRateLimitState(0);
    for (let count = 0; count <= MULTIPLAYER_RATE_LIMIT.MAX_MESSAGES; count++) {
      state = checkFixedWindowRateLimit(state, 0).state;
    }
    expect(state.strikes).toBe(1);

    const recovered = checkFixedWindowRateLimit(
      state,
      MULTIPLAYER_RATE_LIMIT.WINDOW_MS * 2
    );
    expect(recovered.state.strikes).toBe(0);
    expect(recovered.allowed).toBe(true);
  });
});

describe('hibernated connection reconstruction', () => {
  it('rebuilds a room snapshot from valid live connection state', () => {
    const state: ConnectionProtocolState = { plane, rate: createRateLimitState(0) };
    const invalidState = { ...state, plane: { ...plane, lat: Number.NaN } };
    expect(reconstructPlaneRecord([
      { id: plane.id, state },
      { id: 'invalid', state: invalidState },
      { id: 'missing', state: null },
    ])).toEqual({ [plane.id]: plane });
  });
});
