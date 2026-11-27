/**
 * Fixture and harness layer for the reviewer-routing acceptance suite.
 *
 * The scenarios drive the real `serve` path, so the world holds everything that
 * path reads: the live pull-request GET that reports `auto_merge`, the two
 * reviewer routes that record what was requested and withdrawn, and the dry-run
 * flag. One harness serves a whole scenario, so its `routed` map carries the
 * replacement-semantics memory across events.
 *
 * This module is not a vitest entry: `routing.steps.ts` imports it.
 */

import { expect, vi } from "vitest";
import { serve } from "../../src/approval/routing.js";
import type { RoutingDeps } from "../../src/approval/routing.js";
import { autoApprovalSchema } from "../../src/config/schema.js";
import type { AutoApprovalConfig } from "../../src/config/schema.js";
import { recorded, recorder } from "../support/recorded.js";
import { fakeLogger, requireBuilt } from "../support/scenario.js";

type OctokitApi = RoutingDeps["octokit"];

/** Mirrors the module constant in silverPlatter.ts; the scenario pins the delay. */
export const GRACE_MS = 2_000;

export const RENOVATE = "renovate[bot]";
export const MY_USER = "my-user";
export const DEPENDABOT = "dependabot[bot]";

/** The bot enabled auto-merge on its own pull request. */
export const ENABLED_BY_SELF: AutoMerge = { enabled_by: { login: RENOVATE } };

export interface AutoMerge {
  readonly enabled_by: { readonly login: string };
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

/** How the harness reads the current auto-merge fact on every GET. */
type AutoMergeSource = AutoMerge | null | (() => AutoMerge | null);

interface HarnessOptions {
  /** The `auto_merge` object the live GET returns; null means nobody enabled it. */
  readonly autoMerge?: AutoMergeSource;
  readonly dryRun?: boolean;
}

/**
 * Fake octokit plus the reviewer request/withdrawal log. The GET reads the
 * auto-merge fact at call time, so a scenario can toggle it between events.
 */
export function buildRoutingHarness(options?: HarnessOptions) {
  const { autoMerge = null, dryRun = false } = options ?? {};

  const readAutoMerge = (): AutoMerge | null =>
    typeof autoMerge === "function" ? autoMerge() : autoMerge;

  const calls: string[] = [];
  const record = recorder(calls);

  // Cumulative, so a step can assert on the reviewer sets of one pass without
  // parsing the call log.
  const requested: string[][] = [];
  const removed: string[][] = [];

  const get = recorded(record, "get", async () => ({
    data: { auto_merge: readAutoMerge() },
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

  const octokit = {
    pulls: { get, requestReviewers, removeRequestedReviewers },
    apps: { getAuthenticated: async () => ({ data: { slug: "woodhouse" } }) },
  } as unknown as OctokitApi;

  const log = fakeLogger();
  const routed = new Map<string, readonly string[]>();
  const deps: RoutingDeps = { octokit, log, dryRun, routed };

  return {
    deps,
    octokit,
    log,
    routed,
    calls,
    requested,
    removed,
    get,
    requestReviewers,
    removeRequestedReviewers,
  };
}

export type Harness = ReturnType<typeof buildRoutingHarness>;

export interface World {
  config: AutoApprovalConfig | undefined;
  autoMerge: AutoMerge | null;
  dryRun: boolean;
  harness: Harness | undefined;
  /** Lengths of the cumulative logs when the current pass started. */
  passStart: number;
  passRemovedStart: number;
}

export function world(): World {
  return {
    config: undefined,
    autoMerge: null,
    dryRun: false,
    harness: undefined,
    passStart: 0,
    passRemovedStart: 0,
  };
}

export function requireConfig(w: World): AutoApprovalConfig {
  return requireBuilt(w.config, "The auto-approval configuration has not been built yet.");
}

export function requireRoutingHarness(w: World): Harness {
  return requireBuilt(w.harness, "The pull request has not been routed yet.");
}

interface Facts {
  readonly author: string;
  readonly action: string;
  readonly draft?: boolean;
}

/**
 * Run one routing pass through the scenario's harness. An `opened` pass waits
 * the auto-merge grace under fake timers, mirroring the auto-approval suite.
 */
export async function routeOnce(w: World, facts: Facts): Promise<void> {
  w.harness ??= buildRoutingHarness({ autoMerge: () => w.autoMerge, dryRun: w.dryRun });

  const h = w.harness;
  w.passStart = h.requested.length;
  w.passRemovedStart = h.removed.length;

  const run = (): Promise<void> =>
    serve(
      h.deps,
      "acme",
      "widgets",
      {
        number: 7,
        author: facts.author,
        draft: facts.draft ?? false,
        state: "open",
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

/** The reviewer sets requested during the most recent pass. */
export function passRequested(w: World): string[][] {
  return requireRoutingHarness(w).requested.slice(w.passStart);
}

/** The reviewer sets withdrawn during the most recent pass. */
export function passRemoved(w: World): string[][] {
  return requireRoutingHarness(w).removed.slice(w.passRemovedStart);
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
