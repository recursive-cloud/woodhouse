/**
 * The outcome of a settings sync, as data.
 *
 * `syncSettings` aggregates each applier's change records and failures into an
 * `ApplySummary`; this module renders it for the log. Keeping the rendering
 * pure and in one place makes the wording deliberate — pinned by unit tests —
 * and leaves the orchestrator with nothing to format.
 */

import type { ChangeRecord, Failure } from "./appliers/types.js";

export interface ApplySummary {
  readonly changes: readonly ChangeRecord[];
  readonly failures: readonly Failure[];
  readonly dryRun: boolean;
}

/**
 * Render a summary as the log text.
 *
 * The live and dry-run variants share a headline; the individual changes and
 * failures are listed beneath it so the whole outcome is visible in one log
 * entry. An empty summary says so rather than logging nothing.
 */
export function formatApplySummary(summary: ApplySummary): string {
  const { changes, failures, dryRun } = summary;
  const lines: string[] = [];

  if (changes.length > 0) {
    lines.push(
      dryRun
        ? `DRY_RUN: would apply ${changes.length} change(s)`
        : `Applied ${changes.length} change(s)`,
    );
    for (const change of changes) {
      lines.push(`  - ${change.area} ${change.action}: ${change.target}`);
    }
  } else if (failures.length === 0) {
    lines.push("Repository already matches configuration");
  }

  if (failures.length > 0) {
    lines.push(`Failed ${failures.length} area(s)`);
    for (const failure of failures) {
      lines.push(`  - ${failure.area}: ${failure.message}`);
    }
  }

  return lines.join("\n");
}
