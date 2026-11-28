/**
 * Fixtures and the fake octokit for the silver-platter tests.
 *
 * The test file owns every assertion; this module only builds the pull
 * requests and the fake client they are served through. It is not a vitest
 * entry: vitest includes only `*.test.ts` files under `test/` as entries.
 */

import { vi } from "vitest";
import type { Logger } from "pino";
import { serve } from "../src/approval/silverPlatter.js";

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
  readonly reviews?: unknown[];
  /** When set, every live GET rejects with this error. */
  readonly getError?: Error;
  /** When set, the commit→PR listing rejects with this error. */
  readonly listError?: Error;
}

export function harness(options: HarnessOptions) {
  const associated = options.associated ?? [pull({})];
  const filePages = options.filePages ?? [pageOf(3)];

  const live = new Map<number, FakePullRequest | Error>();
  for (const entry of associated) {
    live.set(entry.number, options.live?.[entry.number] ?? entry);
  }

  const getAuthenticated = vi.fn(async () => ({ data: { slug: "woodhouse" } }));

  const listAssociated = vi.fn(async (params: { page?: number }) => {
    if (options.listError !== undefined) throw options.listError;
    return { data: (params.page ?? 1) === 1 ? associated.map(apiPull) : [] };
  });

  // The live pull request GET: the only source of the author, draft, state,
  // head and auto-merge facts.
  const get = vi.fn(async (params: { pull_number: number }) => {
    if (options.getError !== undefined) throw options.getError;
    const entry = live.get(params.pull_number);
    if (entry === undefined) {
      throw new Error(`No live pull request fixture for #${params.pull_number}`);
    }
    if (entry instanceof Error) throw entry;
    return { data: apiPull(entry) };
  });

  const listFiles = vi.fn(async (params: { page?: number }) => ({
    data: filePages[(params.page ?? 1) - 1] ?? [],
  }));

  const listReviews = vi.fn(async () => ({ data: options.reviews ?? ([] as unknown[]) }));

  const createReview = vi.fn(async () => ({ data: {} }));

  // Mirrors octokit.paginate: call the route per page until a short page.
  const paginate = vi.fn(
    async (
      route: (params: Record<string, unknown>) => Promise<{ data: unknown[] }>,
      params: Record<string, unknown>,
    ) => {
      const out: unknown[] = [];
      for (let page = 1; ; page += 1) {
        const { data } = await route({ ...params, page });
        out.push(...data);
        if (data.length < ((params.per_page as number | undefined) ?? 100)) break;
      }
      return out;
    },
  );

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
