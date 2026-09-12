import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "../src/lib/scheduler.js";

describe("Scheduler", () => {
  it("runs work after the delay", async () => {
    vi.useFakeTimers();
    const scheduler = new Scheduler();
    const fn = vi.fn();

    scheduler.schedule("a", 1000, fn);
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("does not push back existing work when rescheduled", async () => {
    // A burst of pushes to the same commit must not defer the check
    // indefinitely.
    vi.useFakeTimers();
    const scheduler = new Scheduler();
    const fn = vi.fn();

    scheduler.schedule("a", 1000, fn);
    await vi.advanceTimersByTimeAsync(900);
    scheduler.schedule("a", 1000, fn);
    await vi.advanceTimersByTimeAsync(100);

    expect(fn).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("keys work independently", async () => {
    vi.useFakeTimers();
    const scheduler = new Scheduler();
    const a = vi.fn();
    const b = vi.fn();

    scheduler.schedule("a", 1000, a);
    scheduler.schedule("b", 1000, b);
    expect(scheduler.size).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(scheduler.size).toBe(0);
    vi.useRealTimers();
  });

  it("routes errors to the handler instead of rejecting unhandled", async () => {
    vi.useFakeTimers();
    const scheduler = new Scheduler();
    const onError = vi.fn();

    scheduler.schedule("a", 10, () => Promise.reject(new Error("boom")), onError);
    await vi.advanceTimersByTimeAsync(10);

    expect(onError).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("cancels", async () => {
    vi.useFakeTimers();
    const scheduler = new Scheduler();
    const fn = vi.fn();

    scheduler.schedule("a", 1000, fn);
    scheduler.cancel("a");
    await vi.advanceTimersByTimeAsync(2000);

    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("cancelAll clears everything", () => {
    vi.useFakeTimers();
    const scheduler = new Scheduler();
    scheduler.schedule("a", 1000, vi.fn());
    scheduler.schedule("b", 1000, vi.fn());

    scheduler.cancelAll();
    expect(scheduler.size).toBe(0);
    vi.useRealTimers();
  });
});
