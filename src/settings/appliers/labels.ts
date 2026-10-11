/**
 * Labels applier.
 *
 * Executes the label plan produced by the pure `planLabels` function. Reads are
 * not dry-run gated: the plan is built from the repository's current labels, so
 * reading them always fires.
 *
 * Errors are deliberately not caught here. This applier throws exactly as it
 * always has and `syncSettings` classifies the failure; only the appliers where
 * a 404 is routine collect failures internally.
 */

import type { WoodhouseConfig } from "../../config/schema.js";
import { performWrite } from "../../lib/dry-run.js";
import { planLabels } from "../plan.js";
import type { ApplierContext, ApplierResult, ChangeRecord } from "./types.js";

/** GitHub wants six hex digits with no leading `#`. */
function colour(value: string | undefined): string | undefined {
  return value?.replace(/^#/, "").toLowerCase();
}

export async function applyLabels(
  ctx: ApplierContext,
  config: WoodhouseConfig,
): Promise<ApplierResult> {
  if (config.labels.length === 0 && !config.settings.pruneLabels) {
    return { changes: [], failures: [] };
  }

  const existing = await ctx.octokit.paginate(ctx.octokit.issues.listLabelsForRepo, {
    owner: ctx.owner,
    repo: ctx.repo,
    per_page: 100,
  });

  const plan = planLabels(
    existing.map((l) => ({
      name: l.name,
      color: l.color,
      description: l.description ?? null,
    })),
    config.labels,
    config.settings.pruneLabels,
  );

  const changes: ChangeRecord[] = [];
  const base = { owner: ctx.owner, repo: ctx.repo };

  for (const label of plan.create) {
    await performWrite(ctx, `create label ${label.name}`, () =>
      ctx.octokit.issues.createLabel({
        ...base,
        name: label.name,
        ...(label.color !== undefined ? { color: colour(label.color)! } : {}),
        ...(label.description !== undefined ? { description: label.description } : {}),
      }),
    );
    changes.push({ area: "label", action: "create", target: label.name });
  }

  for (const label of plan.rename) {
    await performWrite(ctx, `rename label ${label.from} -> ${label.name}`, () =>
      ctx.octokit.issues.updateLabel({
        ...base,
        name: label.from!,
        new_name: label.name,
        ...(label.color !== undefined ? { color: colour(label.color)! } : {}),
        ...(label.description !== undefined ? { description: label.description } : {}),
      }),
    );
    changes.push({
      area: "label",
      action: "rename",
      target: `${label.from} -> ${label.name}`,
    });
  }

  for (const label of plan.update) {
    await performWrite(ctx, `update label ${label.name}`, () =>
      ctx.octokit.issues.updateLabel({
        ...base,
        name: label.name,
        new_name: label.name,
        ...(label.color !== undefined ? { color: colour(label.color)! } : {}),
        ...(label.description !== undefined ? { description: label.description } : {}),
      }),
    );
    changes.push({ area: "label", action: "update", target: label.name });
  }

  for (const name of plan.delete) {
    await performWrite(ctx, `delete label ${name}`, () =>
      ctx.octokit.issues.deleteLabel({ ...base, name }),
    );
    changes.push({ area: "label", action: "delete", target: name });
  }

  return { changes, failures: [] };
}
