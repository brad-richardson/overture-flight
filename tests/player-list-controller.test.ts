import { describe, expect, it, vi } from 'vitest';
import {
  getCurrentPlayerPosition,
  isRemotePlayerId,
  playerListEntryChanged,
  playerListSignature,
  PlayerListRenderController,
  staleRemotePlayerIds,
} from '../src/player-list-controller.js';
import type { PlaneState } from '../src/plane.js';

function plane(
  id: string,
  overrides: Partial<PlaneState> = {}
): PlaneState {
  return {
    id,
    lat: 40,
    lng: -70,
    altitude: 500,
    heading: 0,
    pitch: 0,
    roll: 0,
    speed: 80,
    color: '#3b82f6',
    name: '',
    ...overrides,
  };
}

describe('player list render controller', () => {
  it('renders the first state, including an empty multiplayer map, exactly once', () => {
    const render = vi.fn();
    const controller = new PlayerListRenderController(render);
    const players = new Map<string, PlaneState>();

    expect(controller.update(players, 'local')).toBe(true);
    expect(controller.update(players, 'local')).toBe(false);
    expect(render).toHaveBeenCalledOnce();
  });

  it('ignores motion-only updates but renders displayed metadata and membership changes', () => {
    const render = vi.fn();
    const controller = new PlayerListRenderController(render);
    const players = new Map([['remote', plane('remote')]]);

    controller.update(players, 'local');
    players.set('remote', plane('remote', {
      lat: 50,
      lng: 10,
      altitude: 900,
      heading: 180,
      pitch: 4,
      roll: 5,
      speed: 120,
    }));
    expect(controller.update(players, 'local')).toBe(false);

    // This explicit name renders identically to the fallback and stays clean.
    players.set('remote', plane('remote', { name: 'Player mote' }));
    expect(controller.update(players, 'local')).toBe(false);

    players.set('remote', plane('remote', { name: 'Pilot', color: '#ef4444' }));
    expect(controller.update(players, 'local')).toBe(true);
    players.delete('remote');
    expect(controller.update(players, 'local')).toBe(true);
    expect(render).toHaveBeenCalledTimes(3);
  });

  it('checks steady-state dirtiness in O(1) from membership, name, and color only', () => {
    const previous = plane('remote');

    expect(playerListEntryChanged(undefined, previous)).toBe(true);
    expect(playerListEntryChanged(previous, plane('remote', {
      lat: 55,
      lng: 12,
      altitude: 1_000,
      heading: 90,
      pitch: 3,
      roll: 4,
      speed: 150,
    }))).toBe(false);
    expect(playerListEntryChanged(previous, plane('remote', { name: 'Pilot' }))).toBe(true);
    expect(playerListEntryChanged(previous, plane('remote', { color: '#ef4444' }))).toBe(true);
  });

  it('reconciles authoritative snapshots without ever removing the local player', () => {
    const currentIds = ['local', 'stale', 'retained'];
    const snapshotIds = new Set(['retained', 'joined']);

    expect(staleRemotePlayerIds(currentIds, snapshotIds, 'local')).toEqual(['stale']);
    expect(isRemotePlayerId('local', 'local')).toBe(false);
    expect(isRemotePlayerId('retained', 'local')).toBe(true);
  });

  it('includes ordered IDs and local status in the displayed signature', () => {
    const first = new Map([
      ['one', plane('one')],
      ['two', plane('two')],
    ]);
    const reordered = new Map([
      ['two', plane('two')],
      ['one', plane('one')],
    ]);

    expect(playerListSignature(first, 'one')).not.toBe(
      playerListSignature(reordered, 'one')
    );
    expect(playerListSignature(first, 'one')).not.toBe(
      playerListSignature(first, 'two')
    );
  });

  it('resolves teleport coordinates from the latest state without rerendering', () => {
    const render = vi.fn();
    const controller = new PlayerListRenderController(render);
    const players = new Map([['remote', plane('remote')]]);
    controller.update(players, 'local');

    players.set('remote', plane('remote', { lat: 51.5, lng: -0.12 }));
    expect(controller.update(players, 'local')).toBe(false);
    expect(getCurrentPlayerPosition(players, 'remote')).toEqual({
      lat: 51.5,
      lng: -0.12,
    });

    players.delete('remote');
    expect(getCurrentPlayerPosition(players, 'remote')).toBeNull();
    expect(render).toHaveBeenCalledOnce();
  });
});
