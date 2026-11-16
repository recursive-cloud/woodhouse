/**
 * Shared test-support fakes for the settings-sync BDD scenarios.
 *
 * This module is not a vitest entry: it is imported by the `.steps.ts` files
 * only. The fakes mirror the ones the unit suites use, so a scenario asserts
 * the same observable calls the corresponding unit test does.
 */

import { vi } from "vitest";
import type { Logger } from "pino";
import type { Probot } from "probot";
import { woodhouseConfigSchema } from "../../src/config/schema.js";
import type { ResolvedConfig } from "../../src/config/resolver.js";
import type { ApplyContext } from "../../src/settings/apply.js";
import type { ChangedFile } from "../../src/github/pulls.js";
import type { MergeFeedbackDeps } from "../../src/settings/mergeFeedback.js";

export const RULESETS_ROUTE = "GET /repos/{owner}/{repo}/rulesets";
export const LOCAL_SOURCE = "acme/widgets:.github/woodhouse.yml";

export const SETTINGS_FILE: ChangedFile = {
  filename: ".github/woodhouse.yml",
  status: "modified",
};

export interface Comment {
  id: number;
  body?: string;
}

/** A logger whose every method is a spy; `child` returns the same logger. */
export function fakeLogger(): Logger {
  const log: Record<string, unknown> = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  log.child = vi.fn(() => log);
  return log as unknown as Logger;
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

export interface AppOctokitOptions {
  /** Delivery tag prefixed onto every recorded applier call. */
  readonly label: string;
  readonly calls: string[];
  readonly gate: Gate;
  /** The live repository state `repos.get` reports. */
  readonly current?: { has_issues: boolean };
  readonly configFiles?: Record<string, string>;
  readonly files?: readonly ChangedFile[];
  readonly comments?: readonly Comment[];
}

/**
 * Fake octokit for one app-level delivery. Applier calls are tagged with
 * `label` into the shared `calls` list, so the final sequence shows which
 * delivery performed each write and in what order. Comment calls are not
 * tagged, keeping the applier assertion binding.
 */
export function makeAppOctokit(options: AppOctokitOptions) {
  const {
    label,
    calls,
    gate,
    current = { has_issues: false },
    configFiles = {},
    files = [SETTINGS_FILE],
    comments = [],
  } = options;

  const push = (call: string) => calls.push(`${label}:${call}`);

  const getContent = makeGetContent(configFiles);

  const get = vi.fn(async () => {
    push("repos.get");
    if (gate.claim()) await gate.promise;
    return { data: { ...current } };
  });
  const update = vi.fn(async () => {
    push("repos.update");
    return { data: {} };
  });
  const replaceAllTopics = vi.fn(async () => {
    push("repos.replaceAllTopics");
    return { data: {} };
  });
  const updateBranchProtection = vi.fn(async () => {
    push("repos.updateBranchProtection");
    return { data: {} };
  });

  const listLabelsForRepo = vi.fn(async () => ({ data: [] }));
  const createLabel = vi.fn(async () => {
    push("issues.createLabel");
    return { data: {} };
  });
  const updateLabel = vi.fn(async () => {
    push("issues.updateLabel");
    return { data: {} };
  });
  const deleteLabel = vi.fn(async () => {
    push("issues.deleteLabel");
    return { data: {} };
  });

  const listFiles = vi.fn(async () => ({ data: [...files] }));

  const listComments = vi.fn(async () => ({ data: [...comments] }));
  const createComment = vi.fn(async (..._args: unknown[]) => ({ data: { id: 1 } }));
  const updateComment = vi.fn(async (..._args: unknown[]) => ({ data: { id: 1 } }));
  const deleteComment = vi.fn(async () => ({ data: {} }));

  const paginate = vi.fn(async (target: unknown) => {
    if (target === listComments) return [...comments];
    if (target === listFiles) return [...files];
    if (target === RULESETS_ROUTE) {
      push("rulesets.list");
      return [];
    }
    push("labels.list");
    return [];
  });

  const request = vi.fn(async (route: string) => {
    push(`request ${route}`);
    return { data: {} };
  });

  const octokit = {
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
  } as unknown as Record<string, unknown>;

  return {
    octokit,
    get,
    getContent,
    update,
    listFiles,
    listComments,
    createComment,
    updateComment,
    deleteComment,
    paginate,
    request,
  };
}

export interface ApplyOctokitOptions {
  /** The live repository state `repos.get` reports. */
  readonly current?: Record<string, unknown>;
  /** What the rulesets route already contains. */
  readonly existingRulesets?: readonly { id: number; name: string }[];
}

/**
 * Fake octokit covering every surface the four appliers touch, for the
 * syncSettings-level scenarios. Each call is tagged into `calls` in the order
 * it fired, exactly as `test/apply.test.ts` does.
 */
export function makeApplyOctokit(options: ApplyOctokitOptions = {}) {
  const calls: string[] = [];
  const current = options.current ?? { has_issues: false };
  const existingRulesets = options.existingRulesets ?? [];

  const get = vi.fn(async () => {
    calls.push("repos.get");
    return { data: { ...current } };
  });
  const update = vi.fn(async () => {
    calls.push("repos.update");
    return { data: {} };
  });
  const replaceAllTopics = vi.fn(async () => {
    calls.push("repos.replaceAllTopics");
    return { data: {} };
  });
  const updateBranchProtection = vi.fn(async () => {
    calls.push("repos.updateBranchProtection");
    return { data: {} };
  });

  const listLabelsForRepo = vi.fn(async () => ({ data: [] }));
  const createLabel = vi.fn(async () => {
    calls.push("issues.createLabel");
    return { data: {} };
  });
  const updateLabel = vi.fn(async () => {
    calls.push("issues.updateLabel");
    return { data: {} };
  });
  const deleteLabel = vi.fn(async () => {
    calls.push("issues.deleteLabel");
    return { data: {} };
  });

  // Labels paginate a method; rulesets paginate a route string.
  const paginate = vi.fn(async (target: unknown) => {
    if (target === RULESETS_ROUTE) {
      calls.push("rulesets.list");
      return [...existingRulesets];
    }
    calls.push("labels.list");
    return [];
  });

  const request = vi.fn(async (route: string) => {
    calls.push(`request ${route}`);
    return { data: {} };
  });

  const octokit = {
    repos: { get, update, replaceAllTopics, updateBranchProtection },
    issues: { listLabelsForRepo, createLabel, updateLabel, deleteLabel },
    paginate,
    request,
  } as unknown as ApplyContext["octokit"];

  return {
    octokit,
    calls,
    get,
    update,
    replaceAllTopics,
    updateBranchProtection,
    listLabelsForRepo,
    createLabel,
    updateLabel,
    deleteLabel,
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
  configInput: Record<string, unknown>,
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

  const resolver = {
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

export interface FeedbackOctokitOptions {
  readonly files?: readonly ChangedFile[];
  readonly comments?: readonly Comment[];
  readonly configFiles?: Record<string, string>;
  readonly current?: Record<string, unknown>;
  readonly existingRulesets?: readonly { id: number; name: string }[];
}

/**
 * Fake octokit covering the changed-file listing, the applier surface a sync
 * touches, and the issue-comment surface the outcome comment uses. Only
 * applier calls are recorded in `calls`, so the recorded sequence stays exactly
 * the writes the handler caused.
 */
export function makeFeedbackOctokit(options: FeedbackOctokitOptions = {}) {
  const {
    files = [SETTINGS_FILE],
    comments = [],
    configFiles = {},
    current = { has_issues: false },
    existingRulesets = [],
  } = options;

  const calls: string[] = [];

  const listFiles = vi.fn(async () => ({ data: [...files] }));
  const getContent = makeGetContent(configFiles);

  const get = vi.fn(async () => {
    calls.push("repos.get");
    return { data: { ...current } };
  });
  const update = vi.fn(async () => {
    calls.push("repos.update");
    return { data: {} };
  });
  const replaceAllTopics = vi.fn(async () => {
    calls.push("repos.replaceAllTopics");
    return { data: {} };
  });
  const updateBranchProtection = vi.fn(async () => {
    calls.push("repos.updateBranchProtection");
    return { data: {} };
  });

  const listLabelsForRepo = vi.fn(async () => ({ data: [] }));
  const createLabel = vi.fn(async () => {
    calls.push("issues.createLabel");
    return { data: {} };
  });
  const updateLabel = vi.fn(async () => {
    calls.push("issues.updateLabel");
    return { data: {} };
  });
  const deleteLabel = vi.fn(async () => {
    calls.push("issues.deleteLabel");
    return { data: {} };
  });

  // The comment surface. Its calls are deliberately not recorded in `calls`.
  const listComments = vi.fn(async () => ({ data: [...comments] }));
  const createComment = vi.fn(async (..._args: unknown[]) => ({ data: { id: 1 } }));
  const updateComment = vi.fn(async (..._args: unknown[]) => ({ data: { id: 1 } }));
  const deleteComment = vi.fn(async () => ({ data: {} }));

  const paginate = vi.fn(async (target: unknown) => {
    if (target === listComments) return [...comments];
    if (target === listFiles) return [...files];
    if (target === RULESETS_ROUTE) {
      calls.push("rulesets.list");
      return [...existingRulesets];
    }
    calls.push("labels.list");
    return [];
  });

  const request = vi.fn(async (route: string) => {
    calls.push(`request ${route}`);
    return { data: {} };
  });

  const octokit = {
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
  } as unknown as MergeFeedbackDeps["octokit"];

  return {
    octokit,
    calls,
    listFiles,
    listComments,
    createComment,
    updateComment,
    deleteComment,
    paginate,
    get,
    getContent,
    update,
    updateBranchProtection,
    request,
  };
}

const OWNER = { login: "trusted-org" };

export interface PushContextOptions {
  readonly ref?: string;
  readonly changed?: string[];
  readonly deleted?: boolean;
}

/** A `push` delivery context for the fake Probot. */
export function pushContext(
  octokit: Record<string, unknown>,
  options: PushContextOptions = {},
) {
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
export function closedContext(octokit: Record<string, unknown>) {
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
