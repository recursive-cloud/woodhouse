/**
 * Concurrency controls for the settings-sync suites.
 *
 * A manual gate parks the first applier read so two deliveries can be forced to
 * contend; a settled promise chain lets a fire-and-forget handler finish before
 * the scenario inspects its result. This module is not a vitest entry.
 */

/**
 * A promise plus its releaser plus a once-only claim: the first caller to
 * `claim()` is parked on `promise`, every later caller sails through. The
 * once-only claim removes the timing artifact that would make an unsynchronised
 * race look batched.
 */
export interface Gate {
  claim(): boolean;
  readonly promise: Promise<void>;
  release(): void;
}

export function manualGate(): Gate {
  let armed = true;
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    claim(): boolean {
      if (!armed) return false;
      armed = false;
      return true;
    },
    promise,
    release,
  };
}

/** A gate that never parks an applier read: for deliveries that run straight through. */
export const OPEN_GATE: Gate = {
  claim: () => false,
  promise: Promise.resolve(),
  release: () => {},
};

/** Drain every runnable microtask and a bounded number of macrotask turns. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
