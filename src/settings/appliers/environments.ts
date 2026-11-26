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
 * Branch-policy patterns under a custom-mode environment are the exception:
 * they converge by create-and-delete, because the configured list is the whole
 * deployment allowlist. Deletion is deliberate, so a pattern removed from the
 * config stops permitting deployments. The environments themselves are still
 * never deleted.
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

/**
 * Re-label a thrown error with the environment (and pattern) it came from,
 * keeping the `status` property so the caller's 403 / plan-limit / raw-message
 * classification still sees the HTTP status.
 */
function contextualError(error: unknown, prefix: string): Error {
  const labelled = new Error(`${prefix}: ${messageOf(error)}`);
  const status = statusOf(error);
  if (status !== undefined) Object.assign(labelled, { status });
  return labelled;
}

/** Run `write`, re-throwing any failure with `prefix` folded into its message. */
async function withContext<T>(prefix: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw contextualError(error, prefix);
  }
}

/**
 * Make one environment's branch-policy patterns match `patterns` exactly.
 *
 * The configured list is the whole allowlist: patterns missing on the
 * environment are created and patterns absent from the list are deleted. The
 * listing returns branch and tag policies and cannot distinguish them; any
 * policy whose name is not in the configured list is deleted, so the configured
 * list is the environment's whole deployment allowlist (tag policies included),
 * while Woodhouse only ever creates branch policies.
 *
 * Every write goes through `performWrite`, so dry-run skips the call but the
 * change is still recorded. A thrown error aborts the remaining writes for this
 * environment and propagates to the caller's per-environment catch.
 */
async function convergeBranchPolicies(
  ctx: ApplierContext,
  environmentName: string,
  patterns: readonly string[],
): Promise<ChangeRecord[]> {
  const changes: ChangeRecord[] = [];

  const { data } = await withContext(`${environmentName}: listing branch policies`, () =>
    ctx.octokit.repos.listDeploymentBranchPolicies({
      owner: ctx.owner,
      repo: ctx.repo,
      environment_name: environmentName,
    }),
  );
  // The generated OpenAPI type marks both fields optional; a real response
  // always sends them, so ignore an incomplete entry rather than invent one.
  const existing = data.branch_policies.filter(
    (policy): policy is { id: number; name: string } =>
      policy.id !== undefined && policy.name !== undefined,
  );
  const configured = new Set(patterns);
  const existingNames = new Set(existing.map((policy) => policy.name));

  for (const pattern of patterns) {
    if (existingNames.has(pattern)) continue;

    await withContext(`${environmentName}: ${pattern}`, () =>
      performWrite(ctx, `create branch policy ${environmentName}: ${pattern}`, () =>
        ctx.octokit.repos.createDeploymentBranchPolicy({
          owner: ctx.owner,
          repo: ctx.repo,
          environment_name: environmentName,
          name: pattern,
        }),
      ),
    );
    changes.push({
      area: "environments",
      action: "create",
      target: `${environmentName}: ${pattern}`,
    });
  }

  for (const policy of existing) {
    if (configured.has(policy.name)) continue;

    await withContext(`${environmentName}: ${policy.name}`, () =>
      performWrite(ctx, `delete branch policy ${environmentName}: ${policy.name}`, () =>
        ctx.octokit.repos.deleteDeploymentBranchPolicy({
          owner: ctx.owner,
          repo: ctx.repo,
          environment_name: environmentName,
          branch_policy_id: policy.id,
        }),
      ),
    );
    changes.push({
      area: "environments",
      action: "delete",
      target: `${environmentName}: ${policy.name}`,
    });
  }

  return changes;
}

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
      // The config carries a plain mode string; the REST API takes two
      // mutually exclusive booleans. Unset stays null, which allows every
      // branch to deploy.
      const deploymentBranchPolicy =
        environment.deployment_branch_policy === undefined
          ? null
          : {
              protected_branches: environment.deployment_branch_policy === "protected",
              custom_branch_policies: environment.deployment_branch_policy === "custom",
            };

      await performWrite(ctx, `declare environment ${name}`, () =>
        ctx.octokit.repos.createOrUpdateEnvironment({
          owner: ctx.owner,
          repo: ctx.repo,
          environment_name: name,
          // Full desired state: the PUT replaces the environment, so every
          // optional field is sent explicitly rather than left to GitHub.
          wait_timer: environment.wait_timer ?? 0,
          prevent_self_review: environment.prevent_self_review ?? false,
          deployment_branch_policy: deploymentBranchPolicy,
          reviewers: environment.reviewers ?? null,
          ...(environment.can_admins_bypass !== undefined
            ? { can_admins_bypass: environment.can_admins_bypass }
            : {}),
        }),
      );
      changes.push({ area: "environments", action: "update", target: name });

      // Only custom mode has a pattern list; branch_policies is rejected at
      // authoring time under any other mode, so there is nothing to converge.
      if (environment.deployment_branch_policy === "custom") {
        changes.push(
          ...(await convergeBranchPolicies(ctx, name, environment.branch_policies ?? [])),
        );
      }
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
