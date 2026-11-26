/**
 * Recording octokit fake for the settings-sync suites.
 *
 * The fake mirrors the octokit surface every settings applier touches, so a
 * scenario asserts the same observable calls the corresponding unit test does.
 * This module is not a vitest entry: it is imported by the `.steps.ts` files,
 * the colocated world modules and `test/settings-concurrency.test.ts`.
 */

import { vi } from "vitest";
import type { Context } from "probot";
import type { ChangedFile } from "../../src/github/pulls.js";
import type { MergeFeedbackDeps } from "../../src/settings/mergeFeedback.js";
import type { Gate } from "./concurrency.js";
import { type CallLog, recorder, recorded } from "../support/recorded.js";

export const RULESETS_ROUTE = "GET /repos/{owner}/{repo}/rulesets";

export const SETTINGS_FILE: ChangedFile = { filename: ".github/woodhouse.yml", status: "modified" };

export interface Comment {
  id: number;
  body?: string;
}

/** One deployment branch policy as the fake stores it. */
export interface BranchPolicy {
  readonly id: number;
  readonly name: string;
  readonly environment: string;
}

/** An error shaped like an Octokit request failure. */
export function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** An empty REST payload the appliers never read past. */
const emptyPayload = async () => ({ data: {} });

/**
 * Serves the config cascade to a real `ConfigResolver`. Keyed `repo:path`,
 * 404ing everything else, exactly as the Contents API does.
 */
function makeGetContent(configFiles: Record<string, string>) {
  return vi.fn(async ({ repo, path }: { repo: string; path: string }) => {
    const key = `${repo}:${path}`;
    if (!(key in configFiles)) {
      throw httpError(404, "Not Found");
    }
    return {
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(configFiles[key]!, "utf8").toString("base64"),
      },
    };
  });
}

/** The production client the recording fakes stand in for. */
type OctokitApi = Context<"push">["octokit"];

/** One stubbed method, including its vitest mock controls. */
type Stub = ReturnType<typeof vi.fn>;

/** A namespace's methods; every name must exist on the production client. */
type Methods<Namespace extends keyof OctokitApi, Names extends keyof OctokitApi[Namespace]> = {
  readonly [K in Names]: Stub;
};

/** A method directly on the production client, checked to still exist. */
type ClientMethod<Name extends keyof OctokitApi> = Record<Name, Stub>[Name];

/**
 * The octokit surface the recording fake implements. Each namespace is keyed by
 * the real Probot client, so a renamed or removed production method fails this
 * file's build rather than surfacing as "x is not a function" at runtime.
 */
export interface RecordingOctokit {
  readonly repos: Methods<
    "repos",
    | "get"
    | "getContent"
    | "update"
    | "replaceAllTopics"
    | "updateBranchProtection"
    | "createOrUpdateEnvironment"
    | "getAllEnvironments"
    | "listDeploymentBranchPolicies"
    | "createDeploymentBranchPolicy"
    | "deleteDeploymentBranchPolicy"
  >;
  readonly issues: Methods<
    "issues",
    | "listLabelsForRepo"
    | "createLabel"
    | "updateLabel"
    | "deleteLabel"
    | "listComments"
    | "createComment"
    | "updateComment"
    | "deleteComment"
  >;
  readonly pulls: Methods<"pulls", "listFiles">;
  readonly paginate: ClientMethod<"paginate">;
  readonly request: ClientMethod<"request">;
}

/**
 * The one place a recording fake is widened to the merge-feedback handler's
 * client type. `RecordingOctokit` is the structural surface every fake
 * implements; Probot's client type is the full API, so the unavoidable cast
 * lives here rather than at each call site.
 */
export function asMergeFeedbackOctokit(octokit: RecordingOctokit): MergeFeedbackDeps["octokit"] {
  return octokit as unknown as MergeFeedbackDeps["octokit"];
}

export interface OctokitOptions {
  /** Delivery tag prefixed onto recorded applier calls, when supplied. */
  readonly label?: string;
  /** The call list to record into; a fresh list is created and returned when absent. */
  readonly calls?: string[];
  /** When supplied, `repos.get` claims the gate before returning. */
  readonly gate?: Gate;
  readonly current?: Record<string, unknown>;
  readonly configFiles?: Record<string, string>;
  readonly files?: readonly ChangedFile[];
  readonly comments?: readonly Comment[];
  readonly existingRulesets?: readonly { id: number; name: string }[];
  /** Deployment branch policies already present on the environment. */
  readonly branchPolicies?: readonly BranchPolicy[];
}

/**
 * The deployment branch-policy surface, backed by a per-environment map so a
 * create, delete and list see the same state a live environment would.
 */
function makeBranchPolicySurface(record: CallLog, seeded: readonly BranchPolicy[]) {
  const byEnvironment = new Map<string, BranchPolicy[]>();
  for (const policy of seeded) {
    const entries = byEnvironment.get(policy.environment) ?? [];
    entries.push({ ...policy });
    byEnvironment.set(policy.environment, entries);
  }
  let nextId = seeded.reduce((max, policy) => Math.max(max, policy.id), 0) + 1;

  const listDeploymentBranchPolicies = recorded(
    record,
    "repos.listDeploymentBranchPolicies",
    async ({ environment_name }: { environment_name: string }) => {
      const branch_policies = [...(byEnvironment.get(environment_name) ?? [])];
      return { data: { total_count: branch_policies.length, branch_policies } };
    },
  );
  const createDeploymentBranchPolicy = recorded(
    record,
    "repos.createDeploymentBranchPolicy",
    async ({ environment_name, name }: { environment_name: string; name: string }) => {
      const entry: BranchPolicy = { id: nextId++, name, environment: environment_name };
      const entries = byEnvironment.get(environment_name) ?? [];
      entries.push(entry);
      byEnvironment.set(environment_name, entries);
      return { data: entry };
    },
  );
  const deleteDeploymentBranchPolicy = recorded(
    record,
    "repos.deleteDeploymentBranchPolicy",
    async ({ branch_policy_id }: { branch_policy_id: number }) => {
      for (const entries of byEnvironment.values()) {
        const index = entries.findIndex((entry) => entry.id === branch_policy_id);
        if (index !== -1) {
          entries.splice(index, 1);
          break;
        }
      }
      return emptyPayload();
    },
  );
  const branchPolicyStore = (): readonly BranchPolicy[] =>
    [...byEnvironment.values()].flat().map((policy) => Object.assign({}, policy));

  return {
    listDeploymentBranchPolicies,
    createDeploymentBranchPolicy,
    deleteDeploymentBranchPolicy,
    branchPolicyStore,
  };
}

/** The `repos` namespace: the settings read plus the appliers' write surface. */
function makeReposSurface(
  record: CallLog,
  options: {
    readonly gate?: Gate;
    readonly current?: Record<string, unknown>;
    readonly configFiles?: Record<string, string>;
    readonly branchPolicies?: readonly BranchPolicy[];
  },
) {
  const { gate, current = { has_issues: false }, configFiles = {}, branchPolicies = [] } = options;
  const get = recorded(record, "repos.get", async () => {
    if (gate?.claim()) await gate.promise;
    return { data: { ...current } };
  });

  return {
    get,
    getContent: makeGetContent(configFiles),
    update: recorded(record, "repos.update", emptyPayload),
    replaceAllTopics: recorded(record, "repos.replaceAllTopics", emptyPayload),
    updateBranchProtection: recorded(record, "repos.updateBranchProtection", emptyPayload),
    createOrUpdateEnvironment: recorded(record, "repos.createOrUpdateEnvironment", emptyPayload),
    getAllEnvironments: recorded(record, "repos.getAllEnvironments", emptyPayload),
    ...makeBranchPolicySurface(record, branchPolicies),
  };
}

/** The `issues` namespace: label writes plus the merge-feedback comment surface. */
function makeIssuesSurface(record: CallLog, comments: readonly Comment[]) {
  return {
    listLabelsForRepo: vi.fn(async () => ({ data: [] })),
    createLabel: recorded(record, "issues.createLabel", emptyPayload),
    updateLabel: recorded(record, "issues.updateLabel", emptyPayload),
    deleteLabel: recorded(record, "issues.deleteLabel", emptyPayload),
    listComments: vi.fn(async () => ({ data: [...comments] })),
    createComment: vi.fn(async (..._args: unknown[]) => ({ data: { id: 1 } })),
    updateComment: vi.fn(async (..._args: unknown[]) => ({ data: { id: 1 } })),
    deleteComment: vi.fn(async () => ({ data: {} })),
  };
}

/** The `pulls` namespace: the changed-files listing. */
function makePullsSurface(files: readonly ChangedFile[]) {
  return {
    listFiles: vi.fn(async () => ({ data: [...files] })),
  };
}

/**
 * `paginate` dispatches on the target the way octokit does: comments and files
 * are methods, rulesets are a route string, deployment branch policies are a
 * method whose response wraps the array, and anything else is the labels
 * listing. The branch-policy branch calls the recorded method so call
 * assertions still bind, then normalises the wrapped response the way octokit's
 * paginator does before applying the map.
 */
function makePaginateSurface(
  record: CallLog,
  options: {
    readonly comments: readonly Comment[];
    readonly files: readonly ChangedFile[];
    readonly existingRulesets: readonly { id: number; name: string }[];
    readonly listComments: ReturnType<typeof makeIssuesSurface>["listComments"];
    readonly listFiles: ReturnType<typeof makePullsSurface>["listFiles"];
    readonly listDeploymentBranchPolicies: ReturnType<
      typeof makeBranchPolicySurface
    >["listDeploymentBranchPolicies"];
  },
) {
  const { comments, files, existingRulesets, listComments, listFiles } = options;
  const { listDeploymentBranchPolicies } = options;

  return vi.fn(
    async (target: unknown, params?: unknown, map?: (response: { data: unknown }) => unknown) => {
      if (target === listComments) return [...comments];
      if (target === listFiles) return [...files];
      if (target === RULESETS_ROUTE) {
        record("rulesets.list");
        return [...existingRulesets];
      }
      if (target === listDeploymentBranchPolicies) {
        const response = await listDeploymentBranchPolicies(params as { environment_name: string });
        const data = response.data.branch_policies;
        return map ? map({ ...response, data }) : data;
      }
      record("labels.list");
      return [];
    },
  );
}

/**
 * One recording octokit fake for every suite. Applier calls append to `calls`,
 * tagged with `label` when supplied; comment calls are never recorded, so an
 * applier assertion stays binding. Each namespace is built by a module-level
 * factory, and the assembled fake is the only variant the suites share.
 */
export function makeOctokit(options?: OctokitOptions) {
  const {
    label,
    gate,
    current,
    configFiles,
    files = [SETTINGS_FILE],
    comments = [],
    existingRulesets = [],
    branchPolicies,
    calls: providedCalls,
  } = options ?? {};
  const calls = providedCalls ?? [];
  const record = recorder(calls, label);

  const repos = makeReposSurface(record, { gate, current, configFiles, branchPolicies });
  const issues = makeIssuesSurface(record, comments);
  const pulls = makePullsSurface(files);
  const paginate = makePaginateSurface(record, {
    comments,
    files,
    existingRulesets,
    listComments: issues.listComments,
    listFiles: pulls.listFiles,
    listDeploymentBranchPolicies: repos.listDeploymentBranchPolicies,
  });
  const request = recorded(record, (route: string) => `request ${route}`, emptyPayload);

  const octokit: RecordingOctokit = {
    repos: {
      get: repos.get,
      getContent: repos.getContent,
      update: repos.update,
      replaceAllTopics: repos.replaceAllTopics,
      updateBranchProtection: repos.updateBranchProtection,
      createOrUpdateEnvironment: repos.createOrUpdateEnvironment,
      getAllEnvironments: repos.getAllEnvironments,
      listDeploymentBranchPolicies: repos.listDeploymentBranchPolicies,
      createDeploymentBranchPolicy: repos.createDeploymentBranchPolicy,
      deleteDeploymentBranchPolicy: repos.deleteDeploymentBranchPolicy,
    },
    issues,
    pulls,
    paginate,
    request,
  };

  return {
    octokit,
    calls,
    ...repos,
    ...issues,
    ...pulls,
    paginate,
    request,
  };
}
