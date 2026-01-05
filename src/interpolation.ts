import { NETWORK } from './constants.js';
import type { PlaneState } from './plane.js';

/**
 * Interpolated player state with target tracking
 */
interface InterpolatedPlayer {
  current: PlaneState;
  target: PlaneState;
}

// Store interpolated states for remote players
const interpolatedPlayers = new Map<string, InterpolatedPlayer>();

/**
 * Normalize angle to 0-360 range
 */
function normalizeAngle(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

/**
 * Interpolate between two angles, taking the shortest path
 */
function lerpAngle(current: number, target: number, t: number): number {
  current = normalizeAngle(current);
  target = normalizeAngle(target);

  let diff = target - current;

  // Take the shortest path
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;

  return normalizeAngle(current + diff * t);
}

/**
 * Linear interpolation
 */
function lerp(current: number, target: number, t: number): number {
  return current + (target - current) * t;
}

/**
 * Set target state for a remote player
 */
export function setPlayerTarget(id: string, target: PlaneState): void {
  const existing = interpolatedPlayers.get(id);

  if (existing) {
    // Update target, keep current position for smooth interpolation
    existing.target = { ...target };
  } else {
    // New player, start at target position
    interpolatedPlayers.set(id, {
      current: { ...target },
      target: { ...target },
    });
  }
}

/**
 * Get interpolated state for a remote player
 */
export function getInterpolatedState(id: string): PlaneState | null {
  const player = interpolatedPlayers.get(id);
  return player ? { ...player.current } : null;
}

/**
 * Update all interpolated players (call each frame)
 */
export function updateInterpolation(deltaTime: number): void {
  const t = Math.min(1, deltaTime * NETWORK.INTERPOLATION_SPEED);

  for (const [, player] of interpolatedPlayers) {
    // Interpolate position
    player.current.lat = lerp(player.current.lat, player.target.lat, t);
    player.current.lng = lerp(player.current.lng, player.target.lng, t);
    player.current.altitude = lerp(player.current.altitude, player.target.altitude, t);

    // Interpolate rotation (using angle lerp for heading)
    player.current.heading = lerpAngle(player.current.heading, player.target.heading, t);
    player.current.pitch = lerp(player.current.pitch, player.target.pitch, t);
    player.current.roll = lerp(player.current.roll, player.target.roll, t);

    // Interpolate speed
    player.current.speed = lerp(player.current.speed, player.target.speed, t);

    // Copy non-interpolated properties
    player.current.color = player.target.color;
    player.current.name = player.target.name;
    player.current.id = player.target.id;
  }
}

/**
 * Remove a player from interpolation
 */
export function removeInterpolatedPlayer(id: string): void {
  interpolatedPlayers.delete(id);
}

/**
 * Check if a player exists in interpolation
 */
export function hasInterpolatedPlayer(id: string): boolean {
  return interpolatedPlayers.has(id);
}

/**
 * Get all interpolated player IDs
 */
export function getInterpolatedPlayerIds(): string[] {
  return Array.from(interpolatedPlayers.keys());
}

/**
 * Clear all interpolated players
 */
export function clearInterpolatedPlayers(): void {
  interpolatedPlayers.clear();
}
