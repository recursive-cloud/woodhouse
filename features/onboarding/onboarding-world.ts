/**
 * Fixture and harness layer for the onboarding acceptance suite (REC-19).
 *
 * Three fake worlds live here because the three capabilities the suite spans
 * have different octokit surfaces:
 *
 *  - the onboarding walk (scenarios 1-12 and 15), a recording fake modelled on the one
 *    `test/onboarding-handler.test.ts` used;
 *  - the merge-feedback handler (scenario 13), the shared recording octokit plus
 *    the issue-comment surface, with a literal resolver whose config has a local
 *    layer (the merged onboarding file is the opt-in);
 *  - the white-glove check handler (scenario 14), a checks fake plus recording
 *    stubs for the settings-applier surface, so "no settings are written" is a
 *    positive assertion rather than an absence of stubs.
 *
 * This module is not a vitest entry: `onboarding.steps.ts` imports it.
 */

import { vi } from "vitest";
import type { ReconcileDeps } from "../../src/gatekeeper/handler.js";
import type { ChangedFile } from "../../src/github/pulls.js";
import { KeyedMutex } from "../../src/lib/mutex.js";
import type { OnboardingDeps } from "../../src/onboarding/handler.js";
import { ONBOARDING_BRANCH, ONBOARDING_LABEL } from "../../src/onboarding/wording.js";
import type { MergeFeedbackDeps } from "../../src/settings/mergeFeedback.js";
import {
  RULESETS_ROUTE,
  asMergeFeedbackOctokit,
  httpError,
  makeOctokit,
} from "../settings-sync/octokit-fakes.js";
import { gatekeeperDeps } from "../gatekeeper/gatekeeper-world.js";
import { fakeResolver } from "../settings-sync/resolver-fakes.js";
import { fakeLogger } from "../support/scenario.js";

/* -------------------------------------------------------------------------
 * The onboarding walk world (scenarios 1-12)
 * ---------------------------------------------------------------------- */

interface FakeConfig {
  /** Settings paths that exist: an exact path, or `repo:path`, for any repository. */
  presentPaths?: readonly string[];
  /** Return an open onboarding pull request from `pulls.list`. */
  openOnboardingPr?: boolean;
  /** Repositories whose `repos.get` has no default branch (empty repository). */
  emptyRepos?: readonly string[];
  /** A repository whose onboarding branch already exists (`git.getRef` succeeds). */
  branchExistsRepos?: readonly string[];
  /** `pulls.create` rejects with a 403 for this repository, after the probes. */
  failCreateForRepo?: string;
  /** A read probe (`repos.getContent`) rejects with a 403 for this repository. */
  forbiddenReadForRepo?: string;
  /** Repositories `apps.listReposAccessibleToInstallation` reports, page by page. */
  accessibleRepos?: ReadonlyArray<{ readonly name?: unknown } | null>;
  /** Enumeration rejects (the installation endpoint refuses). */
  enumerationFails?: boolean;
  /** Repositories whose open-offer probe (`pulls.list`) refuses with a 500. */
  probeFailsFor?: readonly string[];
}

/** Every optional field unset. Read-only, so one shared instance is safe. */
const DEFAULT_FIXTURE: FakeConfig = {};

/** Whether a settings path exists per the fixture, as an exact path or `repo:path`. */
function present(config: FakeConfig, repo: string, path: string): boolean {
  return (config.presentPaths ?? []).some((entry) => entry === path || entry === `${repo}:${path}`);
}

/** A `vi.fn` that records a call and resolves to an empty payload. */
function recordingStub(calls: string[], call: string) {
  return vi.fn(async () => {
    calls.push(call);
    return { data: {} };
  });
}

function readContentStub(config: FakeConfig, calls: string[]) {
  return vi.fn(async ({ repo, path }: { repo: string; path: string }) => {
    calls.push(`repos.getContent ${repo}:${path}`);
    if (config.forbiddenReadForRepo === repo) {
      throw httpError(403, "Resource not accessible by integration");
    }
    if (present(config, repo, path)) return { data: { type: "file", content: "c2V0dGluZ3M6IHt9" } };
    throw httpError(404, "Not Found");
  });
}

function repoStub(config: FakeConfig, calls: string[]) {
  return vi.fn(async ({ repo }: { repo: string }) => {
    calls.push(`repos.get ${repo}`);
    const empty = (config.emptyRepos ?? []).includes(repo);
    return { data: { default_branch: empty ? "" : "main" } };
  });
}

function refStub(config: FakeConfig, calls: string[]) {
  return vi.fn(async ({ repo, ref }: { repo: string; ref: string }) => {
    calls.push(`git.getRef ${repo}:${ref}`);
    if (ref.includes(ONBOARDING_BRANCH)) {
      if ((config.branchExistsRepos ?? []).includes(repo)) {
        return { data: { object: { sha: "existing-onboarding-sha" } } };
      }
      throw httpError(404, "Not Found");
    }
    return { data: { object: { sha: "base-sha" } } };
  });
}

function openOffersStub(config: FakeConfig, calls: string[]) {
  return vi.fn(async ({ repo }: { repo: string }) => {
    calls.push(`pulls.list ${repo}`);
    if ((config.probeFailsFor ?? []).includes(repo)) {
      throw httpError(500, "boom");
    }
    if (!config.openOnboardingPr) return { data: [] };
    return { data: [{ number: 9, labels: [{ name: ONBOARDING_LABEL }] }] };
  });
}

function createPullStub(config: FakeConfig, calls: string[]) {
  return vi.fn(async ({ repo }: { repo: string }) => {
    calls.push(`pulls.create ${repo}`);
    if (config.failCreateForRepo === repo) {
      throw httpError(403, "Resource not accessible by integration");
    }
    return { data: { number: 42 } };
  });
}

function addLabelsStub(calls: string[]) {
  return vi.fn(async ({ repo }: { repo: string }) => {
    calls.push(`issues.addLabels ${repo}`);
    return { data: [] };
  });
}

function installationReposStub(config: FakeConfig, calls: string[]) {
  return vi.fn(async (params: { per_page?: number; page?: number } = {}) => {
    const perPage = params.per_page ?? 30;
    const page = params.page ?? 1;
    calls.push(`apps.listReposAccessibleToInstallation page=${page} per_page=${perPage}`);
    if (config.enumerationFails) {
      throw httpError(403, "Resource not accessible by integration");
    }
    const all = config.accessibleRepos ?? [];
    return {
      data: {
        total_count: all.length,
        repositories: all.slice((page - 1) * perPage, page * perPage),
      },
    };
  });
}

/** Mirrors `octokit.paginate` for the installation endpoint, page by page. */
function paginateStub() {
  return vi.fn(
    async (
      route: (params: Record<string, unknown>) => Promise<{ data: unknown }>,
      params: Record<string, unknown> = {},
    ) => {
      const perPage = typeof params.per_page === "number" ? params.per_page : 30;
      const items: unknown[] = [];
      for (let page = 1; ; page += 1) {
        const { data } = await route({ ...params, page });
        const batch = Array.isArray(data)
          ? data
          : ((data as { repositories?: unknown[] }).repositories ?? []);
        items.push(...batch);
        if (batch.length < perPage) break;
      }
      return items;
    },
  );
}

/**
 * Recording fake octokit.
 *
 * Every method the walk could reach pushes a line onto `calls` in invocation
 * order — reads included — so "cheap-first", "skipped silently" and "no writes"
 * are literal assertions over the whole surface rather than per-mock checks.
 * Each method body is a module-level factory, so the builder itself stays flat.
 */
function fakeOnboardingOctokit(config: FakeConfig = DEFAULT_FIXTURE) {
  const calls: string[] = [];
  const getContent = readContentStub(config, calls);
  const get = repoStub(config, calls);
  const getRef = refStub(config, calls);
  const list = openOffersStub(config, calls);
  const createRef = recordingStub(calls, "git.createRef");
  const createOrUpdateFileContents = recordingStub(calls, "repos.createOrUpdateFileContents");
  const create = createPullStub(config, calls);
  const addLabels = addLabelsStub(calls);
  const listReposAccessibleToInstallation = installationReposStub(config, calls);
  const paginate = paginateStub();

  const octokit = {
    repos: { getContent, get, createOrUpdateFileContents },
    git: { getRef, createRef },
    pulls: { list, create },
    issues: { addLabels },
    apps: { listReposAccessibleToInstallation },
    paginate,
  } as unknown as OnboardingDeps["octokit"];

  return {
    octokit,
    calls,
    getContent,
    get,
    getRef,
    list,
    createRef,
    createOrUpdateFileContents,
    create,
    addLabels,
    listReposAccessibleToInstallation,
    paginate,
  };
}

export function buildOnboarding(config: FakeConfig = DEFAULT_FIXTURE, dryRun = false) {
  const fake = fakeOnboardingOctokit(config);
  const log = fakeLogger();
  const deps: OnboardingDeps = {
    octokit: fake.octokit,
    log,
    dryRun,
  };

  return { ...fake, log, deps };
}

export type OnboardingWorld = ReturnType<typeof buildOnboarding>;

/** The world a When step built, or a plain failure when the step order is wrong. */
export function requireWorld<World>(world: World | undefined): World {
  if (world === undefined) {
    throw new Error("The world has not been built yet; the When step must run first.");
  }
  return world;
}

/** `installation` `created` payload carrying the freshly installed repositories. */
export const created = (...names: string[]) => ({
  action: "created",
  installation: { repositories: names.map((name) => ({ name })) },
});

/** `installation_repositories` `added` payload. */
export const added = (...names: string[]) => ({
  action: "added",
  repositories_added: names.map((name) => ({ name })),
});

/* -------------------------------------------------------------------------
 * The merge-feedback world (scenario 13)
 * ---------------------------------------------------------------------- */

const ONBOARDING_CHANGED_FILE: ChangedFile = {
  filename: ".github/woodhouse.yml",
  status: "added",
};

export interface CommentParams {
  owner: string;
  repo: string;
  issue_number: number;
  body: string;
}

/**
 * The merge-feedback world reuses the shared recording octokit and resolver
 * fakes. The resolution carries a local layer (the merged onboarding file is
 * the opt-in), and `pruneRulesets` makes the rulesets applier read GitHub's
 * list, which is how the scenario observes that the sync ran past the
 * repository applier.
 */
export function buildMergeWorld() {
  const octokit = makeOctokit({ files: [ONBOARDING_CHANGED_FILE] });
  const log = fakeLogger();
  const { resolver } = fakeResolver({
    settings: { enabled: true, pruneRulesets: true },
    repository: { has_issues: true },
  });

  const deps: MergeFeedbackDeps = {
    octokit: asMergeFeedbackOctokit(octokit.octokit),
    resolver,
    mutex: new KeyedMutex(),
    log,
    dryRun: false,
  };

  return { ...octokit, log, resolver, deps };
}

export type MergeWorld = ReturnType<typeof buildMergeWorld>;

/* -------------------------------------------------------------------------
 * The white-glove world (scenario 14)
 * ---------------------------------------------------------------------- */

export const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

/** A `vi.fn` resolving to an empty REST payload. */
function emptyStub() {
  return vi.fn(async () => ({ data: {} }));
}

/** A settings-applier stub that records the method name it stands in for. */
function applierStub(applierCalls: string[], method: string, data?: Record<string, unknown>) {
  return vi.fn(async () => {
    applierCalls.push(method);
    return { data: data ?? {} };
  });
}

function requestStub(applierCalls: string[]) {
  return vi.fn(async (route: string) => {
    applierCalls.push(`request ${route}`);
    return { data: {} };
  });
}

/** Dispatch `paginate` the way octokit does: methods first, then route strings. */
function checksPaginate(applierCalls: string[], runs: readonly unknown[], listForRef: unknown) {
  return async (target: unknown) => {
    if (target === listForRef) return runs;
    if (target === RULESETS_ROUTE) {
      applierCalls.push("rulesets.list");
      return [];
    }
    applierCalls.push("labels.list");
    return [];
  };
}

/**
 * Fake octokit for `reconcile`, plus recording stubs for the settings-applier
 * surface. A repository with no settings file is never synced, so every applier
 * stub must stay untouched — recorded here so the absence is positive.
 */
function fakeChecksOctokit() {
  const applierCalls: string[] = [];
  const runs: readonly unknown[] = [];

  const listForRef = vi.fn(async () => ({ data: { check_runs: runs } }));
  const create = emptyStub();
  const update = emptyStub();
  const paginate = vi.fn(checksPaginate(applierCalls, runs, listForRef));

  // `repos.get` is read for the current settings, so it keeps a real payload.
  const reposGet = applierStub(applierCalls, "repos.get", { has_issues: true });
  const reposUpdate = applierStub(applierCalls, "repos.update");
  const replaceAllTopics = applierStub(applierCalls, "repos.replaceAllTopics");
  const updateBranchProtection = applierStub(applierCalls, "repos.updateBranchProtection");
  const createLabel = applierStub(applierCalls, "issues.createLabel");
  const request = requestStub(applierCalls);

  const octokit = {
    paginate,
    checks: { listForRef, create, update },
    repos: {
      get: reposGet,
      update: reposUpdate,
      replaceAllTopics,
      updateBranchProtection,
    },
    issues: { createLabel },
    request,
  } as unknown as ReconcileDeps["octokit"];

  return {
    octokit,
    applierCalls,
    listForRef,
    create,
    update,
    reposGet,
    reposUpdate,
    replaceAllTopics,
    updateBranchProtection,
    createLabel,
    request,
  };
}

export function buildChecksWorld() {
  const fake = fakeChecksOctokit();
  const { deps, log } = gatekeeperDeps(fake.octokit);

  return { ...fake, log, deps };
}

export type ChecksWorld = ReturnType<typeof buildChecksWorld>;
