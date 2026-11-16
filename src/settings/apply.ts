/**
 * Settings sync orchestrator.
 *
 * Runs the appliers in the order declared by `./appliers/index.ts`, aggregating
 * changes and failures rather than aborting on the first error: one repository
 * lacking a `main` branch should not prevent its labels from being synced. The
 * actual work lives in `./appliers/`; this module only sequences it, classifies
 * thrown errors, and renders the summary through `formatApplySummary`.
 */

import type { Context } from "probot";
import type { Logger } from "pino";
import type { ResolvedConfig } from "../config/resolver.js";
import { APPLIERS } from "./appliers/index.js";
import type { ChangeRecord, Failure } from "./appliers/types.js";
import { describeForbidden, messageOf, statusOf } from "./forbidden.js";
import { type ApplySummary, formatApplySummary } from "./summary.js";

type Api = Context<"push">["octokit"];

export interface ApplyContext {
  readonly octokit: Api;
  readonly owner: string;
  readonly repo: string;
  readonly log: Logger;
  readonly dryRun: boolean;
}

/* -------------------------------------------------------------------------
 * Gate
 * ---------------------------------------------------------------------- */

export type SettingsSyncBlockReason = "no-local-file" | "settings-disabled" | "invalid-config";

/**
 * Why settings sync must not run for a resolved configuration, or null to run.
 *
 * The repository's own `.github/woodhouse.yml` (or `.yaml`) is the opt-in
 * signal: without one the repository is never synced, no matter what the
 * cascade says. `settings.enabled` is a kill switch that defaults on; an
 * explicit `false` anywhere in the cascade silences the repository, and a
 * repository-level `true` overrides a baseline `false` because raw layers are
 * merged before validation. Invalid configuration fails closed exactly as it
 * did when the switch defaulted off: the resolver hands back fallback defaults
 * alongside its issues, and those must never drive a sync.
 */
export function settingsSyncBlock(resolved: ResolvedConfig): SettingsSyncBlockReason | null {
  if (resolved.localSource === undefined) return "no-local-file";
  if (!resolved.config.settings.enabled) return "settings-disabled";
  if (resolved.issues.length > 0) return "invalid-config";
  return null;
}

/* -------------------------------------------------------------------------
 * Orchestration
 * ---------------------------------------------------------------------- */

export async function syncSettings(
  ctx: ApplyContext,
  resolved: ResolvedConfig,
): Promise<ApplySummary> {
  const block = settingsSyncBlock(resolved);
  if (block !== null) {
    ctx.log.debug({ reason: block }, "Settings sync skipped");
    return { changes: [], failures: [], dryRun: ctx.dryRun };
  }

  ctx.log.debug({ sources: resolved.sources }, "Running settings sync");

  const config = resolved.config;

  const changes: ChangeRecord[] = [];
  const failures: Failure[] = [];

  for (const applier of APPLIERS) {
    try {
      const result = await applier.run(ctx, config);
      changes.push(...result.changes);
      failures.push(...result.failures);
    } catch (error) {
      const status = statusOf(error);
      const message = messageOf(error);

      if (status === 403) {
        // Fold the classified explanation into the collected failure (design
        // D1) while logging exactly what we always have.
        const detail = describeForbidden(applier.name, message);
        ctx.log.error({ applier: applier.name, status, err: message }, detail);
        failures.push({ area: applier.name, message: detail });
      } else {
        ctx.log.error(
          { applier: applier.name, status, err: message },
          `Failed applying ${applier.name}`,
        );
        failures.push({ area: applier.name, message });
      }
    }
  }

  const summary: ApplySummary = { changes, failures, dryRun: ctx.dryRun };

  if (changes.length > 0) {
    ctx.log.info({ changes: summary.changes, dryRun: ctx.dryRun }, formatApplySummary(summary));
  } else if (failures.length === 0) {
    ctx.log.debug(formatApplySummary(summary));
  }

  return summary;
}
