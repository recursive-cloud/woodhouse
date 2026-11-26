/**
 * Harness for the environments acceptance suite.
 *
 * `resolvedFromLayers` runs the same merge-then-validate pipeline the production
 * resolver uses, so an explicit `null` in the local layer deletes the inherited
 * key exactly as it does in a live cascade, and an invalid environments section
 * surfaces as `issues` rather than throwing at fixture-build time. This module
 * is not a vitest entry: `apply.steps.ts` imports it.
 */

import yaml from "js-yaml";
import type { Logger } from "pino";
import { mergeLayers } from "../../src/config/merge.js";
import type { ResolvedConfig } from "../../src/config/resolver.js";
import { defaultConfig, parseConfig } from "../../src/config/schema.js";
import { type ApplyContext, syncSettings } from "../../src/settings/apply.js";
import { type OctokitOptions, makeOctokit } from "../settings-sync/octokit-fakes.js";
import { type FakeLogger, fakeLogger } from "../support/scenario.js";

export { resolvedConfig } from "../settings-sync/resolver-fakes.js";

const BASELINE_SOURCE = ".github-private:woodhouse.yml";
const LOCAL_SOURCE = "acme/widgets:.github/woodhouse.yml";

/** The apply context every scenario uses, with the dry-run flag as the only variable. */
export function applyContext(
  octokit: ReturnType<typeof makeOctokit>["octokit"],
  log: Logger,
  dryRun = false,
): ApplyContext {
  return {
    octokit,
    owner: "acme",
    repo: "widgets",
    log,
    dryRun,
  } as unknown as ApplyContext;
}

/** Merge the supplied YAML layers (lowest precedence first) and validate once. */
export function resolvedFromLayers(
  baselineYaml: string | undefined,
  localYaml: string | undefined,
): ResolvedConfig {
  const sources: string[] = [];
  const layers: unknown[] = [];

  if (baselineYaml !== undefined) {
    layers.push(yaml.load(baselineYaml) ?? {});
    sources.push(BASELINE_SOURCE);
  }
  if (localYaml !== undefined) {
    layers.push(yaml.load(localYaml) ?? {});
    sources.push(LOCAL_SOURCE);
  }

  const localSource = localYaml === undefined ? undefined : LOCAL_SOURCE;
  const result = parseConfig(mergeLayers(layers));

  if (!result.ok) {
    return { config: defaultConfig(), sources, issues: result.issues, localSource };
  }

  return { config: result.config, sources, issues: [], localSource };
}

/** The environments map, read through the not-yet-typed section. */
export function environmentsOf(resolved: ResolvedConfig): Record<string, unknown> {
  const config = resolved.config as { environments?: Record<string, unknown> };
  return config.environments ?? {};
}

/** Mutable slots one scenario fills in step order. */
export interface EnvironmentsWorld {
  readonly built: ReturnType<typeof makeOctokit>;
  readonly log: FakeLogger;
  readonly ctx: ApplyContext;
  resolved?: ResolvedConfig;
  summary?: Awaited<ReturnType<typeof syncSettings>>;
}

/** Build one scenario's octokit fake, logger and apply context. */
export function world(options?: {
  readonly dryRun?: boolean;
  readonly branchPolicies?: OctokitOptions["branchPolicies"];
}): EnvironmentsWorld {
  const built = makeOctokit({ branchPolicies: options?.branchPolicies });
  const log = fakeLogger();
  return {
    built,
    log,
    ctx: applyContext(built.octokit, log, options?.dryRun ?? false),
  };
}

export function requireResolved(resolved: ResolvedConfig | undefined): ResolvedConfig {
  if (resolved === undefined) {
    throw new Error("The configuration has not been resolved yet.");
  }
  return resolved;
}

export function requireSummary(
  summary: Awaited<ReturnType<typeof syncSettings>> | undefined,
): Awaited<ReturnType<typeof syncSettings>> {
  if (summary === undefined) {
    throw new Error("The settings sync has not run yet.");
  }
  return summary;
}
