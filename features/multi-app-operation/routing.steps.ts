import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import type { Request, Response } from "express";
import type { Logger } from "pino";
import type { Probot } from "probot";
import type { AppRegistry, RegisteredApp } from "../../src/apps/registry.js";
import { Allowlist } from "../../src/security/allowlist.js";
import { GuardedApp } from "../../src/security/guard.js";
import { handleWebhook, TARGET_ID_HEADER, TARGET_TYPE_HEADER } from "../../src/webhook-route.js";

const feature = await loadFeature("features/multi-app-operation/routing.feature");

const APP_ID = 111;

type ScenarioVariables = Record<string, unknown>;

/** Read one Examples cell. A missing cell is a malformed scenario, not a value to guess. */
function readCell(variables: ScenarioVariables, key: string): string {
  const value = variables[key];
  if (typeof value !== "string") {
    throw new Error(`Scenario outline row is missing a string "${key}" cell.`);
  }
  return value;
}

/** Map a placeholder cell such as "absent" to the undefined header the route sees. */
function readOptionalCell(cell: string, absent = "absent"): string | undefined {
  if (cell === absent) return undefined;
  const quoted = /^"([^"]*)"$/.exec(cell);
  if (quoted === null) {
    throw new Error(`Unrecognised cell value: ${JSON.stringify(cell)}`);
  }
  return quoted[1];
}

function fakeLogger(): {
  log: Logger;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  const error = vi.fn();
  const info = vi.fn();
  const debug = vi.fn();
  const log: Record<string, unknown> = { warn, error, info, debug };
  log.child = vi.fn(() => log);
  return { log: log as unknown as Logger, warn, error, info, debug };
}

/** Minimal Probot stand-in: just the surface `handleWebhook` and GuardedApp use. */
function fakeProbot(): {
  probot: Probot;
  verifyAndReceive: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
} {
  const verifyAndReceive = vi.fn().mockResolvedValue(undefined);
  const on = vi.fn();
  const probot = { on, webhooks: { verifyAndReceive } } as unknown as Probot;
  return { probot, verifyAndReceive, on };
}

/** The headers GitHub sends with an App delivery, overridable per scenario. */
function headers(overrides: Record<string, string | null> = {}): Record<string, string> {
  const values: Record<string, string> = {
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

/** Express request stand-in: header lookup is lowercase, as `req.get` normalises it. */
function request(headerValues: Record<string, string>, body: string): Request {
  return {
    get: (name: string) => headerValues[name.toLowerCase()],
    body,
  } as unknown as Request;
}

/** Express response stand-in capturing the chained `status().json()` result. */
function fakeResponse(): {
  res: Response;
  status: () => number | undefined;
  body: () => unknown;
} {
  let statusCode: number | undefined;
  let responseBody: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      responseBody = payload;
      return res;
    },
  } as unknown as Response;
  return { res, status: () => statusCode, body: () => responseBody };
}

function registeredApp(probot: Probot, webhookSecret = "test-secret"): RegisteredApp {
  return { appId: APP_ID, label: "test-app", probot, webhookSecret };
}

/** The only registry method the route uses. */
function registryServing(app: RegisteredApp | undefined): AppRegistry {
  return {
    get: (appId: number) => (appId === APP_ID ? app : undefined),
  } as unknown as AppRegistry;
}

/** A registry that fails the test if the route consults it at all. */
function unconsultedRegistry(): AppRegistry {
  return {
    get: () => {
      throw new Error("The registry must not be consulted for this delivery.");
    },
  } as unknown as AppRegistry;
}

function assertRejection(
  captured: { status: () => number | undefined; body: () => unknown },
  status: number,
  error: string,
): void {
  expect(captured.status()).toBe(status);
  expect(captured.body()).toEqual({ error });
}

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  Scenario(`Unknown App`, ({ Given, When, Then, And }) => {
    const { log, warn } = fakeLogger();
    const { probot, verifyAndReceive } = fakeProbot();
    let registry: AppRegistry | undefined;
    const captured = fakeResponse();

    Given(`an instance serving App 111 only`, () => {
      registry = registryServing(registeredApp(probot));
    });
    When(`a delivery arrives for App 99999`, async () => {
      if (registry === undefined) {
        throw new Error("The instance has not been started yet.");
      }
      await handleWebhook(
        request(headers({ [TARGET_ID_HEADER]: "99999" }), "{}"),
        captured.res,
        registry,
        log,
      );
    });
    Then(`the delivery is rejected with 404 and "unknown App"`, () => {
      assertRejection(captured, 404, "unknown App");
      expect(verifyAndReceive).not.toHaveBeenCalled();
    });
    And(`a warning is logged naming the delivery "delivery-1" and the App 99999`, () => {
      expect(warn).toHaveBeenCalledWith(
        { deliveryId: "delivery-1", event: "push", appId: 99999 },
        "Rejected delivery for an App this instance does not serve",
      );
    });
  });

  Scenario(`Repository-level webhook`, ({ When, Then }) => {
    const { log, warn } = fakeLogger();
    const captured = fakeResponse();

    When(`a delivery arrives with target type "repository"`, async () => {
      await handleWebhook(
        request(headers({ [TARGET_TYPE_HEADER]: "repository" }), "{}"),
        captured.res,
        unconsultedRegistry(),
        log,
      );
    });
    Then(`the delivery is rejected with 400 and "unsupported webhook target type"`, () => {
      assertRejection(captured, 400, "unsupported webhook target type");
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        { deliveryId: "delivery-1", event: "push", targetType: "repository" },
        "Ignoring delivery that did not come from a GitHub App",
      );
    });
  });

  Scenario(`Forged header, no matching signature`, ({ Given, When, Then }) => {
    const { log, warn } = fakeLogger();
    const { probot, verifyAndReceive } = fakeProbot();
    let registry: AppRegistry | undefined;
    const captured = fakeResponse();

    Given(`an instance serving App 111 with webhook secret "alpha"`, () => {
      registry = registryServing(registeredApp(probot, "alpha"));
      // The App is registered for "push", so coverage adds no warning of its own.
      const guarded = new GuardedApp(probot, new Allowlist(["test-org"]));
      guarded.on("push", "settings-sync", () => {});
      verifyAndReceive.mockRejectedValue(
        Object.assign(new Error("signature does not match"), { status: 400 }),
      );
    });
    When(`a delivery for App 111 arrives signed with the secret "beta"`, async () => {
      if (registry === undefined) {
        throw new Error("The instance has not been started yet.");
      }
      await handleWebhook(request(headers(), "{}"), captured.res, registry, log);
    });
    Then(`the delivery is rejected with 400 and "invalid signature"`, () => {
      assertRejection(captured, 400, "invalid signature");
      expect(warn).toHaveBeenCalledWith(
        { deliveryId: "delivery-1", event: "push", app: "test-app" },
        "Rejected delivery with an invalid signature",
      );
    });
  });

  Scenario(`Handler failure is surfaced`, ({ Given, When, Then }) => {
    const { log } = fakeLogger();
    const { probot, verifyAndReceive } = fakeProbot();
    let registry: AppRegistry | undefined;
    const captured = fakeResponse();

    Given(`an instance serving App 111`, () => {
      registry = registryServing(registeredApp(probot));
      const guarded = new GuardedApp(probot, new Allowlist(["test-org"]));
      guarded.on("push", "settings-sync", () => {});
      verifyAndReceive.mockRejectedValue(new Error("boom"));
    });
    When(`a delivery arrives whose handler throws`, async () => {
      if (registry === undefined) {
        throw new Error("The instance has not been started yet.");
      }
      await handleWebhook(request(headers(), "{}"), captured.res, registry, log);
    });
    Then(`the delivery is rejected with 500 so GitHub marks it failed and can redeliver it`, () => {
      assertRejection(captured, 500, "handler failed");
    });
  });

  Scenario(`Event with no registered handler`, ({ Given, When, Then, And }) => {
    const { log, warn } = fakeLogger();
    const { probot, verifyAndReceive } = fakeProbot();
    let registry: AppRegistry | undefined;
    let rawBody: string | undefined;
    const captured = fakeResponse();

    Given(`the App registered for "pull_request.opened" only`, () => {
      registry = registryServing(registeredApp(probot));
      const guarded = new GuardedApp(probot, new Allowlist(["test-org"]));
      guarded.on("pull_request.opened", "white-glove", () => {});
    });
    When(`a "pull_request" delivery with action "edited" arrives`, async () => {
      if (registry === undefined) {
        throw new Error("The instance has not been started yet.");
      }
      rawBody = JSON.stringify({ action: "edited" });
      await handleWebhook(
        request(headers({ "x-github-event": "pull_request" }), rawBody),
        captured.res,
        registry,
        log,
      );
    });
    Then(`the delivery is accepted with 200`, () => {
      expect(captured.status()).toBe(200);
      expect(captured.body()).toEqual({ ok: true });
    });
    And(
      `a warning is logged naming the delivery "delivery-1", the event "pull_request", the action "edited" and the App 111`,
      () => {
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(
          { deliveryId: "delivery-1", event: "pull_request", action: "edited", appId: APP_ID },
          "Delivery routed to an App with no handler for this event",
        );
      },
    );
    And(`the delivery is verified and received with its exact payload`, () => {
      if (rawBody === undefined) {
        throw new Error("The delivery body has not been sent yet.");
      }
      expect(verifyAndReceive).toHaveBeenCalledOnce();
      const call = verifyAndReceive.mock.calls[0]?.[0] as {
        id: string;
        name: string;
        signature: string;
        payload: string;
      };
      expect(call).toEqual({
        id: "delivery-1",
        // The raw event header, never the dot-scoped coverage form.
        name: "pull_request",
        signature: "sha256=deadbeef",
        payload: rawBody,
      });
      expect(call.payload).toBe(rawBody);
    });
  });

  Scenario(`Handled event keeps the normal path`, ({ Given, When, Then }) => {
    const { log, warn } = fakeLogger();
    const { probot, verifyAndReceive } = fakeProbot();
    let registry: AppRegistry | undefined;
    const captured = fakeResponse();

    Given(`the App registered for "push"`, () => {
      registry = registryServing(registeredApp(probot));
      const guarded = new GuardedApp(probot, new Allowlist(["test-org"]));
      guarded.on("push", "settings-sync", () => {});
    });
    When(`a "push" delivery arrives`, async () => {
      if (registry === undefined) {
        throw new Error("The instance has not been started yet.");
      }
      await handleWebhook(
        request(headers(), JSON.stringify({ ref: "refs/heads/main" })),
        captured.res,
        registry,
        log,
      );
    });
    Then(`the delivery is accepted without a warning`, () => {
      expect(captured.status()).toBe(200);
      expect(captured.body()).toEqual({ ok: true });
      expect(verifyAndReceive).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalled();
    });
  });

  ScenarioOutline(`Payload action unknown`, ({ Given, When, Then, And }, variables) => {
    const { log, warn } = fakeLogger();
    const { probot, verifyAndReceive } = fakeProbot();
    let registry: AppRegistry | undefined;
    const captured = fakeResponse();

    Given(`the served App has no listener for "pull_request"`, () => {
      registry = registryServing(registeredApp(probot));
      const guarded = new GuardedApp(probot, new Allowlist(["test-org"]));
      guarded.on("pull_request.opened", "white-glove", () => {});
    });
    When(
      `a "pull_request" delivery arrives whose action is unreadable because <cause>`,
      async () => {
        if (registry === undefined) {
          throw new Error("The instance has not been started yet.");
        }
        const cause = readCell(variables, "cause").trim();
        let body: string;
        switch (cause) {
          case "the body is not JSON":
            body = "this is not json";
            break;
          case "the action is not a string":
            body = JSON.stringify({ action: { nested: "x" } });
            break;
          default:
            throw new Error(`Unrecognised cause phrase: ${JSON.stringify(cause)}`);
        }
        await handleWebhook(
          request(headers({ "x-github-event": "pull_request" }), body),
          captured.res,
          registry,
          log,
        );
      },
    );
    Then(`the delivery is still accepted with 200`, () => {
      expect(captured.status()).toBe(200);
      expect(captured.body()).toEqual({ ok: true });
      expect(verifyAndReceive).toHaveBeenCalledOnce();
    });
    And(
      `a warning is logged with the action omitted naming the delivery "delivery-1", the event "pull_request" and the App 111`,
      () => {
        expect(warn).toHaveBeenCalledOnce();
        const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
        expect(fields).toEqual({
          deliveryId: "delivery-1",
          event: "pull_request",
          action: undefined,
          appId: APP_ID,
        });
        // The key survives with an undefined value; pino omits it when
        // serialising, so this is what "the action omitted" means in a log.
        expect(Object.hasOwn(fields, "action")).toBe(true);
        expect(fields.action).toBeUndefined();
        expect(message).toBe("Delivery routed to an App with no handler for this event");
      },
    );
  });

  ScenarioOutline(
    `Missing headers rejected and logged`,
    ({ Given, When, Then, And }, variables) => {
      const { log, warn } = fakeLogger();
      const { probot, verifyAndReceive } = fakeProbot();
      let registry: AppRegistry | undefined;
      const captured = fakeResponse();

      Given(`a serving instance for App 111`, () => {
        registry = registryServing(registeredApp(probot));
      });
      When(`a delivery arrives without <header>`, async () => {
        if (registry === undefined) {
          throw new Error("The instance has not been started yet.");
        }
        const header = readCell(variables, "header").trim();
        let omitted: string;
        switch (header) {
          case "the delivery ID":
            omitted = "x-github-delivery";
            break;
          case "the event":
            omitted = "x-github-event";
            break;
          case "the signature":
            omitted = "x-hub-signature-256";
            break;
          default:
            throw new Error(`Unrecognised header phrase: ${JSON.stringify(header)}`);
        }
        await handleWebhook(
          request(headers({ [omitted]: null }), "{}"),
          captured.res,
          registry,
          log,
        );
      });
      Then(
        `the delivery is rejected with 400 and "missing required GitHub webhook headers"`,
        () => {
          assertRejection(captured, 400, "missing required GitHub webhook headers");
        },
      );
      And(`a warning records the delivery ID as <delivery> and the event as <event>`, () => {
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(
          {
            deliveryId: readOptionalCell(readCell(variables, "delivery")),
            event: readOptionalCell(readCell(variables, "event")),
          },
          "Delivery rejected: missing required GitHub webhook headers",
        );
      });
      And(`the delivery is not verified`, () => {
        expect(verifyAndReceive).not.toHaveBeenCalled();
      });
    },
  );
});
