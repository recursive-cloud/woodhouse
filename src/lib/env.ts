/**
 * Environment parsing and validation.
 *
 * Everything is read and validated exactly once, at boot. A misconfigured
 * deployment should fail to start loudly rather than run with a subtly wrong
 * (and possibly wide-open) security posture.
 */

import { DEFAULT_BASELINE_REPO } from "../config/resolver.js";

export interface WoodhouseEnv {
  readonly appId: string;
  readonly privateKey: string;
  readonly webhookSecret: string;
  readonly allowedInstallationTargets: readonly string[];
  readonly baselineRepo: string;
  readonly port: number;
  readonly host: string | undefined;
  readonly webhookPath: string;
  readonly logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  readonly dryRun: boolean;
}

export class ConfigurationError extends Error {
  override name = "ConfigurationError";
}

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === "") {
    throw new ConfigurationError(
      `Missing required environment variable ${key}.`,
    );
  }
  return value;
}

/**
 * The private key is commonly supplied base64-encoded because multi-line env
 * vars are awkward in Kubernetes manifests and Docker. Accept either form.
 */
function readPrivateKey(env: NodeJS.ProcessEnv): string {
  const raw = required(env, "PRIVATE_KEY");
  if (raw.includes("-----BEGIN")) return raw.replace(/\\n/g, "\n");

  const decoded = Buffer.from(raw, "base64").toString("utf8");
  if (decoded.includes("-----BEGIN")) return decoded;

  throw new ConfigurationError(
    "PRIVATE_KEY does not look like a PEM key. Provide the raw .pem contents " +
      "or a base64 encoding of them.",
  );
}

/**
 * Accepts either a JSON array (`["a","b"]`) or a comma-separated list (`a,b`).
 *
 * An empty or absent list is a hard error rather than an implicit "allow all".
 * This app requests administrative scopes; the failure mode of a typo here must
 * be "nothing works" and not "everything is permitted".
 */
export function parseAllowedTargets(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") {
    throw new ConfigurationError(
      "ALLOWED_INSTALLATION_TARGETS is required and must list at least one " +
        "owner. Refusing to start without an installation allowlist.",
    );
  }

  const trimmed = raw.trim();
  let parts: string[];

  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ConfigurationError(
        "ALLOWED_INSTALLATION_TARGETS looks like JSON but could not be parsed.",
      );
    }
    if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string")) {
      throw new ConfigurationError(
        "ALLOWED_INSTALLATION_TARGETS must be an array of strings.",
      );
    }
    parts = parsed as string[];
  } else {
    parts = trimmed.split(",");
  }

  const cleaned = parts.map((p) => p.trim()).filter((p) => p !== "");

  if (cleaned.length === 0) {
    throw new ConfigurationError(
      "ALLOWED_INSTALLATION_TARGETS contained no usable entries.",
    );
  }

  // A literal "*" is rejected outright: there is no legitimate reason for a
  // personal homelab bot with admin scopes to accept every installation.
  const wildcard = cleaned.find((p) => p === "*" || p === "all");
  if (wildcard !== undefined) {
    throw new ConfigurationError(
      `ALLOWED_INSTALLATION_TARGETS may not contain the wildcard "${wildcard}".`,
    );
  }

  return cleaned;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Repository holding the owner-wide baseline config. Defaults to
 * `.github-private` so the config is not forced public alongside the
 * community health files that live in `.github`.
 */
export function parseBaselineRepo(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") return DEFAULT_BASELINE_REPO;

  const value = raw.trim();

  // A slash almost certainly means someone wrote "owner/repo". The owner is
  // always the installation account, so accepting it would silently read from
  // somewhere other than intended.
  if (value.includes("/")) {
    throw new ConfigurationError(
      `BASELINE_REPO must be a repository name only, not "${value}". ` +
        "The owner is always the installation account.",
    );
  }

  if (!/^[A-Za-z0-9-_.]+$/.test(value)) {
    throw new ConfigurationError(
      `BASELINE_REPO is not a valid repository name: "${value}".`,
    );
  }

  return value;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): WoodhouseEnv {
  const logLevel = (env.LOG_LEVEL ?? "info").toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    throw new ConfigurationError(
      `LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}; got "${logLevel}".`,
    );
  }

  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError(`PORT must be a valid port; got "${env.PORT}".`);
  }

  return {
    appId: required(env, "APP_ID"),
    privateKey: readPrivateKey(env),
    webhookSecret: required(env, "WEBHOOK_SECRET"),
    allowedInstallationTargets: parseAllowedTargets(
      env.ALLOWED_INSTALLATION_TARGETS,
    ),
    baselineRepo: parseBaselineRepo(env.BASELINE_REPO),
    port,
    host: env.HOST,
    webhookPath: env.WEBHOOK_PATH ?? "/api/github/webhooks",
    logLevel: logLevel as WoodhouseEnv["logLevel"],
    dryRun: parseBool(env.DRY_RUN, false),
  };
}
