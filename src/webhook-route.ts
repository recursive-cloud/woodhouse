/**
 * Webhook route.
 *
 * Extracted from `server.ts` so tests can mount the same handler without
 * importing the module that calls `main()` at load time. Everything here runs
 * before the signature is verified, so it must not trust or log payload
 * contents beyond the bounded action token.
 */

import type { Request, Response } from "express";
import type { Logger } from "pino";
import type { AppRegistry } from "./apps/registry.js";
import { isRequestRejection } from "./lib/webhook-errors.js";
import { guardedFor } from "./security/guard.js";

/** GitHub identifies the App that sent a delivery with these headers. */
export const TARGET_ID_HEADER = "x-github-hook-installation-target-id";
export const TARGET_TYPE_HEADER = "x-github-hook-installation-target-type";

/** GitHub action names are lowercase words joined by `_` or `-`. */
const ACTION_PATTERN = /^[a-z0-9_-]{1,64}$/;

/**
 * Read the delivery's `action` from the raw payload, or undefined.
 *
 * The payload has not been signature-verified yet, so this is deliberately
 * bounded: exactly one parse, and only a GitHub-shaped action token is
 * returned. An unparseable body, a non-string action, or arbitrary attacker
 * text — which could otherwise walk megabytes of garbage into a log line — all
 * degrade to "unknown", and the coverage check runs event-only. Nothing else
 * of the payload is read, retained or logged on this path.
 */
function sniffAction(payload: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }

  const action = (parsed as { action?: unknown } | null)?.action;
  return typeof action === "string" && ACTION_PATTERN.test(action) ? action : undefined;
}

export async function handleWebhook(
  req: Request,
  res: Response,
  registry: AppRegistry,
  log: Logger,
): Promise<void> {
  const deliveryId = req.get("x-github-delivery");
  const event = req.get("x-github-event");
  const signature = req.get("x-hub-signature-256");
  const targetId = req.get(TARGET_ID_HEADER);
  const targetType = req.get(TARGET_TYPE_HEADER);

  if (deliveryId === undefined || event === undefined || signature === undefined) {
    log.warn({ deliveryId, event }, "Delivery rejected: missing required GitHub webhook headers");
    res.status(400).json({ error: "missing required GitHub webhook headers" });
    return;
  }

  // Only App-level deliveries are meaningful; a repository or organisation
  // webhook has no App to attribute it to and no secret we would know.
  if (targetType !== undefined && targetType.toLowerCase() !== "integration") {
    log.warn(
      { deliveryId, event, targetType },
      "Ignoring delivery that did not come from a GitHub App",
    );
    res.status(400).json({ error: "unsupported webhook target type" });
    return;
  }

  const appId = Number(targetId);
  if (!Number.isInteger(appId) || appId <= 0) {
    log.warn({ deliveryId, event, targetId }, "Delivery has no usable App ID");
    res.status(400).json({ error: "missing App ID header" });
    return;
  }

  const app = registry.get(appId);
  if (app === undefined) {
    // Not an error condition: something is pointed at this endpoint that we
    // are not configured to serve. Say so once, clearly, and move on.
    log.warn(
      { deliveryId, event, appId },
      "Rejected delivery for an App this instance does not serve",
    );
    res.status(404).json({ error: "unknown App" });
    return;
  }

  const payload = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");
  const action = sniffAction(payload);

  // Coverage decides whether to log, never the status: an App that deliberately
  // ignores event types still accepts them, and marking those deliveries failed
  // in GitHub's UI would be noise. A missing record is an invariant break, not
  // something to hide, so it is made observable and the normal path continues.
  const guarded = guardedFor(app.probot);
  if (guarded === undefined) {
    log.warn(
      { deliveryId, event, appId },
      "Delivery routed to an App with no coverage record; treating as handled",
    );
  } else if (!guarded.handlesEvent(event, action)) {
    log.warn(
      { deliveryId, event, action, appId },
      "Delivery routed to an App with no handler for this event",
    );
  }

  try {
    // Verification uses this App's own secret. The target ID header that
    // selected it is unauthenticated, but that is harmless: it only decides
    // which key to try, and a forged value simply picks a key the sender
    // cannot produce a valid signature for.
    await app.probot.webhooks.verifyAndReceive({
      id: deliveryId,
      name: event as never,
      signature,
      payload,
    });
    res.status(200).json({ ok: true });
  } catch (error) {
    if (isRequestRejection(error)) {
      log.warn(
        { deliveryId, event, app: app.label },
        "Rejected delivery with an invalid signature",
      );
      res.status(400).json({ error: "invalid signature" });
      return;
    }

    // A handler threw. The guard has already logged it with full context;
    // return 500 so the delivery is marked failed and can be redelivered.
    res.status(500).json({ error: "handler failed" });
  }
}
