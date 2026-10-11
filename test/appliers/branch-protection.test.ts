import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { applyBranchProtection } from "../../src/settings/appliers/branch-protection.js";
import type { ApplierContext } from "../../src/settings/appliers/types.js";
import { woodhouseConfigSchema } from "../../src/config/schema.js";

/** GitHub's own wording for the Free-plan/private-repo case. */
const PLAN_LIMIT_MESSAGE =
  "Upgrade to GitHub Pro or make this repository public to enable this feature.";

/**
 * Fake octokit covering only the branch protection surface this applier
 * touches. Every call is recorded so the tests can assert the plan-to-call
 * mapping without reaching for the network.
 */
function fakeOctokit() {
  const updateBranchProtection = vi.fn(async () => ({ data: {} }));

  const octokit = {
    repos: { updateBranchProtection },
  } as unknown as ApplierContext["octokit"];

  return { octokit, updateBranchProtection };
}

function fakeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function build(configInput: Record<string, unknown> = {}, dryRun = false) {
  const fake = fakeOctokit();
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

/** An error shaped like an Octokit request failure. */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("applyBranchProtection", () => {
  it("PUTs once per planned protection entry, with the required null fields", async () => {
    const { ctx, config, updateBranchProtection } = build({
      branchProtection: {
        main: {
          required_status_checks: { strict: true, contexts: ["ci"] },
          enforce_admins: true,
          required_pull_request_reviews: null,
          required_linear_history: true,
        },
        release: {},
      },
    });

    const result = await applyBranchProtection(ctx, config);

    expect(updateBranchProtection).toHaveBeenCalledTimes(2);

    expect(updateBranchProtection).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        owner: "acme",
        repo: "widgets",
        branch: "main",
        required_status_checks: { strict: true, contexts: ["ci"] },
        enforce_admins: true,
        required_pull_request_reviews: null,
        restrictions: null,
        required_linear_history: true,
      }),
    );

    // Absent optional fields become explicit nulls (GitHub requires them) and
    // the conditional spreads stay out of the payload.
    expect(updateBranchProtection).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        owner: "acme",
        repo: "widgets",
        branch: "release",
        required_status_checks: null,
        enforce_admins: null,
        required_pull_request_reviews: null,
        restrictions: null,
      }),
    );
    const secondPayload = updateBranchProtection.mock.calls[1]![0] as Record<string, unknown>;
    expect(secondPayload).not.toHaveProperty("required_linear_history");

    expect(result).toEqual({
      changes: [
        { area: "branch-protection", action: "update", target: "main" },
        { area: "branch-protection", action: "update", target: "release" },
      ],
      failures: [],
    });
  });

  it("folds a 403 into one failure carrying the describeForbidden detail, and aborts", async () => {
    const { ctx, config, updateBranchProtection, log } = build({
      branchProtection: { main: {}, release: {}, hotfix: {} },
    });

    updateBranchProtection.mockImplementation(async ({ branch }: { branch: string }) => {
      if (branch === "release") throw httpError(403, PLAN_LIMIT_MESSAGE);
      return { data: {} };
    });

    const result = await applyBranchProtection(ctx, config);

    // main succeeded, release aborted the applier: hotfix is never attempted.
    expect(updateBranchProtection).toHaveBeenCalledTimes(2);

    // Pinned exactly: the deliberate D1 change is that the failure message is
    // the classified explanation, not the raw GitHub message.
    const detail =
      "Cannot apply branch-protection: Upgrade to GitHub Pro or make this " +
      "repository public to enable this feature. Both branch protection and " +
      "rulesets require the repository to be public, or a paid plan (Pro, Team " +
      "or Enterprise) if it is private. On the Free plan a private repository " +
      "can use neither.";

    expect(result).toEqual({
      changes: [{ area: "branch-protection", action: "update", target: "main" }],
      failures: [{ area: "branch-protection", message: detail }],
    });
    expect(log.error).toHaveBeenCalledWith(
      { applier: "branch-protection", status: 403, err: PLAN_LIMIT_MESSAGE },
      detail,
    );
  });

  it("skips a 404 (branch does not exist) and keeps going", async () => {
    const { ctx, config, updateBranchProtection, log } = build({
      branchProtection: { main: {}, release: {} },
    });

    updateBranchProtection.mockImplementation(async ({ branch }: { branch: string }) => {
      if (branch === "main") throw httpError(404, "Branch not found");
      return { data: {} };
    });

    const result = await applyBranchProtection(ctx, config);

    expect(updateBranchProtection).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      changes: [{ area: "branch-protection", action: "update", target: "release" }],
      failures: [],
    });
    expect(log.debug).toHaveBeenCalledWith(
      { branch: "main" },
      "Branch does not exist; skipping protection",
    );
  });

  it("rethrows a non-403, non-404 error out of the applier", async () => {
    const { ctx, config, updateBranchProtection } = build({
      branchProtection: { main: {} },
    });
    updateBranchProtection.mockRejectedValueOnce(httpError(500, "boom"));

    await expect(applyBranchProtection(ctx, config)).rejects.toThrow("boom");
  });

  it("performs zero writes in dry-run but still reports the changes", async () => {
    const { ctx, config, updateBranchProtection } = build(
      { branchProtection: { main: {}, release: {} } },
      true,
    );

    const result = await applyBranchProtection(ctx, config);

    expect(updateBranchProtection).not.toHaveBeenCalled();
    expect(result.changes).toHaveLength(2);
    expect(result.failures).toEqual([]);
  });

  it("makes no calls and returns nothing when no branches are configured", async () => {
    const { ctx, config, updateBranchProtection } = build({});

    const result = await applyBranchProtection(ctx, config);

    expect(updateBranchProtection).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], failures: [] });
  });
});
