/**
 * Fixture and fake pieces shared by the approval acceptance suites.
 *
 * The auto-approval and reviewer-routing worlds drive the same commit-level
 * passes over the same shape of pull request, so the facts, the config parser
 * and the octokit stubs live here. Each world keeps only the state and entry
 * points its own steps need.
 *
 * This module is not a vitest entry: the world modules import it.
 */

import { vi } from "vitest";
import { handleCheckRunCompleted } from "../../src/app.js";
import { autoApprovalSchema } from "../../src/config/schema.js";
import type { AutoApprovalConfig } from "../../src/config/schema.js";
import type { ReconcileDeps } from "../../src/gatekeeper/handler.js";
import type { RawCheckRun } from "../gatekeeper/gatekeeper-world.js";
import { paginatePages, requireBuilt } from "./scenario.js";

/** The head commit every approval scenario works on; assertions pin it. */
export const HEAD = "abc123";

export const RENOVATE = "renovate[bot]";

export const OWNER = "acme";
export const REPO = "widgets";
export const PR_NUMBER = 7;
/** The check run whose completion drives the reconcile. Never the white-glove one. */
export const CHILD_CHECK = "ci/test";

export interface AutoMerge {
  readonly enabled_by: { readonly login: string };
}

/** The bot enabled auto-merge on its own pull request. */
export const ENABLED_BY_SELF: AutoMerge = { enabled_by: { login: RENOVATE } };

interface FilePageEntry {
  readonly filename: string;
  readonly status: string;
}
export type FilePage = readonly FilePageEntry[];

/** The state of the head commit's checks; the white-glove run itself is never stored. */
export type RunsState = "failing" | "passed" | "none";

export const RUNS: Record<RunsState, readonly RawCheckRun[]> = {
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
export const UNREMARKABLE_FILES: FilePage = [
  { filename: "src/index.ts", status: "modified" },
  { filename: "README.md", status: "modified" },
];

export interface ReviewParams {
  readonly owner: string;
  readonly repo: string;
  readonly pull_number: number;
  readonly event: string;
  readonly commit_id: string;
  readonly body: string;
}

/** The pull-request facts every approval fixture carries. */
export interface PullRequestFacts {
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

/** The config a scenario built, or a plain failure when a step ran out of order. */
export function requireConfig(w: { readonly config: AutoApprovalConfig | undefined }) {
  return requireBuilt(w.config, "The auto-approval configuration has not been built yet.");
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

/** Re-parse the config with one more allowed bot, so defaults still apply. */
export function withAllowedBot(config: AutoApprovalConfig, bot: string): AutoApprovalConfig {
  return autoApprovalSchema.parse({
    ...config,
    allowedActors: { ...config.allowedActors, bots: [bot] },
  });
}

/** The checks surface the reconcile reads and writes. */
export function checksStubs(fixture: { readonly checks: RunsState }) {
  return {
    listForRef: vi.fn(async () => ({ data: { check_runs: RUNS[fixture.checks] } })),
    create: vi.fn(async () => ({ data: {} })),
    update: vi.fn(async () => ({ data: {} })),
  };
}

/** The pull-request reads, plus the review submission the approval pass makes. */
export function pullRequestStubs(
  fixture: Pick<PullRequestFacts, "filePages" | "reviews">,
  submitted: ReviewParams[],
) {
  const listFiles = vi.fn(async (params: { page?: number }) => ({
    data: fixture.filePages[(params.page ?? 1) - 1] ?? [],
  }));
  const listReviews = vi.fn(async () => ({ data: fixture.reviews }));

  const createReview = vi.fn(async (params: ReviewParams) => {
    submitted.push(params);
    return { data: {} };
  });

  return { listFiles, listReviews, createReview };
}

/** The commit→pull-request listing both commit-level passes read. */
export function associatedStub(fixture: Pick<PullRequestFacts, "number" | "state">) {
  return vi.fn(async () => ({
    data: [{ number: fixture.number, state: fixture.state }],
  }));
}

/**
 * The octokit surface both approval harnesses hand the production code. The
 * only difference between them is which `pulls` methods they expose, so the
 * caller supplies that namespace while the shared shape lives here.
 */
export function approvalOctokit(parts: {
  readonly paginate: unknown;
  readonly pulls: Record<string, unknown>;
  readonly listAssociated: unknown;
  readonly listForRef: unknown;
  readonly create: unknown;
  readonly update: unknown;
}) {
  return {
    paginate: parts.paginate,
    pulls: parts.pulls,
    repos: { listPullRequestsAssociatedWithCommit: parts.listAssociated },
    checks: { listForRef: parts.listForRef, create: parts.create, update: parts.update },
    apps: { getAuthenticated: async () => ({ data: { slug: "woodhouse" } }) },
  } as unknown as ReconcileDeps["octokit"];
}

/**
 * Run the production check-run handler and assert the white-glove verdict.
 * `expectation` completes "The scenario expects ...".
 */
export async function runHeadChecks(
  deps: ReconcileDeps,
  expected: "failure" | "success",
  expectation: string,
): Promise<void> {
  const result = await handleCheckRunCompleted(deps, OWNER, REPO, {
    name: CHILD_CHECK,
    head_sha: HEAD,
  });
  if (result === undefined) {
    throw new Error("reconcile returned undefined; the gatekeeper should be enabled.");
  }
  if (result.evaluation.outcome !== expected) {
    throw new Error(
      `The scenario expects ${expectation}, but the white-glove verdict was "${result.evaluation.outcome}".`,
    );
  }
}

/** The body the live pull-request GET returns. */
export function livePullData(fixture: PullRequestFacts, autoMerge: AutoMerge | null) {
  return {
    number: fixture.number,
    user: { login: fixture.author },
    draft: fixture.draft,
    state: fixture.state,
    head: { sha: fixture.headSha },
    auto_merge: autoMerge,
  };
}

/**
 * The paginate fake both approval harnesses use: an unrecognised route is a
 * harness gap rather than an empty listing, and a check-run response is
 * unwrapped the way octokit's paginator does.
 */
export function approvalPaginate(knownRoutes: ReadonlySet<unknown>, errorMessage: string) {
  return vi.fn(
    async (
      route: (params: Record<string, unknown>) => Promise<{ data: unknown }>,
      params: Record<string, unknown>,
    ): Promise<unknown[]> => {
      if (!knownRoutes.has(route)) {
        throw new Error(errorMessage);
      }

      return paginatePages(route, params, {
        unwrap: (data) =>
          Array.isArray(data) ? data : ((data as { check_runs?: unknown[] }).check_runs ?? []),
      });
    },
  );
}
