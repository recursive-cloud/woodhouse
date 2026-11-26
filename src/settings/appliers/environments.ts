/**
 * Deployment environments applier.
 *
 * Converges by full re-declaration: every configured environment is PUT with
 * its complete desired state on every sync, with no GET first. GitHub's GET
 * representation is normalised and the PUT is idempotent, so diffing buys
 * nothing and risks constant false positives. Environments are never deleted:
 * removing an entry only stops the re-assertion and leaves the repository's
 * environment in place.
 *
 * Unlike the other appliers this one collects every per-environment failure
 * (403, 404 and anything else) and continues the loop: one environment's
 * failure must not leave the rest of the declared set unapplied.
 */

import type { WoodhouseConfig } from "../../config/schema.js";
import { performWrite } from "../../lib/dry-run.js";
import {
  describeForbidden,
  looksLikePlanLimit,
  messageOf,
  planLimitDetail,
  statusOf,
} from "../forbidden.js";
import type { ApplierContext, ApplierResult, ChangeRecord, Failure } from "./types.js";

export async function applyEnvironments(
  ctx: ApplierContext,
  config: WoodhouseConfig,
): Promise<ApplierResult> {
  const environments = Object.entries(config.environments);
  if (environments.length === 0) return { changes: [], failures: [] };

  const changes: ChangeRecord[] = [];
  const failures: Failure[] = [];

  for (const [name, environment] of environments) {
    // Null-clears convention: an explicit null drops an inherited entry.
    if (environment === null) continue;

    try {
      await performWrite(ctx, `declare environment ${name}`, () =>
        ctx.octokit.repos.createOrUpdateEnvironment({
          owner: ctx.owner,
          repo: ctx.repo,
          environment_name: name,
          // Full desired state: the PUT replaces the environment, so every
          // optional field is sent explicitly rather than left to GitHub.
          wait_timer: environment.wait_timer ?? 0,
          prevent_self_review: environment.prevent_self_review ?? false,
          deployment_branch_policy: null,
          reviewers: environment.reviewers ?? null,
          ...(environment.can_admins_bypass !== undefined
            ? { can_admins_bypass: environment.can_admins_bypass }
            : {}),
        }),
      );
      changes.push({ area: "environments", action: "update", target: name });
    } catch (error) {
      const status = statusOf(error);
      const message = messageOf(error);
      // GitHub hides the endpoint on plans without environments (404), and some
      // plan-restricted writes return a 422 naming the billing plan; both are
      // the plan limit rather than a validation or missing-environment error.
      const planLimited = status === 404 || (status === 422 && looksLikePlanLimit(message));
      const detail =
        status === 403
          ? describeForbidden("environments", message)
          : planLimited
            ? planLimitDetail("environments")
            : message;

      ctx.log.error({ applier: "environments", environment: name, status, err: message }, detail);
      failures.push({ area: "environments", message: detail });
    }
  }

  return { changes, failures };
}
