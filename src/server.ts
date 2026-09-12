/**
 * Headless multi-App webhook server.
 *
 * Probot's own `run()` helper assumes a single App and mounts a landing page,
 * a setup wizard and static assets. None of that applies here: Woodhouse is a
 * private App, registered separately by each user or organisation, so one
 * container serves several Apps and needs nothing but a webhook endpoint.
 *
 * Probot is therefore used as a library. Express owns the HTTP surface, and
 * each incoming delivery is routed to the right Probot instance before its
 * signature is verified — necessarily, since each App has its own secret.
 */

import express, { type Request, type Response } from "express";
import { createServer, type Server as HttpServer } from "node:http";
import { AppRegistry, loadAppDefinitions } from "./apps/registry.js";
import { ConfigurationError, loadEnv } from "./lib/env.js";
import { createLogger } from "./lib/logger.js";
import { isRequestRejection } from "./lib/webhook-errors.js";

/** GitHub identifies the App that sent a delivery with these headers. */
const TARGET_ID_HEADER = "x-github-hook-installation-target-id";
const TARGET_TYPE_HEADER = "x-github-hook-installation-target-type";

/**
 * Deliveries are capped well above anything GitHub sends (payloads are
 * documented as up to 25 MB, but in practice are orders of magnitude smaller)
 * so a malformed or hostile request cannot exhaust memory.
 */
const MAX_PAYLOAD = "10mb";

function fatal(message: string, stack?: string): never {
  process.stderr.write(
    `${JSON.stringify({
      level: "fatal",
      msg: message,
      stack,
      name: "woodhouse",
      time: new Date().toISOString(),
    })}\n`,
  );
  process.exit(78); // EX_CONFIG
}

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof ConfigurationError) fatal(error.message);
    throw error;
  }

  const log = createLogger({ level: env.logLevel });

  let registry: AppRegistry;
  try {
    const definitions = loadAppDefinitions(env.appsConfigPath, process.env);
    registry = await AppRegistry.create(
      definitions,
      {
        allowedInstallationTargets: env.allowedInstallationTargets,
        baselineRepo: env.baselineRepo,
        dryRun: env.dryRun,
      },
      log,
    );
  } catch (error) {
    if (error instanceof ConfigurationError) fatal(error.message);
    throw error;
  }

  log.info(
    {
      apps: registry.list().map((a) => a.label),
      appsConfigPath: env.appsConfigPath,
      dryRun: env.dryRun,
    },
    `Woodhouse reporting for duty, serving ${registry.size} App(s)`,
  );

  const server = express();
  server.disable("x-powered-by");

  // Raw body, because the signature is computed over the exact bytes GitHub
  // sent. Parsing to JSON first and re-serialising would change them.
  server.post(
    env.webhookPath,
    express.raw({ type: "*/*", limit: MAX_PAYLOAD }),
    (req, res) => void handleWebhook(req, res, registry, log),
  );

  server.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", apps: registry.size });
  });

  const httpServer: HttpServer = createServer(server);

  await new Promise<void>((resolvePromise, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(env.port, ...(env.host !== undefined ? [env.host] : []), () => {
      httpServer.off("error", reject);
      resolvePromise();
    });
  });

  log.info(
    { port: env.port, host: env.host ?? "0.0.0.0", webhookPath: env.webhookPath },
    "Listening",
  );

  const shutdown = (signal: string) => {
    log.info({ signal }, "Shutting down");
    httpServer.close(() => process.exit(0));
    // Do not hang forever on a wedged keep-alive connection.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function handleWebhook(
  req: Request,
  res: Response,
  registry: AppRegistry,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  const deliveryId = req.get("x-github-delivery");
  const event = req.get("x-github-event");
  const signature = req.get("x-hub-signature-256");
  const targetId = req.get(TARGET_ID_HEADER);
  const targetType = req.get(TARGET_TYPE_HEADER);

  if (
    deliveryId === undefined ||
    event === undefined ||
    signature === undefined
  ) {
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

  const payload = Buffer.isBuffer(req.body)
    ? req.body.toString("utf8")
    : String(req.body ?? "");

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

main().catch((error: unknown) => {
  fatal(
    error instanceof Error ? error.message : String(error),
    error instanceof Error ? error.stack : undefined,
  );
});
