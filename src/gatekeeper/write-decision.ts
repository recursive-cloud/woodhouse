/**
 * Whether a white-glove write must create a new check run or update the
 * existing one.
 *
 * Pure and synchronous by design: the decision is plain data in, a single word
 * out, so the matrix is exhaustively testable without octokit. The load-bearing
 * rule is that a completed run must never be PATCHed back to `in_progress` —
 * the Checks API accepts that request but silently ignores the terminal →
 * pending regression, leaving the previous red run visible beside a "waiting"
 * merge box. Anything not yet completed is safe to update in place.
 */

import type { Outcome } from "./evaluate.js";

/** The subset of an existing check run the decision needs. */
export interface ExistingCheckRun {
  readonly status: string;
}

export type CheckWrite = "create" | "update";

/**
 * Resolve the write path for a check run.
 *
 * - no existing run → create
 * - existing run not `completed` (queued, in_progress, any non-terminal
 *   status) → update; PATCHing it can never be a completed → pending
 *   regression
 * - existing run completed and the new outcome is terminal → update
 * - existing run completed and the new outcome is pending → create
 */
export function resolveCheckWrite(
  existing: ExistingCheckRun | undefined,
  outcome: Outcome,
): CheckWrite {
  if (existing === undefined) {
    return "create";
  }

  if (existing.status !== "completed") {
    return "update";
  }

  return outcome === "pending" ? "create" : "update";
}
