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

/** The mutable Checks API store plus the id sequence its writes draw from. */
interface RunStore {
  readonly runs: StoredRun[];
  nextId: number;
}

type AssociatedPullList = (params: {
  owner: string;
  repo: string;
  commit_sha: string;
}) => Promise<{ data: FakePullRequest[] }>;

function createStoredRun(store: RunStore, params: Record<string, unknown>) {
  const run: StoredRun = {
    id: store.nextId++,
    head_sha: String(params.head_sha),
    name: String(params.name),
    status: String(params.status),
    conclusion: (params.conclusion as string | null | undefined) ?? null,
    output: params.output as StoredRun["output"],
  };
  store.runs.push(run);
  return { data: run };
}

function applyRunUpdate(runs: StoredRun[], params: Record<string, unknown>) {
  const run = runs.find((candidate) => candidate.id === params.check_run_id);
  if (run === undefined) {
    throw new Error(`No fake check run with id ${String(params.check_run_id)}`);
  }
  run.status = String(params.status);
  run.conclusion = (params.conclusion as string | null | undefined) ?? null;
  run.output = params.output as StoredRun["output"];
  return { data: run };
}

function listRunsFor(runs: StoredRun[], ref: string, checkName: string | undefined) {
  return {
    data: {
      check_runs: runs.filter(
        (run) => run.head_sha === ref && (checkName === undefined || run.name === checkName),
      ),
    },
  };
}

async function paginateAssociated(
  list: AssociatedPullList,
  target: unknown,
  params: Record<string, unknown> | undefined,
) {
  if (target !== list) {
    throw new Error(`Unexpected paginate target: ${String(target)}`);
  }
  const response = await list(params as Parameters<AssociatedPullList>[0]);
  return response.data;
}

/** Record a title on the open pull request headed by `sha` (one PR per commit). */
function setTitleOn(pullRequests: FakePullRequest[], title: string, sha: string): void {
  const existing = pullRequests.find((pull) => pull.head.sha === sha);
  if (existing === undefined) {
    pullRequests.push({ number: 1, state: "open", title, head: { sha } });
    return;
  }
  existing.title = title;
}

/** Simulate GitHub re-queueing the existing run when a user re-requests it. */
function queueRunIn(store: RunStore, sha: string): void {
  const existing = store.runs.find(
    (run) => run.head_sha === sha && run.name === DRESS_CODE_CHECK_NAME,
  );
  if (existing === undefined) {
    store.runs.push({
      id: store.nextId++,
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

function runsForSha(runs: StoredRun[], sha: string): StoredRun[] {
  return runs.filter((run) => run.head_sha === sha);
}

function latestRunFor(runs: StoredRun[], sha: string): StoredRun {
  const matching = runsForSha(runs, sha);
  if (matching.length !== 1) {
    throw new Error(`Expected exactly one dress-code run on ${sha}, found ${matching.length}`);
  }
  return matching[0] as StoredRun;
}

export function makeDressCodeWorld(options: DressCodeWorldOptions) {
  const store: RunStore = { runs: [], nextId: 100 };
  const runs = store.runs;
  const pullRequests: FakePullRequest[] = [];

  const create = vi.fn(async (params: Record<string, unknown>) => createStoredRun(store, params));

  const update = vi.fn(async (params: Record<string, unknown>) => applyRunUpdate(runs, params));

  const listForRef = vi.fn(async (params: { ref: string; check_name?: string | undefined }) =>
    listRunsFor(runs, params.ref, params.check_name),
  );

  const listPullRequestsAssociatedWithCommit = vi.fn(
    async (_params: { owner: string; repo: string; commit_sha: string }) => ({
      data: pullRequests,
    }),
  );

  // Mirrors `octokit.paginate` over the associated-pull-request listing.
  const paginate = vi.fn((target: unknown, params?: Record<string, unknown>) =>
    paginateAssociated(listPullRequestsAssociatedWithCommit, target, params),
  );

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

  return {
    deps,
    runs,
    pullRequests,
    create,
    update,
    listForRef,
    listPullRequestsAssociatedWithCommit,
    paginate,
    setTitle: (title: string, sha: string = HEAD_SHA) => setTitleOn(pullRequests, title, sha),
    queueRun: (sha: string = HEAD_SHA) => queueRunIn(store, sha),
    runsFor: (sha: string) => runsForSha(runs, sha),
    latestRun: (sha: string) => latestRunFor(runs, sha),
    runCheck: (title: string, sha: string = HEAD_SHA) =>
      runDressCodeCheck(deps, { owner: OWNER, repo: REPO, sha, title }),
    reRequest: (sha: string = HEAD_SHA) => reRequestDressCodeCheck(deps, OWNER, REPO, sha),
  };
}

export type DressCodeWorld = ReturnType<typeof makeDressCodeWorld>;

export function requireWorld(world: DressCodeWorld | undefined): DressCodeWorld {
  return requireBuilt(world, "The fake GitHub client has not been built yet.");
}
