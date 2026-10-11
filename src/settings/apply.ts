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
import type { WoodhouseConfig } from "../config/schema.js";
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
 * Orchestration
 * ---------------------------------------------------------------------- */

export async function syncSettings(
  ctx: ApplyContext,
  config: WoodhouseConfig,
): Promise<ApplySummary> {
  if (!config.settings.enabled) {
    ctx.log.debug("Settings sync not enabled for this repository");
    return { changes: [], failures: [], dryRun: ctx.dryRun };
  }

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
