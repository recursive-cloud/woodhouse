/**
 * Auto-approval policy.
 *
 * Pure decision logic, kept apart from the API calls so every refusal reason
 * is directly testable. Defaults are deliberately conservative: this code
 * casts a binding approval vote on the user's behalf.
 */

import type { AutoApprovalConfig } from "../config/schema.js";

export interface ApprovalRequest {
  readonly author: string;
  readonly draft: boolean;
  readonly state: string;
  /** Paths changed by the PR. */
  readonly changedFiles: readonly string[];
  /** True when the file list was too large to enumerate completely. */
  readonly fileListTruncated: boolean;
  /** True when we have already approved this exact head SHA. */
  readonly alreadyApproved: boolean;
}

export type ApprovalDecision =
  | { readonly approve: true }
  | { readonly approve: false; readonly reason: string };

/**
 * Match a changed file against a protected path entry.
 *
 * Supports an exact path, a directory prefix (`dir/`), and a trailing `*`
 * wildcard. Deliberately not full glob syntax: a half-implemented glob that
 * silently fails to match is worse than a simple rule that obviously does.
 */
export function pathMatches(file: string, pattern: string): boolean {
  const f = file.toLowerCase();
  const p = pattern.trim().toLowerCase();

  if (p.endsWith("/")) return f.startsWith(p);
  if (p.endsWith("*")) return f.startsWith(p.slice(0, -1));
  return f === p;
}

export function decide(
  request: ApprovalRequest,
  config: AutoApprovalConfig,
): ApprovalDecision {
  if (!config.enabled) {
    return { approve: false, reason: "auto-approval is disabled" };
  }

  if (request.state !== "open") {
    return { approve: false, reason: `pull request is ${request.state}` };
  }

  if (request.draft) {
    // A draft is an explicit statement that the work is not ready.
    return { approve: false, reason: "pull request is a draft" };
  }

  const author = request.author.toLowerCase();
  const trusted = config.allowedActors.some(
    (actor) => actor.trim().toLowerCase() === author,
  );

  if (!trusted) {
    return {
      approve: false,
      reason: `author "${request.author}" is not in autoApproval.allowedActors`,
    };
  }

  // Fail closed when we cannot see the whole diff. An enormous PR is exactly
  // where a change to a protected path is easiest to hide.
  if (request.fileListTruncated) {
    return {
      approve: false,
      reason: "pull request is too large to enumerate changed files safely",
    };
  }

  // The critical rule. Without it, anyone in allowedActors could open a PR
  // widening allowedActors, have it auto-approved, and merge it - turning a
  // single trusted actor into permanent control of the config. Self-approval
  // of the file that grants approval rights must never be possible.
  const protectedHit = request.changedFiles.find((file) =>
    config.protectedPaths.some((pattern) => pathMatches(file, pattern)),
  );

  if (protectedHit !== undefined) {
    return {
      approve: false,
      reason: `modifies protected path "${protectedHit}"`,
    };
  }

  if (request.alreadyApproved) {
    return { approve: false, reason: "already approved at this commit" };
  }

  return { approve: true };
}
