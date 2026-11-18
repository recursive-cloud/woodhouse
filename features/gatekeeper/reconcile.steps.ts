import { expect } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import {
  handleCheckRunCompleted,
  handleCheckSuiteCompleted,
  seedAndSchedule,
} from "../../src/app.js";
import { reconcile, type ReconcileResult } from "../../src/gatekeeper/handler.js";
import type { Outcome } from "../../src/gatekeeper/evaluate.js";
import { WHITE_GLOVE_CHECK_NAME } from "../../src/gatekeeper/constants.js";
import { Scheduler } from "../../src/lib/scheduler.js";
import {
  buildGatekeeperHarness,
  requireGatekeeperHarness,
  type GatekeeperHarness,
  type RawCheckRun,
} from "./gatekeeper-world.js";
import { readCell } from "../support/scenario.js";

const feature = await loadFeature("features/gatekeeper/reconcile.feature");

const OWNER = "acme";
const REPO = "widgets";
const SHA = "0123456789abcdef0123456789abcdef01234567";

/**
 * Build the head commit's white-glove runs from a `<white-glove runs>` cell.
 *
 * The phrases are fixed by the feature and two of them describe a *pair* of
 * runs, so this is an exact-phrase lookup rather than a split on " and ". An
 * unrecognised phrase is a broken scenario, so it throws.
 */
function parseWhiteGloveRuns(cell: string): RawCheckRun[] {
  switch (cell.trim()) {
    case "no white-glove run":
      return [];
    case "a white-glove run in progress":
      return [
        {
          name: WHITE_GLOVE_CHECK_NAME,
          id: 301,
          status: "in_progress",
          conclusion: null,
          started_at: "2026-01-02T00:00:00Z",
        },
      ];
    case "a white-glove run queued":
      return [{ name: WHITE_GLOVE_CHECK_NAME, id: 500, status: "queued", conclusion: null }];
    case `a white-glove run in status "preparing"`:
      return [{ name: WHITE_GLOVE_CHECK_NAME, id: 600, status: "preparing", conclusion: null }];
    case `a white-glove run in status "requested"`:
      return [{ name: WHITE_GLOVE_CHECK_NAME, id: 700, status: "requested", conclusion: null }];
    case "a white-glove run completed and failing":
      return [
        {
          name: WHITE_GLOVE_CHECK_NAME,
          id: 302,
          status: "completed",
          conclusion: "failure",
          started_at: "2026-01-01T00:00:00Z",
        },
      ];
    case "a completed white-glove run and a newer in progress white-glove run":
      return [
        {
          name: WHITE_GLOVE_CHECK_NAME,
          id: 400,
          status: "completed",
          conclusion: "failure",
          started_at: "2026-01-01T00:00:00Z",
        },
        {
          name: WHITE_GLOVE_CHECK_NAME,
          id: 401,
          status: "in_progress",
          conclusion: null,
          started_at: "2026-01-02T00:00:00Z",
        },
      ];
    case "a foreign-named run and a white-glove run in progress":
      return [
        {
          name: "someone-elses-check",
          id: 999,
          status: "completed",
          conclusion: "success",
          started_at: "2026-01-03T00:00:00Z",
        },
        {
          name: WHITE_GLOVE_CHECK_NAME,
          id: 401,
          status: "in_progress",
          conclusion: null,
          started_at: "2026-01-02T00:00:00Z",
        },
      ];
    case "a white-glove run without a start time and an older completed white-glove run":
      return [
        { name: WHITE_GLOVE_CHECK_NAME, id: 601, status: "in_progress", conclusion: null },
        {
          name: WHITE_GLOVE_CHECK_NAME,
          id: 500,
          status: "completed",
          conclusion: "failure",
          started_at: "2026-01-01T00:00:00Z",
        },
      ];
    default:
      throw new Error(`Unrecognised white-glove runs phrase: ${JSON.stringify(cell)}`);
  }
}

/** Build the head commit's child checks from a `<child checks>` cell. */
function parseChildChecks(cell: string): RawCheckRun[] {
  switch (cell.trim()) {
    case "no child checks":
      return [];
    case "a running build check":
      return [
        {
          name: "build",
          id: 201,
          status: "in_progress",
          conclusion: null,
          started_at: "2026-01-02T00:00:00Z",
        },
      ];
    case "a passing build check":
      return [
        {
          name: "build",
          id: 202,
          status: "completed",
          conclusion: "success",
          started_at: "2026-01-02T00:00:00Z",
        },
      ];
    case "a failing build check":
      return [
        {
          name: "build",
          id: 203,
          status: "completed",
          conclusion: "failure",
          started_at: "2026-01-02T00:00:00Z",
        },
      ];
    default:
      throw new Error(`Unrecognised child checks phrase: ${JSON.stringify(cell)}`);
  }
}

type Decision = { readonly kind: "create" } | { readonly kind: "update"; readonly id: number };

/** Map a `<decision>` cell to the write path it names. */
function parseDecision(cell: string): Decision {
  const text = cell.trim();
  if (text === "a new white-glove run is created on the head commit") {
    return { kind: "create" };
  }

  const update = /^the white-glove run with id (\d+) is updated in place$/.exec(text);
  if (update !== null) {
    return { kind: "update", id: Number(update[1]) };
  }

  throw new Error(`Unrecognised decision phrase: ${JSON.stringify(cell)}`);
}

/**
 * The verdict the child checks imply, derived from the cell rather than from
 * the handler's own evaluation so the write assertion stays independent:
 * failure beats pending beats success, exactly as `evaluate` orders them.
 *
 * Scoped to the check states the feature uses — a running, passing or failing
 * build check. A completed run with any other conclusion (skipped, neutral,
 * cancelled, …) is outside this matrix and maps to failure here; adding one to
 * a scenario would need this helper revisited.
 */
function expectedOutcome(checks: readonly RawCheckRun[]): Outcome {
  if (checks.some((run) => run.status !== "completed")) return "pending";
  if (checks.some((run) => run.conclusion !== "success")) return "failure";
  return "success";
}

function requireResult(result: ReconcileResult | undefined): ReconcileResult {
  if (result === undefined) {
    throw new Error("reconcile returned undefined; the gatekeeper should be enabled.");
  }
  return result;
}

/** The status/conclusion body the fresh verdict implies. */
function expectedState(outcome: Outcome): Record<string, unknown> {
  return outcome === "pending"
    ? { status: "in_progress" }
    : { status: "completed", conclusion: outcome };
}

/** Pin the write path named by a `<decision>` cell, including the status body. */
function expectDecisionWrite(
  harness: GatekeeperHarness,
  decision: Decision,
  outcome: Outcome,
): void {
  const state = expectedState(outcome);

  if (decision.kind === "create") {
    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.create).toHaveBeenCalledTimes(1);
    const body = harness.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual(
      expect.objectContaining({ name: WHITE_GLOVE_CHECK_NAME, head_sha: SHA, ...state }),
    );
    // `check_run_id` addresses an existing run; GitHub has no such field on create.
    expect(body).not.toHaveProperty("check_run_id");
    return;
  }

  expect(harness.create).not.toHaveBeenCalled();
  expect(harness.update).toHaveBeenCalledTimes(1);
  const body = harness.update.mock.calls[0]?.[0] as Record<string, unknown>;
  expect(body).toEqual(
    expect.objectContaining({ name: WHITE_GLOVE_CHECK_NAME, check_run_id: decision.id, ...state }),
  );
  // `head_sha` is a create-only parameter; GitHub has no such field on update.
  expect(body).not.toHaveProperty("head_sha");
}

/** Pin an in-place update that concludes failure. */
function expectUpdatedAsFailed(harness: GatekeeperHarness, id: number): void {
  expect(harness.create).not.toHaveBeenCalled();
  expect(harness.update).toHaveBeenCalledTimes(1);
  const body = harness.update.mock.calls[0]?.[0] as Record<string, unknown>;
  expect(body).toEqual(
    expect.objectContaining({
      name: WHITE_GLOVE_CHECK_NAME,
      check_run_id: id,
      status: "completed",
      conclusion: "failure",
    }),
  );
  expect(body).not.toHaveProperty("head_sha");
}

describeFeature(feature, ({ ScenarioOutline, Scenario }) => {
  ScenarioOutline(
    `The write follows the latest white-glove run and the fresh verdict`,
    ({ Given, When, Then, And }, variables) => {
      let whiteGloveRuns: RawCheckRun[] = [];
      let childChecks: RawCheckRun[] = [];
      let harness: GatekeeperHarness | undefined;
      let result: ReconcileResult | undefined;

      Given(`the head commit carries <white-glove runs>`, () => {
        whiteGloveRuns = parseWhiteGloveRuns(readCell(variables, "white-glove runs"));
      });
      And(`the commit carries <child checks>`, () => {
        childChecks = parseChildChecks(readCell(variables, "child checks"));
      });
      When(`the white-glove check is reconciled`, async () => {
        harness = buildGatekeeperHarness({ whiteGloveRuns, childChecks });
        result = await reconcile(harness.deps, OWNER, REPO, SHA);
        requireResult(result);
      });
      Then(`<decision>`, () => {
        expectDecisionWrite(
          requireGatekeeperHarness(harness),
          parseDecision(readCell(variables, "decision")),
          expectedOutcome(childChecks),
        );
      });
    },
  );

  Scenario(`A pull request event seeds the check on the head commit`, ({ Given, When, Then }) => {
    let harness: GatekeeperHarness | undefined;
    let scheduler: Scheduler | undefined;

    Given(`the head commit has no white-glove run and no child checks`, () => {
      harness = buildGatekeeperHarness({ whiteGloveRuns: [], childChecks: [] });
      scheduler = new Scheduler();
    });
    When(`the white-glove check is seeded for a pull request event`, async () => {
      const built = requireGatekeeperHarness(harness);
      if (scheduler === undefined) throw new Error("The scheduler has not been built yet.");
      const first = await seedAndSchedule({ ...built.deps, scheduler }, OWNER, REPO, SHA);
      if (first === undefined) {
        throw new Error("reconcile returned undefined; the gatekeeper should be enabled.");
      }
      // The first pass sees an empty commit, so it must hold the check pending.
      expect(first.result.evaluation.outcome).toBe("pending");
    });
    Then(`a new white-glove run is created on the head commit as pending`, () => {
      const built = requireGatekeeperHarness(harness);
      scheduler?.cancelAll();
      expect(built.update).not.toHaveBeenCalled();
      expect(built.create).toHaveBeenCalledTimes(1);
      expect(built.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: WHITE_GLOVE_CHECK_NAME,
          head_sha: SHA,
          status: "in_progress",
        }),
      );
    });
  });

  Scenario(
    `A completed check run triggers a fresh reconciliation`,
    ({ Given, When, Then, And }) => {
      let whiteGloveRuns: RawCheckRun[] = [];
      let childChecks: RawCheckRun[] = [];
      let harness: GatekeeperHarness | undefined;
      let result: ReconcileResult | undefined;

      Given(`the head commit carries a white-glove run completed and failing`, () => {
        whiteGloveRuns = parseWhiteGloveRuns("a white-glove run completed and failing");
      });
      And(`the commit carries a failing build check`, () => {
        childChecks = parseChildChecks("a failing build check");
      });
      When(`the white-glove check is reconciled for a completed check run event`, async () => {
        harness = buildGatekeeperHarness({ whiteGloveRuns, childChecks });
        // A foreign check run completed; reconciling our own would loop.
        result = await handleCheckRunCompleted(harness.deps, OWNER, REPO, {
          name: "build",
          head_sha: SHA,
        });
      });
      Then(`the fresh verdict is re-derived from every check on the head commit`, () => {
        const evaluation = requireResult(result).evaluation;
        // One failing child is enough: proving the whole run set was re-read
        // rather than trusting the single check run in the webhook payload.
        expect(evaluation.counts.failed).toBe(1);
        expect(evaluation.checks).toContainEqual({
          name: "build",
          verdict: "failed",
          detail: "failure",
        });
      });
      And(`the white-glove run with id 302 is updated in place as failed`, () => {
        expectUpdatedAsFailed(requireGatekeeperHarness(harness), 302);
      });
    },
  );

  Scenario(
    `A completed check suite triggers a fresh reconciliation`,
    ({ Given, When, Then, And }) => {
      let whiteGloveRuns: RawCheckRun[] = [];
      let childChecks: RawCheckRun[] = [];
      let harness: GatekeeperHarness | undefined;
      let result: ReconcileResult | undefined;

      Given(`the head commit carries a white-glove run completed and failing`, () => {
        whiteGloveRuns = parseWhiteGloveRuns("a white-glove run completed and failing");
      });
      And(`the commit carries a failing build check`, () => {
        childChecks = parseChildChecks("a failing build check");
      });
      When(`the white-glove check is reconciled for a completed check suite event`, async () => {
        harness = buildGatekeeperHarness({ whiteGloveRuns, childChecks });
        result = await handleCheckSuiteCompleted(harness.deps, OWNER, REPO, SHA);
      });
      Then(`the fresh verdict is re-derived from every check on the head commit`, () => {
        const evaluation = requireResult(result).evaluation;
        // One failing child is enough: proving the whole run set was re-read
        // rather than trusting the single check run in the webhook payload.
        expect(evaluation.counts.failed).toBe(1);
        expect(evaluation.checks).toContainEqual({
          name: "build",
          verdict: "failed",
          detail: "failure",
        });
      });
      And(`the white-glove run with id 302 is updated in place as failed`, () => {
        expectUpdatedAsFailed(requireGatekeeperHarness(harness), 302);
      });
    },
  );

  Scenario(`A re-request re-derives the verdict fresh`, ({ Given, When, Then, And }) => {
    let whiteGloveRuns: RawCheckRun[] = [];
    let childChecks: RawCheckRun[] = [];
    let harness: GatekeeperHarness | undefined;
    let scheduler: Scheduler | undefined;

    Given(`the head commit carries a white-glove run completed and failing`, () => {
      whiteGloveRuns = parseWhiteGloveRuns("a white-glove run completed and failing");
    });
    And(`the commit carries a failing build check`, () => {
      childChecks = parseChildChecks("a failing build check");
    });
    When(`the white-glove check is re-requested`, async () => {
      harness = buildGatekeeperHarness({ whiteGloveRuns, childChecks });
      scheduler = new Scheduler();
      const first = await seedAndSchedule({ ...harness.deps, scheduler }, OWNER, REPO, SHA);
      if (first === undefined) {
        throw new Error("reconcile returned undefined; the gatekeeper should be enabled.");
      }
      expect(first.result.evaluation.outcome).toBe("failure");
      // The commit already has checks, so the pass has nothing to wait for and
      // leaves no re-check behind.
      expect(first.scheduled).toBe(false);
    });
    Then(`the white-glove run with id 302 is updated in place as failed`, () => {
      scheduler?.cancelAll();
      expectUpdatedAsFailed(requireGatekeeperHarness(harness), 302);
    });
  });

  Scenario(`The gatekeeper is disabled`, ({ Given, When, Then, And }) => {
    let enabled = true;
    let harness: GatekeeperHarness | undefined;
    let result: ReconcileResult | undefined;

    Given(`gatekeeper.enabled is false`, () => {
      enabled = false;
    });
    And(`the head commit has no white-glove run and no child checks`, () => {
      harness = buildGatekeeperHarness({ whiteGloveRuns: [], childChecks: [], enabled });
    });
    When(`the white-glove check is reconciled`, async () => {
      const built = requireGatekeeperHarness(harness);
      result = await reconcile(built.deps, OWNER, REPO, SHA);
    });
    Then(`no white-glove run is created or updated`, () => {
      const built = requireGatekeeperHarness(harness);
      expect(result).toBeUndefined();
      expect(built.create).not.toHaveBeenCalled();
      expect(built.update).not.toHaveBeenCalled();
    });
  });
});
