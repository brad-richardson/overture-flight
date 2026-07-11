/** A bounded LRU of fulfilled values with separate concurrent-load coalescing. */
export class AsyncLruCache<Key, Value> {
  private readonly values = new Map<Key, Value>();
  private readonly inFlight = new Map<Key, Promise<Value>>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('AsyncLruCache maxEntries must be a positive integer');
    }
  }

  getOrLoad(key: Key, load: () => Promise<Value>): Promise<Value> {
    if (this.values.has(key)) {
      const value = this.values.get(key)!;
      // Map insertion order is the LRU order: oldest first, newest last.
      this.values.delete(key);
      this.values.set(key, value);
      return Promise.resolve(value);
    }

    const existingLoad = this.inFlight.get(key);
    if (existingLoad) return existingLoad;

    const pending = Promise.resolve()
      .then(load)
      .then(value => {
        this.values.set(key, value);
        while (this.values.size > this.maxEntries) {
          const oldest = this.values.keys().next();
          if (oldest.done) break;
          this.values.delete(oldest.value);
        }
        return value;
      })
      .finally(() => {
        // Rejections are never retained, so a later call can retry.
        if (this.inFlight.get(key) === pending) {
          this.inFlight.delete(key);
        }
      });

    this.inFlight.set(key, pending);
    return pending;
  }
}
