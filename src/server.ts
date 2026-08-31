/**
 * Headless entrypoint.
 *
 * Probot's `run()` helper mounts a landing page, a setup wizard and static
 * assets. None of those are wanted here: this process only ever needs to
 * receive webhooks, so we construct the Server ourselves and mount nothing but
 * the webhook endpoint and a health probe. Smaller attack surface, and no
 * chance of the setup wizard appearing if a credential is briefly missing.
 */

import { Probot, Server } from "probot";
import { createApp } from "./app.js";
import { ConfigurationError, loadEnv } from "./lib/env.js";
import { createLogger } from "./lib/logger.js";

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      // No logger yet, and this must be visible in container logs.
      process.stderr.write(
        `${JSON.stringify({
          level: "fatal",
          msg: error.message,
          name: "woodhouse",
          time: new Date().toISOString(),
        })}\n`,
      );
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  const log = createLogger({ level: env.logLevel });

  const server = new Server({
    port: env.port,
    ...(env.host !== undefined ? { host: env.host } : {}),
    webhookPath: env.webhookPath,
    log: log.child({ component: "server" }),
    Probot: Probot.defaults({
      appId: env.appId,
      privateKey: env.privateKey,
      secret: env.webhookSecret,
      log: log.child({ component: "probot" }),
    }),
    // Per-request HTTP access logs are noise for a webhook-only service; the
    // handlers emit their own structured events with far more context.
    loggingOptions: { autoLogging: false },
  });

  server.expressApp.disable("x-powered-by");

  // Kubernetes probes. Liveness only — readiness is the same thing here, as
  // the process has no dependencies to warm up.
  server.expressApp.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  await server.load(createApp({ env }));
  await server.start();

  const shutdown = (signal: string) => {
    server.log.info({ signal }, "Shutting down");
    void server.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      level: "fatal",
      msg: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      time: new Date().toISOString(),
    })}\n`,
  );
  process.exit(1);
});
