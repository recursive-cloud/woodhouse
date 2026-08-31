/**
 * The white-glove consolidation algorithm.
 *
 * Pure and synchronous by design: given the set of check runs on a commit and
 * the resolved config, decide the state of `woodhouse/white-glove`. All the
 * subtle precedence rules live here where they can be exhaustively unit-tested
 * without touching the network.
 */

import type { GatekeeperConfig } from "../config/schema.js";
import { WHITE_GLOVE_CHECK_NAME } from "./constants.js";

export type CheckStatus =
  | "queued"
  | "in_progress"
  | "waiting"
  | "requested"
  | "pending"
  | "completed";

export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "skipped"
  | "stale"
  | "startup_failure"
  | null;

/** The subset of a check run this algorithm cares about. */
export interface CheckRunLike {
  readonly name: string;
  readonly status: CheckStatus | string;
  readonly conclusion: CheckConclusion | string | null;
  readonly detailsUrl?: string | null;
}

export type Outcome = "success" | "failure" | "pending";

export type Verdict =
  | "passed"
  | "failed"
  | "pending"
  | "ignored"
  | "missing-required";

export interface EvaluatedCheck {
  readonly name: string;
  readonly verdict: Verdict;
  readonly detail: string;
}

export interface Evaluation {
  readonly outcome: Outcome;
  readonly title: string;
  readonly summary: string;
  readonly checks: readonly EvaluatedCheck[];
  readonly counts: {
    readonly passed: number;
    readonly failed: number;
    readonly pending: number;
    readonly ignored: number;
    readonly missing: number;
  };
}

/** Terminal conclusions that mean the check did not pass. */
const FAILING_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "stale",
  "startup_failure",
]);

/** Terminal conclusions that are acceptable non-results. */
const NON_RESULT_CONCLUSIONS = new Set(["skipped", "neutral"]);

function isComplete(run: CheckRunLike): boolean {
  return run.status === "completed";
}

/**
 * Glob-free exact matching, case-insensitive.
 *
 * Check names are chosen by the user in their own workflows, so exact matching
 * is predictable. Case-insensitivity avoids a class of frustrating "why is my
 * required check never found" bugs.
 */
function nameMatches(name: string, list: readonly string[]): boolean {
  const lowered = name.toLowerCase();
  return list.some((entry) => entry.trim().toLowerCase() === lowered);
}

export function evaluate(
  runs: readonly CheckRunLike[],
  config: GatekeeperConfig,
): Evaluation {
  const strict = config.strictChecks;
  const ignored = config.ignoredChecks;

  const checks: EvaluatedCheck[] = [];

  // Precedence is failure > pending > success. We track both flags rather than
  // returning early so the check output can list *every* problem at once —
  // fixing one failure only to discover the next on the following run is a
  // miserable experience.
  let anyFailure = false;
  let anyPending = false;

  for (const run of runs) {
    // Never evaluate ourselves. Without this the check would react to its own
    // completion event and loop indefinitely.
    if (run.name === WHITE_GLOVE_CHECK_NAME) continue;

    const isStrict = nameMatches(run.name, strict);

    // A strict requirement cannot be waived by adding it to ignoredChecks;
    // strict wins, otherwise the two lists would silently contradict.
    if (!isStrict && nameMatches(run.name, ignored)) {
      checks.push({
        name: run.name,
        verdict: "ignored",
        detail: "explicitly ignored by configuration",
      });
      continue;
    }

    if (!isComplete(run)) {
      anyPending = true;
      checks.push({
        name: run.name,
        verdict: "pending",
        detail: `still ${String(run.status).replace(/_/g, " ")}`,
      });
      continue;
    }

    const conclusion = run.conclusion;

    if (conclusion === "success") {
      checks.push({ name: run.name, verdict: "passed", detail: "success" });
      continue;
    }

    if (conclusion === null) {
      // Completed with no conclusion should not happen; treat as unresolved
      // rather than assuming success.
      anyPending = true;
      checks.push({
        name: run.name,
        verdict: "pending",
        detail: "completed without a conclusion",
      });
      continue;
    }

    if (NON_RESULT_CONCLUSIONS.has(conclusion)) {
      if (isStrict) {
        anyFailure = true;
        checks.push({
          name: run.name,
          verdict: "failed",
          detail: `${conclusion}, but listed in gatekeeper.strictChecks and must report success`,
        });
      } else {
        checks.push({
          name: run.name,
          verdict: "ignored",
          detail: `${conclusion} (acceptable)`,
        });
      }
      continue;
    }

    if (FAILING_CONCLUSIONS.has(conclusion)) {
      anyFailure = true;
      checks.push({ name: run.name, verdict: "failed", detail: conclusion });
      continue;
    }

    // Unrecognised conclusion: fail closed. GitHub may add new conclusion
    // values, and guessing that an unknown outcome is benign is exactly the
    // wrong default for something that gates merges.
    anyFailure = true;
    checks.push({
      name: run.name,
      verdict: "failed",
      detail: `unrecognised conclusion "${conclusion}"`,
    });
  }

  // A strict check that never reported at all must hold us at pending. This is
  // the case most naive implementations miss: they only look at checks that
  // exist, so a workflow that failed to trigger reads as "nothing wrong".
  const present = new Set(runs.map((r) => r.name.toLowerCase()));
  for (const required of strict) {
    if (!present.has(required.trim().toLowerCase())) {
      anyPending = true;
      checks.push({
        name: required,
        verdict: "missing-required",
        detail: "required by gatekeeper.strictChecks but has not reported",
      });
    }
  }

  const counts = {
    passed: checks.filter((c) => c.verdict === "passed").length,
    failed: checks.filter((c) => c.verdict === "failed").length,
    pending: checks.filter((c) => c.verdict === "pending").length,
    ignored: checks.filter((c) => c.verdict === "ignored").length,
    missing: checks.filter((c) => c.verdict === "missing-required").length,
  };

  const outcome: Outcome = anyFailure
    ? "failure"
    : anyPending
      ? "pending"
      : "success";

  return {
    outcome,
    title: buildTitle(outcome, counts),
    summary: buildSummary(outcome, checks, counts),
    checks,
    counts,
  };
}

function buildTitle(outcome: Outcome, counts: Evaluation["counts"]): string {
  switch (outcome) {
    case "failure":
      return `${counts.failed} check${counts.failed === 1 ? "" : "s"} failing`;
    case "pending": {
      const waiting = counts.pending + counts.missing;
      return `Waiting on ${waiting} check${waiting === 1 ? "" : "s"}`;
    }
    case "success":
      return counts.passed === 0
        ? "Nothing to check"
        : `All ${counts.passed} check${counts.passed === 1 ? "" : "s"} passing`;
  }
}

const VERDICT_ICON: Record<Verdict, string> = {
  passed: "x",
  failed: "x",
  pending: " ",
  ignored: "x",
  "missing-required": " ",
};

const VERDICT_LABEL: Record<Verdict, string> = {
  passed: "pass",
  failed: "FAIL",
  pending: "pending",
  ignored: "ignored",
  "missing-required": "MISSING",
};

function buildSummary(
  outcome: Outcome,
  checks: readonly EvaluatedCheck[],
  counts: Evaluation["counts"],
): string {
  const lines: string[] = [];

  switch (outcome) {
    case "failure":
      lines.push(
        "Woodhouse will not be presenting this one. The following checks did not pass:",
      );
      break;
    case "pending":
      lines.push("Still waiting for the rest of the results.");
      break;
    case "success":
      lines.push(
        counts.passed === 0
          ? "No checks required evaluation on this commit."
          : "Everything checks out.",
      );
      break;
  }

  if (checks.length > 0) {
    lines.push("");
    // Ordered so the actionable items are at the top.
    const order: Verdict[] = [
      "failed",
      "missing-required",
      "pending",
      "passed",
      "ignored",
    ];
    const sorted = [...checks].sort(
      (a, b) =>
        order.indexOf(a.verdict) - order.indexOf(b.verdict) ||
        a.name.localeCompare(b.name),
    );
    for (const check of sorted) {
      lines.push(
        `- [${VERDICT_ICON[check.verdict]}] **${check.name}** — ` +
          `${VERDICT_LABEL[check.verdict]} (${check.detail})`,
      );
    }
  }

  return lines.join("\n");
}
