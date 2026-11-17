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

export const RULESETS_ROUTE = "GET /repos/{owner}/{repo}/rulesets";

export const SETTINGS_FILE: ChangedFile = { filename: ".github/woodhouse.yml", status: "modified" };

export interface Comment {
  id: number;
  body?: string;
}

/** An error shaped like an Octokit request failure. */
export function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

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
    "get" | "getContent" | "update" | "replaceAllTopics" | "updateBranchProtection"
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
}

/**
 * One recording octokit fake for every suite. Applier calls append to `calls`,
 * tagged with `label` when supplied; comment calls are never recorded, so an
 * applier assertion stays binding. `paginate` dispatches on the target the way
 * octokit does.
 */
export function makeOctokit(options?: OctokitOptions) {
  const {
    label,
    gate,
    current = { has_issues: false },
    configFiles = {},
    files = [SETTINGS_FILE],
    comments = [],
    existingRulesets = [],
    calls: providedCalls,
  } = options ?? {};
  const calls = providedCalls ?? [];

  const record = (call: string) => {
    calls.push(label === undefined ? call : `${label}:${call}`);
  };

  const get = vi.fn(async () => {
    record("repos.get");
    if (gate?.claim()) await gate.promise;
    return { data: { ...current } };
  });
  const getContent = makeGetContent(configFiles);
  const update = vi.fn(async () => {
    record("repos.update");
    return { data: {} };
  });
  const replaceAllTopics = vi.fn(async () => {
    record("repos.replaceAllTopics");
    return { data: {} };
  });
  const updateBranchProtection = vi.fn(async () => {
    record("repos.updateBranchProtection");
    return { data: {} };
  });

  const listLabelsForRepo = vi.fn(async () => ({ data: [] }));
  const createLabel = vi.fn(async () => {
    record("issues.createLabel");
    return { data: {} };
  });
  const updateLabel = vi.fn(async () => {
    record("issues.updateLabel");
    return { data: {} };
  });
  const deleteLabel = vi.fn(async () => {
    record("issues.deleteLabel");
    return { data: {} };
  });

  const listFiles = vi.fn(async () => ({ data: [...files] }));

  const listComments = vi.fn(async () => ({ data: [...comments] }));
  const createComment = vi.fn(async (..._args: unknown[]) => ({ data: { id: 1 } }));
  const updateComment = vi.fn(async (..._args: unknown[]) => ({ data: { id: 1 } }));
  const deleteComment = vi.fn(async () => ({ data: {} }));

  // Pagination dispatches on the target: comments and files are methods,
  // rulesets are a route string, and anything else is the labels listing.
  const paginate = vi.fn(async (target: unknown) => {
    if (target === listComments) return [...comments];
    if (target === listFiles) return [...files];
    if (target === RULESETS_ROUTE) {
      record("rulesets.list");
      return [...existingRulesets];
    }
    record("labels.list");
    return [];
  });

  const request = vi.fn(async (route: string) => {
    record(`request ${route}`);
    return { data: {} };
  });

  const octokit: RecordingOctokit = {
    repos: { get, getContent, update, replaceAllTopics, updateBranchProtection },
    issues: {
      listLabelsForRepo,
      createLabel,
      updateLabel,
      deleteLabel,
      listComments,
      createComment,
      updateComment,
      deleteComment,
    },
    pulls: { listFiles },
    paginate,
    request,
  };

  return {
    octokit,
    calls,
    get,
    getContent,
    update,
    replaceAllTopics,
    updateBranchProtection,
    listLabelsForRepo,
    createLabel,
    updateLabel,
    deleteLabel,
    listFiles,
    listComments,
    createComment,
    updateComment,
    deleteComment,
    paginate,
    request,
  };
}
