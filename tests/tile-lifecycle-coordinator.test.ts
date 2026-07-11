import { describe, expect, it } from 'vitest';
import { TileLifecycleCoordinator } from '../src/tile-lifecycle-coordinator.js';

describe('TileLifecycleCoordinator', () => {
  it('rejects a duplicate claim without consuming additional capacity', () => {
    const lifecycle = new TileLifecycleCoordinator<string>(2);
    const token = lifecycle.claim('14/1/2');

    expect(token).not.toBeNull();
    expect(lifecycle.claim('14/1/2')).toBeNull();
    expect(lifecycle.outstandingCount).toBe(1);
  });

  it('invalidates a claimed token by generation and identity', () => {
    const lifecycle = new TileLifecycleCoordinator<string>();
    const token = lifecycle.claim('14/1/2')!;

    expect(lifecycle.isCurrent(token)).toBe(true);
    expect(lifecycle.invalidate()).toBe(1);
    expect(lifecycle.isCurrent(token)).toBe(false);
    expect(lifecycle.hasClaim('14/1/2')).toBe(false);
    expect(lifecycle.outstandingCount).toBe(1);
  });

  it('allows a same-key replacement without giving stale cleanup ownership', () => {
    const lifecycle = new TileLifecycleCoordinator<string>();
    const stale = lifecycle.claim('14/1/2')!;
    lifecycle.invalidate();
    const replacement = lifecycle.claim('14/1/2')!;

    expect(lifecycle.isCurrent(replacement)).toBe(true);
    expect(lifecycle.release(stale)).toBe(true);
    expect(lifecycle.owns(replacement)).toBe(true);
    expect(lifecycle.outstandingCount).toBe(1);
  });

  it('makes repeated or stale releases idempotent', () => {
    const lifecycle = new TileLifecycleCoordinator<string>();
    const token = lifecycle.claim('14/1/2')!;

    lifecycle.invalidate();
    expect(lifecycle.release(token)).toBe(true);
    expect(lifecycle.release(token)).toBe(false);
    expect(lifecycle.outstandingCount).toBe(0);
  });

  it('counts invalidated work against the outstanding budget until release', () => {
    const lifecycle = new TileLifecycleCoordinator<string>(1);
    const stale = lifecycle.claim('14/1/2')!;

    lifecycle.invalidate();
    expect(lifecycle.hasCapacity).toBe(false);
    expect(lifecycle.claim('14/1/3')).toBeNull();

    lifecycle.release(stale);
    expect(lifecycle.hasCapacity).toBe(true);
    expect(lifecycle.claim('14/1/3')).not.toBeNull();
  });

  it('can retain claims across invalidation to prevent same-key overlap', () => {
    const lifecycle = new TileLifecycleCoordinator<string>();
    const stale = lifecycle.claim('14/1/2')!;

    lifecycle.invalidate({ retainClaims: true });
    expect(lifecycle.isCurrent(stale)).toBe(false);
    expect(lifecycle.claim('14/1/2')).toBeNull();

    lifecycle.release(stale);
    expect(lifecycle.claim('14/1/2')).not.toBeNull();
  });
});
