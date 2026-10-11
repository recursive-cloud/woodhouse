/**
 * Classic branch protection applier.
 *
 * Executes the branch protection entries from the resolved config directly:
 * their representation differs enough from a GET that diffing is more
 * error-prone than an idempotent PUT, so every configured branch is written
 * unconditionally via `performWrite` (dry-run gating is structural).
 *
 * A 404 means the branch does not exist (routine for a shared baseline), so
 * that branch is skipped and the rest continue. A 403 is folded into a
 * collected `Failure` carrying the `describeForbidden` explanation, and the
 * applier aborts, exactly as the previously-thrown error did. Any other error
 * propagates to the orchestrator.
 */

import type { WoodhouseConfig } from "../../config/schema.js";
import { performWrite } from "../../lib/dry-run.js";
import { describeForbidden, messageOf, statusOf } from "../forbidden.js";
import type { ApplierContext, ApplierResult, ChangeRecord } from "./types.js";

export async function applyBranchProtection(
  ctx: ApplierContext,
  config: WoodhouseConfig,
): Promise<ApplierResult> {
  const branches = Object.entries(config.branchProtection);
  if (branches.length === 0) return { changes: [], failures: [] };

  const changes: ChangeRecord[] = [];

  for (const [branch, protection] of branches) {
    // Always PUT rather than diff: the GET representation of branch
    // protection is structurally quite different from the PUT payload
    // (nested `enabled` wrappers, expanded actor objects), and comparing them
    // reliably is more error-prone than an idempotent write.
    try {
      await performWrite(ctx, `update branch protection for ${branch}`, () =>
        ctx.octokit.repos.updateBranchProtection({
          owner: ctx.owner,
          repo: ctx.repo,
          branch,
          // These three are required by the API and must be explicitly null
          // when unused, otherwise the request is rejected.
          required_status_checks:
            protection.required_status_checks === undefined
              ? null
              : protection.required_status_checks,
          enforce_admins: protection.enforce_admins ?? null,
          required_pull_request_reviews:
            protection.required_pull_request_reviews === undefined
              ? null
              : protection.required_pull_request_reviews,
          restrictions: null,
          ...(protection.required_linear_history !== undefined
            ? { required_linear_history: protection.required_linear_history }
            : {}),
          ...(protection.allow_force_pushes !== undefined
            ? { allow_force_pushes: protection.allow_force_pushes }
            : {}),
          ...(protection.allow_deletions !== undefined
            ? { allow_deletions: protection.allow_deletions }
            : {}),
          ...(protection.required_conversation_resolution !== undefined
            ? {
                required_conversation_resolution: protection.required_conversation_resolution,
              }
            : {}),
          ...(protection.lock_branch !== undefined ? { lock_branch: protection.lock_branch } : {}),
          ...(protection.block_creations !== undefined
            ? { block_creations: protection.block_creations }
            : {}),
        }),
      );
      changes.push({
        area: "branch-protection",
        action: "update",
        target: branch,
      });
    } catch (error) {
      if (statusOf(error) === 404) {
        // Configuring protection for a branch that does not exist is a normal
        // consequence of a shared baseline, not an error worth alerting on.
        ctx.log.debug({ branch }, "Branch does not exist; skipping protection");
        continue;
      }

      if (statusOf(error) === 403) {
        const message = messageOf(error);
        const detail = describeForbidden("branch-protection", message);
        ctx.log.error({ applier: "branch-protection", status: 403, err: message }, detail);
        return {
          changes,
          failures: [{ area: "branch-protection", message: detail }],
        };
      }

      throw error;
    }
  }

  return { changes, failures: [] };
}
