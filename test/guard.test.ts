import { describe, expect, it, vi } from "vitest";
import type { Probot } from "probot";
import { Allowlist } from "../src/security/allowlist.js";
import { GuardedApp } from "../src/security/guard.js";

function fakeLogger() {
  const log: Record<string, unknown> = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  log.child = vi.fn(() => log);
  return log as never;
}

/** Minimal Probot stand-in that captures the registered emitter callback. */
function fakeApp() {
  let registered: ((ctx: unknown) => Promise<void>) | undefined;
  const app = {
    on: (_events: unknown, cb: (ctx: unknown) => Promise<void>) => {
      registered = cb;
    },
  } as unknown as Probot;
  return {
    app,
    deliver: (payload: unknown) => {
      if (registered === undefined) throw new Error("no handler registered");
      return registered({
        name: "check_run",
        id: "delivery-1",
        payload,
        log: fakeLogger(),
      });
    },
  };
}

const allowlist = new Allowlist(["trusted-org"]);

describe("GuardedApp", () => {
  it("runs the handler for an allowlisted owner", async () => {
    const { app, deliver } = fakeApp();
    const handler = vi.fn();
    new GuardedApp(app, allowlist).on("check_run", "t", handler);

    await deliver({
      repository: { name: "repo", owner: { login: "trusted-org" } },
    });

    expect(handler).toHaveBeenCalledOnce();
    const scope = handler.mock.calls[0]?.[1];
    expect(scope).toMatchObject({
      owner: "trusted-org",
      repo: "repo",
      deliveryId: "delivery-1",
    });
  });

  it("does not invoke the handler for a non-allowlisted owner", async () => {
    const { app, deliver } = fakeApp();
    const handler = vi.fn();
    new GuardedApp(app, allowlist).on("check_run", "t", handler);

    await deliver({
      repository: { name: "repo", owner: { login: "some-stranger" } },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("does not invoke the handler when the owner cannot be resolved", async () => {
    const { app, deliver } = fakeApp();
    const handler = vi.fn();
    new GuardedApp(app, allowlist).on("check_run", "t", handler);

    await deliver({ sender: { login: "trusted-org" } });

    // sender matching an allowlist entry must not be enough.
    expect(handler).not.toHaveBeenCalled();
  });

  it("swallows rejection rather than failing the delivery", async () => {
    const { app, deliver } = fakeApp();
    new GuardedApp(app, allowlist).on("check_run", "t", vi.fn());
    await expect(
      deliver({ repository: { name: "r", owner: { login: "nope" } } }),
    ).resolves.toBeUndefined();
  });

  it("rethrows handler errors so the delivery is marked failed", async () => {
    const { app, deliver } = fakeApp();
    new GuardedApp(app, allowlist).on("check_run", "t", () => {
      throw new Error("boom");
    });

    await expect(
      deliver({ repository: { name: "r", owner: { login: "trusted-org" } } }),
    ).rejects.toThrow("boom");
  });
});
