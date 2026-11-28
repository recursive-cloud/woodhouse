/**
 * Harness for the dress-code acceptance suite.
 *
 * The fake octokit keeps a mutable Checks API store so a second run on the same
 * commit finds the first run and updates it in place, exactly as GitHub would.
 * The fake resolver returns a configurable `dressCode.enabled`, which is the
 * only configuration the check reads.
 *
 * This module is not a vitest entry: `title.steps.ts` imports it.
 */

import { vi } from "vitest";
import type { DressCodeDeps } from "../../src/dresscode/check.js";
import { reRequestDressCodeCheck, runDressCodeCheck } from "../../src/dresscode/check.js";
import { DRESS_CODE_CHECK_NAME } from "../../src/dresscode/constants.js";
import { woodhouseConfigSchema } from "../../src/config/schema.js";
import { fakeLogger, requireBuilt } from "../support/scenario.js";

export const OWNER = "acme";
export const REPO = "widgets";
export const HEAD_SHA = "1111111111111111111111111111111111111111";
export const NEW_SHA = "2222222222222222222222222222222222222222";

export interface StoredRun {
  readonly id: number;
  readonly head_sha: string;
  readonly name: string;
  status: string;
  conclusion: string | null;
  output?: { title?: string; summary?: string };
}

export interface FakePullRequest {
  readonly number: number;
  readonly state: string;
  title: string;
  readonly head: { readonly sha: string };
}

export interface DressCodeWorldOptions {
  readonly enabled: boolean;
  readonly dryRun?: boolean;
}

export function makeDressCodeWorld(options: DressCodeWorldOptions) {
  const runs: StoredRun[] = [];
  const pullRequests: FakePullRequest[] = [];
  let nextId = 100;

  const create = vi.fn(async (params: Record<string, unknown>) => {
    const run: StoredRun = {
      id: nextId++,
      head_sha: String(params.head_sha),
      name: String(params.name),
      status: String(params.status),
      conclusion: (params.conclusion as string | null | undefined) ?? null,
      output: params.output as StoredRun["output"],
    };
    runs.push(run);
    return { data: run };
  });

  const update = vi.fn(async (params: Record<string, unknown>) => {
    const run = runs.find((candidate) => candidate.id === params.check_run_id);
    if (run === undefined) {
      throw new Error(`No fake check run with id ${String(params.check_run_id)}`);
    }
    run.status = String(params.status);
    run.conclusion = (params.conclusion as string | null | undefined) ?? null;
    run.output = params.output as StoredRun["output"];
    return { data: run };
  });

  const listForRef = vi.fn(async (params: { ref: string; check_name?: string | undefined }) => ({
    data: {
      check_runs: runs.filter(
        (run) =>
          run.head_sha === params.ref &&
          (params.check_name === undefined || run.name === params.check_name),
      ),
    },
  }));

  const listPullRequestsAssociatedWithCommit = vi.fn(
    async (_params: { owner: string; repo: string; commit_sha: string }) => ({
      data: pullRequests,
    }),
  );

  // Mirrors `octokit.paginate` over the associated-pull-request listing.
  const paginate = vi.fn(async (target: unknown, params?: Record<string, unknown>) => {
    if (target !== listPullRequestsAssociatedWithCommit) {
      throw new Error(`Unexpected paginate target: ${String(target)}`);
    }
    const response = await listPullRequestsAssociatedWithCommit(
      params as { owner: string; repo: string; commit_sha: string },
    );
    return response.data;
  });

  const octokit = {
    checks: { create, update, listForRef },
    repos: { listPullRequestsAssociatedWithCommit },
    paginate,
  } as unknown as DressCodeDeps["octokit"];

  const config = woodhouseConfigSchema.parse({ dressCode: { enabled: options.enabled } });
  const resolver = {
    resolve: vi.fn(async () => ({ config, sources: [], issues: [] })),
  } as unknown as DressCodeDeps["resolver"];

  const log = fakeLogger();
  const deps: DressCodeDeps = { octokit, resolver, log, dryRun: options.dryRun ?? false };

  /** Record a title on the open pull request headed by `sha` (one PR per commit). */
  function setTitle(title: string, sha: string = HEAD_SHA): void {
    const existing = pullRequests.find((pull) => pull.head.sha === sha);
    if (existing === undefined) {
      pullRequests.push({ number: 1, state: "open", title, head: { sha } });
      return;
    }
    existing.title = title;
  }

  /** Simulate GitHub re-queueing the existing run when a user re-requests it. */
  function queueRun(sha: string = HEAD_SHA): void {
    const existing = runs.find((run) => run.head_sha === sha && run.name === DRESS_CODE_CHECK_NAME);
    if (existing === undefined) {
      runs.push({
        id: nextId++,
        head_sha: sha,
        name: DRESS_CODE_CHECK_NAME,
        status: "queued",
        conclusion: null,
      });
      return;
    }
    existing.status = "queued";
    existing.conclusion = null;
    existing.output = undefined;
  }

  function runsFor(sha: string) {
    return runs.filter((run) => run.head_sha === sha);
  }

  function latestRun(sha: string): StoredRun {
    const matching = runsFor(sha);
    if (matching.length !== 1) {
      throw new Error(`Expected exactly one dress-code run on ${sha}, found ${matching.length}`);
    }
    return matching[0] as StoredRun;
  }

  function runCheck(title: string, sha: string = HEAD_SHA) {
    return runDressCodeCheck(deps, { owner: OWNER, repo: REPO, sha, title });
  }

  function reRequest(sha: string = HEAD_SHA) {
    return reRequestDressCodeCheck(deps, OWNER, REPO, sha);
  }

  return {
    deps,
    runs,
    pullRequests,
    create,
    update,
    listForRef,
    listPullRequestsAssociatedWithCommit,
    paginate,
    setTitle,
    queueRun,
    runsFor,
    latestRun,
    runCheck,
    reRequest,
  };
}

export type DressCodeWorld = ReturnType<typeof makeDressCodeWorld>;

export function requireWorld(world: DressCodeWorld | undefined): DressCodeWorld {
  return requireBuilt(world, "The fake GitHub client has not been built yet.");
}
