/**
 * Fixtures and the fake octokit for the silver-platter tests.
 *
 * The test file owns every assertion; this module only builds the pull
 * requests and the fake client they are served through. It is not a vitest
 * entry: vitest includes only `*.test.ts` files under `test/` as entries.
 *
 * Each fake route is a module-level factory over the plain data it reads, so
 * the harness itself only assembles them.
 */

import { vi } from "vitest";
import type { Logger } from "pino";
import { serve } from "../src/approval/silverPlatter.js";
import { paginateFake } from "../features/support/scenario.js";

type Deps = Parameters<typeof serve>[0];

export const SHA = "abc123";

export const RENOVATE = "renovate[bot]";
export const OWNER = "my-user";

/** The bot enabled auto-merge on its own pull request. */
export const enabledBySelf = { enabled_by: { login: RENOVATE } };

/** The facts of one pull request, as the listing and the live GET report them. */
export interface FakePullRequest {
  readonly number: number;
  readonly author: string;
  readonly draft: boolean;
  readonly state: string;
  readonly headSha: string;
  readonly autoMerge?: { enabled_by: { login: string } } | null;
}

/** An eligible, open bot pull request headed by SHA, with no auto-merge yet. */
export const BASE_PR: FakePullRequest = {
  number: 7,
  author: RENOVATE,
  draft: false,
  state: "open",
  headSha: SHA,
  autoMerge: null,
};

export function pull(overrides: Partial<FakePullRequest>): FakePullRequest {
  return { ...BASE_PR, ...overrides };
}

/** The REST shape the re-fetch returns. */
export function apiPull(fixture: FakePullRequest) {
  return {
    number: fixture.number,
    state: fixture.state,
    draft: fixture.draft,
    user: { login: fixture.author },
    head: { sha: fixture.headSha },
    auto_merge: fixture.autoMerge ?? null,
  };
}

/** `count` changed files starting at index `from`. */
export function pageOf(count: number, from = 0) {
  return Array.from({ length: count }, (_, i) => ({
    filename: `file-${from + i}.txt`,
    status: "added",
  }));
}

export function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

export interface HarnessOptions {
  /** The commit→PR listing. Defaults to one open bot PR headed by SHA. */
  readonly associated?: readonly FakePullRequest[];
  /** Live state by PR number; defaults to the listing entry. */
  readonly live?: Readonly<Record<number, FakePullRequest | Error>>;
  /** Changed-file pages; defaults to one unremarkable page. */
  readonly filePages?: ReturnType<typeof pageOf>[];
  /** Existing reviews, for the idempotency case. */
  readonly reviews?: readonly unknown[];
  /** When set, every live GET rejects with this error. */
  readonly getError?: Error;
  /** When set, the commit→PR listing rejects with this error. */
  readonly listError?: Error;
}

/** The live fixture per PR number: an explicit override, else the listing entry. */
function liveByNumber(
  associated: readonly FakePullRequest[],
  overrides: HarnessOptions["live"],
): Map<number, FakePullRequest | Error> {
  const live = new Map<number, FakePullRequest | Error>();
  for (const entry of associated) {
    live.set(entry.number, overrides?.[entry.number] ?? entry);
  }
  return live;
}

/** The commit→PR listing: page one carries every fixture, later pages are empty. */
function makeListAssociated(associated: readonly FakePullRequest[], listError?: Error) {
  return vi.fn(async (params: { page?: number }) => {
    if (listError !== undefined) throw listError;
    const page = params.page ?? 1;
    return { data: page === 1 ? associated.map(apiPull) : [] };
  });
}

// The live pull request GET: the only source of the author, draft, state,
// head and auto-merge facts.
function makeGet(live: ReadonlyMap<number, FakePullRequest | Error>, getError?: Error) {
  return vi.fn(async (params: { pull_number: number }) => {
    if (getError !== undefined) throw getError;
    const entry = live.get(params.pull_number);
    if (entry === undefined) {
      throw new Error(`No live pull request fixture for #${params.pull_number}`);
    }
    if (entry instanceof Error) throw entry;
    return { data: apiPull(entry) };
  });
}

function makeListFiles(filePages: ReturnType<typeof pageOf>[]) {
  return vi.fn(async (params: { page?: number }) => ({
    data: filePages[(params.page ?? 1) - 1] ?? [],
  }));
}

function makeListReviews(reviews: readonly unknown[] | undefined) {
  return vi.fn(async () => ({ data: reviews ?? [] }));
}

function makeCreateReview() {
  return vi.fn(async () => ({ data: {} }));
}

function makeGetAuthenticated() {
  return vi.fn(async () => ({ data: { slug: "woodhouse" } }));
}

export function harness(options: HarnessOptions) {
  const associated = options.associated ?? [pull({})];
  const filePages = options.filePages ?? [pageOf(3)];
  const live = liveByNumber(associated, options.live);

  const listAssociated = makeListAssociated(associated, options.listError);
  const get = makeGet(live, options.getError);
  const listFiles = makeListFiles(filePages);
  const listReviews = makeListReviews(options.reviews);
  const createReview = makeCreateReview();
  const getAuthenticated = makeGetAuthenticated();
  // Mirrors octokit.paginate; shared with the Gherkin fakes.
  const paginate = paginateFake();

  const octokit = {
    pulls: { listFiles, listReviews, createReview, get },
    repos: { listPullRequestsAssociatedWithCommit: listAssociated },
    apps: { getAuthenticated },
    paginate,
  } as unknown as Deps["octokit"];

  return {
    octokit,
    log: fakeLogger(),
    paginate,
    listAssociated,
    listFiles,
    listReviews,
    createReview,
    get,
    getAuthenticated,
  };
}
