/**
 * The settings appliers, and the order in which they run.
 *
 * The order is declared exactly once, here, so the orchestrator and the tests
 * observe the same sequence: repository, labels, branch-protection, rulesets,
 * environments.
 *
 * Each applier is an independent plain function over the shared `Applier`
 * shape and may throw; `syncSettings` collects the failures and continues.
 */

import { applyBranchProtection } from "./branch-protection.js";
import { applyEnvironments } from "./environments.js";
import { applyLabels } from "./labels.js";
import { applyRepository } from "./repository.js";
import { applyRulesets } from "./rulesets.js";
import type { Applier } from "./types.js";

export { applyBranchProtection, applyEnvironments, applyLabels, applyRepository, applyRulesets };

export const APPLIERS: { name: string; run: Applier }[] = [
  { name: "repository", run: applyRepository },
  { name: "labels", run: applyLabels },
  { name: "branch-protection", run: applyBranchProtection },
  // Rulesets run after the appliers they can restrict: they can limit what the
  // App itself is permitted to do, so everything else should already be in
  // place before they take effect.
  { name: "rulesets", run: applyRulesets },
  // Environments converge by re-declaration and are never deleted, so they run
  // after the appliers that can narrow what the App is permitted to do.
  { name: "environments", run: applyEnvironments },
];
