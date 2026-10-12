import { describe, expect, it, vi } from "vitest";
import type { Probot } from "probot";
import { createApp } from "../src/app.js";
import { Allowlist } from "../src/security/allowlist.js";

/**
 * App-level concurrency characterisation.
 *
 * The push and `pull_request.closed` deliveries both trigger a settings sync
 * for the same repository. Delivery order is not guaranteed and, in
 * production, the two can land within milliseconds of each other. This test
 * drives the real `createApp` wiring — real resolver, real mutex, real
 * handlers — through a multi-handler fake Probot.
 *
 * The sync's first applier read is held on a manual gate so the two deliveries
 * are forced to contend: whichever reaches the applier first must be the only
 * one that proceeds, because the shared mutex serialises the syncs. Recording
 * only the applier calls, tagged by delivery, makes the assertion independent
 * of yield granularity and of which delivery wins the race.
 */

const RULESETS_ROUTE = "GET /repos/{owner}/{repo}/rulesets";

/**
 * A promise plus its releaser plus a once-only claim: the first caller to
 * `claim()` is parked on `promise`, every later caller sails through.
 *
 * This is the key to a non-vacuous test. A microtask-only yield lets the push
 * handler's whole get/update pair finish before the closed handler reaches its
 * first applier call, so the recorded sequence looks batched even with no
 * serialisation at all. Parking the first applier read removes that timing
 * artifact: two unsynchronised syncs both reach the read and the second one
 * then writes while the first is still held, which the assertion catches.
 */
function manualGate() {
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
const OPEN_GATE = { claim: () => false, promise: Promise.resolve(), release: () => {} };

function fakeLogger() {
  const log: Record<string, unknown> = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  log.child = vi.fn(() => log);
  return log as never;
}

/**
 * Fake octokit for one delivery. Applier calls are tagged with `label` into the
 * shared `calls` list, so the final sequence shows which delivery performed
 * each write and in what order.
 */
function makeOctokit(
  label: string,
  calls: string[],
  gate: ReturnType<typeof manualGate>,
  /** The live repository state `repos.get` reports, so a test can choose a
   * repository that already matches the configured `has_issues: true`. */
  current: { has_issues: boolean } = { has_issues: false },
): Record<string, unknown> {
  const push = (call: string) => calls.push(`${label}:${call}`);

  const getContent = vi.fn(async ({ repo, path }: { repo: string; path: string }) => {
    if (repo === "widgets" && path === ".github/woodhouse.yml") {
      const body = "settings:\n  enabled: true\nrepository:\n  has_issues: true\n";
      return {
        data: {
          type: "file",
          content: Buffer.from(body, "utf8").toString("base64"),
          encoding: "base64",
        },
      };
    }
    throw Object.assign(new Error("Not Found"), { status: 404 });
  });

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

  const listFiles = vi.fn(async () => ({ data: [] }));

  // The outcome comment's surface. Its calls are not pushed into `calls`, so
  // the applier-only sequence stays the binding assertion.
  const listComments = vi.fn(async () => ({ data: [] }));
  const createComment = vi.fn(async () => ({ data: { id: 1 } }));
  const updateComment = vi.fn(async () => ({ data: { id: 1 } }));
  const deleteComment = vi.fn(async () => ({ data: {} }));

  const paginate = vi.fn(async (target: unknown) => {
    if (target === listComments) {
      return [];
    }
    if (target === listFiles) {
      return [{ filename: ".github/woodhouse.yml", status: "modified" }];
    }
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

  return {
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
}

/**
 * Multi-handler Probot stand-in: `createApp` registers dozens of listeners, so
 * events map to a list of callbacks rather than a single one.
 */
function fakeProbot() {
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

/** Drain every runnable microtask and a bounded number of macrotask turns. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const OWNER = { login: "trusted-org" };

function pushContext(
  octokit: Record<string, unknown>,
  ref = "refs/heads/main",
  changed: string[] = [".github/woodhouse.yml"],
) {
  return {
    name: "push",
    id: "delivery-push",
    log: fakeLogger(),
    octokit,
    payload: {
      ref,
      deleted: false,
      repository: { default_branch: "main", name: "widgets", owner: OWNER },
      commits: [{ added: changed, modified: [], removed: [] }],
    },
  };
}

function closedContext(octokit: Record<string, unknown>) {
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

describe("merge push and merged pull request race", () => {
  it("serializes the two same-repository syncs, in some order, never interleaved", async () => {
    const { app, deliver } = fakeProbot();
    const calls: string[] = [];
    const gate = manualGate();

    createApp({
      allowlist: new Allowlist(["trusted-org"]),
      baselineRepo: ".github-private",
      dryRun: false,
    })(app);

    const push = deliver("push", pushContext(makeOctokit("push", calls, gate)));
    const closed = deliver(
      "pull_request.closed",
      closedContext(makeOctokit("closed", calls, gate)),
    );

    // Fire both without awaiting (done above), then let both run as far as they
    // can. With the first applier read parked, a shared mutex permits exactly
    // one sync to have started: a single read, and no write yet. Without
    // serialisation the second sync reaches its read and writes while the first
    // is still held, so this length is the binding assertion.
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/:repos\.get$/);

    gate.release();
    await Promise.all([push, closed]);

    const pushBatch = ["push:repos.get", "push:repos.update"];
    const closedBatch = ["closed:repos.get", "closed:repos.update"];

    // Two contiguous batches. The spec says "in some order", so either
    // delivery may go first; what must never appear is an interleave.
    expect([
      [...pushBatch, ...closedBatch],
      [...closedBatch, ...pushBatch],
    ]).toContainEqual(calls);
  });
});

describe("push dispatch negative cases", () => {
  it("does not sync when a push to another branch touches a settings file", async () => {
    const { app, deliver } = fakeProbot();
    const calls: string[] = [];

    createApp({
      allowlist: new Allowlist(["trusted-org"]),
      baselineRepo: ".github-private",
      dryRun: false,
    })(app);

    await deliver(
      "push",
      pushContext(makeOctokit("push", calls, manualGate()), "refs/heads/feature/x"),
    );

    // The default-branch check refuses before the sync, so no applier call at
    // all — the same-repository race test's batch assertion needs no change.
    expect(calls).toEqual([]);
  });

  it("re-checks a near-miss default-branch push without writing when the repository matches", async () => {
    const { app, deliver } = fakeProbot();
    const calls: string[] = [];

    createApp({
      allowlist: new Allowlist(["trusted-org"]),
      baselineRepo: ".github-private",
      dryRun: false,
    })(app);

    // `docs/woodhouse.yml` is not a settings path, so the touched-config
    // predicate is false and the cache is never invalidated; the push still
    // triggers the routine diff-based re-check. The repository already matches
    // the configured `has_issues: true`, so nothing is written.
    const octokit = makeOctokit("push", calls, OPEN_GATE, { has_issues: true });
    await deliver("push", pushContext(octokit, "refs/heads/main", ["docs/woodhouse.yml"]));

    // The repository applier reads the current state, plans zero changes and
    // writes nothing; labels, branch-protection and rulesets each early-return
    // on the minimal config before any call. The re-check is read-only: a drift
    // would have produced `push:repos.update`.
    expect(calls).toEqual(["push:repos.get"]);

    // Pushes never comment: the marker-comment surface stays untouched.
    const surface = octokit as unknown as {
      paginate: ReturnType<typeof vi.fn>;
      issues: {
        listComments: ReturnType<typeof vi.fn>;
        createComment: ReturnType<typeof vi.fn>;
        updateComment: ReturnType<typeof vi.fn>;
      };
    };
    expect(surface.paginate).not.toHaveBeenCalledWith(
      surface.issues.listComments,
      expect.anything(),
    );
    expect(surface.issues.listComments).not.toHaveBeenCalled();
    expect(surface.issues.createComment).not.toHaveBeenCalled();
    expect(surface.issues.updateComment).not.toHaveBeenCalled();
  });
});
