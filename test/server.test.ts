import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import type { Probot } from "probot";
import type { AppRegistry, RegisteredApp } from "../src/apps/registry.js";
import { Allowlist } from "../src/security/allowlist.js";
import { GuardedApp } from "../src/security/guard.js";
import { handleWebhook, TARGET_ID_HEADER, TARGET_TYPE_HEADER } from "../src/webhook-route.js";

const APP_ID = 12345;
const WEBHOOK_PATH = "/webhook";
/** Mirrors the limit `server.ts` wires into `express.raw`. */
const MAX_PAYLOAD = "10mb";

function fakeLogger(): { log: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const log: Record<string, unknown> = {
    warn,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  log.child = vi.fn(() => log);
  return { log: log as unknown as Logger, warn };
}

/** Minimal Probot stand-in: just the surface `handleWebhook` and GuardedApp use. */
function fakeProbot() {
  const verifyAndReceive = vi.fn().mockResolvedValue(undefined);
  const on = vi.fn();
  const probot = { on, webhooks: { verifyAndReceive } } as unknown as Probot;
  return { probot, verifyAndReceive, on };
}

function registeredApp(probot: Probot): RegisteredApp {
  return { appId: APP_ID, label: "test-app", probot, webhookSecret: "test-secret" };
}

/** The only registry method the route uses. */
function fakeRegistry(app: RegisteredApp | undefined): AppRegistry {
  return {
    get: (appId: number) => (appId === APP_ID ? app : undefined),
  } as unknown as AppRegistry;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

/** Mount the same route surface as `server.ts`, on an ephemeral port. */
async function startServer(registry: AppRegistry, log: Logger): Promise<string> {
  const app = express();
  app.disable("x-powered-by");
  app.post(
    WEBHOOK_PATH,
    express.raw({ type: "*/*", limit: MAX_PAYLOAD }),
    (req, res) => void handleWebhook(req, res, registry, log),
  );

  const server = createServer(app);
  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}${WEBHOOK_PATH}`;
}

function headers(overrides: Record<string, string | null> = {}): Record<string, string> {
  const values: Record<string, string> = {
    "content-type": "application/json",
    "x-github-delivery": "delivery-1",
    "x-github-event": "push",
    "x-hub-signature-256": "sha256=deadbeef",
    [TARGET_ID_HEADER]: String(APP_ID),
    [TARGET_TYPE_HEADER]: "integration",
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete values[key];
    else values[key] = value;
  }

  return values;
}

function post(
  url: string,
  body: string,
  headerOverrides: Record<string, string | null> = {},
): Promise<Response> {
  return fetch(url, { method: "POST", headers: headers(headerOverrides), body });
}

describe("handleWebhook", () => {
  it("warns but still responds 200 when the routed App has no handler for the event", async () => {
    const { probot, verifyAndReceive } = fakeProbot();
    // Registered for pull_request.opened only, so pull_request.edited is
    // deliberately uncovered.
    const guarded = new GuardedApp(probot, new Allowlist(["test-org"]));
    guarded.on("pull_request.opened", "white-glove", () => {});

    const { log, warn } = fakeLogger();
    const url = await startServer(fakeRegistry(registeredApp(probot)), log);

    const rawBody = JSON.stringify({ action: "edited" });
    const response = await post(url, rawBody, { "x-github-event": "pull_request" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    // Pin the exact verification input: the name stays the raw event header
    // (never the dot-scoped form the coverage check keys on) and the payload
    // stays byte-identical to what was received, since that is what the
    // signature covers.
    expect(verifyAndReceive).toHaveBeenCalledOnce();
    expect(verifyAndReceive).toHaveBeenCalledWith({
      id: "delivery-1",
      name: "pull_request",
      signature: "sha256=deadbeef",
      payload: rawBody,
    });
    expect(warn).toHaveBeenCalledWith(
      { deliveryId: "delivery-1", event: "pull_request", action: "edited", appId: APP_ID },
      "Delivery routed to an App with no handler for this event",
    );
  });

  it("follows the normal path without warning for a handled event", async () => {
    const { probot, verifyAndReceive } = fakeProbot();
    const guarded = new GuardedApp(probot, new Allowlist(["test-org"]));
    guarded.on("push", "settings-sync", () => {});

    const { log, warn } = fakeLogger();
    const url = await startServer(fakeRegistry(registeredApp(probot)), log);

    const response = await post(url, JSON.stringify({ ref: "refs/heads/main" }));

    expect(response.status).toBe(200);
    expect(verifyAndReceive).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not throw on an unparseable payload and leaves the action unknown", async () => {
    const { probot, verifyAndReceive } = fakeProbot();
    const guarded = new GuardedApp(probot, new Allowlist(["test-org"]));
    guarded.on("pull_request.opened", "white-glove", () => {});

    const { log, warn } = fakeLogger();
    const url = await startServer(fakeRegistry(registeredApp(probot)), log);

    // Not JSON: the sniff must degrade to "action unknown", not throw.
    const response = await post(url, "this is not json", { "x-github-event": "issues" });

    expect(response.status).toBe(200);
    expect(verifyAndReceive).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();

    const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ deliveryId: "delivery-1", event: "issues", appId: APP_ID });
    // Presence of the key with an undefined value, not a fabricated action.
    expect(Object.hasOwn(fields, "action")).toBe(true);
    expect(fields.action).toBeUndefined();
    expect(message).toBe("Delivery routed to an App with no handler for this event");
  });

  it("rejects a delivery with no signature header with 400 and warns", async () => {
    const { probot, verifyAndReceive } = fakeProbot();
    const { log, warn } = fakeLogger();
    const url = await startServer(fakeRegistry(registeredApp(probot)), log);

    const response = await post(url, "{}", { "x-hub-signature-256": null });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "missing required GitHub webhook headers",
    });
    expect(verifyAndReceive).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { deliveryId: "delivery-1", event: "push" },
      "Delivery rejected: missing required GitHub webhook headers",
    );
  });

  it("rejects a delivery with no delivery ID header with 400 and warns", async () => {
    const { probot, verifyAndReceive } = fakeProbot();
    const { log, warn } = fakeLogger();
    const url = await startServer(fakeRegistry(registeredApp(probot)), log);

    // Delivery ID omitted; event and signature are present. The spec asks the
    // rejection warning name whatever is known, so the event must survive even
    // though the delivery ID is absent.
    const response = await post(url, "{}", { "x-github-delivery": null });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "missing required GitHub webhook headers",
    });
    expect(verifyAndReceive).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();

    const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.event).toBe("push");
    expect(fields.deliveryId).toBeUndefined();
    expect(message).toBe("Delivery rejected: missing required GitHub webhook headers");
  });

  it("rejects an unknown App with 404 and warns", async () => {
    const { log, warn } = fakeLogger();
    const url = await startServer(fakeRegistry(undefined), log);

    const response = await post(url, "{}");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "unknown App" });
    expect(warn).toHaveBeenCalledWith(
      { deliveryId: "delivery-1", event: "push", appId: APP_ID },
      "Rejected delivery for an App this instance does not serve",
    );
  });

  it("logs the unroutable warning and still rejects an invalid signature with 400", async () => {
    const { probot, verifyAndReceive } = fakeProbot();
    verifyAndReceive.mockRejectedValue(
      Object.assign(new Error("signature does not match"), { status: 400 }),
    );

    const guarded = new GuardedApp(probot, new Allowlist(["test-org"]));
    guarded.on("pull_request.opened", "white-glove", () => {});

    const { log, warn } = fakeLogger();
    const url = await startServer(fakeRegistry(registeredApp(probot)), log);

    const response = await post(url, JSON.stringify({ action: "opened" }), {
      "x-github-event": "issues",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid signature" });
    expect(warn).toHaveBeenCalledWith(
      { deliveryId: "delivery-1", event: "issues", action: "opened", appId: APP_ID },
      "Delivery routed to an App with no handler for this event",
    );
    expect(warn).toHaveBeenCalledWith(
      { deliveryId: "delivery-1", event: "issues", app: "test-app" },
      "Rejected delivery with an invalid signature",
    );
  });

  it("warns and proceeds normally when there is no coverage record", async () => {
    const { probot, verifyAndReceive } = fakeProbot();
    // Never handed to a GuardedApp, so the WeakMap lookup misses.
    const { log, warn } = fakeLogger();
    const url = await startServer(fakeRegistry(registeredApp(probot)), log);

    const response = await post(url, JSON.stringify({ ref: "refs/heads/main" }));

    expect(response.status).toBe(200);
    expect(verifyAndReceive).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      { deliveryId: "delivery-1", event: "push", appId: APP_ID },
      "Delivery routed to an App with no coverage record; treating as handled",
    );
  });
});
