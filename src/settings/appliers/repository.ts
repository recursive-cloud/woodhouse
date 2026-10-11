/**
 * Repository core settings applier.
 *
 * The single highest-privilege applier: it PATCHes the repository itself and
 * replaces topics. Both decisions come from the pure plan functions in
 * `settings/plan.ts`; this module only executes them through `performWrite`, so
 * dry-run gating is structural.
 *
 * Errors are deliberately not caught here. This applier throws exactly as it
 * always has and `syncSettings` classifies the failure (including 403s); the
 * only failure-collecting appliers are the ones where a 404 is routine.
 */

import type { WoodhouseConfig } from "../../config/schema.js";
import { performWrite } from "../../lib/dry-run.js";
import { diffRepositorySettings, topicsDiffer } from "../plan.js";
import type { ApplierContext, ApplierResult, ChangeRecord } from "./types.js";

export async function applyRepository(
  ctx: ApplierContext,
  config: WoodhouseConfig,
): Promise<ApplierResult> {
  const { data: current } = await ctx.octokit.repos.get({
    owner: ctx.owner,
    repo: ctx.repo,
  });

  // Never fight the user over an archived repository: writes would fail, and
  // if they somehow succeeded that would be worse.
  if (current.archived) {
    ctx.log.info("Repository is archived; skipping settings sync");
    return { changes: [], failures: [] };
  }

  const changes: ChangeRecord[] = [];

  const patch = diffRepositorySettings(
    current as unknown as Record<string, unknown>,
    config.repository,
  );

  if (Object.keys(patch).length > 0) {
    await performWrite(ctx, "update repository settings", () =>
      ctx.octokit.repos.update({
        owner: ctx.owner,
        repo: ctx.repo,
        ...patch,
      }),
    );
    changes.push({
      area: "repository",
      action: "update",
      target: Object.keys(patch).toSorted().join(", "),
    });
  }

  const desiredTopics = config.repository.topics;
  if (desiredTopics !== undefined && topicsDiffer(current.topics ?? [], desiredTopics)) {
    await performWrite(ctx, "replace repository topics", () =>
      ctx.octokit.repos.replaceAllTopics({
        owner: ctx.owner,
        repo: ctx.repo,
        // GitHub rejects uppercase topics outright.
        names: desiredTopics.map((t) => t.toLowerCase()),
      }),
    );
    changes.push({
      area: "topics",
      action: "update",
      target: desiredTopics.join(", "),
    });
  }

  return { changes, failures: [] };
}
