import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { applyEnvironments } from "../../src/settings/appliers/environments.js";
import type { ApplierContext } from "../../src/settings/appliers/types.js";
import { planLimitDetail } from "../../src/settings/forbidden.js";
import { woodhouseConfigSchema } from "../../src/config/schema.js";

/** GitHub's real 422 wording for a plan-restricted protected-branch rule. */
const BILLING_PLAN_422 =
  "Fail to create protected rule, please ensure billing plan include protected branch gate";

/**
 * Fake octokit covering only the environments surface this applier touches.
 * Every call is recorded so the tests can assert the write payload and the
 * plan-to-call mapping without reaching for the network.
 */
function fakeOctokit() {
  const createOrUpdateEnvironment = vi.fn(async () => ({ data: {} }));

  const octokit = {
    repos: { createOrUpdateEnvironment },
  } as unknown as ApplierContext["octokit"];

  return { octokit, createOrUpdateEnvironment };
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
});
