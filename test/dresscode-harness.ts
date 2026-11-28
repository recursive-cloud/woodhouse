/**
 * Fake GitHub client and fixture builders for the dress-code unit suite.
 *
 * This module is not a vitest entry: `dresscode.test.ts` imports it.
 */

import { vi } from "vitest";
import type { Logger } from "pino";
import type { DressCodeDeps } from "../src/dresscode/check.js";
import { DRESS_CODE_CHECK_NAME } from "../src/dresscode/constants.js";
import { woodhouseConfigSchema } from "../src/config/schema.js";

export const OWNER = "acme";
export const REPO = "widgets";
export const SHA = "1111111111111111111111111111111111111111";
export const NEW_SHA = "2222222222222222222222222222222222222222";

export interface StoredRun {
  readonly id: number;
  readonly head_sha: string;
  readonly name: string;
  status: string;
  conclusion: string | null;
  started_at?: string;
  output?: { title?: string; summary?: string };
}

export interface FakePull {
  readonly number: number;
  readonly state: string;
  readonly title: string;
  readonly head: { readonly sha: string };
}

export interface BuildOptions {
  readonly enabled?: boolean;
  readonly dryRun?: boolean;
  readonly runs?: readonly StoredRun[];
  readonly pullRequests?: readonly FakePull[];
}

/** The mutable Checks API store plus the id sequence its writes draw from. */
interface RunStore {
  readonly runs: StoredRun[];
  nextId: number;
}

type AssociatedPullList = (params: Record<string, unknown>) => Promise<{ data: FakePull[] }>;

export function storedRun(overrides?: Partial<StoredRun>): StoredRun {
  return {
    id: 77,
    head_sha: SHA,
    name: DRESS_CODE_CHECK_NAME,
    status: "completed",
    conclusion: "success",
    started_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

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

// Mirrors `octokit.paginate` over the associated-pull-request listing.
async function paginateAssociated(
  list: AssociatedPullList,
  target: unknown,
  params: Record<string, unknown> | undefined,
) {
  if (target !== list) {
    throw new Error(`Unexpected paginate target: ${String(target)}`);
  }
  const response = await list(params ?? {});
  return response.data;
}

/**
 * A stateful fake octokit: the Checks API store is mutated by create/update so
 * listForRef reflects what GitHub would return, which is what makes the
 * update-in-place assertions meaningful.
 */
export function build(options?: BuildOptions) {
  const store: RunStore = { runs: structuredClone([...(options?.runs ?? [])]), nextId: 100 };
  const runs = store.runs;
  const pullRequests: FakePull[] = structuredClone([...(options?.pullRequests ?? [])]);

  const create = vi.fn(async (params: Record<string, unknown>) => createStoredRun(store, params));

  const update = vi.fn(async (params: Record<string, unknown>) => applyRunUpdate(runs, params));

  const listForRef = vi.fn(async (params: { ref: string; check_name?: string | undefined }) =>
    listRunsFor(runs, params.ref, params.check_name),
  );

  const listPullRequestsAssociatedWithCommit = vi.fn(async (_params: Record<string, unknown>) => ({
    data: pullRequests,
  }));

  const paginate = vi.fn((target: unknown, params?: Record<string, unknown>) =>
    paginateAssociated(listPullRequestsAssociatedWithCommit, target, params),
  );

  const octokit = {
    checks: { create, update, listForRef },
    repos: { listPullRequestsAssociatedWithCommit },
    paginate,
  } as unknown as DressCodeDeps["octokit"];

  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;

  const config = woodhouseConfigSchema.parse({
    dressCode: { enabled: options?.enabled ?? true },
  });
  const resolver = {
    resolve: vi.fn(async () => ({ config, sources: [], issues: [] })),
  } as unknown as DressCodeDeps["resolver"];

  const deps: DressCodeDeps = {
    octokit,
    resolver,
    log,
    dryRun: options?.dryRun ?? false,
  };

  return {
    deps,
    log,
    runs,
    pullRequests,
    create,
    update,
    listForRef,
    listPullRequestsAssociatedWithCommit,
    paginate,
  };
}
