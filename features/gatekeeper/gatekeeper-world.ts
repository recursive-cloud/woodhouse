/**
 * Fixture and harness layer shared by the gatekeeper acceptance suites.
 *
 * `grace.steps.ts` and `reconcile.steps.ts` drive the same handler with the same
 * checks-surface fake; only the runs they put on the head commit differ. The
 * fake and its dependency bundle therefore live here rather than being copied
 * into both step files. The onboarding suite's white-glove world reuses the same
 * dependency bundle over its wider recording octokit.
 *
 * This module is not a vitest entry: the step files import it.
 */

import { vi } from "vitest";
import { woodhouseConfigSchema } from "../../src/config/schema.js";
import type { ReconcileDeps } from "../../src/gatekeeper/handler.js";
import { fakeLogger, requireBuilt } from "../support/scenario.js";

/** The subset of a raw Checks API run the handler reads. */
export interface RawCheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly id: number;
  readonly started_at?: string;
}

interface GatekeeperHarnessOptions {
  /** The runs `checks.listForRef` returns, unfiltered as the fake's caller supplied them. */
  readonly whiteGloveRuns: readonly RawCheckRun[];
  /** Runs only the paginated listing sees, so the verdict must read the whole commit. */
  readonly childChecks?: readonly RawCheckRun[];
  readonly enabled?: boolean;
}

/**
 * The reconcile dependencies over an existing fake octokit: a resolver whose
 * config has no local layer, a fresh spy logger and dry-run off. Suites that
 * need a wider octokit surface build their client and wrap it here.
 */
export function gatekeeperDeps(
  octokit: ReconcileDeps["octokit"],
  options?: { readonly enabled?: boolean },
) {
  const config = woodhouseConfigSchema.parse({ gatekeeper: { enabled: options?.enabled ?? true } });
  const resolver = {
    resolve: vi.fn(async () => ({ config, sources: [], issues: [] })),
  } as unknown as ReconcileDeps["resolver"];
  const log = fakeLogger();

  const deps: ReconcileDeps = {
    octokit,
    resolver,
    log,
    dryRun: false,
  };

  return { deps, config, log };
}

/**
 * Fake octokit covering only the checks surface the handler touches.
 *
 * `paginate` sees every run on the ref. `checks.listForRef` filters by name in
 * reality, but here it returns the white-glove runs exactly as supplied, so a
 * foreign-named run in a scenario's cell reaches the handler's response and
 * exercises its fail-closed name re-assertion.
 */
export function buildGatekeeperHarness(options: GatekeeperHarnessOptions) {
  const { whiteGloveRuns, childChecks = [], enabled = true } = options;
  const allRuns = [...whiteGloveRuns, ...childChecks];

  const paginate = vi.fn(async () => allRuns);
  const listForRef = vi.fn(async () => ({ data: { check_runs: whiteGloveRuns } }));
  const create = vi.fn(async () => ({ data: {} }));
  const update = vi.fn(async () => ({ data: {} }));

  const octokit = {
    paginate,
    checks: { listForRef, create, update },
  } as unknown as ReconcileDeps["octokit"];

  return { ...gatekeeperDeps(octokit, { enabled }), paginate, listForRef, create, update };
}

export type GatekeeperHarness = ReturnType<typeof buildGatekeeperHarness>;

export function requireGatekeeperHarness(
  harness: GatekeeperHarness | undefined,
): GatekeeperHarness {
  return requireBuilt(harness, "The fake GitHub client has not been built yet.");
}
