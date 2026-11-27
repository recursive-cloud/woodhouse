/**
 * Step definitions for `features/environments/apply.feature`.
 *
 * Every scenario drives the real `syncSettings` orchestrator against the
 * recording octokit fake, so the cascade gate and the environments applier
 * behave exactly as they do in production. The applier does not exist yet:
 * these scenarios are the specification it must satisfy.
 */

import { expect } from "vitest";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { httpError } from "../settings-sync/octokit-fakes.js";
import {
  type EnvironmentsWorld,
  environmentsOf,
  requireSummary,
  resolvedConfig,
  resolvedFromLayers,
  runSync,
  world,
} from "./apply-world.js";
import {
  assertNoSettingsWritten,
  rejectInvalidConfig,
  skippedForInvalidConfig,
} from "./authoring-rejection.js";

const feature = await loadFeature("features/environments/apply.feature");

const PRODUCTION_WITH_REVIEWERS = `settings:
  enabled: true
environments:
  production:
    wait_timer: 10
    reviewers:
      - type: User
        id: 42
`;

const PRODUCTION_WAIT_TIMER = `settings:
  enabled: true
environments:
  production:
    wait_timer: 5
`;

const TWO_ENVIRONMENTS = `settings:
  enabled: true
environments:
  production:
    wait_timer: 5
  staging: {}
`;

const BASELINE_STAGING = `settings:
  enabled: true
environments:
  staging:
    wait_timer: 5
`;

const LOCAL_STAGING_NULL = `environments:
  staging: null
`;

const BASELINE_PRODUCTION = `settings:
  enabled: true
environments:
  production:
    wait_timer: 10
    reviewers:
      - type: User
        id: 7
`;

const LOCAL_PRODUCTION_WAIT_TIMER = `environments:
  production:
    wait_timer: 5
`;

const SLASH_ENVIRONMENT = `settings:
  enabled: true
environments:
  release/production:
    wait_timer: 3
`;

const DUPLICATE_ENVIRONMENTS = `environments:
  Prod: {}
  prod: {}
`;

/** The shared And body for the collected-failure scenarios. */
function remainingEnvironmentsApplied(w: EnvironmentsWorld): () => void {
  return () => {
    expect(w.built.createOrUpdateEnvironment).toHaveBeenCalledTimes(2);
    expect(requireSummary(w.summary).changes).toContainEqual({
      area: "environments",
      action: "update",
      target: "staging",
    });
  };
}

describeFeature(feature, ({ Scenario }) => {
  Scenario(
    `Environments declared in config are written to the repository`,
    ({ Given, When, Then, And }) => {
      const w = world();

      Given(
        `a repository configuration with the environment "production" carrying a wait timer and reviewers`,
        () => {
          w.resolved = resolvedFromLayers(undefined, PRODUCTION_WITH_REVIEWERS);
        },
      );
      When(`the settings sync runs`, runSync(w));
      Then(`the environment "production" is declared with its full protection state`, () => {
        const fake = w.built;
        expect(fake.createOrUpdateEnvironment).toHaveBeenCalledTimes(1);
        expect(fake.createOrUpdateEnvironment).toHaveBeenCalledWith(
          expect.objectContaining({
            owner: "acme",
            repo: "widgets",
            environment_name: "production",
            wait_timer: 10,
            prevent_self_review: false,
            reviewers: [{ type: "User", id: 42 }],
            deployment_branch_policy: null,
          }),
        );

        const sent = fake.createOrUpdateEnvironment.mock.calls[0]?.[0] as
          | Record<string, unknown>
          | undefined;
        expect(sent).toBeDefined();
        expect(sent).not.toHaveProperty("can_admins_bypass");
      });
      And(`the summary reports an environments update for "production"`, () => {
        expect(requireSummary(w.summary).changes).toContainEqual({
          area: "environments",
          action: "update",
          target: "production",
        });
      });
    },
  );

  Scenario(`Environments converge by re-declaration`, ({ Given, When, Then, And }) => {
    const w = world();

    Given(`a repository whose environments already match the configured environments`, () => {
      w.resolved = resolvedFromLayers(undefined, PRODUCTION_WITH_REVIEWERS);
    });
    When(`the settings sync runs`, runSync(w));
    Then(`each configured environment is re-declared with an idempotent update`, () => {
      const fake = w.built;
      // A re-declaration is a full-state PUT, never a diff: one call per configured name.
      expect(fake.createOrUpdateEnvironment).toHaveBeenCalledTimes(1);
      expect(fake.createOrUpdateEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({
          environment_name: "production",
          wait_timer: 10,
          prevent_self_review: false,
          reviewers: [{ type: "User", id: 42 }],
          deployment_branch_policy: null,
        }),
      );
    });
    And(`the summary reports an environments update for each configured environment`, () => {
      const changes = requireSummary(w.summary).changes.filter(
        (change) => change.area === "environments",
      );
      expect(changes).toEqual([{ area: "environments", action: "update", target: "production" }]);
    });
  });

  Scenario(`A removed environments entry stops the re-assertion`, ({ Given, When, Then, And }) => {
    const w = world();

    Given(`a configuration that no longer lists an environment that was previously applied`, () => {
      w.resolved = resolvedConfig({ settings: { enabled: true } });
    });
    When(`the settings sync runs`, runSync(w));
    Then(`nothing is re-asserted for that environment`, () => {
      expect(w.built.createOrUpdateEnvironment).not.toHaveBeenCalled();
      expect(w.built.calls).not.toContain("repos.createOrUpdateEnvironment");
    });
    And(`the existing environment is not deleted`, () => {
      // There is no delete path: removing the entry ends the re-assertion only.
      expect(requireSummary(w.summary).changes).toEqual([]);
    });
  });

  Scenario(
    `A local file removes an inherited environment entry with an explicit null`,
    ({ Given, When, Then }) => {
      const w = world();

      Given(`a baseline declaring the environment "staging" and a local file nulling it`, () => {
        w.resolved = resolvedFromLayers(BASELINE_STAGING, LOCAL_STAGING_NULL);
        expect(environmentsOf(w.resolved)).not.toHaveProperty("staging");
      });
      When(`the settings sync runs`, runSync(w));
      Then(`nothing is written for "staging"`, () => {
        expect(w.built.createOrUpdateEnvironment).not.toHaveBeenCalled();
        expect(requireSummary(w.summary).changes).toEqual([]);
      });
    },
  );

  Scenario(
    `An unset environments section performs no environment writes`,
    ({ Given, When, Then, And }) => {
      const w = world();

      Given(`a configuration with no environments section`, () => {
        w.resolved = resolvedConfig({ settings: { enabled: true } });
        expect(environmentsOf(w.resolved)).toEqual({});
      });
      When(`the settings sync runs`, runSync(w));
      Then(`no environment is declared`, () => {
        expect(w.built.createOrUpdateEnvironment).not.toHaveBeenCalled();
      });
      And(`the existing environments are left untouched`, () => {
        // No reads, no writes: an unset section is entirely out of scope.
        expect(w.built.getAllEnvironments).not.toHaveBeenCalled();
        expect(requireSummary(w.summary).changes).toEqual([]);
      });
    },
  );

  Scenario(
    `A local file overrides one environment's wait timer without restating the baseline's reviewers`,
    ({ Given, When, Then }) => {
      const w = world();

      Given(
        `a baseline declaring the environment "production" with reviewers and a local file overriding only its wait timer`,
        () => {
          w.resolved = resolvedFromLayers(BASELINE_PRODUCTION, LOCAL_PRODUCTION_WAIT_TIMER);
        },
      );
      When(`the settings sync runs`, runSync(w));
      Then(
        `the environment "production" is declared with the overridden wait timer and the inherited reviewers`,
        () => {
          expect(w.built.createOrUpdateEnvironment).toHaveBeenCalledWith(
            expect.objectContaining({
              environment_name: "production",
              wait_timer: 5,
              reviewers: [{ type: "User", id: 7 }],
            }),
          );
        },
      );
    },
  );

  Scenario(
    `Environment names colliding only in case are rejected at authoring time`,
    ({ Given, When, Then, And }) => {
      const w = world();

      Given(`a configuration declaring the environments "Prod" and "prod"`, () => {
        rejectInvalidConfig(w, DUPLICATE_ENVIRONMENTS, "duplicate environment name");
      });
      When(`the settings sync runs`, runSync(w));
      Then(`no settings are written`, () => {
        assertNoSettingsWritten(w);
      });
      And(`the sync is skipped because "invalid-config"`, skippedForInvalidConfig(w));
    },
  );

  Scenario(
    `A slash in an environment name is passed verbatim as one name`,
    ({ Given, When, Then }) => {
      const w = world();

      Given(`a repository configuration with the environment "release/production"`, () => {
        w.resolved = resolvedFromLayers(undefined, SLASH_ENVIRONMENT);
      });
      When(`the settings sync runs`, runSync(w));
      Then(
        `the environment "release/production" is declared with its full protection state`,
        () => {
          const fake = w.built;
          // One name, one call: the slash is not a path separator.
          expect(fake.createOrUpdateEnvironment).toHaveBeenCalledTimes(1);
          expect(fake.createOrUpdateEnvironment).toHaveBeenCalledWith(
            expect.objectContaining({
              environment_name: "release/production",
              wait_timer: 3,
              prevent_self_review: false,
              reviewers: null,
              deployment_branch_policy: null,
            }),
          );
        },
      );
    },
  );

  Scenario(
    `A plan-restricted environment write is reported as a collected failure`,
    ({ Given, When, Then, And }) => {
      const w = world();

      Given(`an environment write the repository's plan does not support`, () => {
        w.resolved = resolvedFromLayers(undefined, TWO_ENVIRONMENTS);
        // GitHub hides the endpoint on plans without environments, so a write 404s.
        w.built.createOrUpdateEnvironment.mockRejectedValueOnce(httpError(404, "Not Found"));
      });
      When(`the settings sync runs`, runSync(w));
      Then(`the summary reports the environments failure naming the plan limit`, () => {
        const summary = requireSummary(w.summary);
        expect(summary.failures).toHaveLength(1);
        const [failure] = summary.failures;
        expect(failure?.area).toBe("environments");
        expect(failure?.message).toMatch(/plan|public repositor|upgrade/i);
      });
      And(
        `the remaining configured environments are still applied`,
        remainingEnvironmentsApplied(w),
      );
    },
  );

  Scenario(
    `A forbidden environment write is reported with the forbidden detail`,
    ({ Given, When, Then, And }) => {
      const w = world();

      Given(`an environment write the installation is not permitted to perform`, () => {
        w.resolved = resolvedFromLayers(undefined, TWO_ENVIRONMENTS);
        w.built.createOrUpdateEnvironment.mockRejectedValueOnce(
          httpError(403, "Resource not accessible by integration"),
        );
      });
      When(`the settings sync runs`, runSync(w));
      Then(`the summary reports the environments failure with the forbidden detail`, () => {
        const summary = requireSummary(w.summary);
        expect(summary.failures).toHaveLength(1);
        const [failure] = summary.failures;
        expect(failure?.area).toBe("environments");
        expect(failure?.message).toContain("Forbidden applying environments");
        expect(failure?.message).toContain("administration: write");
      });
      And(
        `the remaining configured environments are still applied`,
        remainingEnvironmentsApplied(w),
      );
    },
  );

  Scenario(`Dry run declares environments without writing`, ({ Given, When, Then, And }) => {
    const w = world({ dryRun: true });

    Given(`dry run mode`, () => {
      w.resolved = resolvedFromLayers(undefined, PRODUCTION_WAIT_TIMER);
      expect(w.ctx.dryRun).toBe(true);
    });
    When(`the settings sync runs`, runSync(w));
    Then(`no environment write is performed`, () => {
      expect(w.built.createOrUpdateEnvironment).not.toHaveBeenCalled();
    });
    And(`the summary reports the environments changes as would-apply`, () => {
      const summary = requireSummary(w.summary);
      expect(summary.dryRun).toBe(true);
      expect(summary.changes).toContainEqual({
        area: "environments",
        action: "update",
        target: "production",
      });
    });
  });
});
