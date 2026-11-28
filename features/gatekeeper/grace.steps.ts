import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { seedAndSchedule, type FirstPass as AppFirstPass, type GraceDeps } from "../../src/app.js";
import { WHITE_GLOVE_CHECK_NAME } from "../../src/gatekeeper/constants.js";
import { Scheduler } from "../../src/lib/scheduler.js";
import {
  buildGatekeeperHarness,
  requireGatekeeperHarness,
  type GatekeeperHarness,
  type RawCheckRun,
} from "./gatekeeper-world.js";
import { installScenarioFakeClock, readCell } from "../support/scenario.js";

const feature = await loadFeature("features/gatekeeper/grace.feature");

const OWNER = "acme";
const REPO = "widgets";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SCHEDULER_KEY = `${OWNER}/${REPO}@${SHA}`;

/**
 * Build the head commit's check runs from a `<runs>` cell.
 *
 * The phrases are fixed by the feature; an unrecognised phrase is a broken
 * scenario, so this throws rather than returning an empty set that might pass.
 */
function parseRuns(cell: string): RawCheckRun[] {
  switch (cell.trim()) {
    case "no checks at all":
      return [];
    case "only the white-glove check itself":
      return [
        {
          name: WHITE_GLOVE_CHECK_NAME,
          id: 300,
          status: "completed",
          conclusion: "success",
          started_at: "2026-01-01T00:00:00Z",
        },
      ];
    default:
      throw new Error(`Unrecognised runs phrase: ${JSON.stringify(cell)}`);
  }
}

/**
 * Let pending promise chains settle.
 *
 * The scheduled callback is fire-and-forget (the real `Scheduler` deliberately
 * does not await it), so the test has to give the reconcile chain it starts a
 * turn to finish before inspecting its result.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve();
  }
}

/** The production first pass, pinned to the instant the scenario scheduled it. */
interface FirstPass extends AppFirstPass {
  readonly scheduledAt: number;
}

/** The harness dependencies plus the scheduler the extracted grace path needs. */
function graceDeps(harness: GatekeeperHarness, scheduler: Scheduler): GraceDeps {
  return { ...harness.deps, scheduler };
}

/**
 * Run the production grace path: reconcile with `emptyIsPending`, then schedule
 * a second, unconstrained pass once the grace period expires if the commit is
 * still waiting for checks to start.
 */
async function runFirstPass(harness: GatekeeperHarness, scheduler: Scheduler): Promise<FirstPass> {
  // Recorded before the call so the scheduler `runAt` can be pinned against
  // it; fake timers keep `Date.now()` stable across the awaited reconcile.
  const scheduledAt = Date.now();
  const pass = await seedAndSchedule(graceDeps(harness, scheduler), OWNER, REPO, SHA);

  if (pass === undefined) {
    throw new Error("reconcile returned undefined; the gatekeeper should be enabled.");
  }
  if (!pass.result.evaluation.awaitingStart) {
    throw new Error("The scenario expects a commit carrying nothing but the white-glove check.");
  }

  return {
    result: pass.result,
    graceMs: pass.graceMs,
    scheduledAt,
    scheduled: pass.scheduled,
  };
}

describeFeature(feature, ({ ScenarioOutline, Scenario, BeforeEachScenario, AfterEachScenario }) => {
  // The fake clock must bracket a whole scenario: the clock is installed once
  // and the scheduled timer survives into the step that fires it.
  installScenarioFakeClock({ BeforeEachScenario, AfterEachScenario });
  ScenarioOutline(
    `Inside the grace window the check holds pending and schedules a re-check`,
    ({ Given, When, Then, And }, variables) => {
      let harness: GatekeeperHarness | undefined;
      let scheduler: Scheduler | undefined;
      let first: FirstPass | undefined;

      Given(`a pull request opened on a head commit with <runs>`, () => {
        // The grace feature's `<runs>` cell only ever describes the white-glove
        // runs on the head commit.
        harness = buildGatekeeperHarness({
          whiteGloveRuns: parseRuns(readCell(variables, "runs")),
        });
        scheduler = new Scheduler();
      });
      When(`the first pass runs`, async () => {
        const built = requireGatekeeperHarness(harness);
        if (scheduler === undefined) throw new Error("The scheduler has not been built yet.");
        first = await runFirstPass(built, scheduler);
      });
      Then(`the white-glove check is pending`, () => {
        if (first === undefined) throw new Error("The first pass has not run yet.");
        expect(first.result.evaluation.outcome).toBe("pending");
      });
      And(`a re-check is scheduled after the grace period`, async () => {
        if (first === undefined) throw new Error("The first pass has not run yet.");
        if (scheduler === undefined) throw new Error("The scheduler has not been built yet.");
        const built = requireGatekeeperHarness(harness);

        // The schema default, asserted rather than assumed.
        expect(first.graceMs).toBe(30_000);

        // The first pass reported that the commit left it no choice but to
        // schedule a re-check.
        expect(first.scheduled).toBe(true);

        const pending = scheduler.pending();
        expect(pending).toHaveLength(1);
        expect(pending[0]!.key).toBe(SCHEDULER_KEY);
        expect(pending[0]!.runAt).toBe(first.scheduledAt + first.graceMs);

        // The first pass reconciled once; nothing more until the timer fires.
        expect(built.paginate).toHaveBeenCalledTimes(1);

        // One millisecond short the re-check must still be waiting.
        await vi.advanceTimersByTimeAsync(first.graceMs - 1);
        expect(scheduler.pending()).toHaveLength(1);
        expect(built.paginate).toHaveBeenCalledTimes(1);

        // The last millisecond fires it, and the re-check re-reads the commit.
        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(scheduler.pending()).toHaveLength(0);
        expect(built.paginate).toHaveBeenCalledTimes(2);
      });
    },
  );

  Scenario(`No CI at all`, ({ Given, When, Then }) => {
    let harness: GatekeeperHarness | undefined;
    let scheduler: Scheduler | undefined;
    let first: FirstPass | undefined;

    Given(`a pull request opened on a head commit with no checks at all`, async () => {
      harness = buildGatekeeperHarness({ whiteGloveRuns: parseRuns("no checks at all") });
      scheduler = new Scheduler();
      first = await runFirstPass(harness, scheduler);
      expect(scheduler.pending()).toHaveLength(1);
    });
    When(`the grace period elapses with still no check runs`, async () => {
      if (first === undefined) throw new Error("The first pass has not run yet.");
      await vi.advanceTimersByTimeAsync(first.graceMs);
      await flushMicrotasks();
    });
    Then(`the white-glove check passes`, () => {
      const built = requireGatekeeperHarness(harness);
      if (first === undefined) throw new Error("The first pass has not run yet.");

      // The re-check saw no checks and concluded success, so it wrote a
      // completed run. The first pass had created a pending one.
      expect(built.paginate).toHaveBeenCalledTimes(2);
      expect(built.create).toHaveBeenCalledTimes(2);
      expect(built.create.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({
          name: WHITE_GLOVE_CHECK_NAME,
          head_sha: SHA,
          status: "completed",
          conclusion: "success",
        }),
      );
    });
  });
});
