/**
 * Shared test-support fakes for the settings-sync BDD scenarios.
 *
 * This module is not a vitest entry: it is imported by the `.steps.ts` files
 * and by `test/settings-concurrency.test.ts`. The fakes mirror the ones the
 * unit suites use, so a scenario asserts the same observable calls the
 * corresponding unit test does.
 *
 * Construction verbs: `fake*` stands in for a named interface (a Probot app, a
 * config resolver); `make*` composes a builder over options.
 */

import { vi } from "vitest";
import type { Context, Probot } from "probot";
import { woodhouseConfigSchema } from "../../src/config/schema.js";
import type { ResolvedConfig } from "../../src/config/resolver.js";
import type { ChangedFile } from "../../src/github/pulls.js";
import type { MergeFeedbackResolver } from "../../src/settings/mergeFeedback.js";
import { fakeLogger } from "../support/scenario.js";

export const RULESETS_ROUTE = "GET /repos/{owner}/{repo}/rulesets";
export const LOCAL_SOURCE = "acme/widgets:.github/woodhouse.yml";

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
 * A promise plus its releaser plus a once-only claim: the first caller to
 * `claim()` is parked on `promise`, every later caller sails through. The
 * once-only claim removes the timing artifact that would make an unsynchronised
 * race look batched.
 */
export interface Gate {
  claim(): boolean;
  readonly promise: Promise<void>;
  release(): void;
}

export function manualGate(): Gate {
  let armed = true;
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    claim(): boolean {
      if (!armed) return false;
      armed = false;
      return true;
    },
    promise,
    release,
  };
}

/** A gate that never parks an applier read: for deliveries that run straight through. */
export const OPEN_GATE: Gate = {
  claim: () => false,
  promise: Promise.resolve(),
  release: () => {},
};

/** Drain every runnable microtask and a bounded number of macrotask turns. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Multi-handler Probot stand-in: `createApp` registers dozens of listeners, so
 * events map to a list of callbacks rather than a single one.
 */
export function fakeProbot() {
  const handlers = new Map<string, ((ctx: unknown) => Promise<void>)[]>();

  const app = {
    on: (events: string | string[], cb: (ctx: unknown) => Promise<void>) => {
      const list = Array.isArray(events) ? events : [events];
      for (const event of list) {
        const existing = handlers.get(event) ?? [];
        existing.push(cb);
        handlers.set(event, existing);
      }
    },
  } as unknown as Probot;

  return {
    app,
    async deliver(event: string, context: unknown): Promise<void> {
      const list = handlers.get(event);
      if (list === undefined) throw new Error(`no handler registered for ${event}`);
      await Promise.all(list.map((cb) => cb(context)));
    },
  };
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
export function makeOctokit(options: OctokitOptions = {}) {
  const {
    label,
    gate,
    current = { has_issues: false },
    configFiles = {},
    files = [SETTINGS_FILE],
    comments = [],
    existingRulesets = [],
  } = options;
  const calls = options.calls ?? [];

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

/** A resolution carrying a local layer unless overridden. */
export function resolvedConfig(
  configInput: Record<string, unknown> = {},
  overrides: Partial<ResolvedConfig> = {},
): ResolvedConfig {
  return {
    config: woodhouseConfigSchema.parse(configInput),
    sources: [LOCAL_SOURCE],
    issues: [],
    localSource: LOCAL_SOURCE,
    ...overrides,
  };
}

/**
 * Literal fake resolver. `resolve` returns a fully-validated config so the
 * appliers behave exactly as they would in production.
 */
export function fakeResolver(
  configInput: Record<string, unknown> = {},
  overrides: Partial<ResolvedConfig> = {},
) {
  const calls: string[] = [];
  const config = woodhouseConfigSchema.parse(configInput);

  const resolved: ResolvedConfig = {
    config,
    sources: [LOCAL_SOURCE],
    issues: [],
    localSource: LOCAL_SOURCE,
    ...overrides,
  };

  const resolver: MergeFeedbackResolver = {
    isBaselineRepo: vi.fn((_repo: string) => false),
    invalidate: vi.fn((_owner: string, _repo: string) => {
      calls.push("invalidate");
    }),
    invalidateOwner: vi.fn((_owner: string) => {
      calls.push("invalidateOwner");
    }),
    resolve: vi.fn(async () => {
      calls.push("resolve");
      return resolved;
    }),
  };

  return { resolver, calls, config, resolved };
}

const OWNER = { login: "trusted-org" };

export interface PushContextOptions {
  readonly ref?: string;
  readonly changed?: string[];
  readonly deleted?: boolean;
}

/** A `push` delivery context for the fake Probot. */
export function pushContext(octokit: RecordingOctokit, options: PushContextOptions = {}) {
  const { ref = "refs/heads/main", changed = [".github/woodhouse.yml"], deleted = false } = options;
  return {
    name: "push",
    id: "delivery-push",
    log: fakeLogger(),
    octokit,
    payload: {
      ref,
      deleted,
      repository: { default_branch: "main", name: "widgets", owner: OWNER },
      commits: [{ added: changed, modified: [], removed: [] }],
    },
  };
}

/** A `pull_request.closed` (merged) delivery context for the fake Probot. */
export function closedContext(octokit: RecordingOctokit) {
  return {
    name: "pull_request",
    id: "delivery-closed",
    log: fakeLogger(),
    octokit,
    payload: {
      action: "closed",
      pull_request: { number: 7, merged: true, base: { ref: "main" } },
      repository: { default_branch: "main", name: "widgets", owner: OWNER },
    },
  };
}
