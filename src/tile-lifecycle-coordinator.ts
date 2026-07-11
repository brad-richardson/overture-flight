const lifecycleTokenBrand: unique symbol = Symbol('lifecycle-token');

/** Exact identity for one key-scoped unit of asynchronous tile work. */
export interface TileLifecycleToken<Key> {
  readonly key: Key;
  readonly generation: number;
  readonly [lifecycleTokenBrand]: true;
}

export interface InvalidateOptions {
  /**
   * Keep key ownership until each invalidated request settles. This prevents a
   * replacement from overlapping work for the same tile in another origin.
   */
  retainClaims?: boolean;
}

/**
 * Owns the lifecycle of key-scoped asynchronous tile work.
 *
 * Generation validity, exact request ownership, and outstanding work are
 * deliberately separate concepts: invalidated work is no longer current, but
 * still consumes real resources until it settles.
 */
export class TileLifecycleCoordinator<Key> {
  private generationValue = 0;
  private readonly claims = new Map<Key, TileLifecycleToken<Key>>();
  private readonly outstandingTokens = new Set<TileLifecycleToken<Key>>();

  constructor(private readonly maxOutstanding = Number.POSITIVE_INFINITY) {
    if (maxOutstanding <= 0) {
      throw new RangeError('maxOutstanding must be greater than zero');
    }
  }

  get generation(): number {
    return this.generationValue;
  }

  get outstandingCount(): number {
    return this.outstandingTokens.size;
  }

  get hasCapacity(): boolean {
    return this.outstandingCount < this.maxOutstanding;
  }

  hasClaim(key: Key): boolean {
    return this.claims.has(key);
  }

  /** Claim a key if it is neither owned nor over the outstanding-work budget. */
  claim(key: Key): TileLifecycleToken<Key> | null {
    if (this.hasClaim(key) || !this.hasCapacity) {
      return null;
    }

    const token: TileLifecycleToken<Key> = {
      key,
      generation: this.generationValue,
      [lifecycleTokenBrand]: true,
    };
    this.claims.set(key, token);
    this.outstandingTokens.add(token);
    return token;
  }

  owns(token: TileLifecycleToken<Key>): boolean {
    return this.claims.get(token.key) === token;
  }

  isCurrent(token: TileLifecycleToken<Key>): boolean {
    return token.generation === this.generationValue && this.owns(token);
  }

  /**
   * Settle a request exactly once. A stale token can reduce the outstanding
   * count, but can never release a newer request's same-key claim.
   */
  release(token: TileLifecycleToken<Key>): boolean {
    if (!this.outstandingTokens.delete(token)) {
      return false;
    }

    if (this.owns(token)) {
      this.claims.delete(token.key);
    }
    return true;
  }

  /** Invalidate current work and return the new generation identifier. */
  invalidate(options: InvalidateOptions = {}): number {
    this.generationValue++;
    if (!options.retainClaims) {
      this.claims.clear();
    }
    return this.generationValue;
  }
}
