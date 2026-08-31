/**
 * Per-key serial execution.
 *
 * Several check runs typically complete within milliseconds of each other, so
 * without serialisation we would evaluate and write the same commit
 * concurrently: two handlers both see "no existing check run" and both POST,
 * producing duplicate white-glove checks, or a stale evaluation lands after a
 * fresh one and reverts it.
 *
 * Single-replica deployment means an in-process lock is sufficient. Under
 * multiple replicas this would need to move to Redis.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();

    // Swallow the predecessor's rejection so one failure does not cascade
    // through everything else queued on the same key.
    const result = previous.then(fn, fn);

    this.tails.set(
      key,
      result.catch(() => undefined),
    );

    try {
      return await result;
    } finally {
      // Only clear if nothing else queued behind us in the meantime.
      if (this.tails.get(key) !== undefined) {
        const current = this.tails.get(key);
        void Promise.resolve(current).then(() => {
          if (this.tails.get(key) === current) this.tails.delete(key);
        });
      }
    }
  }

  get pending(): number {
    return this.tails.size;
  }
}
