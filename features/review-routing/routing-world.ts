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
import { handleCheckRunCompleted } from "../../src/app.js";
import { serve } from "../../src/approval/routing.js";
import type { RoutingDeps } from "../../src/approval/routing.js";
import { approvalPass } from "../../src/approval/silverPlatter.js";
import { autoApprovalSchema, woodhouseConfigSchema } from "../../src/config/schema.js";
import type { AutoApprovalConfig } from "../../src/config/schema.js";
import type { ReconcileDeps } from "../../src/gatekeeper/handler.js";
import type { RawCheckRun } from "../gatekeeper/gatekeeper-world.js";
import { recorded, recorder } from "../support/recorded.js";
import { fakeLogger, requireBuilt } from "../support/scenario.js";

type OctokitApi = RoutingDeps["octokit"];

/** Mirrors the module constant in routing.ts; the scenario pins the delay. */
export const GRACE_MS = 2_000;

export const RENOVATE = "renovate[bot]";
export const MY_USER = "my-user";
export const DEPENDABOT = "dependabot[bot]";

/** The head commit every scenario works on; approval assertions pin it. */
export const HEAD = "abc123";

/** The bot enabled auto-merge on its own pull request. */
export const ENABLED_BY_SELF: AutoMerge = { enabled_by: { login: RENOVATE } };

export interface AutoMerge {
  readonly enabled_by: { readonly login: string };
}

const OWNER = "acme";
const REPO = "widgets";
const PR_NUMBER = 7;
/** The check run whose completion drives the reconcile. Never the white-glove one. */
const CHILD_CHECK = "ci/test";

interface FilePageEntry {
  readonly filename: string;
  readonly status: string;
}
export type FilePage = readonly FilePageEntry[];

/** The state of the head commit's checks; the white-glove run itself is never stored. */
export type RunsState = "failing" | "passed" | "none";

const RUNS: Record<RunsState, readonly RawCheckRun[]> = {
  failing: [
    {
      name: CHILD_CHECK,
      id: 200,
      status: "completed",
      conclusion: "failure",
      started_at: "2026-01-01T00:00:00Z",
    },
  ],
  passed: [
    {
      name: CHILD_CHECK,
      id: 201,
      status: "completed",
      conclusion: "success",
      started_at: "2026-01-02T00:00:00Z",
    },
  ],
  none: [],
};

/** Unremarkable changed files: none may match the default protected paths. */
const UNREMARKABLE_FILES: FilePage = [
  { filename: "src/index.ts", status: "modified" },
  { filename: "README.md", status: "modified" },
];

/**
 * The live pull request both passes re-read. `autoMerge` deliberately lives on
 * the world (`w.autoMerge`) so the GET can read it at call time.
 */
export interface PullRequestFixture {
  readonly number: number;
  author: string;
  draft: boolean;
  readonly state: string;
  readonly headSha: string;
  reviews: readonly unknown[];
  /** The per-page changed-file listing; one unremarkable page by default. */
  filePages: readonly FilePage[];
  checks: RunsState;
}

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

/** Parse the auto-approval config the feature describes, so defaults apply as in production. */
export function parseConfig(allowedActors: {
  owners?: string[];
  bots?: string[];
}): AutoApprovalConfig {
  return autoApprovalSchema.parse({ allowedActors });
}

/** Re-parse the config with one owner, so defaults still apply. */
export function withOwner(config: AutoApprovalConfig, owner: string): AutoApprovalConfig {
  return autoApprovalSchema.parse({
    ...config,
    allowedActors: { ...config.allowedActors, owners: [owner] },
  });
}

interface ReviewerParams {
  readonly owner: string;
  readonly repo: string;
  readonly pull_number: number;
  readonly reviewers: string[];
}

interface ReviewParams {
  readonly owner: string;
  readonly repo: string;
  readonly pull_number: number;
  readonly event: string;
  readonly commit_id: string;
  readonly body: string;
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
export function buildRoutingHarness(options: HarnessOptions = {}) {
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
    data: {
      number: fixture.number,
      user: { login: fixture.author },
      draft: fixture.draft,
      state: fixture.state,
      head: { sha: fixture.headSha },
      auto_merge: readAutoMerge(),
    },
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

  const listFiles = vi.fn(async (params: { page?: number } = {}) => ({
    data: fixture.filePages[(params.page ?? 1) - 1] ?? [],
  }));
  const listReviews = vi.fn(async () => ({ data: fixture.reviews }));

  const createReview = vi.fn(async (params: ReviewParams) => {
    submitted.push(params);
    return { data: {} };
  });

  const listAssociated = vi.fn(async () => ({
    data: [{ number: fixture.number, state: fixture.state }],
  }));

  const listForRef = vi.fn(async () => ({ data: { check_runs: RUNS[fixture.checks] } }));
  const create = vi.fn(async () => ({ data: {} }));
  const update = vi.fn(async () => ({ data: {} }));

  const knownRoutes = new Set<unknown>([listForRef, listFiles, listReviews, listAssociated]);
  const paginate = vi.fn(
    async (
      route: (params: Record<string, unknown>) => Promise<{ data: unknown }>,
      params: Record<string, unknown>,
    ): Promise<unknown[]> => {
      // An unrecognised route is a harness gap, not an empty listing.
      if (!knownRoutes.has(route)) {
        throw new Error("Unrecognised paginate route in the routing harness");
      }

      const perPage = (params.per_page as number | undefined) ?? 100;
      const rows: unknown[] = [];
      for (let page = 1; ; page += 1) {
        const { data } = await route({ ...params, page });
        const batch = Array.isArray(data)
          ? data
          : ((data as { check_runs?: unknown[] }).check_runs ?? []);
        rows.push(...batch);
        if (batch.length < perPage) break;
      }
      return rows;
    },
  );

  const octokit = {
    paginate,
    pulls: {
      get,
      requestReviewers,
      removeRequestedReviewers,
      listFiles,
      listReviews,
      createReview,
    },
    repos: { listPullRequestsAssociatedWithCommit: listAssociated },
    checks: { listForRef, create, update },
    apps: { getAuthenticated: async () => ({ data: { slug: "woodhouse" } }) },
  } as unknown as ReconcileDeps["octokit"];

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
  const reconcileDeps: ReconcileDeps = {
    octokit,
    resolver,
    log,
    dryRun,
    onSuccess: approvalPass(resolver, dryRun)(octokit, log),
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

export function requireConfig(w: World): AutoApprovalConfig {
  return requireBuilt(w.config, "The auto-approval configuration has not been built yet.");
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

  const run = (): Promise<void> =>
    serve(
      h.deps,
      OWNER,
      REPO,
      {
        number: w.fixture.number,
        author: facts.author,
        draft: facts.draft ?? false,
        state: w.fixture.state,
        action: facts.action,
      },
      requireConfig(w),
    );

  if (facts.action === "opened") {
    vi.useFakeTimers();
    try {
      // The opened event races a bot's own auto-merge toggle, so the live GET
      // happens only after the grace.
      const pending = run();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(GRACE_MS);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    return;
  }

  await run();
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

  const result = await handleCheckRunCompleted(h.reconcileDeps, OWNER, REPO, {
    name: CHILD_CHECK,
    head_sha: HEAD,
  });
  if (result === undefined) {
    throw new Error("reconcile returned undefined; the gatekeeper should be enabled.");
  }
  if (result.evaluation.outcome !== expected) {
    throw new Error(
      `The scenario expects "${state}" checks, but the white-glove verdict was "${result.evaluation.outcome}".`,
    );
  }
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
