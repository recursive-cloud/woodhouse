import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { applyRulesets } from "../../src/settings/appliers/rulesets.js";
import type { ApplierContext } from "../../src/settings/appliers/types.js";
import { woodhouseConfigSchema, type RulesetConfig } from "../../src/config/schema.js";

interface ExistingRuleset {
  id: number;
  name: string;
}

/** GitHub's own wording for the Free-plan/private-repo case. */
const PLAN_LIMIT_MESSAGE =
  "Upgrade to GitHub Pro or make this repository public to enable this feature.";

/**
 * Fake octokit covering only the ruleset surface this applier touches. Both the
 * paginate read and every request are recorded so the tests can assert the
 * plan-to-call mapping without reaching for the network.
 */
function fakeOctokit(existing: ExistingRuleset[] = []) {
  const paginate = vi.fn(async () => existing);
  const request = vi.fn(async () => ({ data: {} }));

  const octokit = { paginate, request } as unknown as ApplierContext["octokit"];

  return { octokit, paginate, request };
}

function fakeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function build(
  existing: ExistingRuleset[] = [],
  configInput: Record<string, unknown> = {},
  dryRun = false,
) {
  const fake = fakeOctokit(existing);
  const log = fakeLogger();
  const ctx = {
    octokit: fake.octokit,
    owner: "acme",
    repo: "widgets",
    log,
    dryRun,
  } as unknown as ApplierContext;

  return { ...fake, log, ctx, config: woodhouseConfigSchema.parse(configInput) };
}

/**
 * The same full ruleset shape the planner tests use. It is parsed through the
 * real `woodhouseConfigSchema` by `build`, so the request assertions prove the
 * typed schema plus the applier carry rules, conditions and bypass actors
 * through verbatim.
 */
const FULL_RULESET: RulesetConfig = {
  name: "main",
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
  bypass_actors: [
    { actor_id: 42, actor_type: "RepositoryRole", bypass_mode: "pull_request" },
    { actor_id: 1341, actor_type: "User", bypass_mode: "exempt" },
  ],
  rules: [
    {
      type: "required_status_checks",
      parameters: {
        required_status_checks: [{ context: "woodhouse/white-glove" }],
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
      },
    },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 1,
        dismiss_stale_reviews_on_push: true,
      },
    },
  ],
};

/**
 * An error shaped like an Octokit request failure.
 */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("applyRulesets", () => {
  it("makes no calls at all when there are no rulesets and no pruning", async () => {
    const { ctx, config, paginate, request } = build([], { rulesets: [] });

    const result = await applyRulesets(ctx, config);

    expect(paginate).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], failures: [] });
  });

  it("POSTs once per created ruleset, sending the ruleset body", async () => {
    const { ctx, config, request } = build([], { rulesets: [{ name: "main" }] });

    const result = await applyRulesets(ctx, config);

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/rulesets",
      expect.objectContaining({
        owner: "acme",
        repo: "widgets",
        name: "main",
        target: "branch",
        enforcement: "active",
        rules: [],
      }),
    );
    expect(result).toEqual({
      changes: [{ area: "ruleset", action: "create", target: "main" }],
      failures: [],
    });
  });

  it("PUTs per planned update with the matched ruleset id (always, never diffed)", async () => {
    const { ctx, config, request } = build([{ id: 7, name: "main" }], {
      rulesets: [{ name: "main" }],
    });

    const result = await applyRulesets(ctx, config);

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}",
      expect.objectContaining({
        owner: "acme",
        repo: "widgets",
        ruleset_id: 7,
        name: "main",
      }),
    );
    expect(result).toEqual({
      changes: [{ area: "ruleset", action: "update", target: "main" }],
      failures: [],
    });
  });

  it("DELETEs per planned deletion when pruning is enabled", async () => {
    const { ctx, config, request } = build([{ id: 1, name: "manual" }], {
      rulesets: [],
      settings: { pruneRulesets: true },
    });

    const result = await applyRulesets(ctx, config);

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
      owner: "acme",
      repo: "widgets",
      ruleset_id: 1,
    });
    expect(result).toEqual({
      changes: [{ area: "ruleset", action: "delete", target: "manual" }],
      failures: [],
    });
  });

  it("fires the create, update and delete calls per the planRulesets mapping", async () => {
    const { ctx, config, request } = build(
      [
        { id: 7, name: "kept" },
        { id: 9, name: "stale" },
      ],
      {
        rulesets: [{ name: "kept" }, { name: "fresh" }],
        settings: { pruneRulesets: true },
      },
    );

    const result = await applyRulesets(ctx, config);

    // Creates run first, then updates, then deletes: the loop order matches.
    expect(request).toHaveBeenNthCalledWith(
      1,
      "POST /repos/{owner}/{repo}/rulesets",
      expect.objectContaining({ name: "fresh" }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}",
      expect.objectContaining({ ruleset_id: 7, name: "kept" }),
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      "DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}",
      expect.objectContaining({ ruleset_id: 9 }),
    );
    expect(result).toEqual({
      changes: [
        { area: "ruleset", action: "create", target: "fresh" },
        { area: "ruleset", action: "update", target: "kept" },
        { area: "ruleset", action: "delete", target: "stale" },
      ],
      failures: [],
    });
  });

  it("folds a 403 on a write into one failure carrying the describeForbidden detail, and aborts", async () => {
    const { ctx, config, request, log } = build([], {
      rulesets: [{ name: "first" }, { name: "second" }, { name: "third" }],
    });

    request.mockImplementation(async (_route: string, params: { name?: string }) => {
      if (params.name === "second") throw httpError(403, PLAN_LIMIT_MESSAGE);
      return { data: {} };
    });

    const result = await applyRulesets(ctx, config);

    // first succeeded, second aborted the applier: third is never attempted.
    expect(request).toHaveBeenCalledTimes(2);

    // Pinned exactly: the failure message is the classified explanation, not
    // the raw GitHub message.
    const detail =
      "Cannot apply rulesets: Upgrade to GitHub Pro or make this repository " +
      "public to enable this feature. Both branch protection and rulesets " +
      "require the repository to be public, or a paid plan (Pro, Team or " +
      "Enterprise) if it is private. On the Free plan a private repository can " +
      "use neither.";

    expect(result).toEqual({
      changes: [{ area: "ruleset", action: "create", target: "first" }],
      failures: [{ area: "rulesets", message: detail }],
    });
    expect(log.error).toHaveBeenCalledWith(
      { applier: "rulesets", status: 403, err: PLAN_LIMIT_MESSAGE },
      detail,
    );
  });

  it("folds a 403 on the existing-rulesets read into a failure too", async () => {
    const { ctx, config, paginate, request, log } = build([], {
      rulesets: [{ name: "main" }],
    });
    paginate.mockRejectedValueOnce(httpError(403, "Forbidden"));

    const result = await applyRulesets(ctx, config);

    const detail =
      "Forbidden applying rulesets: Forbidden Check the App has " +
      "`administration: write`. Note also that branch protection and rulesets " +
      "are unavailable on private repositories on the Free plan.";

    expect(request).not.toHaveBeenCalled();
    expect(result).toEqual({
      changes: [],
      failures: [{ area: "rulesets", message: detail }],
    });
    expect(log.error).toHaveBeenCalledWith(
      { applier: "rulesets", status: 403, err: "Forbidden" },
      detail,
    );
  });

  it("rethrows a non-403 error out of the applier", async () => {
    const { ctx, config, request } = build([], { rulesets: [{ name: "main" }] });
    request.mockRejectedValueOnce(httpError(500, "boom"));

    await expect(applyRulesets(ctx, config)).rejects.toThrow("boom");
  });

  it("performs the read but zero writes in dry-run, still reporting the changes", async () => {
    const { ctx, config, paginate, request } = build(
      [
        { id: 7, name: "kept" },
        { id: 9, name: "stale" },
      ],
      {
        rulesets: [{ name: "kept" }, { name: "fresh" }],
        settings: { pruneRulesets: true },
      },
      true,
    );

    const result = await applyRulesets(ctx, config);

    expect(paginate).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(result.changes).toHaveLength(3);
    expect(result.failures).toEqual([]);
  });

  it("reads with the rulesets route and per_page when any ruleset work is pending", async () => {
    const { ctx, config, paginate } = build([], { rulesets: [{ name: "main" }] });

    await applyRulesets(ctx, config);

    expect(paginate).toHaveBeenCalledOnce();
    expect(paginate).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/rulesets", {
      owner: "acme",
      repo: "widgets",
      per_page: 100,
    });
  });

  it("POSTs a full ruleset body with rules, conditions and bypass actors verbatim", async () => {
    const { ctx, config, request } = build([], { rulesets: [FULL_RULESET] });

    const result = await applyRulesets(ctx, config);

    expect(request).toHaveBeenCalledOnce();
    // Deep equality on the whole body: every rule parameter survives verbatim.
    expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/rulesets", {
      owner: "acme",
      repo: "widgets",
      ...FULL_RULESET,
    });
    expect(result).toEqual({
      changes: [{ area: "ruleset", action: "create", target: "main" }],
      failures: [],
    });
  });

  it("PUTs a full ruleset body with rules, conditions and bypass actors verbatim", async () => {
    const { ctx, config, request } = build([{ id: 7, name: "main" }], {
      rulesets: [FULL_RULESET],
    });

    const result = await applyRulesets(ctx, config);

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
      owner: "acme",
      repo: "widgets",
      ruleset_id: 7,
      ...FULL_RULESET,
    });
    expect(result).toEqual({
      changes: [{ area: "ruleset", action: "update", target: "main" }],
      failures: [],
    });
  });

  it("DELETEs only the unconfigured hand-made ruleset when the configured one is claimed", async () => {
    const { ctx, config, request } = build(
      [
        { id: 7, name: "main" },
        { id: 9, name: "hotfix" },
      ],
      { rulesets: [FULL_RULESET], settings: { pruneRulesets: true } },
    );

    const result = await applyRulesets(ctx, config);

    // main is configured (PUT), hotfix is hand-made and unconfigured (DELETE).
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}",
      expect.objectContaining({ ruleset_id: 7, name: "main" }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}",
      {
        owner: "acme",
        repo: "widgets",
        ruleset_id: 9,
      },
    );
    // The configured ruleset's id is never the target of a delete.
    expect(request).not.toHaveBeenCalledWith(
      "DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}",
      expect.objectContaining({ ruleset_id: 7 }),
    );
    expect(result.changes).toContainEqual({
      area: "ruleset",
      action: "delete",
      target: "hotfix",
    });
  });
});
