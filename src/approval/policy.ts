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
  /**
   * Login that enabled auto-merge on the pull request, from the current PR
   * state. Deliberately tri-state:
   *
   * - `undefined` — not gathered yet (the cheap preliminary pass). The bot
   *   gate is inert: `decide()` neither vetoes a bot for the missing fact nor
   *   approves it on the strength of it, so an otherwise-eligible bot proceeds
   *   to fact gathering. Nothing is ever submitted on such a pass; submission
   *   only follows a full pass, where the fact is always gathered.
   * - `null` — gathered: nobody has enabled auto-merge.
   * - a string — gathered: this login enabled it.
   */
  readonly autoMergeEnabledBy?: string | null;
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

/**
 * How a PR author relates to `autoApproval.allowedActors`, by membership only
 * (never `pr.user.type`). An author listed as both an owner and a bot is an
 * owner: owner membership means unconditional approval.
 */
export type ActorClass = "owner" | "bot" | "neither";

/** GitHub logins compare case-insensitively; normalise both sides of every check. */
const normalizeLogin = (login: string): string => login.trim().toLowerCase();

function isListed(list: readonly string[], login: string): boolean {
  return list.some((entry) => normalizeLogin(entry) === login);
}

/**
 * Classify a PR author as an owner, a bot, or neither, by list membership.
 * Pure and config-driven so the caller can use it (e.g. to decide whether the
 * auto-merge fact needs gathering) before running the full decision.
 */
export function classifyActor(author: string, config: AutoApprovalConfig): ActorClass {
  const login = normalizeLogin(author);
  if (isListed(config.allowedActors.owners, login)) return "owner";
  if (isListed(config.allowedActors.bots, login)) return "bot";
  return "neither";
}

export function decide(request: ApprovalRequest, config: AutoApprovalConfig): ApprovalDecision {
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

  const actorClass = classifyActor(request.author, config);

  if (actorClass === "neither") {
    return {
      approve: false,
      reason: `author "${request.author}" is not in autoApproval.allowedActors`,
    };
  }

  // Owners are approved unconditionally (subject to the shared guards below).
  // Bots additionally require that they enabled auto-merge themselves. The
  // gate is inert when the fact has not been gathered (`undefined`) so the
  // preliminary pass can still classify the author; it never *approves* on a
  // missing fact either — the shared guards still run.
  if (actorClass === "bot") {
    const enabledBy = request.autoMergeEnabledBy;

    if (enabledBy === null) {
      return {
        approve: false,
        reason: `author "${request.author}" is a bot in autoApproval.allowedActors.bots but nobody has enabled auto-merge`,
      };
    }

    if (enabledBy !== undefined && normalizeLogin(enabledBy) !== normalizeLogin(request.author)) {
      return {
        approve: false,
        reason: `auto-merge was enabled by "${enabledBy}" rather than the author "${request.author}"`,
      };
    }
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
