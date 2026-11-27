import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { escalationPass, shouldHandToOwners } from "../src/approval/escalation.js";
import {
  handToOwners,
  holdsRequest,
  resetAppLoginCache as resetRoutingAppLoginCache,
} from "../src/approval/routing.js";
import {
  resetAppLoginCache as resetApprovalAppLoginCache,
  serve,
} from "../src/approval/silverPlatter.js";
import { autoApprovalSchema, woodhouseConfigSchema } from "../src/config/schema.js";

const SELF = "woodhouse[bot]";
const RENOVATE = "renovate[bot]";
const OWNER = "my-user";
const SHA = "abc123";

const config = autoApprovalSchema.parse({
  allowedActors: { bots: [RENOVATE], owners: [OWNER] },
});

const ENABLED_BY_SELF = { enabled_by: { login: RENOVATE } };

describe("shouldHandToOwners", () => {
  const base = {
    author: RENOVATE,
    actorClass: "bot" as const,
    autoMergeEnabledBy: RENOVATE,
    heldBySelf: true,
  };

  it("hands a bot that enabled its own auto-merge to the owners while Woodhouse holds the review", () => {
    expect(shouldHandToOwners(base)).toBe(true);
  });

  it("does not hand an owner's pull request to the owners", () => {
    expect(shouldHandToOwners({ ...base, actorClass: "owner", author: OWNER })).toBe(false);
  });

  it("does not hand an author outside both lists", () => {
    expect(shouldHandToOwners({ ...base, actorClass: "neither", author: "dependabot[bot]" })).toBe(
      false,
    );
  });

  it("does not hand a bot nobody enabled auto-merge for", () => {
    expect(shouldHandToOwners({ ...base, autoMergeEnabledBy: null })).toBe(false);
  });

  it("does not hand a bot when someone else enabled auto-merge", () => {
    expect(shouldHandToOwners({ ...base, autoMergeEnabledBy: OWNER })).toBe(false);
  });

  it("does not hand a bot when Woodhouse does not hold the review", () => {
    expect(shouldHandToOwners({ ...base, heldBySelf: false })).toBe(false);
  });

  it("compares the author and enabling login case-insensitively", () => {
    expect(
      shouldHandToOwners({
        ...base,
        author: "Renovate[Bot]",
        autoMergeEnabledBy: "renovate[BOT]",
      }),
    ).toBe(true);
  });

  it("trims surrounding whitespace before comparing", () => {
    expect(
      shouldHandToOwners({
        ...base,
        author: " renovate[bot] ",
        autoMergeEnabledBy: "RENOVATE[BOT]",
      }),
    ).toBe(true);
  });
});

describe("holdsRequest", () => {
  it("is true when the tracked set contains the login", () => {
    const routed = new Map<string, readonly string[]>([["acme/widgets#7", [SELF]]]);

    expect(holdsRequest({ routed }, "acme", "widgets", 7, SELF)).toBe(true);
  });

  it("is false when the tracked set does not contain the login", () => {
    const routed = new Map<string, readonly string[]>([["acme/widgets#7", [OWNER]]]);

    expect(holdsRequest({ routed }, "acme", "widgets", 7, SELF)).toBe(false);
  });

  it("is false for an untracked pull request", () => {
    expect(holdsRequest({ routed: new Map() }, "acme", "widgets", 7, SELF)).toBe(false);
  });

  it("compares logins case-insensitively", () => {
    const routed = new Map<string, readonly string[]>([["acme/widgets#7", ["WOODHOUSE[BOT]"]]]);

    expect(holdsRequest({ routed }, "acme", "widgets", 7, SELF)).toBe(true);
  });
});

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

interface FakeOptions {
  readonly files?: readonly { filename: string; status: string }[];
  readonly autoMerge?: { enabled_by: { login: string } } | null;
}

type Deps = Parameters<typeof serve>[0];

/** A live, eligible, open bot pull request headed by SHA. */
function harness(options: FakeOptions = {}) {
  const files = options.files ?? [{ filename: "src/index.ts", status: "modified" }];
  const autoMerge = options.autoMerge === undefined ? ENABLED_BY_SELF : options.autoMerge;

  const get = vi.fn(async () => ({
    data: {
      number: 7,
      state: "open",
      draft: false,
      user: { login: RENOVATE },
      head: { sha: SHA },
      auto_merge: autoMerge,
    },
  }));
  const listFiles = vi.fn(async () => ({ data: files }));
  const listReviews = vi.fn(async () => ({ data: [] }));
  const createReview = vi.fn(async () => ({ data: {} }));
  const requestReviewers = vi.fn(async () => ({ data: {} }));
  const removeRequestedReviewers = vi.fn(async () => ({ data: {} }));
  const listAssociated = vi.fn(async () => ({ data: [{ number: 7, state: "open" }] }));
  const getAuthenticated = vi.fn(async () => ({ data: { slug: "woodhouse" } }));

  const paginate = vi.fn(
    async (
      route: (params: Record<string, unknown>) => Promise<{ data: unknown[] }>,
      params: Record<string, unknown>,
    ) => {
      const { data } = await route({ ...params, page: 1 });
      return data;
    },
  );

  const octokit = {
    paginate,
    pulls: {
      get,
      listFiles,
      listReviews,
      createReview,
      requestReviewers,
      removeRequestedReviewers,
    },
    repos: { listPullRequestsAssociatedWithCommit: listAssociated },
    apps: { getAuthenticated },
  } as unknown as Deps["octokit"];

  return {
    octokit,
    log: fakeLogger(),
    createReview,
    requestReviewers,
    removeRequestedReviewers,
    get,
    getAuthenticated,
    listAssociated,
    paginate,
  };
}

/** A resolver returning the file's config, or a caller-supplied auto-approval block. */
function fakeResolver(approvalConfig: typeof config = config) {
  return {
    resolve: vi.fn(async () => ({
      config: woodhouseConfigSchema.parse({ autoApproval: approvalConfig }),
      sources: [],
      issues: [],
    })),
  };
}

function run(
  h: ReturnType<typeof harness>,
  routed: Map<string, readonly string[]>,
  dryRun = false,
): Promise<boolean> {
  return serve(
    { octokit: h.octokit, log: h.log, dryRun, routing: { routed } },
    "acme",
    "widgets",
    SHA,
    config,
  );
}

beforeEach(() => {
  resetRoutingAppLoginCache();
  resetApprovalAppLoginCache();
});

describe("serve — recovery reconcile", () => {
  it("approves a recovered commit and withdraws the owners, clearing the tracked set", async () => {
    const h = harness();
    const routed = new Map<string, readonly string[]>([["acme/widgets#7", [OWNER]]]);

    const approved = await run(h, routed);

    expect(approved).toBe(true);
    expect(h.createReview).toHaveBeenCalledOnce();
    expect(h.removeRequestedReviewers).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      pull_number: 7,
      reviewers: [OWNER],
    });
    expect(routed.get("acme/widgets#7")).toEqual([]);
  });

  it("clears a Woodhouse-only tracked set without a reviewer write", async () => {
    const h = harness();
    const routed = new Map<string, readonly string[]>([["acme/widgets#7", [SELF]]]);

    const approved = await run(h, routed);

    expect(approved).toBe(true);
    expect(h.removeRequestedReviewers).not.toHaveBeenCalled();
    expect(routed.get("acme/widgets#7")).toEqual([]);
  });

  it("leaves the tracked set alone when the owners' withdrawal fails", async () => {
    const h = harness();
    const routed = new Map<string, readonly string[]>([["acme/widgets#7", [OWNER]]]);
    h.removeRequestedReviewers.mockRejectedValueOnce(new Error("boom"));

    const approved = await run(h, routed);

    expect(approved).toBe(false);
    expect(routed.get("acme/widgets#7")).toEqual([OWNER]);
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ pr: 7, sha: SHA }),
      expect.any(String),
    );
  });
});

describe("serve — refusal escalation", () => {
  it("hands a refused pull request to the owners when Woodhouse holds the review", async () => {
    const h = harness({ files: [{ filename: ".github/woodhouse.yml", status: "modified" }] });
    const routed = new Map<string, readonly string[]>([["acme/widgets#7", [SELF]]]);

    const approved = await run(h, routed);

    expect(approved).toBe(false);
    expect(h.createReview).not.toHaveBeenCalled();
    expect(h.removeRequestedReviewers).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      pull_number: 7,
      reviewers: [SELF],
    });
    expect(h.requestReviewers).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      pull_number: 7,
      reviewers: [OWNER],
    });
    expect(routed.get("acme/widgets#7")).toEqual([OWNER]);
  });

  it("does not re-escalate when the owners already hold the review", async () => {
    const h = harness({ files: [{ filename: ".github/woodhouse.yml", status: "modified" }] });
    const routed = new Map<string, readonly string[]>([["acme/widgets#7", [OWNER]]]);

    const approved = await run(h, routed);

    expect(approved).toBe(false);
    expect(h.removeRequestedReviewers).not.toHaveBeenCalled();
    expect(h.requestReviewers).not.toHaveBeenCalled();
  });
});

describe("handToOwners — replacement dedupe", () => {
  it("does not write when the owners already hold the tracked set", async () => {
    const h = harness();
    const routed = new Map<string, readonly string[]>([["acme/widgets#7", [OWNER]]]);

    await handToOwners(
      { octokit: h.octokit, log: h.log, dryRun: false, routed },
      "acme",
      "widgets",
      7,
      config,
      `checks failed on commit ${SHA}`,
    );

    expect(h.removeRequestedReviewers).not.toHaveBeenCalled();
    expect(h.requestReviewers).not.toHaveBeenCalled();
    expect(routed.get("acme/widgets#7")).toEqual([OWNER]);
    expect(h.log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ pr: 7, reviewers: [OWNER] }),
      "Review routing unchanged",
    );
  });
});

describe("escalationPass — disabled auto-approval", () => {
  it("touches no octokit API at all", async () => {
    const h = harness();
    const disabled = autoApprovalSchema.parse({
      enabled: false,
      allowedActors: { bots: [RENOVATE] },
    });
    const resolver = fakeResolver(disabled);
    const hook = escalationPass(
      resolver as unknown as Parameters<typeof escalationPass>[0],
      false,
      { routed: new Map() },
    )(h.octokit, h.log);

    await hook("acme", "widgets", SHA);

    expect(resolver.resolve).toHaveBeenCalledOnce();
    expect(h.getAuthenticated).not.toHaveBeenCalled();
    expect(h.paginate).not.toHaveBeenCalled();
    expect(h.listAssociated).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.requestReviewers).not.toHaveBeenCalled();
    expect(h.removeRequestedReviewers).not.toHaveBeenCalled();
  });
});
