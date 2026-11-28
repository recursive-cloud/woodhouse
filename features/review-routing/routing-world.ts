/**
 * Fixture and harness layer for the reviewer-routing acceptance suite.
 *
 * The scenarios drive the real production paths, so the world holds everything
 * those paths read: the live pull-request GET that reports `auto_merge`, the two
 * reviewer routes that record what was requested and withdrawn, the commit's
 * check runs, the changed-file pages, the existing reviews and the review
 * submissions. One harness serves a whole scenario, so its `routed` map carries
 * the replacement-semantics memory across events.
 *
 * This module is not a vitest entry: `routing.steps.ts` imports it.
 */

import { expect, vi } from "vitest";
import { serve } from "../../src/approval/routing.js";
import type { RoutingDeps } from "../../src/approval/routing.js";
import { escalationPass } from "../../src/approval/escalation.js";
import { approvalPass } from "../../src/approval/silverPlatter.js";
import { woodhouseConfigSchema } from "../../src/config/schema.js";
import type { AutoApprovalConfig } from "../../src/config/schema.js";
import type { ReconcileDeps } from "../../src/gatekeeper/handler.js";
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
  withOwner,
  type AutoMerge,
  type PullRequestFacts,
  type ReviewParams,
  type RunsState,
} from "../support/approval-fixtures.js";
import { recorded, recorder } from "../support/recorded.js";
import { fakeLogger, requireBuilt } from "../support/scenario.js";

export { ENABLED_BY_SELF, HEAD, RENOVATE, parseConfig, requireConfig, withOwner };
export type { AutoMerge };

type OctokitApi = RoutingDeps["octokit"];

/** Mirrors the module constant in routing.ts; the scenario pins the delay. */
export const GRACE_MS = 2_000;

export const MY_USER = "my-user";
export const DEPENDABOT = "dependabot[bot]";

/** The live pull request both passes re-read. */
export type PullRequestFixture = PullRequestFacts;

export function makeFixture(): PullRequestFixture {
  return {
    number: PR_NUMBER,
    author: MY_USER,
    draft: false,
    state: "open",
    headSha: HEAD,
    reviews: [],
    filePages: [UNREMARKABLE_FILES],
    checks: "none",
  };
}

interface ReviewerParams {
  readonly owner: string;
  readonly repo: string;
  readonly pull_number: number;
  readonly reviewers: string[];
}

/** How the harness reads the current auto-merge fact on every GET. */
type AutoMergeSource = AutoMerge | null | (() => AutoMerge | null);

interface HarnessOptions {
  readonly fixture?: PullRequestFixture;
  /** The `auto_merge` object the live GET returns; null means nobody enabled it. */
  readonly autoMerge?: AutoMergeSource;
  /** The scenario's config, read at call time so a step can still build it. */
  readonly config?: () => AutoApprovalConfig;
  readonly dryRun?: boolean;
}

/**
 * Fake octokit covering both surfaces a scenario uses: the reviewer routes
 * routing writes to, and the pull-request/check facts the approval pass reads.
 * The GET reads the auto-merge fact at call time, so a scenario can toggle it
 * between events.
 *
 * `paginate` mirrors octokit by calling the route once per page until a short
 * page. It sees every route the production code paginates; an unrecognised
 * route is a harness gap, not an empty listing.
 */
export function buildRoutingHarness(options: HarnessOptions) {
  const fixture = options.fixture ?? makeFixture();
  const { autoMerge = null, dryRun = false } = options;
  const config = options.config ?? (() => parseConfig({}));

  const readAutoMerge = (): AutoMerge | null =>
    typeof autoMerge === "function" ? autoMerge() : autoMerge;

  const calls: string[] = [];
  const record = recorder(calls);

  // Cumulative, so a step can assert on the reviewer sets of one pass without
  // parsing the call log.
  const requested: string[][] = [];
  const removed: string[][] = [];
  const submitted: ReviewParams[] = [];

  // The live pull request GET: the only source of the current auto-merge,
  // draft and author facts, so a scenario can toggle any of them after opening.
  const get = recorded(record, "get", async () => ({
    data: livePullData(fixture, readAutoMerge()),
  }));

  const requestReviewers = recorded(
    record,
    (params: ReviewerParams) => `requestReviewers:${params.reviewers.join(",")}`,
    async (params: ReviewerParams) => {
      requested.push([...params.reviewers]);
      return { data: {} };
    },
  );

  const removeRequestedReviewers = recorded(
    record,
    (params: ReviewerParams) => `removeRequestedReviewers:${params.reviewers.join(",")}`,
    async (params: ReviewerParams) => {
      removed.push([...params.reviewers]);
      return { data: {} };
    },
  );

  const { listFiles, listReviews, createReview } = pullRequestStubs(fixture, submitted);
  const listAssociated = associatedStub(fixture);
  const { listForRef, create, update } = checksStubs(fixture);

  const knownRoutes = new Set<unknown>([listForRef, listFiles, listReviews, listAssociated]);
  const paginate = approvalPaginate(
    knownRoutes,
    "Unrecognised paginate route in the routing harness",
  );

  const octokit = approvalOctokit({
    paginate,
    pulls: {
      get,
      requestReviewers,
      removeRequestedReviewers,
      listFiles,
      listReviews,
      createReview,
    },
    listAssociated,
    listForRef,
    create,
    update,
  });

  const log = fakeLogger();
  const routed = new Map<string, readonly string[]>();
  const deps: RoutingDeps = {
    octokit: octokit as unknown as OctokitApi,
    log,
    dryRun,
    routed,
  };

  const resolver = {
    resolve: vi.fn(async () => ({
      config: woodhouseConfigSchema.parse({
        gatekeeper: { enabled: true },
        autoApproval: config(),
      }),
      sources: [],
      issues: [],
    })),
  } as unknown as ReconcileDeps["resolver"];

  // The scenarios call the production entry points directly rather than
  // through `createApp`, so the harness supplies the same approval hook the
  // app wires into its reconcile deps.
  const routing = { routed };
  const reconcileDeps: ReconcileDeps = {
    octokit,
    resolver,
    log,
    dryRun,
    onSuccess: approvalPass(resolver, dryRun, routing)(octokit, log),
    onFailure: escalationPass(resolver, dryRun, routing)(octokit, log),
  };

  return {
    deps,
    reconcileDeps,
    resolver,
    octokit,
    log,
    routed,
    calls,
    requested,
    removed,
    submitted,
    get,
    requestReviewers,
    removeRequestedReviewers,
    listFiles,
    listReviews,
    createReview,
    listForRef,
    listAssociated,
    paginate,
    create,
    update,
  };
}

export type Harness = ReturnType<typeof buildRoutingHarness>;

export interface World {
  config: AutoApprovalConfig | undefined;
  fixture: PullRequestFixture;
  autoMerge: AutoMerge | null;
  dryRun: boolean;
  harness: Harness | undefined;
  /** Lengths of the cumulative logs when the current pass started. */
  passStart: number;
  passRemovedStart: number;
  passSubmittedStart: number;
}

export function world(): World {
  return {
    config: undefined,
    fixture: makeFixture(),
    autoMerge: null,
    dryRun: false,
    harness: undefined,
    passStart: 0,
    passRemovedStart: 0,
    passSubmittedStart: 0,
  };
}

export function requireRoutingHarness(w: World): Harness {
  return requireBuilt(w.harness, "The pull request has not been routed yet.");
}

/** The one harness a scenario shares across all of its passes. */
function harnessFor(w: World): Harness {
  w.harness ??= buildRoutingHarness({
    fixture: w.fixture,
    autoMerge: () => w.autoMerge,
    config: () => requireConfig(w),
    dryRun: w.dryRun,
  });
  return w.harness;
}

interface Facts {
  readonly author: string;
  readonly action: string;
  readonly draft?: boolean;
}

function startPass(w: World, h: Harness): void {
  w.passStart = h.requested.length;
  w.passRemovedStart = h.removed.length;
  w.passSubmittedStart = h.submitted.length;
}

/**
 * Run one routing pass through the scenario's harness. An `opened` pass waits
 * the auto-merge grace under fake timers, mirroring the auto-approval suite.
 */
export async function routeOnce(w: World, facts: Facts): Promise<void> {
  const h = harnessFor(w);
  // The same fixture feeds the commit-level approval pass, which sees the
  // author through the live GET.
  w.fixture.author = facts.author;
  startPass(w, h);

  const request = {
    number: w.fixture.number,
    author: facts.author,
    draft: facts.draft ?? false,
    state: w.fixture.state,
    action: facts.action,
  };
  const config = requireConfig(w);

  if (facts.action !== "opened") {
    await serve(h.deps, OWNER, REPO, request, config);
    return;
  }

  vi.useFakeTimers();
  try {
    // The opened event races a bot's own auto-merge toggle, so the live GET
    // happens only after the grace.
    const pending = serve(h.deps, OWNER, REPO, request, config);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    await pending;
  } finally {
    vi.useRealTimers();
  }
}

/** CI finished on the head commit in the given state: flip the store, then run the production handler. */
async function runChecks(
  w: World,
  state: RunsState,
  expected: "failure" | "success",
): Promise<void> {
  const h = harnessFor(w);
  w.fixture.checks = state;
  startPass(w, h);

  await runHeadChecks(h.reconcileDeps, expected, `"${state}" checks`);
}

/** The head commit's checks failed. */
export async function checkRunFails(w: World): Promise<void> {
  await runChecks(w, "failing", "failure");
}

/** The head commit's checks passed. */
export async function checkRunPasses(w: World): Promise<void> {
  await runChecks(w, "passed", "success");
}

/** The reviewer sets requested during the most recent pass. */
export function passRequested(w: World): string[][] {
  return requireRoutingHarness(w).requested.slice(w.passStart);
}

/** The reviewer sets withdrawn during the most recent pass. */
export function passRemoved(w: World): string[][] {
  return requireRoutingHarness(w).removed.slice(w.passRemovedStart);
}

/** The reviews submitted during the most recent pass. */
export function passSubmitted(w: World): ReviewParams[] {
  return requireRoutingHarness(w).submitted.slice(w.passSubmittedStart);
}

/** Exactly one requestReviewers call in the pass, with exactly these reviewers. */
export function expectRequested(w: World, logins: readonly string[]): void {
  expect(passRequested(w)).toEqual([logins]);
}

/** Exactly one removeRequestedReviewers call in the pass, with exactly these reviewers. */
export function expectRemoved(w: World, logins: readonly string[]): void {
  expect(passRemoved(w)).toEqual([logins]);
}

/** No reviewer route was called during the pass. */
export function expectNoWrites(w: World): void {
  expect(passRequested(w)).toEqual([]);
  expect(passRemoved(w)).toEqual([]);
}

/** An APPROVE review was submitted during the current pass, pinned to the head commit. */
export function expectApproved(w: World): void {
  const approvals = passSubmitted(w).filter((review) => review.event === "APPROVE");
  expect(approvals).toHaveLength(1);
  expect(approvals[0]?.commit_id).toBe(HEAD);
  expect(approvals[0]?.body).toBeTypeOf("string");
}

/** Across every pass of the scenario, exactly one request named exactly these reviewers. */
export function expectRequestedOnce(w: World, logins: readonly string[]): void {
  const matches = requireRoutingHarness(w).requested.filter(
    (entry) =>
      entry.length === logins.length && entry.every((login, index) => login === logins[index]),
  );
  expect(matches).toHaveLength(1);
}
