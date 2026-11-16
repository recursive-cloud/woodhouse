import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { woodhouseConfigSchema } from "../src/config/schema.js";
import type { ResolvedConfig } from "../src/config/resolver.js";
import { KeyedMutex } from "../src/lib/mutex.js";
import { commentSettingsApplied, type MergeFeedbackDeps } from "../src/settings/mergeFeedback.js";
import { SIGN_OFF } from "../src/approval/wording.js";
import type { ChangedFile } from "../src/github/pulls.js";

const RULESETS_ROUTE = "GET /repos/{owner}/{repo}/rulesets";

function fakeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

const SETTINGS_FILE: ChangedFile = {
  filename: ".github/woodhouse.yml",
  status: "modified",
};

interface Comment {
  id: number;
  body?: string;
}

/**
 * Fake octokit covering the changed-file listing, the applier surface a sync
 * touches, and the issue-comment surface the outcome comment uses. Only
 * applier calls are recorded in `calls`, so the recorded sequence stays exactly
 * the writes the handler caused — the comment is outside the mutex and must not
 * perturb that assertion. The comment fakes are returned separately for tests
 * that assert on them.
 */
function fakeOctokit(
  files: readonly ChangedFile[] = [SETTINGS_FILE],
  comments: Comment[] = [],
  configFiles: Record<string, string> = {},
) {
  const calls: string[] = [];

  const listFiles = vi.fn(async () => ({ data: [...files] }));

  // Serves the config cascade to a real `ConfigResolver`. Keyed `repo:path`,
  // 404ing everything else, exactly as the Contents API does.
  const getContent = vi.fn(async ({ repo, path }: { repo: string; path: string }) => {
    const key = `${repo}:${path}`;
    if (!(key in configFiles)) {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    }
    return {
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(configFiles[key]!).toString("base64"),
      },
    };
  });

  const get = vi.fn(async () => {
    calls.push("repos.get");
    return { data: { has_issues: false } };
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
  const listComments = vi.fn(async () => ({ data: comments }));
  const createComment = vi.fn(async (..._args: unknown[]) => ({ data: { id: 1 } }));
  const updateComment = vi.fn(async (..._args: unknown[]) => ({ data: { id: 1 } }));
  const deleteComment = vi.fn(async () => ({ data: {} }));

  // `listChangedFiles` paginates the method; labels paginate a method and
  // rulesets paginate a route string, so all four targets are distinguished.
  const paginate = vi.fn(async (target: unknown) => {
    if (target === listComments) return [...comments];
    if (target === listFiles) return [...files];
    if (target === RULESETS_ROUTE) {
      calls.push("rulesets.list");
      return [];
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
    listComments,
    createComment,
    updateComment,
    paginate,
    get,
    getContent,
    update,
  };
}

/**
 * Literal fake resolver. `resolve` returns a fully-validated config so the
 * appliers behave exactly as they would in production. The default resolution
 * carries a local layer, which is the opt-in signal for settings sync.
 */
function fakeResolver(
  configInput: Record<string, unknown>,
  overrides: Partial<ResolvedConfig> = {},
) {
  const calls: string[] = [];
  const config = woodhouseConfigSchema.parse(configInput);

  const resolved: ResolvedConfig = {
    config,
    sources: ["acme/widgets:.github/woodhouse.yml"],
    issues: [],
    localSource: "acme/widgets:.github/woodhouse.yml",
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

const ENABLED = { settings: { enabled: true }, repository: { has_issues: true } };

function build(
  configInput: Record<string, unknown> = ENABLED,
  comments: Comment[] = [],
  resolution: Partial<ResolvedConfig> = {},
) {
  const octokit = fakeOctokit([SETTINGS_FILE], comments);
  const log = fakeLogger();
  const resolver = fakeResolver(configInput, resolution);
  const mutex = new KeyedMutex();

  const deps: MergeFeedbackDeps = {
    octokit: octokit.octokit,
    resolver: resolver.resolver,
    mutex,
    log,
    dryRun: false,
  };

  return {
    ...octokit,
    log,
    resolver,
    mutex,
    deps,
    scope: { owner: "acme", repo: "widgets", defaultBranch: "main" },
    pr: { number: 7, merged: true, baseRef: "main" },
  };
}

/** A promise plus the function that settles it, for manual sequencing. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Flush every pending microtask (and one macrotask) before asserting. */
function flush() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("commentSettingsApplied", () => {
  it("never syncs or comments when the resolved config failed validation", async () => {
    const { deps, scope, pr, calls, log, paginate, listComments, createComment, updateComment } =
      build(ENABLED, [], {
        issues: [{ path: "settings.enabled", message: "Expected boolean, received string" }],
      });

    await commentSettingsApplied(deps, scope, pr);

    // Invalid configuration fails closed, exactly as it did when the switch
    // defaulted off: no sync and no comment.
    expect(calls).toEqual([]);
    expect(paginate).not.toHaveBeenCalledWith(listComments, expect.anything());
    expect(listComments).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      { owner: "acme", repo: "widgets", reason: "invalid-config" },
      "Settings sync skipped",
    );
  });

  it("does not sync when the merged pull request touched no settings file", async () => {
    const { deps, scope, pr, calls, resolver } = build();
    const octokit = fakeOctokit([{ filename: "src/index.ts", status: "modified" }]);

    await commentSettingsApplied({ ...deps, octokit: octokit.octokit }, scope, pr);

    // The file list is read, the gate refuses, and nothing downstream runs —
    // including the outcome comment.
    expect(resolver.calls).toEqual([]);
    expect(calls).toEqual([]);
    expect(octokit.paginate).not.toHaveBeenCalledWith(octokit.listComments, expect.anything());
    expect(octokit.listComments).not.toHaveBeenCalled();
    expect(octokit.createComment).not.toHaveBeenCalled();
    expect(octokit.updateComment).not.toHaveBeenCalled();
  });

  it("runs the sync under the shared per-repository mutex key", async () => {
    const { deps, scope, pr, calls, mutex } = build();

    // Hold the same key `acme/widgets` that the push handler uses.
    const held = gate();
    const holding = mutex.run("acme/widgets", () => held.promise);

    const run = commentSettingsApplied(deps, scope, pr);

    // Let the handler reach its mutex.run; the sync must stay blocked behind
    // the held key rather than drifting to a different key.
    await flush();
    expect(calls).toEqual([]);

    held.release();
    await Promise.all([run, holding]);

    expect(calls).toEqual(["repos.get", "repos.update"]);
  });

  it("reports the baseline variant and invalidates owner-wide when the baseline repository is the target", async () => {
    const built = build(ENABLED, [], {
      sources: ["acme/.github-private:.github/woodhouse.yml"],
      localSource: "acme/.github-private:.github/woodhouse.yml",
    });
    built.resolver.resolver.isBaselineRepo.mockReturnValue(true);

    await commentSettingsApplied(built.deps, { ...built.scope, repo: ".github-private" }, built.pr);

    // The baseline was touched, so the whole owner cache is dropped, not just
    // this repository's entry.
    expect(built.resolver.calls).toEqual(["invalidateOwner", "resolve"]);
    expect(built.resolver.resolver.invalidate).not.toHaveBeenCalled();

    // The comment states the baseline was synced directly and that other
    // repositories adopt the change at their next event — never that every
    // repository was re-synced.
    const { body } = built.createComment.mock.calls[0][0] as { body: string };
    expect(body).toContain("This is the baseline repository, sir, so it has been synced directly.");
    expect(body).toContain("Other repositories will adopt the change at their next event.");
    expect(body).not.toMatch(/every repository/i);
    expect(body.trimEnd().endsWith(SIGN_OFF)).toBe(true);
  });
});
