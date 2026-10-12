import { describe, expect, it, vi } from "vitest";
import { KeyedMutex } from "../src/lib/mutex.js";

/** A promise plus the function that settles it, for manual sequencing. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("KeyedMutex", () => {
  it("does not start the next same-key call until the previous settles", async () => {
    const mutex = new KeyedMutex();
    const order: number[] = [];
    const first = gate();

    const one = mutex.run("k", async () => {
      order.push(1);
      await first.promise;
    });
    const two = mutex.run("k", async () => {
      order.push(2);
    });

    // Let the first call reach its await before checking: the second must
    // still be queued behind it rather than racing ahead.
    await Promise.resolve();
    expect(order).toEqual([1]);

    first.release();
    await Promise.all([one, two]);
    expect(order).toEqual([1, 2]);
  });

  it("runs same-key calls sequentially in start order", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const first = gate();
    const one = mutex.run("k", async () => {
      order.push("one:start");
      await first.promise;
      order.push("one:end");
    });
    const two = mutex.run("k", async () => {
      order.push("two:start");
      order.push("two:end");
    });

    first.release();
    await Promise.all([one, two]);
    expect(order).toEqual(["one:start", "one:end", "two:start", "two:end"]);
  });

  it("interleaves different keys", async () => {
    const mutex = new KeyedMutex();
    const started: string[] = [];
    const first = gate();

    const a = mutex.run("a", async () => {
      started.push("a");
      await first.promise;
    });
    const b = mutex.run("b", async () => {
      started.push("b");
    });

    // `b` completes while `a` is still parked on its gate, proving the two
    // keys do not serialise against one another.
    await b;
    expect(started).toEqual(["a", "b"]);

    first.release();
    await a;
  });

  it("keeps the queue moving after a rejected predecessor", async () => {
    const mutex = new KeyedMutex();
    const after = vi.fn(async () => undefined);

    await expect(
      mutex.run("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await mutex.run("k", after);
    expect(after).toHaveBeenCalledOnce();
  });

  it("reports pending keys", async () => {
    const mutex = new KeyedMutex();
    expect(mutex.pending).toBe(0);

    const first = gate();
    const held = mutex.run("k", () => first.promise);
    expect(mutex.pending).toBe(1);

    first.release();
    await held;
  });
});
