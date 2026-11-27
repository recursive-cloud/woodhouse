import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import {
  forget,
  resetAppLoginCache,
  route,
  serve,
  type RoutingDeps,
  type RoutingRequest,
} from "../src/approval/routing.js";
import { autoApprovalSchema, type AutoApprovalConfig } from "../src/config/schema.js";

const SELF = "woodhouse[bot]";
const RENOVATE = "renovate[bot]";

const ownerConfig: AutoApprovalConfig = autoApprovalSchema.parse({
  allowedActors: { owners: ["my-user"] },
});

const bothConfig: AutoApprovalConfig = autoApprovalSchema.parse({
  allowedActors: { owners: ["my-user"], bots: [RENOVATE] },
});

const disabledConfig: AutoApprovalConfig = autoApprovalSchema.parse({
  enabled: false,
  allowedActors: { owners: ["my-user"], bots: [RENOVATE] },
});

const noOwnersConfig: AutoApprovalConfig = autoApprovalSchema.parse({});

function decide(
  overrides: Partial<RoutingRequest>,
  config: AutoApprovalConfig = bothConfig,
  selfLogin: string | undefined = SELF,
) {
  return route({ author: "my-user", draft: false, state: "open", ...overrides }, config, selfLogin);
}

describe("route", () => {
  it("routes an owner's open pull request to the app", () => {
    const decision = decide({ author: "my-user" });

    expect(decision.reviewers).toEqual([SELF]);
    expect(decision.reason).toContain("owner");
  });

  it("requests nothing for an owner when auto-approval is disabled", () => {
    expect(decide({ author: "my-user" }, disabledConfig).reviewers).toEqual([]);
  });

  it("routes a bot to the app when it enabled auto-merge itself", () => {
    const decision = decide({ author: RENOVATE, autoMergeEnabledBy: RENOVATE });

    expect(decision.reviewers).toEqual([SELF]);
    expect(decision.reason).toContain("auto-merge");
  });

  it("compares the enabling login case-insensitively", () => {
    expect(decide({ author: RENOVATE, autoMergeEnabledBy: "Renovate[Bot]" }).reviewers).toEqual([
      SELF,
    ]);
  });

  it("routes a bot to the owners when someone else enabled auto-merge", () => {
    expect(decide({ author: RENOVATE, autoMergeEnabledBy: "my-user" }).reviewers).toEqual([
      "my-user",
    ]);
  });

  it("routes a bot to the owners when the auto-merge fact was not gathered", () => {
    expect(decide({ author: RENOVATE }).reviewers).toEqual(["my-user"]);
  });

  it("routes a bot to the owners when auto-approval is disabled", () => {
    expect(
      decide({ author: RENOVATE, autoMergeEnabledBy: RENOVATE }, disabledConfig).reviewers,
    ).toEqual(["my-user"]);
  });

  it("routes an author in neither list to the owners", () => {
    expect(decide({ author: "dependabot[bot]" }).reviewers).toEqual(["my-user"]);
  });

  it("requests every listed owner, in order", () => {
    const config = autoApprovalSchema.parse({ allowedActors: { owners: ["a", "b"] } });

    expect(decide({ author: "dependabot[bot]" }, config).reviewers).toEqual(["a", "b"]);
  });

  it("never routes to the app's own login when it is listed as an owner", () => {
    const config = autoApprovalSchema.parse({
      allowedActors: { owners: [SELF, "my-user"] },
    });

    expect(decide({ author: "dependabot[bot]" }, config).reviewers).toEqual(["my-user"]);
  });

  it("compares the app login case-insensitively when filtering owners", () => {
    const config = autoApprovalSchema.parse({
      allowedActors: { owners: ["WOODHOUSE[bot]", "my-user"] },
    });

    expect(decide({ author: "dependabot[bot]" }, config).reviewers).toEqual(["my-user"]);
  });

  it("requests nothing when the only listed owner is the app itself", () => {
    const config = autoApprovalSchema.parse({ allowedActors: { owners: [SELF] } });

    const decision = decide({ author: "dependabot[bot]" }, config);

    expect(decision.reviewers).toEqual([]);
    expect(decision.reason).toContain("no reviewer to route to");
  });

  it("requests nothing when no owner is configured", () => {
    expect(decide({ author: "dependabot[bot]" }, noOwnersConfig).reviewers).toEqual([]);
  });

  it("falls back to the owners when an enabled config has no resolved app login", () => {
    const owner = route({ author: "my-user", draft: false, state: "open" }, ownerConfig, undefined);
    expect(owner.reviewers).toEqual(["my-user"]);

    const bot = route(
      { author: RENOVATE, draft: false, state: "open", autoMergeEnabledBy: RENOVATE },
      bothConfig,
      undefined,
    );
    expect(bot.reviewers).toEqual(["my-user"]);
  });

  it("requests nothing for a draft, even from an owner", () => {
    expect(decide({ author: "my-user", draft: true }).reviewers).toEqual([]);
  });

  it("requests nothing for a pull request that is not open", () => {
    expect(decide({ author: "my-user", state: "closed" }).reviewers).toEqual([]);
  });
});

interface IoHarnessOptions {
  /** The `auto_merge` object the live GET returns; null means no auto-merge. */
  readonly autoMerge?: { enabled_by: { login: string } } | null;
}

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Logger;
}

function ioHarness(options: IoHarnessOptions = {}) {
  const get = vi.fn(async () => ({ data: { auto_merge: options.autoMerge ?? null } }));
  const requestReviewers = vi.fn(async () => ({ data: {} }));
  const removeRequestedReviewers = vi.fn(async () => ({ data: {} }));

  const octokit = {
    pulls: { get, requestReviewers, removeRequestedReviewers },
    apps: { getAuthenticated: async () => ({ data: { slug: "woodhouse" } }) },
  } as unknown as RoutingDeps["octokit"];

  return { octokit, log: fakeLogger(), get, requestReviewers, removeRequestedReviewers };
}

const ownerPr = {
  number: 7,
  author: "my-user",
  draft: false,
  state: "open",
  action: "synchronize",
};

const botPr = { ...ownerPr, author: RENOVATE };

beforeEach(() => {
  // appLogin is cached per process; each test owns a fresh fake octokit.
  resetAppLoginCache();
});

describe("serve — dry-run", () => {
  it("performs no reviewer writes and remembers nothing", async () => {
    const h = ioHarness();
    const routed = new Map<string, readonly string[]>();

    await serve(
      { octokit: h.octokit, log: h.log, dryRun: true, routed },
      "acme",
      "widgets",
      ownerPr,
      ownerConfig,
    );

    expect(h.requestReviewers).not.toHaveBeenCalled();
    expect(h.removeRequestedReviewers).not.toHaveBeenCalled();
    expect(routed.size).toBe(0);
    expect(h.log.info).toHaveBeenCalledWith(expect.stringContaining("DRY_RUN: would request"));
  });
});

describe("serve — live writes", () => {
  it("requests the routed reviewer and records the set", async () => {
    const h = ioHarness();
    const routed = new Map<string, readonly string[]>();

    await serve(
      { octokit: h.octokit, log: h.log, dryRun: false, routed },
      "acme",
      "widgets",
      ownerPr,
      ownerConfig,
    );

    expect(h.requestReviewers).toHaveBeenCalledOnce();
    expect(h.requestReviewers).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      pull_number: 7,
      reviewers: [SELF],
    });
    expect(h.removeRequestedReviewers).not.toHaveBeenCalled();
    expect(routed.get("acme/widgets#7")).toEqual([SELF]);
    // An owner author never costs the auto-merge GET.
    expect(h.get).not.toHaveBeenCalled();
  });

  it("does not fetch the auto-merge fact for a neither-list author", async () => {
    const h = ioHarness();
    const routed = new Map<string, readonly string[]>();

    await serve(
      { octokit: h.octokit, log: h.log, dryRun: false, routed },
      "acme",
      "widgets",
      { ...ownerPr, author: "dependabot[bot]" },
      bothConfig,
    );

    expect(h.get).not.toHaveBeenCalled();
    expect(h.requestReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ reviewers: ["my-user"] }),
    );
  });

  it("withdraws the previous reviewer and requests the replacement", async () => {
    let autoMerge: { enabled_by: { login: string } } | null = null;
    const h = ioHarness();
    const routed = new Map<string, readonly string[]>();
    const deps = { octokit: h.octokit, log: h.log, dryRun: false, routed };

    // First pass: the bot has not enabled auto-merge, so the owner is routed.
    // The GET reads the fact at call time, so the toggle below is visible.
    h.get.mockImplementation(async () => ({ data: { auto_merge: autoMerge } }));

    await serve(deps, "acme", "widgets", botPr, bothConfig);
    expect(h.requestReviewers).toHaveBeenLastCalledWith(
      expect.objectContaining({ reviewers: ["my-user"] }),
    );

    // A later pass: the bot enabled auto-merge itself. Routing replaces the
    // owner with the app, withdrawing only what it requested.
    autoMerge = { enabled_by: { login: RENOVATE } };

    await serve(deps, "acme", "widgets", botPr, bothConfig);

    expect(h.removeRequestedReviewers).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      pull_number: 7,
      reviewers: ["my-user"],
    });
    expect(h.requestReviewers).toHaveBeenLastCalledWith(
      expect.objectContaining({ reviewers: [SELF] }),
    );
    expect(routed.get("acme/widgets#7")).toEqual([SELF]);
  });

  it("routes an owner's reopened pull request once and does not re-request on a second pass", async () => {
    const h = ioHarness();
    const routed = new Map<string, readonly string[]>();
    const deps = { octokit: h.octokit, log: h.log, dryRun: false, routed };
    const reopened = { ...ownerPr, action: "reopened" };

    await serve(deps, "acme", "widgets", reopened, ownerConfig);
    await serve(deps, "acme", "widgets", reopened, ownerConfig);

    expect(h.requestReviewers).toHaveBeenCalledOnce();
    expect(h.requestReviewers).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      pull_number: 7,
      reviewers: [SELF],
    });
    expect(h.removeRequestedReviewers).not.toHaveBeenCalled();
  });
});

describe("forget", () => {
  it("drops the tracked set for a closed pull request", () => {
    const h = ioHarness();
    const routed = new Map<string, readonly string[]>([["acme/widgets#7", [SELF]]]);

    forget({ log: h.log, routed }, "acme", "widgets", 7);

    expect(routed.has("acme/widgets#7")).toBe(false);
    expect(h.log.debug).toHaveBeenCalledWith({ pr: 7 }, "Forgot routed reviewers on close");
  });

  it("leaves an untracked pull request alone", () => {
    const h = ioHarness();
    const routed = new Map<string, readonly string[]>();

    forget({ log: h.log, routed }, "acme", "widgets", 7);

    expect(routed.size).toBe(0);
    expect(h.log.debug).not.toHaveBeenCalled();
  });
});
