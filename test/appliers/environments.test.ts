import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { applyEnvironments } from "../../src/settings/appliers/environments.js";
import type { ApplierContext } from "../../src/settings/appliers/types.js";
import { planLimitDetail } from "../../src/settings/forbidden.js";
import { woodhouseConfigSchema } from "../../src/config/schema.js";

/** GitHub's real 422 wording for a plan-restricted protected-branch rule. */
const BILLING_PLAN_422 =
  "Fail to create protected rule, please ensure billing plan include protected branch gate";

/** One deployment branch policy as the fake lists it. */
interface FakeBranchPolicy {
  readonly id: number;
  readonly name: string;
}

interface FakeOctokitOptions {
  readonly branchPolicies?: readonly FakeBranchPolicy[];
}

/**
 * Fake octokit covering only the environments surface this applier touches.
 * Every call is recorded so the tests can assert the write payload and the
 * plan-to-call mapping without reaching for the network. The branch-policy
 * listing returns the configured seed; individual tests override the create
 * and delete results when they need a failure or an already-exists response.
 */
function fakeOctokit(options: FakeOctokitOptions = {}) {
  const branchPolicies = options.branchPolicies ?? [];

  const createOrUpdateEnvironment = vi.fn(async () => ({ data: {} }));
  const listDeploymentBranchPolicies = vi.fn(async () => ({
    data: { total_count: branchPolicies.length, branch_policies: branchPolicies },
  }));
  const createDeploymentBranchPolicy = vi.fn(async () => ({ data: {} }));
  const deleteDeploymentBranchPolicy = vi.fn(async () => ({ data: {} }));

  const octokit = {
    repos: {
      createOrUpdateEnvironment,
      listDeploymentBranchPolicies,
      createDeploymentBranchPolicy,
      deleteDeploymentBranchPolicy,
    },
  } as unknown as ApplierContext["octokit"];

  return {
    octokit,
    createOrUpdateEnvironment,
    listDeploymentBranchPolicies,
    createDeploymentBranchPolicy,
    deleteDeploymentBranchPolicy,
  };
}

function fakeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function build(
  configInput: Record<string, unknown> = {},
  dryRun = false,
  options: FakeOctokitOptions = {},
) {
  const fake = fakeOctokit(options);
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

describe("applyEnvironments", () => {
  it("maps a 404 to the plan-limit failure", async () => {
    const { ctx, config, createOrUpdateEnvironment } = build({
      environments: { production: {} },
    });
    createOrUpdateEnvironment.mockRejectedValueOnce(httpError(404, "Not Found"));

    const result = await applyEnvironments(ctx, config);

    expect(result.failures).toEqual([
      { area: "environments", message: planLimitDetail("environments") },
    ]);
  });

  it("maps a 422 whose message names the billing plan to the same plan-limit failure", async () => {
    const { ctx, config, createOrUpdateEnvironment } = build({
      environments: { production: {} },
    });
    createOrUpdateEnvironment.mockRejectedValueOnce(httpError(422, BILLING_PLAN_422));

    const result = await applyEnvironments(ctx, config);

    expect(result.failures).toEqual([
      { area: "environments", message: planLimitDetail("environments") },
    ]);
  });

  it("collects a non-plan 422 as the raw message", async () => {
    const { ctx, config, createOrUpdateEnvironment } = build({
      environments: { production: {} },
    });
    createOrUpdateEnvironment.mockRejectedValueOnce(httpError(422, "Validation Failed"));

    const result = await applyEnvironments(ctx, config);

    expect(result.failures).toEqual([{ area: "environments", message: "Validation Failed" }]);
    expect(result.failures[0]?.message).not.toContain("Cannot apply environments");
  });

  it("explains a 403 with the forbidden detail naming the required permission", async () => {
    const { ctx, config, createOrUpdateEnvironment } = build({
      environments: { production: {} },
    });
    createOrUpdateEnvironment.mockRejectedValueOnce(
      httpError(403, "Resource not accessible by integration"),
    );

    const result = await applyEnvironments(ctx, config);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.message).toContain("Forbidden applying environments:");
    expect(result.failures[0]?.message).toContain("administration: write");
  });

  it("keeps applying after a failure: the second environment survives", async () => {
    const { ctx, config, createOrUpdateEnvironment } = build({
      environments: { alpha: {}, beta: {} },
    });
    createOrUpdateEnvironment.mockImplementation(
      async ({ environment_name }: { environment_name: string }) => {
        if (environment_name === "alpha") throw httpError(403, "Resource not accessible");
        return { data: {} };
      },
    );

    const result = await applyEnvironments(ctx, config);

    expect(createOrUpdateEnvironment).toHaveBeenCalledTimes(2);
    expect(result.changes).toEqual([{ area: "environments", action: "update", target: "beta" }]);
    expect(result.failures).toHaveLength(1);
  });

  it("skips an explicit null entry and writes nothing for it", async () => {
    const { ctx, config, createOrUpdateEnvironment } = build({
      environments: { staging: null, production: { wait_timer: 5 } },
    });

    const result = await applyEnvironments(ctx, config);

    expect(createOrUpdateEnvironment).toHaveBeenCalledTimes(1);
    expect(createOrUpdateEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ environment_name: "production", wait_timer: 5 }),
    );
    expect(result.changes).toEqual([
      { area: "environments", action: "update", target: "production" },
    ]);
    expect(result.changes.some((change) => change.target === "staging")).toBe(false);
  });

  it("sends the API defaults for a bare entry and omits can_admins_bypass", async () => {
    const { ctx, config, createOrUpdateEnvironment } = build({
      environments: { production: {} },
    });

    await applyEnvironments(ctx, config);

    expect(createOrUpdateEnvironment).toHaveBeenCalledTimes(1);
    expect(createOrUpdateEnvironment).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        owner: "acme",
        repo: "widgets",
        environment_name: "production",
        wait_timer: 0,
        prevent_self_review: false,
        reviewers: null,
        deployment_branch_policy: null,
      }),
    );

    const sent = createOrUpdateEnvironment.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("can_admins_bypass");
  });

  it("sends can_admins_bypass when it is set", async () => {
    const { ctx, config, createOrUpdateEnvironment } = build({
      environments: { production: { can_admins_bypass: true } },
    });

    await applyEnvironments(ctx, config);

    expect(createOrUpdateEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ environment_name: "production", can_admins_bypass: true }),
    );
  });

  it("maps custom mode to custom_branch_policies on the PUT", async () => {
    const { ctx, config, createOrUpdateEnvironment } = build({
      environments: { production: { deployment_branch_policy: "custom" } },
    });

    await applyEnvironments(ctx, config);

    expect(createOrUpdateEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        environment_name: "production",
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      }),
    );
  });

  it("maps protected mode to protected_branches on the PUT", async () => {
    const { ctx, config, createOrUpdateEnvironment } = build({
      environments: { production: { deployment_branch_policy: "protected" } },
    });

    await applyEnvironments(ctx, config);

    expect(createOrUpdateEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        environment_name: "production",
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      }),
    );
  });

  it("sends a null deployment_branch_policy when no mode is configured", async () => {
    const { ctx, config, createOrUpdateEnvironment } = build({
      environments: { production: {} },
    });

    await applyEnvironments(ctx, config);

    const sent = createOrUpdateEnvironment.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toHaveProperty("deployment_branch_policy", null);
  });

  it("creates the configured patterns that the environment lacks", async () => {
    const { ctx, config, createDeploymentBranchPolicy, deleteDeploymentBranchPolicy } = build({
      environments: {
        production: { deployment_branch_policy: "custom", branch_policies: ["main", "release/*"] },
      },
    });

    const result = await applyEnvironments(ctx, config);

    expect(createDeploymentBranchPolicy).toHaveBeenCalledTimes(2);
    expect(createDeploymentBranchPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "widgets",
        environment_name: "production",
        name: "main",
      }),
    );
    expect(createDeploymentBranchPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "widgets",
        environment_name: "production",
        name: "release/*",
      }),
    );
    expect(deleteDeploymentBranchPolicy).not.toHaveBeenCalled();
    expect(result.changes).toEqual([
      { area: "environments", action: "update", target: "production" },
      { area: "environments", action: "create", target: "production: main" },
      { area: "environments", action: "create", target: "production: release/*" },
    ]);
    expect(result.failures).toEqual([]);
  });

  it("deletes the patterns absent from the configured list", async () => {
    const { ctx, config, createDeploymentBranchPolicy, deleteDeploymentBranchPolicy } = build(
      {
        environments: {
          production: { deployment_branch_policy: "custom", branch_policies: ["keep"] },
        },
      },
      false,
      {
        branchPolicies: [
          { id: 1, name: "keep" },
          { id: 2, name: "gone" },
        ],
      },
    );

    const result = await applyEnvironments(ctx, config);

    expect(createDeploymentBranchPolicy).not.toHaveBeenCalled();
    expect(deleteDeploymentBranchPolicy).toHaveBeenCalledTimes(1);
    expect(deleteDeploymentBranchPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ environment_name: "production", branch_policy_id: 2 }),
    );
    expect(result.changes).toEqual([
      { area: "environments", action: "update", target: "production" },
      { area: "environments", action: "delete", target: "production: gone" },
    ]);
    expect(result.failures).toEqual([]);
  });

  it("converges custom mode with no branch_policies key to an empty allowlist", async () => {
    const { ctx, config, createDeploymentBranchPolicy, deleteDeploymentBranchPolicy } = build(
      {
        environments: { production: { deployment_branch_policy: "custom" } },
      },
      false,
      { branchPolicies: [{ id: 9, name: "stale" }] },
    );

    await applyEnvironments(ctx, config);

    expect(createDeploymentBranchPolicy).not.toHaveBeenCalled();
    expect(deleteDeploymentBranchPolicy).toHaveBeenCalledTimes(1);
    expect(deleteDeploymentBranchPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ environment_name: "production", branch_policy_id: 9 }),
    );
  });

  it("treats an already-exists create response as a recorded change, not a failure", async () => {
    const { ctx, config, createDeploymentBranchPolicy } = build({
      environments: {
        production: { deployment_branch_policy: "custom", branch_policies: ["main"] },
      },
    });
    createDeploymentBranchPolicy.mockResolvedValueOnce({ status: 303, data: {} });

    const result = await applyEnvironments(ctx, config);

    expect(result.changes).toContainEqual({
      area: "environments",
      action: "create",
      target: "production: main",
    });
    expect(result.failures).toEqual([]);
  });

  it("collects a pattern failure and still applies the other environments", async () => {
    const { ctx, config, createOrUpdateEnvironment, createDeploymentBranchPolicy } = build({
      environments: {
        production: {
          deployment_branch_policy: "custom",
          branch_policies: ["main", "release/*"],
        },
        staging: {},
      },
    });
    createDeploymentBranchPolicy.mockRejectedValueOnce(httpError(422, "Validation Failed"));

    const result = await applyEnvironments(ctx, config);

    expect(createDeploymentBranchPolicy).toHaveBeenCalledTimes(1);
    expect(createOrUpdateEnvironment).toHaveBeenCalledTimes(2);
    expect(result.failures).toEqual([
      { area: "environments", message: "production: main: Validation Failed" },
    ]);
    expect(result.changes).toContainEqual({
      area: "environments",
      action: "update",
      target: "staging",
    });
  });

  it("keeps the status when a pattern failure is labelled with its environment", async () => {
    const { ctx, config, createDeploymentBranchPolicy } = build({
      environments: {
        production: { deployment_branch_policy: "custom", branch_policies: ["main"] },
      },
    });
    createDeploymentBranchPolicy.mockRejectedValueOnce(
      httpError(403, "Resource not accessible by integration"),
    );

    const result = await applyEnvironments(ctx, config);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.message).toContain("Forbidden applying environments:");
    expect(result.failures[0]?.message).toContain("production: main:");
    expect(result.failures[0]?.message).toContain("administration: write");
  });

  it("records branch-policy changes in dry-run without calling the write endpoints", async () => {
    const {
      ctx,
      config,
      listDeploymentBranchPolicies,
      createDeploymentBranchPolicy,
      deleteDeploymentBranchPolicy,
    } = build(
      {
        environments: {
          production: {
            deployment_branch_policy: "custom",
            branch_policies: ["main", "release/*"],
          },
        },
      },
      true,
      { branchPolicies: [{ id: 2, name: "gone" }] },
    );

    const result = await applyEnvironments(ctx, config);

    expect(listDeploymentBranchPolicies).toHaveBeenCalledTimes(1);
    expect(createDeploymentBranchPolicy).not.toHaveBeenCalled();
    expect(deleteDeploymentBranchPolicy).not.toHaveBeenCalled();
    expect(result.changes).toEqual([
      { area: "environments", action: "update", target: "production" },
      { area: "environments", action: "create", target: "production: main" },
      { area: "environments", action: "create", target: "production: release/*" },
      { area: "environments", action: "delete", target: "production: gone" },
    ]);
    expect(result.failures).toEqual([]);
  });
});
