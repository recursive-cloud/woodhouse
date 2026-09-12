/**
 * Deferred, de-duplicated work.
 *
 * Used for the gatekeeper grace period: when a pull request opens, GitHub has
 * usually not created its check runs yet, so we look again a little later to
 * decide whether any are coming.
 *
 * In-process timers only. That is sound for a single-replica deployment but
 * means pending work is lost on restart — see `cancelAll` and the note in
 * TODO.md about sweeping orphaned checks.
 */

export interface ScheduledTask {
  readonly key: string;
  readonly runAt: number;
}

export class Scheduler {
  private readonly timers = new Map<
    string,
    { timer: NodeJS.Timeout; runAt: number }
  >();

  get size(): number {
    return this.timers.size;
  }

  /**
   * Run `fn` after `delayMs`.
   *
   * If work is already scheduled for `key` the existing timer is kept rather
   * than pushed back, so a rapid burst of pushes to the same commit cannot
   * defer the check indefinitely.
   */
  schedule(
    key: string,
    delayMs: number,
    fn: () => Promise<void> | void,
    onError?: (error: unknown) => void,
  ): void {
    if (this.timers.has(key)) return;

    const timer = setTimeout(() => {
      this.timers.delete(key);
      void (async () => {
        try {
          await fn();
        } catch (error) {
          onError?.(error);
        }
      })();
    }, delayMs);

    // Do not hold the event loop open for a pending grace period; a clean
    // shutdown should not wait on it.
    timer.unref?.();

    this.timers.set(key, { timer, runAt: Date.now() + delayMs });
  }

  cancel(key: string): void {
    const entry = this.timers.get(key);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.timers.delete(key);
  }

  cancelAll(): void {
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  pending(): ScheduledTask[] {
    return [...this.timers.entries()].map(([key, { runAt }]) => ({
      key,
      runAt,
    }));
  }
}
