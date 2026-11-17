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
