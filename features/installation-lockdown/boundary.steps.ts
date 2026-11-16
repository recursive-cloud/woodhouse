import { expect } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { Allowlist, resolveOwner } from "../../src/security/allowlist.js";
import type { AllowlistDecision } from "../../src/security/allowlist.js";
import { resolveDefinitions } from "../../src/apps/registry.js";
import type { AppDefinition, RegistryDefaults } from "../../src/apps/registry.js";
import { ConfigurationError, parseAllowedTargets } from "../../src/lib/env.js";

const feature = await loadFeature("features/installation-lockdown/boundary.feature");

const PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nfoo\n-----END RSA PRIVATE KEY-----";

type ScenarioVariables = Record<string, unknown>;

/** Read one Examples cell. A missing cell is a malformed scenario, not a value to guess. */
function readCell(variables: ScenarioVariables, key: string): string {
  const value = variables[key];
  if (typeof value !== "string") {
    throw new Error(`Scenario outline row is missing a string "${key}" cell.`);
  }
  return value;
}

/** Global defaults for a registry test; `undefined` means no global allowlist. */
function registryDefaults(
  allowedInstallationTargets: readonly string[] | undefined,
): RegistryDefaults {
  return {
    allowedInstallationTargets,
    baselineRepo: "homelab-org/baseline",
    dryRun: false,
  };
}

/** Fail the step unless startup was refused with a ConfigurationError. */
function configurationMessage(captured: unknown): string {
  expect(captured).toBeInstanceOf(ConfigurationError);
  if (!(captured instanceof ConfigurationError)) {
    throw new Error("Startup did not fail with a ConfigurationError.");
  }
  return captured.message;
}

/** Decode a `<value>` cell that the feature writes as a JSON string array. */
function parseStringArrayCell(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`The target list cell is not JSON: ${JSON.stringify(value)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`The target list cell is not a JSON array: ${JSON.stringify(value)}`);
  }
  const entries: unknown[] = parsed;
  if (entries.some((entry) => typeof entry !== "string")) {
    throw new Error(`The target list cell is not an array of strings: ${JSON.stringify(value)}`);
  }
  return entries as string[];
}

describeFeature(feature, ({ ScenarioOutline, Scenario }) => {
  Scenario(`Installation event without a repository`, ({ Given, When, Then, And }) => {
    let payload: unknown;
    let list: Allowlist | undefined;
    let decision: AllowlistDecision | undefined;

    Given(`an allowlist containing "homelab-org"`, () => {
      list = new Allowlist(["homelab-org"]);
      expect(list.size).toBe(1);
    });
    And(`a webhook payload with installation account "homelab-org" and no repository`, () => {
      payload = { installation: { account: { login: "homelab-org" } } };
      expect(payload).not.toHaveProperty("repository");
    });
    When(`the payload is checked against the allowlist`, () => {
      if (list === undefined) {
        throw new Error("The allowlist has not been built yet.");
      }
      decision = list.check(payload);
    });
    Then(`the owner is resolved from "installation.account.login"`, () => {
      expect(resolveOwner(payload)).toEqual({
        owner: "homelab-org",
        source: "installation.account.login",
      });
    });
    And(`the decision is allowed for "homelab-org"`, () => {
      expect(decision).toEqual({ allowed: true, owner: "homelab-org" });
    });
  });

  Scenario(`Allowlisted sender, non-allowlisted repository`, ({ Given, When, Then, And }) => {
    let payload: unknown;
    let list: Allowlist | undefined;
    let decision: AllowlistDecision | undefined;

    Given(`an allowlist containing "my-user"`, () => {
      list = new Allowlist(["my-user"]);
      expect(list.has("my-user")).toBe(true);
    });
    And(`a webhook payload with repository owner "stranger-org" and sender "my-user"`, () => {
      payload = {
        repository: { owner: { login: "stranger-org" } },
        sender: { login: "my-user" },
      };
    });
    When(`the payload is checked against the allowlist`, () => {
      if (list === undefined) {
        throw new Error("The allowlist has not been built yet.");
      }
      decision = list.check(payload);
    });
    Then(`the decision is denied for "stranger-org" because "not-allowlisted"`, () => {
      // The allowlisted sender must not be mistaken for the repository owner.
      expect(decision).toEqual({
        allowed: false,
        owner: "stranger-org",
        reason: "not-allowlisted",
      });
    });
  });

  Scenario(`No allowlist anywhere`, ({ Given, When, Then }) => {
    let definitions: Record<string, AppDefinition> | undefined;
    let resolved: ReturnType<typeof resolveDefinitions> | undefined;
    let captured: unknown;

    Given(`an App definition with no allowedInstallationTargets and no global default`, () => {
      definitions = {
        "12345": {
          appId: 12345,
          privateKey: PRIVATE_KEY,
          webhookSecret: "secret",
        },
      };
      expect(definitions["12345"]?.allowedInstallationTargets).toBeUndefined();
    });
    When(`the App definitions are resolved`, () => {
      if (definitions === undefined) {
        throw new Error("The App definitions have not been built yet.");
      }
      try {
        resolved = resolveDefinitions(definitions, registryDefaults(undefined));
      } catch (error) {
        captured = error;
      }
    });
    Then(`startup fails with a refusal to start without a boundary`, () => {
      expect(resolved).toBeUndefined();
      const message = configurationMessage(captured);
      expect(message).toContain("no installation allowlist");
      expect(message).toContain("Refusing to start without a boundary");
    });
  });

  Scenario(`Map key disagrees with the App ID`, ({ Given, When, Then }) => {
    let definitions: Record<string, AppDefinition> | undefined;
    let resolved: ReturnType<typeof resolveDefinitions> | undefined;
    let captured: unknown;

    Given(`an App definition with appId 456 under the configuration key "123"`, () => {
      definitions = {
        "123": {
          appId: 456,
          privateKey: PRIVATE_KEY,
          webhookSecret: "secret",
        },
      };
    });
    When(`the App definitions are resolved`, () => {
      if (definitions === undefined) {
        throw new Error("The App definitions have not been built yet.");
      }
      // The allowlist is supplied so the key mismatch is the only possible cause.
      try {
        resolved = resolveDefinitions(definitions, registryDefaults(["my-user"]));
      } catch (error) {
        captured = error;
      }
    });
    Then(`startup fails rather than silently misrouting the App's events`, () => {
      expect(resolved).toBeUndefined();
      const message = configurationMessage(captured);
      expect(message).toContain(`App key "123"`);
      expect(message).toContain("does not match its appId 456");
    });
  });

  ScenarioOutline(
    `A wildcard target is rejected at startup`,
    ({ Given, When, Then }, variables) => {
      let configuration: { channel: string; value: string } | undefined;
      let parsedTargets: string[] | undefined;
      let resolved: ReturnType<typeof resolveDefinitions> | undefined;
      let captured: unknown;

      Given(`the allowlist is configured through <channel> as <value>`, () => {
        configuration = {
          channel: readCell(variables, "channel"),
          value: readCell(variables, "value"),
        };
      });
      When(`the configuration is validated at startup`, () => {
        if (configuration === undefined) {
          throw new Error("The allowlist configuration has not been built yet.");
        }
        const { channel, value } = configuration;

        if (channel === "the environment variable") {
          try {
            parsedTargets = parseAllowedTargets(value);
          } catch (error) {
            captured = error;
          }
          return;
        }

        if (channel === "a per-App target list") {
          const definitions: Record<string, AppDefinition> = {
            "12345": {
              appId: 12345,
              privateKey: PRIVATE_KEY,
              webhookSecret: "secret",
              allowedInstallationTargets: parseStringArrayCell(value),
            },
          };
          try {
            resolved = resolveDefinitions(definitions, registryDefaults(undefined));
          } catch (error) {
            captured = error;
          }
          return;
        }

        throw new Error(`Unrecognised allowlist channel: ${JSON.stringify(channel)}`);
      });
      Then(`it is rejected as a wildcard rather than widening the boundary to everyone`, () => {
        if (configuration === undefined) {
          throw new Error("The allowlist configuration has not been built yet.");
        }
        // Each channel populates a different variable; only that one must stay empty.
        if (configuration.channel === "the environment variable") {
          expect(parsedTargets).toBeUndefined();
        } else if (configuration.channel === "a per-App target list") {
          expect(resolved).toBeUndefined();
        } else {
          throw new Error(
            `Unrecognised allowlist channel: ${JSON.stringify(configuration.channel)}`,
          );
        }
        const message = configurationMessage(captured);
        expect(message).toContain("may not contain the wildcard");
        expect(message).toContain(`"*"`);
      });
    },
  );
});
