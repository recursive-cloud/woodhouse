import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import type { Logger } from "pino";
import {
  reconcile,
  type ReconcileDeps,
  type ReconcileResult,
} from "../../src/gatekeeper/handler.js";
import { WHITE_GLOVE_CHECK_NAME } from "../../src/gatekeeper/constants.js";
import { woodhouseConfigSchema } from "../../src/config/schema.js";
import { Scheduler } from "../../src/lib/scheduler.js";

const feature = await loadFeature("features/gatekeeper/grace.feature");

const OWNER = "acme";
const REPO = "widgets";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SCHEDULER_KEY = `${OWNER}/${REPO}@${SHA}`;

type ScenarioVariables = Record<string, unknown>;

/** Read one Examples cell. A missing cell is a malformed scenario, not a value to guess. */
function readCell(variables: ScenarioVariables, key: string): string {
  const value = variables[key];
  if (typeof value !== "string") {
    throw new Error(`Scenario outline row is missing a string "${key}" cell.`);
  }
  return value;
}

/** The subset of a raw Checks API run the handler reads. */
interface RawCheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly id: number;
  readonly started_at?: string;
}

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
 * Fake octokit covering only the checks surface the handler touches. Both the
 * paginated listing and the name-filtered lookup see `runs`, so a re-check made
 * after the grace period observes exactly what the scenario left on the commit.
 */
function buildHarness(runs: readonly RawCheckRun[]) {
  const paginate = vi.fn(async () => runs);
  const listForRef = vi.fn(async () => ({
    data: { check_runs: runs.filter((run) => run.name === WHITE_GLOVE_CHECK_NAME) },
  }));
  const create = vi.fn(async () => ({ data: {} }));
  const update = vi.fn(async () => ({ data: {} }));

  const octokit = {
    paginate,
    checks: { listForRef, create, update },
  } as unknown as ReconcileDeps["octokit"];

  const config = woodhouseConfigSchema.parse({ gatekeeper: { enabled: true } });
  const resolver = {
    resolve: vi.fn(async () => ({ config, sources: [], issues: [] })),
  } as unknown as ReconcileDeps["resolver"];

  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const deps: ReconcileDeps = {
    octokit,
    resolver,
    log: log as unknown as Logger,
    dryRun: false,
  };

  return { deps, config, paginate, listForRef, create, update, log };
}

type Harness = ReturnType<typeof buildHarness>;

function requireHarness(harness: Harness | undefined): Harness {
  if (harness === undefined) {
    throw new Error("The fake GitHub client has not been built yet.");
  }
  return harness;
}

function requireResult(result: ReconcileResult | undefined): ReconcileResult {
  if (result === undefined) {
    throw new Error("reconcile returned undefined; the gatekeeper should be enabled.");
  }
  return result;
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

interface FirstPass {
  readonly result: ReconcileResult;
  readonly graceMs: number;
  readonly scheduledAt: number;
}

/**
 * The first half of `app.ts` `seedAndSchedule`: reconcile with
 * `emptyIsPending`, then schedule a second, unconstrained pass once the grace
 * period expires if the commit is still waiting for checks to start.
 */
async function seedAndSchedule(
  harness: Harness,
  scheduler: Scheduler,
  onRecheck: (result: ReconcileResult | undefined) => void,
): Promise<FirstPass> {
  const result = await reconcile(harness.deps, OWNER, REPO, SHA, { emptyIsPending: true });
  const required = requireResult(result);

  if (!required.evaluation.awaitingStart) {
    throw new Error("The scenario expects a commit carrying nothing but the white-glove check.");
  }

  const graceMs = required.gatekeeper.gracePeriodSeconds * 1000;
  const scheduledAt = Date.now();

  // app.ts also returns early when graceMs is 0; not mirrored here because no
  // scenario configures a zero grace period (the schema default is 30).
  scheduler.schedule(SCHEDULER_KEY, graceMs, async () => {
    onRecheck(await reconcile(harness.deps, OWNER, REPO, SHA));
  });

  return { result: required, graceMs, scheduledAt };
}

describeFeature(feature, ({ ScenarioOutline, Scenario, BeforeEachScenario, AfterEachScenario }) => {
  // vitest-cucumber runs one vitest test per step, so a per-test hook would
  // discard the fake clock between the step that schedules and the step that
  // advances it. These hooks bracket a whole scenario instead: the clock is
  // installed once and the scheduled timer survives into the step that fires it.
  BeforeEachScenario(() => {
    vi.useFakeTimers();
  });
  AfterEachScenario(() => {
    vi.useRealTimers();
  });
  ScenarioOutline(
    `Inside the grace window the check holds pending and schedules a re-check`,
    ({ Given, When, Then, And }, variables) => {
      let harness: Harness | undefined;
      let scheduler: Scheduler | undefined;
      let first: FirstPass | undefined;
      let recheckRan = false;

      Given(`a pull request opened on a head commit with <runs>`, () => {
        harness = buildHarness(parseRuns(readCell(variables, "runs")));
        scheduler = new Scheduler();
        recheckRan = false;
      });
      When(`the first pass runs`, async () => {
        const built = requireHarness(harness);
        if (scheduler === undefined) throw new Error("The scheduler has not been built yet.");
        first = await seedAndSchedule(built, scheduler, () => {
          recheckRan = true;
        });
      });
      Then(`the white-glove check is pending`, () => {
        if (first === undefined) throw new Error("The first pass has not run yet.");
        expect(first.result.evaluation.outcome).toBe("pending");
      });
      And(`a re-check is scheduled after the grace period`, async () => {
        if (first === undefined) throw new Error("The first pass has not run yet.");
        if (scheduler === undefined) throw new Error("The scheduler has not been built yet.");

        // The schema default, asserted rather than assumed.
        expect(first.graceMs).toBe(30_000);

        const pending = scheduler.pending();
        expect(pending).toHaveLength(1);
        expect(pending[0]!.key).toBe(SCHEDULER_KEY);
        expect(pending[0]!.runAt).toBe(first.scheduledAt + first.graceMs);

        // One millisecond short the re-check must still be waiting.
        await vi.advanceTimersByTimeAsync(first.graceMs - 1);
        expect(scheduler.pending()).toHaveLength(1);
        expect(recheckRan).toBe(false);

        // The last millisecond fires it.
        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(scheduler.pending()).toHaveLength(0);
        expect(recheckRan).toBe(true);
      });
    },
  );

  Scenario(`No CI at all`, ({ Given, When, Then }) => {
    let scheduler: Scheduler | undefined;
    let first: FirstPass | undefined;
    let recheckResult: ReconcileResult | undefined;

    Given(`a pull request opened on a head commit with no checks at all`, async () => {
      const harness = buildHarness(parseRuns("no checks at all"));
      scheduler = new Scheduler();
      recheckResult = undefined;
      first = await seedAndSchedule(harness, scheduler, (result) => {
        recheckResult = result;
      });
      expect(scheduler.pending()).toHaveLength(1);
    });
    When(`the grace period elapses with still no check runs`, async () => {
      if (first === undefined) throw new Error("The first pass has not run yet.");
      await vi.advanceTimersByTimeAsync(first.graceMs);
      await flushMicrotasks();
    });
    Then(`the white-glove check passes`, () => {
      if (recheckResult === undefined) {
        throw new Error("The scheduled re-check has not completed yet.");
      }
      expect(recheckResult.evaluation.outcome).toBe("success");
    });
  });
});
