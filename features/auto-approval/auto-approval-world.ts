/**
 * Fixture and harness layer for the auto-approval acceptance suite.
 *
 * The scenarios drive the real production entry points: `seedAndSchedule` for a
 * pull request event and `handleCheckRunCompleted` for CI finishing. Both run
 * the white-glove reconcile, which is where the approval now has to come from,
 * so the world holds the live pull request that pass re-reads, the head
 * commit's check runs, the changed-file pages, the existing reviews and the
 * dry-run flag. Only the fake octokit is built here; the scenario owns the
 * facts it hands the entry helpers.
 *
 * This module is not a vitest entry: `auto-approval.steps.ts` imports it.
 */

import { expect, vi } from "vitest";
import { seedAndSchedule } from "../../src/app.js";
import type { GraceDeps } from "../../src/app.js";
import { approvalPass } from "../../src/approval/silverPlatter.js";
import { woodhouseConfigSchema } from "../../src/config/schema.js";
import type { AutoApprovalConfig } from "../../src/config/schema.js";
import type { ReconcileDeps } from "../../src/gatekeeper/handler.js";
import { Scheduler } from "../../src/lib/scheduler.js";
import {
  ENABLED_BY_SELF,
  HEAD,
  OWNER,
  PR_NUMBER,
  REPO,
  RENOVATE,
  UNREMARKABLE_FILES,
  approvalOctokit,
  approvalPaginate,
  associatedStub,
  checksStubs,
  livePullData,
  parseConfig,
  pullRequestStubs,
  requireConfig,
  runHeadChecks,
  withAllowedBot,
  type AutoMerge,
  type PullRequestFacts,
  type ReviewParams,
} from "../support/approval-fixtures.js";
import { fakeLogger, requireBuilt } from "../support/scenario.js";

export { ENABLED_BY_SELF, HEAD, RENOVATE, parseConfig, requireConfig, withAllowedBot };
export type { AutoMerge };

/** The live pull request the approval pass re-reads on every evaluation. */
export interface PullRequestFixture extends PullRequestFacts {
  autoMerge: AutoMerge | null;
}

interface HarnessOptions {
  readonly autoApproval: AutoApprovalConfig;
  readonly dryRun?: boolean;
}

/**
 * Fake octokit covering both surfaces a scenario uses: the checks API the
 * reconcile writes to, and the pull-request facts the eventual approval reads.
 *
 * `paginate` mirrors octokit by calling the route once per page until a short
 * page. It sees every route the production code paginates, and reads the
 * check-run store exactly as supplied, so the white-glove run a previous pass
 * created is deliberately absent (production re-reads GitHub, not its own
 * writes).
 */
export function buildAutoApprovalHarness(fixture: PullRequestFixture, options: HarnessOptions) {
  const { autoApproval, dryRun = false } = options;
  const config = woodhouseConfigSchema.parse({
    gatekeeper: { enabled: true },
    autoApproval,
  });
  const resolver = {
    resolve: vi.fn(async () => ({ config, sources: [], issues: [] })),
  } as unknown as ReconcileDeps["resolver"];

  const { listForRef, create, update } = checksStubs(fixture);

  // Recorded separately from the mock so a scenario can read the review body
  // without poking at vi.fn internals.
  const submitted: ReviewParams[] = [];
  const { listFiles, listReviews, createReview } = pullRequestStubs(fixture, submitted);

  // The live pull request GET: the only source of the current auto-merge, draft
  // and author facts, so a scenario can toggle any of them after opening.
  const get = vi.fn(async () => ({ data: livePullData(fixture, fixture.autoMerge) }));

  const listAssociated = associatedStub(fixture);

  const knownRoutes = new Set<unknown>([listForRef, listFiles, listReviews, listAssociated]);
  const paginate = approvalPaginate(
    knownRoutes,
    "Unrecognised paginate route in the auto-approval harness",
  );

  const octokit = approvalOctokit({
    paginate,
    pulls: { listFiles, listReviews, get, createReview },
    listAssociated,
    listForRef,
    create,
    update,
  });

  const log = fakeLogger();
  // The scenarios call the production entry points directly rather than
  // through `createApp`, so the harness supplies the same approval hook the
  // app wires into its reconcile deps: after a successful evaluation, approve
  // the open pull requests headed by the commit.
  const deps: ReconcileDeps = {
    octokit,
    resolver,
    log,
    dryRun,
    onSuccess: approvalPass(resolver, dryRun)(octokit, log),
  };

  return {
    deps,
    resolver,
    log,
    listForRef,
    create,
    update,
    listFiles,
    listReviews,
    get,
    createReview,
    submitted,
  };
}

export type Harness = ReturnType<typeof buildAutoApprovalHarness>;

/** Everything a scenario accumulates before the scenario's entry point runs. */
export interface World {
  config: AutoApprovalConfig | undefined;
  fixture: PullRequestFixture;
  dryRun: boolean;
  scheduler: Scheduler;
  harness: Harness | undefined;
  /** The most recent `seedAndSchedule` result, so the grace scenario can read it. */
  firstPass: FirstPass | undefined;
}

type FirstPass = NonNullable<Awaited<ReturnType<typeof seedAndSchedule>>>;

export function world(): World {
  return {
    config: undefined,
    fixture: {
      number: PR_NUMBER,
      author: "my-user",
      draft: false,
      state: "open",
      headSha: HEAD,
      autoMerge: null,
      reviews: [],
      filePages: [UNREMARKABLE_FILES],
      checks: "none",
    },
    dryRun: false,
    scheduler: new Scheduler(),
    harness: undefined,
    firstPass: undefined,
  };
}

export function harnessFor(w: World): Harness {
  if (w.harness === undefined) {
    w.harness = buildAutoApprovalHarness(w.fixture, {
      autoApproval: requireConfig(w),
      dryRun: w.dryRun,
    });
  }
  return w.harness;
}

function depsFor(w: World): GraceDeps {
  return { ...harnessFor(w).deps, scheduler: w.scheduler };
}

/** Let pending promise chains settle, including a fire-and-forget re-check. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve();
  }
}

/** Run the production pull-request path for the fixture's head commit. */
async function seed(w: World): Promise<void> {
  const pass = await seedAndSchedule(depsFor(w), OWNER, REPO, HEAD);
  w.firstPass = requireBuilt(
    pass,
    "reconcile returned undefined; the gatekeeper should be enabled.",
  );
}

/** A pull request (or a reopened/synchronized one) from `author`. */
export async function openPullRequest(w: World, author: string): Promise<void> {
  w.fixture.author = author;
  w.fixture.draft = false;
  await seed(w);
}

/** A force-push: the same fixture now carries a new head commit. */
export async function synchronize(w: World): Promise<void> {
  await seed(w);
}

/** GitHub's post-ready payload: the fixture is no longer a draft. */
export async function readyForReview(w: World): Promise<void> {
  w.fixture.draft = false;
  await seed(w);
}

/** CI finished on the head commit: flip the store, then run the production handler. */
export async function checksPass(w: World): Promise<void> {
  w.fixture.checks = "passed";
  await runHeadChecks(depsFor(w), "success", "passing checks");
}

/** Fire the scheduled re-check after the grace the first pass reported. */
export async function graceElapsed(w: World): Promise<void> {
  const first = requireBuilt(w.firstPass, "The pull request has not been opened yet.");

  // The schema default, read from the pass rather than assumed by the harness.
  expect(first.graceMs).toBe(30_000);

  await vi.advanceTimersByTimeAsync(first.graceMs);
  await flushMicrotasks();
}

export function requireAutoApprovalHarness(harness: Harness | undefined): Harness {
  return requireBuilt(harness, "The pull request has not been opened yet.");
}
