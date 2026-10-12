import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { woodhouseConfigSchema } from "../src/config/schema.js";
import { KeyedMutex } from "../src/lib/mutex.js";
import {
  SETTINGS_APPLIED_MARKER,
  buildSettingsAppliedComment,
  commentSettingsApplied,
  type MergeFeedbackDeps,
} from "../src/settings/mergeFeedback.js";
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
function fakeOctokit(files: readonly ChangedFile[] = [SETTINGS_FILE], comments: Comment[] = []) {
  const calls: string[] = [];

  const listFiles = vi.fn(async () => ({ data: [...files] }));

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
    repos: { get, update, replaceAllTopics, updateBranchProtection },
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
    update,
  };
}

/**
 * Literal fake resolver. `resolve` returns a fully-validated config so the
 * appliers behave exactly as they would in production.
 */
function fakeResolver(configInput: Record<string, unknown>) {
  const calls: string[] = [];
  const config = woodhouseConfigSchema.parse(configInput);

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
      return { config, sources: [], issues: [] };
    }),
  };

  return { resolver, calls, config };
}

const ENABLED = { settings: { enabled: true }, repository: { has_issues: true } };

function build(configInput: Record<string, unknown> = ENABLED, comments: Comment[] = []) {
  const octokit = fakeOctokit([SETTINGS_FILE], comments);
  const log = fakeLogger();
  const resolver = fakeResolver(configInput);
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
  it("invalidates, resolves, and syncs when a settings change merges to the default branch", async () => {
    const { deps, scope, pr, calls, resolver, log } = build();

    await commentSettingsApplied(deps, scope, pr);

    // Cache dropped before resolving, so a stale entry cannot be served
    // whichever order the closed and push deliveries arrive in.
    expect(resolver.calls).toEqual(["invalidate", "resolve"]);
    expect(resolver.resolver.isBaselineRepo).toHaveBeenCalledWith("widgets");

    // The sync ran end to end: repository read then the settings write.
    expect(calls).toEqual(["repos.get", "repos.update"]);
    expect(log.debug).toHaveBeenCalledWith(
      { owner: "acme", repo: "widgets" },
      "Settings changed on merge; running settings sync",
    );
  });

  it("still checks the cache and resolves, but never syncs, when settings are disabled", async () => {
    const {
      deps,
      scope,
      pr,
      calls,
      resolver,
      log,
      paginate,
      listComments,
      createComment,
      updateComment,
    } = build({
      settings: { enabled: false },
      repository: { has_issues: true },
    });

    await commentSettingsApplied(deps, scope, pr);

    expect(resolver.calls).toEqual(["invalidate", "resolve"]);
    // No applier call at all: the master switch is honoured before any write.
    expect(calls).toEqual([]);
    // The comment sits on the enabled path only, after the sync.
    expect(paginate).not.toHaveBeenCalledWith(listComments, expect.anything());
    expect(listComments).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      { owner: "acme", repo: "widgets" },
      "Settings management disabled; skipping sync",
    );
  });

  it("does not list files for a close without a merge", async () => {
    const {
      deps,
      scope,
      pr,
      calls,
      listFiles,
      paginate,
      listComments,
      createComment,
      updateComment,
    } = build();

    await commentSettingsApplied(deps, scope, { ...pr, merged: false });

    expect(listFiles).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(paginate).not.toHaveBeenCalledWith(listComments, expect.anything());
    expect(listComments).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).not.toHaveBeenCalled();
  });

  it("does not list files for a merge into a non-default branch", async () => {
    const {
      deps,
      scope,
      pr,
      calls,
      listFiles,
      paginate,
      listComments,
      createComment,
      updateComment,
    } = build();

    await commentSettingsApplied(deps, scope, { ...pr, baseRef: "feature" });

    expect(listFiles).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(paginate).not.toHaveBeenCalledWith(listComments, expect.anything());
    expect(listComments).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).not.toHaveBeenCalled();
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

  it("treats a deleted settings file as a change and reports the fallback outcome", async () => {
    // Post-deletion the local layer is gone, so the cascade falls back to the
    // baseline-only resolution: `has_issues` comes back true. The live
    // repository still has it false, so the sync must apply that fallback.
    const { deps, scope, pr, resolver } = build();
    const octokit = fakeOctokit([{ filename: ".github/woodhouse.yml", status: "removed" }]);

    await commentSettingsApplied({ ...deps, octokit: octokit.octokit }, scope, pr);

    // The deletion passed the gate: the cache was dropped, the config
    // re-resolved, and the sync applied the fallback-driven write.
    expect(resolver.calls).toEqual(["invalidate", "resolve"]);
    expect(octokit.calls).toEqual(["repos.get", "repos.update"]);

    // The outcome comment reports exactly the summary the sync produced.
    const expected = buildSettingsAppliedComment(
      {
        changes: [{ area: "repository", action: "update", target: "has_issues" }],
        failures: [],
        dryRun: false,
      },
      false,
    );
    expect(octokit.createComment).toHaveBeenCalledWith(expect.objectContaining({ body: expected }));
    expect(expected).toContain("- repository update: has_issues");
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

  it("posts one settings-applied comment whose body is delimited by the marker and sign-off", async () => {
    const { deps, scope, pr, createComment, updateComment, listComments, paginate } = build();

    await commentSettingsApplied(deps, scope, pr);

    expect(paginate).toHaveBeenCalledWith(listComments, expect.anything());
    expect(createComment).toHaveBeenCalledOnce();
    expect(updateComment).not.toHaveBeenCalled();

    const { body } = createComment.mock.calls[0][0] as { body: string };
    expect(body.startsWith(SETTINGS_APPLIED_MARKER)).toBe(true);
    expect(body.trimEnd().endsWith(SIGN_OFF)).toBe(true);
  });

  it("updates the existing marker comment in place on a re-delivery, never duplicating", async () => {
    const { deps, scope, pr, createComment, updateComment } = build(ENABLED, [
      { id: 42, body: `stale outcome\n${SETTINGS_APPLIED_MARKER}\n` },
    ]);

    await commentSettingsApplied(deps, scope, pr);

    expect(updateComment).toHaveBeenCalledOnce();
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 42 }));
    expect(createComment).not.toHaveBeenCalled();
  });

  it("reports the baseline variant and invalidates owner-wide when the baseline repository is the target", async () => {
    const { deps, scope, pr, resolver, createComment } = build();
    resolver.resolver.isBaselineRepo.mockReturnValue(true);

    await commentSettingsApplied(deps, scope, pr);

    // The baseline was touched, so the whole owner cache is dropped, not just
    // this repository's entry.
    expect(resolver.calls).toEqual(["invalidateOwner", "resolve"]);
    expect(resolver.resolver.invalidate).not.toHaveBeenCalled();

    // The comment states the baseline was synced directly and that other
    // repositories adopt the change at their next event — never that every
    // repository was re-synced.
    const { body } = createComment.mock.calls[0][0] as { body: string };
    expect(body).toContain("This is the baseline repository, sir, so it has been synced directly.");
    expect(body).toContain("Other repositories will adopt the change at their next event.");
    expect(body).not.toMatch(/every repository/i);
    expect(body.trimEnd().endsWith(SIGN_OFF)).toBe(true);
  });

  it("in dry-run writes no comment, makes no comment call, and logs the body", async () => {
    const {
      deps,
      scope,
      pr,
      log,
      paginate,
      listComments,
      createComment,
      updateComment,
      deleteComment,
    } = build();

    await commentSettingsApplied({ ...deps, dryRun: true }, scope, pr);

    // The manager guards its own writes: it does not even list our marker
    // comment, and no create/update/delete is issued.
    expect(paginate).not.toHaveBeenCalledWith(listComments, expect.anything());
    expect(listComments).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).not.toHaveBeenCalled();
    expect(deleteComment).not.toHaveBeenCalled();

    // The would-be body is logged, marker and sign-off included.
    const logged = log.info.mock.calls.map((call) => String(call[1])).join("\n");
    expect(logged).toContain(SETTINGS_APPLIED_MARKER);
    expect(logged).toContain(SIGN_OFF);
  });
});
