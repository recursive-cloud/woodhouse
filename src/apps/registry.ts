/**
 * Multi-App registry.
 *
 * Woodhouse is distributed as a private App: each user or organisation
 * registers their own, so one container has to serve several Apps at once.
 * Every App has distinct credentials *and a distinct webhook secret*, so the
 * receiving App must be identified before the signature can be verified.
 *
 * GitHub sends `X-GitHub-Hook-Installation-Target-ID` on App webhooks, giving
 * the App ID. That header is unauthenticated, but using it is safe: it only
 * selects which secret to try, and the HMAC check still has to pass with that
 * secret. A forged header simply picks a key the attacker cannot sign with.
 */

import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Probot } from "probot";
import type { Logger } from "pino";
import { Allowlist } from "../security/allowlist.js";
import { createApp } from "../app.js";
import { ConfigurationError, parseAllowedTargets } from "../lib/env.js";
import { DEFAULT_BASELINE_REPO } from "../config/resolver.js";

/** One App as described by the configuration file. */
const appDefinitionSchema = z
  .object({
    // `parseInt(env.MISSING, 10)` yields NaN rather than undefined, which is
    // the single most likely mistake here. Normalise it so the targeted
    // message in `resolveDefinitions` fires instead of a bare schema error.
    appId: z.preprocess(
      (value) =>
        typeof value === "number" && Number.isNaN(value) ? undefined : value,
      z
        .union([z.number().int().positive(), z.string().trim().min(1)])
        .optional(),
    ),
    privateKey: z.string().trim().min(1),
    webhookSecret: z.string().trim().min(1),
    /** Overrides the global allowlist for this App only. */
    allowedInstallationTargets: z.array(z.string().trim().min(1)).optional(),
    /** Overrides the global baseline repository for this App only. */
    baselineRepo: z.string().trim().min(1).optional(),
    /** Human-readable name used in logs. Defaults to the App ID. */
    label: z.string().trim().min(1).optional(),
  })
  .strict();

const appMapSchema = z.record(z.string(), appDefinitionSchema);

export type AppDefinition = z.infer<typeof appDefinitionSchema>;

export interface RegisteredApp {
  readonly appId: number;
  readonly label: string;
  readonly probot: Probot;
  readonly webhookSecret: string;
}

export interface RegistryDefaults {
  readonly allowedInstallationTargets: readonly string[] | undefined;
  readonly baselineRepo: string;
  readonly dryRun: boolean;
}

/**
 * Load and evaluate the App configuration file.
 *
 * The file is CommonJS and exports a function of `env`, so that operators can
 * map whatever environment variable names their secret tooling produces onto
 * Woodhouse's expectations without this project having to guess at them.
 *
 * It is `require`d rather than imported so a plain `module.exports` file works
 * even though this package is ESM. Use a `.cjs` extension to make that
 * unambiguous — a `.js` file resolves as CommonJS only when no parent
 * `package.json` declares `"type": "module"`.
 */
export function loadAppDefinitions(
  path: string,
  env: NodeJS.ProcessEnv,
): Record<string, AppDefinition> {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);

  let loaded: unknown;
  try {
    const require = createRequire(pathToFileURL(absolute));
    loaded = require(absolute);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "MODULE_NOT_FOUND") {
      throw new ConfigurationError(
        `App configuration file not found at ${absolute}. Set ` +
          "APPS_CONFIG_PATH, or mount a file at the default location.",
      );
    }
    if (code === "ERR_REQUIRE_ESM") {
      throw new ConfigurationError(
        `${absolute} was treated as an ES module. Use \`module.exports = ...\` ` +
          "and a `.cjs` extension.",
      );
    }
    throw new ConfigurationError(
      `Failed to load app configuration from ${absolute}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Tolerate `export default` shapes from a transpiled file.
  const factory =
    typeof loaded === "function"
      ? loaded
      : (loaded as { default?: unknown } | null)?.default;

  if (typeof factory !== "function") {
    throw new ConfigurationError(
      `${absolute} must export a function taking the environment, e.g. ` +
        "`module.exports = function (env) { return { ... }; };`",
    );
  }

  let produced: unknown;
  try {
    produced = (factory as (e: NodeJS.ProcessEnv) => unknown)(env);
  } catch (error) {
    throw new ConfigurationError(
      `App configuration function threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const parsed = appMapSchema.safeParse(produced ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");

    // A key of "undefined" means the variable used to build it is unset, which
    // is far more useful to say than repeating the schema complaint.
    const hint = parsed.error.issues.some((i) => i.path[0] === "undefined")
      ? ` The App ID variable read by ${absolute} is not set, so the ` +
        "configuration has no usable key."
      : "";

    throw new ConfigurationError(`Invalid app configuration: ${detail}.${hint}`);
  }

  return parsed.data;
}

/**
 * Turn raw definitions into validated, ready-to-serve Apps.
 *
 * Deliberately strict: a half-configured App that silently never receives
 * events would be far harder to diagnose than a refusal to start.
 */
export function resolveDefinitions(
  definitions: Record<string, AppDefinition>,
  defaults: RegistryDefaults,
): {
  appId: number;
  label: string;
  privateKey: string;
  webhookSecret: string;
  allowlist: Allowlist;
  baselineRepo: string;
}[] {
  const entries = Object.entries(definitions);

  if (entries.length === 0) {
    throw new ConfigurationError(
      "No GitHub Apps are configured. The configuration file returned an " +
        "empty object - check that the environment variables it reads are set.",
    );
  }

  const seen = new Map<number, string>();

  return entries.map(([key, definition]) => {
    const appId = Number(definition.appId);

    if (!Number.isInteger(appId) || appId <= 0) {
      // The overwhelmingly common cause is an unset variable, which makes the
      // computed key the string "undefined" and the appId NaN.
      const hint =
        key === "undefined" || definition.appId === undefined
          ? " The environment variable it reads is not set."
          : "";
      throw new ConfigurationError(
        `App "${key}" has an invalid appId: ${JSON.stringify(definition.appId)}.${hint}`,
      );
    }

    // The map key is what incoming webhooks are matched against, so a key that
    // disagrees with its own appId would mean events are silently misrouted or
    // dropped.
    if (key.trim() !== String(appId)) {
      throw new ConfigurationError(
        `App key "${key}" does not match its appId ${appId}. The key must be ` +
          "the App ID, since that is what incoming webhooks are matched on.",
      );
    }

    if (seen.has(appId)) {
      throw new ConfigurationError(`Duplicate App ID ${appId}.`);
    }
    seen.set(appId, key);

    const privateKey = normalisePrivateKey(definition.privateKey, appId);

    // Each App must end up with an allowlist, from its own definition or the
    // global default. Without one there is no boundary at all.
    const targets =
      definition.allowedInstallationTargets ??
      defaults.allowedInstallationTargets;

    if (targets === undefined || targets.length === 0) {
      throw new ConfigurationError(
        `App ${appId} has no installation allowlist. Set either ` +
          "`allowedInstallationTargets` on this App in the configuration " +
          "file, which is all that is needed, or the " +
          "ALLOWED_INSTALLATION_TARGETS environment variable as a default " +
          "for every App. Refusing to start without a boundary.",
      );
    }

    // Reuse the global parser so `*` is rejected here too.
    const allowlist = new Allowlist(parseAllowedTargets(targets.join(",")));

    return {
      appId,
      label: definition.label ?? String(appId),
      privateKey,
      webhookSecret: definition.webhookSecret,
      allowlist,
      baselineRepo: definition.baselineRepo ?? defaults.baselineRepo,
    };
  });
}

/** Accepts a raw PEM, an escaped single-line PEM, or base64 of either. */
function normalisePrivateKey(raw: string, appId: number): string {
  if (raw.includes("-----BEGIN")) return raw.replace(/\\n/g, "\n");

  const decoded = Buffer.from(raw, "base64").toString("utf8");
  if (decoded.includes("-----BEGIN")) return decoded;

  throw new ConfigurationError(
    `App ${appId} has a private key that is not a PEM. Provide the raw .pem ` +
      "contents or a base64 encoding of them.",
  );
}

export class AppRegistry {
  private readonly byId = new Map<number, RegisteredApp>();

  private constructor(apps: RegisteredApp[]) {
    for (const app of apps) this.byId.set(app.appId, app);
  }

  static async create(
    definitions: Record<string, AppDefinition>,
    defaults: RegistryDefaults,
    log: Logger,
  ): Promise<AppRegistry> {
    const resolved = resolveDefinitions(definitions, defaults);
    const apps: RegisteredApp[] = [];

    for (const entry of resolved) {
      const probot = new Probot({
        appId: entry.appId,
        privateKey: entry.privateKey,
        secret: entry.webhookSecret,
        log: log.child({ component: "probot", app: entry.label }),
      });

      await probot.load(
        createApp({
          allowlist: entry.allowlist,
          baselineRepo: entry.baselineRepo,
          dryRun: defaults.dryRun,
        }),
      );

      log.info(
        {
          app: entry.label,
          appId: entry.appId,
          allowedInstallationTargets: entry.allowlist.describe(),
          baselineRepo: entry.baselineRepo,
        },
        "Registered GitHub App",
      );

      apps.push({
        appId: entry.appId,
        label: entry.label,
        probot,
        webhookSecret: entry.webhookSecret,
      });
    }

    return new AppRegistry(apps);
  }

  get size(): number {
    return this.byId.size;
  }

  get(appId: number): RegisteredApp | undefined {
    return this.byId.get(appId);
  }

  list(): RegisteredApp[] {
    return [...this.byId.values()];
  }
}
