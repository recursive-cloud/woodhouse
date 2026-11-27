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
import { handleCheckRunCompleted, seedAndSchedule } from "../../src/app.js";
import type { GraceDeps } from "../../src/app.js";
import { approvalPass } from "../../src/approval/silverPlatter.js";
import { autoApprovalSchema, woodhouseConfigSchema } from "../../src/config/schema.js";
import type { AutoApprovalConfig } from "../../src/config/schema.js";
import type { ReconcileDeps } from "../../src/gatekeeper/handler.js";
import { Scheduler } from "../../src/lib/scheduler.js";
import type { RawCheckRun } from "../gatekeeper/gatekeeper-world.js";
import { fakeLogger, requireBuilt } from "../support/scenario.js";

/** The head commit every scenario works on; re-approval assertions pin it. */
export const HEAD = "abc123";

export const RENOVATE = "renovate[bot]";

/** The bot enabled auto-merge on its own pull request. */
export const ENABLED_BY_SELF: AutoMerge = { enabled_by: { login: RENOVATE } };

const OWNER = "acme";
const REPO = "widgets";
const PR_NUMBER = 7;
/** The check run whose completion drives the reconcile. Never the white-glove one. */
const CHILD_CHECK = "ci/test";

/** Unremarkable changed files: none may match the default protected paths. */
const UNREMARKABLE_FILES: FilePage = [
  { filename: "src/index.ts", status: "modified" },
  { filename: "README.md", status: "modified" },
];

export interface AutoMerge {
  readonly enabled_by: { readonly login: string };
}

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

/** The live pull request the approval pass re-reads on every evaluation. */
export interface PullRequestFixture {
  readonly number: number;
  author: string;
  draft: boolean;
  readonly state: string;
  readonly headSha: string;
  autoMerge: AutoMerge | null;
  reviews: readonly unknown[];
  /** The per-page changed-file listing; one unremarkable page by default. */
  filePages: readonly FilePage[];
  checks: RunsState;
}

interface ReviewParams {
  readonly owner: string;
  readonly repo: string;
  readonly pull_number: number;
  readonly event: string;
  readonly commit_id: string;
  readonly body: string;
}

/** Parse the auto-approval config the feature describes, so defaults apply as in production. */
export function parseConfig(allowedActors: {
  owners?: string[];
  bots?: string[];
}): AutoApprovalConfig {
  return autoApprovalSchema.parse({ allowedActors });
}

/** Re-parse the config with one more allowed bot, so defaults still apply. */
export function withAllowedBot(config: AutoApprovalConfig, bot: string): AutoApprovalConfig {
  return autoApprovalSchema.parse({
    ...config,
    allowedActors: { ...config.allowedActors, bots: [bot] },
  });
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
  const config = woodhouseConfigSchema.parse({
    gatekeeper: { enabled: true },
    autoApproval: options.autoApproval,
  });
  const resolver = {
    resolve: vi.fn(async () => ({ config, sources: [], issues: [] })),
  } as unknown as ReconcileDeps["resolver"];

  const listForRef = vi.fn(async () => ({ data: { check_runs: RUNS[fixture.checks] } }));
  const create = vi.fn(async () => ({ data: {} }));
  const update = vi.fn(async () => ({ data: {} }));

  const listFiles = vi.fn(async (params: { page?: number } = {}) => ({
    data: fixture.filePages[(params.page ?? 1) - 1] ?? [],
  }));
  const listReviews = vi.fn(async () => ({ data: fixture.reviews }));

  // Recorded separately from the mock so a scenario can read the review body
  // without poking at vi.fn internals.
  const submitted: ReviewParams[] = [];
  const createReview = vi.fn(async (params: ReviewParams) => {
    submitted.push(params);
    return { data: {} };
  });

  // The live pull request GET: the only source of the current auto-merge, draft
  // and author facts, so a scenario can toggle any of them after opening.
  const get = vi.fn(async () => ({
    data: {
      number: fixture.number,
      user: { login: fixture.author },
      draft: fixture.draft,
      state: fixture.state,
      head: { sha: fixture.headSha },
      auto_merge: fixture.autoMerge,
    },
  }));

  const listAssociated = vi.fn(async () => ({
    data: [{ number: fixture.number, state: fixture.state }],
  }));

  const knownRoutes = new Set<unknown>([listForRef, listFiles, listReviews, listAssociated]);
  const paginate = vi.fn(
    async (
      route: (params: Record<string, unknown>) => Promise<{ data: unknown }>,
      params: Record<string, unknown>,
    ): Promise<unknown[]> => {
      // An unrecognised route is a harness gap, not an empty listing.
      if (!knownRoutes.has(route)) {
        throw new Error("Unrecognised paginate route in the auto-approval harness");
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
    pulls: { listFiles, listReviews, get, createReview },
    repos: { listPullRequestsAssociatedWithCommit: listAssociated },
    checks: { listForRef, create, update },
    apps: { getAuthenticated: async () => ({ data: { slug: "woodhouse" } }) },
  } as unknown as ReconcileDeps["octokit"];

  const log = fakeLogger();
  // The scenarios call the production entry points directly rather than
  // through `createApp`, so the harness supplies the same approval hook the
  // app wires into its reconcile deps: after a successful evaluation, approve
  // the open pull requests headed by the commit.
  const deps: ReconcileDeps = {
    octokit,
    resolver,
    log,
    dryRun: options.dryRun ?? false,
    onSuccess: approvalPass(resolver, options.dryRun ?? false)(octokit, log),
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

export function requireConfig(w: World): AutoApprovalConfig {
  return requireBuilt(w.config, "The auto-approval configuration has not been built yet.");
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
  const result = await handleCheckRunCompleted(depsFor(w), OWNER, REPO, {
    name: CHILD_CHECK,
    head_sha: HEAD,
  });
  if (result === undefined) {
    throw new Error("reconcile returned undefined; the gatekeeper should be enabled.");
  }
  if (result.evaluation.outcome !== "success") {
    throw new Error(
      `The scenario expects passing checks, but the white-glove verdict was "${result.evaluation.outcome}".`,
    );
  }
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
