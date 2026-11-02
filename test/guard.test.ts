import { describe, expect, it, vi } from "vitest";
import type { EmitterWebhookEventName } from "@octokit/webhooks";
import type { Probot } from "probot";
import { Allowlist } from "../src/security/allowlist.js";
import { GuardedApp, guardedFor } from "../src/security/guard.js";

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
  const onCalls: unknown[] = [];
  const app = {
    on: (events: unknown, cb: (ctx: unknown) => Promise<void>) => {
      onCalls.push(events);
      registered = cb;
    },
  } as unknown as Probot;
  return {
    app,
    onCalls,
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

describe("GuardedApp coverage", () => {
  it("records a bare event registration as covering every action", () => {
    const { app } = fakeApp();
    const guarded = new GuardedApp(app, allowlist);
    guarded.on("push", "t", vi.fn());

    expect(guarded.handlesEvent("push")).toBe(true);
    expect(guarded.handlesEvent("push", "created")).toBe(true);
    expect(guarded.handlesEvent("pull_request")).toBe(false);
  });

  it("records an action-scoped registration verbatim", () => {
    const { app } = fakeApp();
    const guarded = new GuardedApp(app, allowlist);
    guarded.on("pull_request.opened", "t", vi.fn());

    expect(guarded.handlesEvent("pull_request", "opened")).toBe(true);
    expect(guarded.handlesEvent("pull_request.edited")).toBe(false);
    expect(guarded.handlesEvent("pull_request", "edited")).toBe(false);
    // D1: the bare form is not recorded alongside an action-scoped name, so a
    // query for the event alone must not claim coverage.
    expect(guarded.handlesEvent("pull_request")).toBe(false);
    // The submitted name is stored exactly as given.
    expect(guarded.handlesEvent("pull_request.opened")).toBe(true);
  });

  it("records each event of an array registration individually", () => {
    const { app } = fakeApp();
    const guarded = new GuardedApp(app, allowlist);
    guarded.on(["pull_request.opened", "pull_request.reopened"], "t", vi.fn());

    expect(guarded.handlesEvent("pull_request", "opened")).toBe(true);
    expect(guarded.handlesEvent("pull_request", "reopened")).toBe(true);
    expect(guarded.handlesEvent("pull_request", "synchronize")).toBe(false);
    expect(guarded.handlesEvent("check_run", "completed")).toBe(false);
  });

  it("treats a * registration as covering every event and action", () => {
    const { app } = fakeApp();
    const guarded = new GuardedApp(app, allowlist);
    guarded.on("*" as EmitterWebhookEventName, "t", vi.fn());

    expect(guarded.handlesEvent("push")).toBe(true);
    expect(guarded.handlesEvent("pull_request", "edited")).toBe(true);
  });

  it("reports unregistered events and actions as uncovered", () => {
    const { app } = fakeApp();
    const guarded = new GuardedApp(app, allowlist);

    expect(guarded.handlesEvent("issues")).toBe(false);
    expect(guarded.handlesEvent("issues", "opened")).toBe(false);
  });

  it("records without adding listeners to the Probot emitter", () => {
    const { app, onCalls } = fakeApp();
    const guarded = new GuardedApp(app, allowlist);
    guarded.on(["pull_request.opened", "pull_request.reopened"], "t", vi.fn());

    expect(onCalls).toEqual([["pull_request.opened", "pull_request.reopened"]]);
  });

  it("looks up the GuardedApp by its Probot instance", () => {
    const { app } = fakeApp();
    const other = fakeApp().app;
    const guarded = new GuardedApp(app, allowlist);

    expect(guardedFor(app)).toBe(guarded);
    expect(guardedFor(other)).toBeUndefined();
  });
});
