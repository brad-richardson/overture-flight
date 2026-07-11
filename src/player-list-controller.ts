import type { PlaneState } from './plane.js';

export interface PlayerListProjection {
  id: string;
  displayName: string;
  color: string;
  isLocal: boolean;
}

export function getPlayerListDisplayName(
  id: string,
  name: string,
  isLocal: boolean
): string {
  if (name) return name;
  const shortId = id.slice(-4);
  return isLocal ? `You (${shortId})` : `Player ${shortId}`;
}

/** Position/orientation are intentionally absent from the displayed-row predicate. */
export function playerListEntryChanged(
  previous: PlaneState | undefined,
  next: PlaneState
): boolean {
  return !previous || previous.name !== next.name || previous.color !== next.color;
}

export function isRemotePlayerId(id: string, localId: string): boolean {
  return id !== localId;
}

/** Find remote rows that are absent from an authoritative multiplayer snapshot. */
export function staleRemotePlayerIds(
  currentPlayerIds: Iterable<string>,
  snapshotPlayerIds: ReadonlySet<string>,
  localId: string
): string[] {
  return Array.from(currentPlayerIds).filter(
    id => isRemotePlayerId(id, localId) && !snapshotPlayerIds.has(id)
  );
}

export function projectPlayerList(
  players: ReadonlyMap<string, PlaneState>,
  localId: string
): PlayerListProjection[] {
  return Array.from(players, ([id, player]) => ({
    id,
    displayName: getPlayerListDisplayName(id, player.name, id === localId),
    color: player.color,
    isLocal: id === localId,
  }));
}

export function playerListSignature(
  players: ReadonlyMap<string, PlaneState>,
  localId: string
): string {
  return JSON.stringify(projectPlayerList(players, localId));
}

export function getCurrentPlayerPosition(
  players: ReadonlyMap<string, PlaneState>,
  id: string
): Pick<PlaneState, 'lat' | 'lng'> | null {
  const player = players.get(id);
  return player ? { lat: player.lat, lng: player.lng } : null;
}

type PlayerListRenderer = (players: Map<string, PlaneState>, localId: string) => void;

/** Render once initially, then only when the displayed projection changes. */
export class PlayerListRenderController {
  private lastSignature: string | null = null;

  constructor(private readonly render: PlayerListRenderer) {}

  update(players: Map<string, PlaneState>, localId: string): boolean {
    const signature = playerListSignature(players, localId);
    if (signature === this.lastSignature) return false;

    this.render(players, localId);
    this.lastSignature = signature;
    return true;
  }
}
