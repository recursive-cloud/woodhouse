/**
 * Environment parsing and validation.
 *
 * Everything is read and validated exactly once, at boot. A misconfigured
 * deployment should fail to start loudly rather than run with a subtly wrong
 * (and possibly wide-open) security posture.
 */

import { DEFAULT_BASELINE_REPO } from "../config/resolver.js";

export interface WoodhouseEnv {
  /** Path to the CommonJS file describing the GitHub Apps to serve. */
  readonly appsConfigPath: string;
  /**
   * Default allowlist, applied to any App that does not define its own.
   * Undefined is permitted only when every App defines one.
   */
  readonly allowedInstallationTargets: readonly string[] | undefined;
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
      "An installation allowlist is required and must list at least one " +
        "owner. Refusing to start without one.",
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

  // Credentials are no longer read here: they belong to individual Apps and
  // are assembled by the configuration file, which may map whatever variable
  // names the operator's secret tooling produces.
  const rawTargets = env.ALLOWED_INSTALLATION_TARGETS;

  return {
    appsConfigPath: env.APPS_CONFIG_PATH ?? "config/apps.cjs",
    allowedInstallationTargets:
      rawTargets === undefined || rawTargets.trim() === ""
        ? undefined
        : parseAllowedTargets(rawTargets),
    baselineRepo: parseBaselineRepo(env.BASELINE_REPO),
    port,
    host: env.HOST,
    webhookPath: env.WEBHOOK_PATH ?? "/api/github/webhooks",
    logLevel: logLevel as WoodhouseEnv["logLevel"],
    dryRun: parseBool(env.DRY_RUN, false),
  };
}
