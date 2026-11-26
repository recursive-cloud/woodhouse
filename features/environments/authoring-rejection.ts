/**
 * Step bodies shared by the environments acceptance suites.
 *
 * Both `apply.steps.ts` and `branch-policies.steps.ts` pin the same
 * authoring-time rejection: the invalid environments section must surface as
 * issues, the sync is skipped for `invalid-config`, and no settings write is
 * attempted. The bodies live here so both features assert the same facts. This
 * module is not a vitest entry: the `.steps.ts` files import it.
 */

import { expect } from "vitest";
import {
  type EnvironmentsWorld,
  requireResolved,
  requireSummary,
  resolvedFromLayers,
} from "./apply-world.js";

/**
 * The `Given` body: resolve one local layer and assert the authoring issue.
 * The baseline is absent, so the supplied fixture alone decides the message.
 */
export function rejectInvalidConfig(
  w: EnvironmentsWorld,
  localYaml: string,
  messageFragment: string,
): void {
  w.resolved = resolvedFromLayers(undefined, localYaml);
  const resolved = requireResolved(w.resolved);
  expect(resolved.issues.length).toBeGreaterThan(0);
  expect(resolved.issues.map((issue) => issue.message).join("\n")).toContain(messageFragment);
}

/** The `Then` body: the gate stopped the sync before any applier call. */
export function assertNoSettingsWritten(w: EnvironmentsWorld): void {
  expect(requireSummary(w.summary)).toEqual({
    changes: [],
    failures: [],
    dryRun: false,
  });
  expect(w.built.calls).toEqual([]);
}

/** The `And` body: the skip reason the gate logged. */
export function skippedForInvalidConfig(w: EnvironmentsWorld): () => void {
  return () => {
    expect(w.log.debug).toHaveBeenCalledWith({ reason: "invalid-config" }, "Settings sync skipped");
  };
}
