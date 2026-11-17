/**
 * Fixture and harness layer for the auto-approval acceptance suite.
 *
 * The scenarios drive the real `serve` path, so the world holds everything that
 * path reads: the changed-file pages, the live pull-request GET that reports
 * `auto_merge`, the existing reviews and the dry-run flag. Only the fake octokit
 * is built here; the scenario owns the facts it hands `cast`.
 *
 * This module is not a vitest entry: `auto-approval.steps.ts` imports it.
 */

import { vi } from "vitest";
import { serve } from "../../src/approval/silverPlatter.js";
import type { SilverPlatterDeps } from "../../src/approval/silverPlatter.js";
import { autoApprovalSchema } from "../../src/config/schema.js";
import type { AutoApprovalConfig } from "../../src/config/schema.js";
import { fakeLogger, paginateFake, requireBuilt } from "../support/scenario.js";

type OctokitApi = SilverPlatterDeps["octokit"];

/** Mirrors the module constant in silverPlatter.ts; the scenario pins the delay. */
export const GRACE_MS = 2_000;

export const RENOVATE = "renovate[bot]";

/** The bot enabled auto-merge on its own pull request. */
export const ENABLED_BY_SELF: AutoMerge = { enabled_by: { login: RENOVATE } };

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
  /** The per-page changed-file listing; one unremarkable page by default. */
  readonly filePages?: readonly FilePage[];
  /** The `auto_merge` object the live GET returns; null means nobody enabled it. */
  readonly autoMerge?: AutoMerge | null;
  /** Existing reviews, for the idempotency scenarios. */
  readonly reviews?: readonly unknown[];
  readonly dryRun?: boolean;
}

/**
 * Fake octokit plus the submitted-review log. `paginate` mirrors octokit by
 * calling the route per page until a short page.
 */
export function buildAutoApprovalHarness(options?: HarnessOptions) {
  const {
    filePages = [UNREMARKABLE_FILES],
    autoMerge = null,
    reviews = [],
    dryRun = false,
  } = options ?? {};

  const listFiles = vi.fn(async (params: { page?: number }) => ({
    data: filePages[(params.page ?? 1) - 1] ?? [],
  }));

  const listReviews = vi.fn(async () => ({ data: reviews }));

  // Recorded separately from the mock so a scenario can read the review body
  // without poking at vi.fn internals.
  const submitted: ReviewParams[] = [];
  const createReview = vi.fn(async (params: ReviewParams) => {
    submitted.push(params);
    return { data: {} };
  });

  // The live pull request GET: the only source of the auto-merge fact.
  const get = vi.fn(async () => ({ data: { auto_merge: autoMerge } }));

  // Mirrors octokit.paginate: call the route per page until a short page.
  const paginate = paginateFake();

  const octokit = {
    pulls: { listFiles, listReviews, createReview, get },
    apps: { getAuthenticated: async () => ({ data: { slug: "woodhouse" } }) },
    paginate,
  } as unknown as OctokitApi;

  const log = fakeLogger();
  const deps: SilverPlatterDeps = { octokit, log, dryRun };
  return { deps, octokit, log, listFiles, listReviews, createReview, get, submitted };
}

export type Harness = ReturnType<typeof buildAutoApprovalHarness>;

interface Facts {
  readonly author: string;
  readonly action: string;
  readonly headSha?: string;
  readonly draft?: boolean;
}

/** Everything a serve() scenario accumulates before the evaluation runs. */
interface World {
  config: AutoApprovalConfig | undefined;
  autoMerge: AutoMerge | null;
  files: readonly FilePage[];
  reviews: readonly unknown[];
  dryRun: boolean;
  harness: Harness | undefined;
  approved: boolean | undefined;
}

export function world(): World {
  return {
    config: undefined,
    autoMerge: null,
    files: [UNREMARKABLE_FILES],
    reviews: [],
    dryRun: false,
    harness: undefined,
    approved: undefined,
  };
}

export function requireConfig(w: World): AutoApprovalConfig {
  return requireBuilt(w.config, "The auto-approval configuration has not been built yet.");
}

export function harnessFor(w: World): Harness {
  return buildAutoApprovalHarness({
    filePages: w.files,
    autoMerge: w.autoMerge,
    reviews: w.reviews,
    dryRun: w.dryRun,
  });
}

export function cast(h: Harness, config: AutoApprovalConfig, facts: Facts): Promise<boolean> {
  return serve(
    h.deps,
    "acme",
    "widgets",
    {
      number: 7,
      author: facts.author,
      draft: facts.draft ?? false,
      state: "open",
      headSha: facts.headSha ?? "abc123",
      action: facts.action,
    },
    config,
  );
}

export async function evaluate(w: World, facts: Facts): Promise<void> {
  const h = harnessFor(w);
  w.harness = h;
  w.approved = await cast(h, requireConfig(w), facts);
}

export function requireAutoApprovalHarness(harness: Harness | undefined): Harness {
  return requireBuilt(harness, "The pull request has not been evaluated yet.");
}
