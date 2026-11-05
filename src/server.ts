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

import express from "express";
import { createServer, type Server as HttpServer } from "node:http";
import { AppRegistry, loadAppDefinitions } from "./apps/registry.js";
import { ConfigurationError, loadEnv } from "./lib/env.js";
import { createLogger } from "./lib/logger.js";
import { handleWebhook } from "./webhook-route.js";

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

main().catch((error: unknown) => {
  fatal(
    error instanceof Error ? error.message : String(error),
    error instanceof Error ? error.stack : undefined,
  );
});
