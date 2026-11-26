/**
 * Step definitions for `features/environments/branch-policies.feature`.
 *
 * Every scenario drives the real `syncSettings` orchestrator against the
 * recording octokit fake, so the cascade gate and the environments applier
 * behave exactly as they do in production. The branch-policy support does not
 * exist yet: these scenarios are the specification it must satisfy.
 */

import { expect, type TaskContext } from "vitest";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { syncSettings } from "../../src/settings/apply.js";
import {
  type EnvironmentsWorld,
  requireResolved,
  requireSummary,
  resolvedFromLayers,
  world,
} from "./apply-world.js";

const feature = await loadFeature("features/environments/branch-policies.feature");

/**
 * Build one environment's YAML. `mode` null marks the authoring fixtures that
 * must be rejected for their patterns alone, so those omit the settings block
 * and cannot be skipped by the kill switch instead of validation.
 */
function environmentsYaml(
  environment: string,
  mode: "custom" | null,
  policies?: readonly string[],
): string {
  const lines = ["environments:", `  ${environment}:`];

  if (mode === "custom") {
    lines.push("    deployment_branch_policy: custom");
  }
  if (policies !== undefined) {
    lines.push("    branch_policies:");
    for (const policy of policies) {
      lines.push(`      - ${policy}`);
    }
  }

  const settings = mode === null ? "" : "settings:\n  enabled: true\n";
  return `${settings}${lines.join("\n")}\n`;
}

/** The shared When body: run the real orchestrator into the world's summary slot. */
function runSync(w: EnvironmentsWorld): () => Promise<void> {
  return async () => {
    w.summary = await syncSettings(w.ctx, requireResolved(w.resolved));
  };
}

/** The shared And body for the authoring-rejection scenarios. */
function skippedForInvalidConfig(w: EnvironmentsWorld): () => void {
  return () => {
    expect(w.log.debug).toHaveBeenCalledWith({ reason: "invalid-config" }, "Settings sync skipped");
  };
}

/** The branch-policy ids a fake delete was called with. */
function deletedBranchPolicyIds(w: EnvironmentsWorld): number[] {
  return w.built.deleteDeploymentBranchPolicy.mock.calls.map(
    (call) => (call[0] as { branch_policy_id: number }).branch_policy_id,
  );
}

describeFeature(feature, ({ Scenario }) => {
  Scenario(`Custom branch patterns are created`, ({ Given, When, Then, And }) => {
    const w = world();

    Given(
      `the environment {string} in custom branch policy mode declaring the patterns {string} and {string}`,
      (_ctx: TaskContext, environment: string, first: string, second: string) => {
        w.resolved = resolvedFromLayers(
          undefined,
          environmentsYaml(environment, "custom", [first, second]),
        );
      },
    );
    When(`the settings sync runs`, runSync(w));
    Then(`both patterns are declared on the environment`, () => {
      const fake = w.built;
      expect(fake.createDeploymentBranchPolicy).toHaveBeenCalledTimes(2);
      expect(fake.createDeploymentBranchPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ name: "main", environment_name: "production" }),
      );
      expect(fake.createDeploymentBranchPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ name: "release/*", environment_name: "production" }),
      );
    });
    And(`the summary names the environment and pattern for each branch-policy change`, () => {
      expect(requireSummary(w.summary).changes).toContainEqual({
        area: "environments",
        action: "create",
        target: "production: main",
      });
      expect(requireSummary(w.summary).changes).toContainEqual({
        area: "environments",
        action: "create",
        target: "production: release/*",
      });
    });
  });

  Scenario(
    `A pattern removed from config is deleted from the environment`,
    ({ Given, When, Then, And }) => {
      const w = world({
        branchPolicies: [
          { id: 1, name: "keep-a", environment: "production" },
          { id: 2, name: "keep-b", environment: "production" },
          { id: 3, name: "gone", environment: "production" },
        ],
      });

      Given(
        `the environment {string} with a configured pattern that was previously applied and a pattern now removed from its list`,
        (_ctx: TaskContext, environment: string) => {
          w.resolved = resolvedFromLayers(
            undefined,
            environmentsYaml(environment, "custom", ["keep-a", "keep-b"]),
          );
        },
      );
      When(`the settings sync runs`, runSync(w));
      Then(`the removed pattern is deleted from the environment`, () => {
        const fake = w.built;
        expect(fake.deleteDeploymentBranchPolicy).toHaveBeenCalledTimes(1);
        expect(fake.deleteDeploymentBranchPolicy).toHaveBeenCalledWith(
          expect.objectContaining({
            environment_name: "production",
            branch_policy_id: 3,
          }),
        );
        expect(fake.createDeploymentBranchPolicy).not.toHaveBeenCalled();
      });
      And(`the remaining configured patterns are kept`, () => {
        const names = w.built.branchPolicyStore().map((policy) => policy.name);
        expect(names).toEqual(expect.arrayContaining(["keep-a", "keep-b"]));
        expect(deletedBranchPolicyIds(w)).not.toContain(1);
        expect(deletedBranchPolicyIds(w)).not.toContain(2);
      });
    },
  );

  Scenario(
    `Declaring a pattern the environment already has is not an error`,
    ({ Given, When, Then, And }) => {
      const w = world({
        branchPolicies: [
          { id: 1, name: "main", environment: "production" },
          { id: 2, name: "release/*", environment: "production" },
        ],
      });

      Given(
        `the environment {string} in custom mode whose patterns already match the configuration`,
        (_ctx: TaskContext, environment: string) => {
          w.resolved = resolvedFromLayers(
            undefined,
            environmentsYaml(environment, "custom", ["main", "release/*"]),
          );
        },
      );
      When(`the settings sync runs`, runSync(w));
      Then(`each configured pattern is present on the environment`, () => {
        const fake = w.built;
        expect(fake.listDeploymentBranchPolicies).toHaveBeenCalledWith(
          expect.objectContaining({ environment_name: "production" }),
        );
        expect(fake.createDeploymentBranchPolicy).not.toHaveBeenCalled();
        expect(fake.deleteDeploymentBranchPolicy).not.toHaveBeenCalled();
        const names = fake.branchPolicyStore().map((policy) => policy.name);
        expect(names).toEqual(expect.arrayContaining(["main", "release/*"]));
      });
      And(`no error is reported`, () => {
        expect(requireSummary(w.summary).failures).toEqual([]);
      });
    },
  );

  Scenario(
    `Switching an environment to custom mode re-declares its patterns`,
    ({ Given, When, Then, And }) => {
      const w = world();

      Given(
        `the environment {string} switching from protected-branch mode to custom branch policies with declared patterns`,
        (_ctx: TaskContext, environment: string) => {
          w.resolved = resolvedFromLayers(
            undefined,
            environmentsYaml(environment, "custom", ["deploy"]),
          );
        },
      );
      When(`the settings sync runs`, runSync(w));
      Then(`the environment's deployment branch policy is set to custom mode`, () => {
        expect(w.built.createOrUpdateEnvironment).toHaveBeenCalledWith(
          expect.objectContaining({
            environment_name: "production",
            deployment_branch_policy: {
              protected_branches: false,
              custom_branch_policies: true,
            },
          }),
        );
      });
      And(`the declared patterns are present on the environment`, () => {
        expect(w.built.createDeploymentBranchPolicy).toHaveBeenCalledWith(
          expect.objectContaining({ name: "deploy", environment_name: "production" }),
        );
        const names = w.built.branchPolicyStore().map((policy) => policy.name);
        expect(names).toContain("deploy");
      });
    },
  );

  Scenario(
    `Patterns declared without custom mode are rejected at authoring time`,
    ({ Given, When, Then, And }) => {
      const w = world();

      Given(
        `the environment {string} declaring patterns without selecting custom branch policies`,
        (_ctx: TaskContext, environment: string) => {
          w.resolved = resolvedFromLayers(undefined, environmentsYaml(environment, null, ["main"]));
          const resolved = requireResolved(w.resolved);
          expect(resolved.issues.length).toBeGreaterThan(0);
          expect(resolved.issues.map((issue) => issue.message).join("\n")).toContain(
            `requires deployment_branch_policy "custom"`,
          );
        },
      );
      When(`the settings sync runs`, runSync(w));
      Then(`no settings are written`, () => {
        expect(requireSummary(w.summary)).toEqual({
          changes: [],
          failures: [],
          dryRun: false,
        });
        expect(w.built.calls).toEqual([]);
      });
      And(`the sync is skipped because "invalid-config"`, skippedForInvalidConfig(w));
    },
  );

  Scenario(
    `Custom mode with no patterns converges to an empty allowlist`,
    ({ Given, When, Then, And }) => {
      const w = world({
        branchPolicies: [{ id: 9, name: "stale", environment: "production" }],
      });

      Given(
        `the environment {string} in custom branch policy mode declaring no patterns`,
        (_ctx: TaskContext, environment: string) => {
          w.resolved = resolvedFromLayers(undefined, environmentsYaml(environment, "custom"));
        },
      );
      When(`the settings sync runs`, runSync(w));
      Then(`no pattern is created`, () => {
        expect(w.built.createDeploymentBranchPolicy).not.toHaveBeenCalled();
      });
      And(`patterns present on the environment but absent from config are removed`, () => {
        expect(w.built.deleteDeploymentBranchPolicy).toHaveBeenCalledTimes(1);
        expect(w.built.deleteDeploymentBranchPolicy).toHaveBeenCalledWith(
          expect.objectContaining({ environment_name: "production", branch_policy_id: 9 }),
        );
        const names = w.built.branchPolicyStore().map((policy) => policy.name);
        expect(names).not.toContain("stale");
      });
    },
  );

  Scenario(
    `Pattern lists colliding only in case are rejected at authoring time`,
    ({ Given, When, Then, And }) => {
      const w = world();

      Given(
        `the environment {string} declaring the patterns {string} and {string}`,
        (_ctx: TaskContext, environment: string, first: string, second: string) => {
          w.resolved = resolvedFromLayers(
            undefined,
            environmentsYaml(environment, null, [first, second]),
          );
          const resolved = requireResolved(w.resolved);
          expect(resolved.issues.length).toBeGreaterThan(0);
          expect(resolved.issues.map((issue) => issue.message).join("\n")).toContain(
            "duplicate branch policy pattern",
          );
        },
      );
      When(`the settings sync runs`, runSync(w));
      Then(`no settings are written`, () => {
        expect(requireSummary(w.summary)).toEqual({
          changes: [],
          failures: [],
          dryRun: false,
        });
        expect(w.built.calls).toEqual([]);
      });
      And(`the sync is skipped because "invalid-config"`, skippedForInvalidConfig(w));
    },
  );
});
