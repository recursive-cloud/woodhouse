/**
 * Repository rulesets applier.
 *
 * Executes the ruleset plan produced by the pure `planRulesets` function. Every
 * configured ruleset is written wholesale via `performWrite`: `planRulesets`
 * always maps an existing name to an update, never a diff, because GitHub's GET
 * representation is heavily normalised (defaults filled in, actor IDs resolved)
 * and comparing it against the authored YAML produces constant false positives.
 * A PUT is idempotent, so this is safe; dry-run gating is structural.
 *
 * A 403 anywhere in the applier (the existing-rulesets read or any write) is
 * folded into a collected `Failure` carrying the `describeForbidden`
 * explanation, and the applier aborts, exactly as the previously-thrown error
 * did. Any other error propagates to the orchestrator.
 */

import type { WoodhouseConfig } from "../../config/schema.js";
import { performWrite } from "../../lib/dry-run.js";
import { describeForbidden, messageOf, statusOf } from "../forbidden.js";
import { planRulesets } from "../plan.js";
import type { ApplierContext, ApplierResult, ChangeRecord } from "./types.js";

export async function applyRulesets(
  ctx: ApplierContext,
  config: WoodhouseConfig,
): Promise<ApplierResult> {
  if (config.rulesets.length === 0 && !config.settings.pruneRulesets) {
    return { changes: [], failures: [] };
  }

  const changes: ChangeRecord[] = [];

  try {
    const existing = await ctx.octokit.paginate("GET /repos/{owner}/{repo}/rulesets", {
      owner: ctx.owner,
      repo: ctx.repo,
      per_page: 100,
    });

    const plan = planRulesets(
      (existing as { id: number; name: string }[]).map((r) => ({
        id: r.id,
        name: r.name,
      })),
      config.rulesets,
      config.settings.pruneRulesets,
    );

    for (const ruleset of plan.create) {
      // `rules` is a large discriminated union in the generated types. Our
      // schema keeps it open on purpose (see rulesetSchema), so the cast is
      // required; GitHub validates the payload server-side either way.
      await performWrite(ctx, `create ruleset ${ruleset.name}`, () =>
        ctx.octokit.request("POST /repos/{owner}/{repo}/rulesets", {
          owner: ctx.owner,
          repo: ctx.repo,
          ...ruleset,
        } as never),
      );
      changes.push({
        area: "ruleset",
        action: "create",
        target: ruleset.name,
      });
    }

    for (const { id, ruleset } of plan.update) {
      await performWrite(ctx, `update ruleset ${ruleset.name}`, () =>
        ctx.octokit.request("PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
          owner: ctx.owner,
          repo: ctx.repo,
          ruleset_id: id,
          ...ruleset,
        } as never),
      );
      changes.push({
        area: "ruleset",
        action: "update",
        target: ruleset.name,
      });
    }

    for (const { id, name } of plan.delete) {
      await performWrite(ctx, `delete ruleset ${name}`, () =>
        ctx.octokit.request("DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
          owner: ctx.owner,
          repo: ctx.repo,
          ruleset_id: id,
        }),
      );
      changes.push({ area: "ruleset", action: "delete", target: name });
    }
  } catch (error) {
    if (statusOf(error) === 403) {
      const message = messageOf(error);
      const detail = describeForbidden("rulesets", message);
      ctx.log.error({ applier: "rulesets", status: 403, err: message }, detail);
      return { changes, failures: [{ area: "rulesets", message: detail }] };
    }

    throw error;
  }

  return { changes, failures: [] };
}
