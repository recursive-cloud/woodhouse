/**
 * The Given registrations the auto-approval and reviewer-routing suites share.
 *
 * The phrases come from the feature files, so the step text cannot become a
 * helper parameter; only the body moves here. Each helper writes the same
 * facts into whichever world the scenario is using.
 *
 * This module is not a vitest entry: the steps files import it.
 */

import type { AutoApprovalConfig } from "../../src/config/schema.js";
import { RENOVATE, parseConfig } from "./approval-fixtures.js";

type StepCallback = () => void;

/** The step-registration callbacks a scenario receives from `describeFeature`. */
export interface ActorSteps {
  readonly Given: (name: string, callback: StepCallback) => void;
  readonly And: (name: string, callback: StepCallback) => void;
}

/** A world with the config slot every auto-approval suite shares. */
export interface ConfigSlot {
  config: AutoApprovalConfig | undefined;
}

/** Register `auto-approval lists "my-user" as an owner`. */
export function givenOwnerMyUser(steps: Pick<ActorSteps, "Given">, w: ConfigSlot): void {
  steps.Given(`auto-approval lists "my-user" as an owner`, () => {
    w.config = parseConfig({ owners: ["my-user"] });
  });
}

/** Register `auto-approval lists the Renovate bot as a bot`. */
export function givenRenovateListed(steps: Pick<ActorSteps, "Given">, w: ConfigSlot): void {
  steps.Given(`auto-approval lists the Renovate bot as a bot`, () => {
    w.config = parseConfig({ bots: [RENOVATE] });
  });
}

/**
 * Register the Renovate-bot pair the bot scenarios share: the bot is listed,
 * and it enabled auto-merge on its own pull request. `enableAutoMerge` writes
 * that fact into the scenario's world, whose shape differs between suites.
 */
export function givenRenovateBot(
  steps: ActorSteps,
  w: ConfigSlot,
  enableAutoMerge: () => void,
): void {
  givenRenovateListed(steps, w);
  steps.And(`the bot enabled auto-merge itself`, () => {
    enableAutoMerge();
  });
}
