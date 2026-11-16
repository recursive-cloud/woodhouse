import { expect } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { Allowlist, resolveOwner } from "../../src/security/allowlist.js";
import type { AllowlistDecision, OwnerResolution } from "../../src/security/allowlist.js";

const feature = await loadFeature("features/installation-lockdown/allowlist.feature");

type ScenarioVariables = Record<string, unknown>;

/** Read one Examples cell. A missing cell is a malformed scenario, not a value to guess. */
function readCell(variables: ScenarioVariables, key: string): string {
  const value = variables[key];
  if (typeof value !== "string") {
    throw new Error(`Scenario outline row is missing a string "${key}" cell.`);
  }
  return value;
}

/** Map a placeholder cell such as "no owner" to the absent value the domain uses. */
function expected(cell: string, absent: string): string | undefined {
  return cell === absent ? undefined : cell;
}

/**
 * Build the webhook payload named by a `<payload>` cell.
 *
 * The phrases are fixed by the feature; an unrecognised phrase is a broken
 * scenario, so this throws instead of returning a payload that might pass.
 */
function parsePayload(phrase: string): unknown {
  const text = phrase.trim();

  const repositoryAndOrganization =
    /^with repository owner "([^"]*)" and organization "([^"]*)"$/.exec(text);
  if (repositoryAndOrganization !== null) {
    return {
      repository: { owner: { login: repositoryAndOrganization[1] } },
      organization: { login: repositoryAndOrganization[2] },
    };
  }

  const repositoryOwner = /^with repository owner "([^"]*)"$/.exec(text);
  if (repositoryOwner !== null) {
    return { repository: { owner: { login: repositoryOwner[1] } } };
  }

  const blankRepositoryOwner = /^with blank repository owner "([^"]*)" only$/.exec(text);
  if (blankRepositoryOwner !== null) {
    return { repository: { owner: { login: blankRepositoryOwner[1] } } };
  }

  const organization = /^with organization "([^"]*)" only$/.exec(text);
  if (organization !== null) {
    return { organization: { login: organization[1] } };
  }

  const installationAccount = /^with installation account "([^"]*)" only$/.exec(text);
  if (installationAccount !== null) {
    return { installation: { account: { login: installationAccount[1] } } };
  }

  const sender = /^with sender "([^"]*)" only$/.exec(text);
  if (sender !== null) {
    return { sender: { login: sender[1] } };
  }

  switch (text) {
    case "with no owner fields":
      return {};
    case "with a null repository object":
      return { repository: null };
    case "that is a null value":
      return null;
    case "that is an undefined value":
      return undefined;
    case "that is a number value":
      return 42;
    case "that is a string value":
      return "string";
    default:
      throw new Error(`Unrecognised payload phrase: ${JSON.stringify(phrase)}`);
  }
}

function parseReason(value: string | undefined): "unresolved-owner" | "not-allowlisted" {
  if (value === "unresolved-owner" || value === "not-allowlisted") {
    return value;
  }
  throw new Error(`Unrecognised rejection reason: ${JSON.stringify(value)}`);
}

/** Build the expected decision from a `<decision>` cell. */
function parseDecision(phrase: string): AllowlistDecision {
  const text = phrase.trim();

  const allowed = /^allowed for "([^"]*)"$/.exec(text);
  if (allowed !== null) {
    return { allowed: true, owner: allowed[1] as string };
  }

  const denied = /^denied for "([^"]*)" because "([^"]*)"$/.exec(text);
  if (denied !== null) {
    return {
      allowed: false,
      owner: denied[1] as string,
      reason: parseReason(denied[2]),
    };
  }

  const deniedWithoutOwner = /^denied without owner because "([^"]*)"$/.exec(text);
  if (deniedWithoutOwner !== null) {
    return {
      allowed: false,
      owner: undefined,
      reason: parseReason(deniedWithoutOwner[1]),
    };
  }

  throw new Error(`Unrecognised decision phrase: ${JSON.stringify(phrase)}`);
}

describeFeature(feature, ({ ScenarioOutline, Scenario }) => {
  ScenarioOutline(
    `The event owner is resolved from the payload's highest-priority source`,
    ({ Given, When, Then, And }, variables) => {
      let payload: unknown;
      let resolution: OwnerResolution | undefined;

      const requireResolution = (): OwnerResolution => {
        if (resolution === undefined) {
          throw new Error("The resolver has not run yet.");
        }
        return resolution;
      };

      Given(`a webhook payload <payload>`, () => {
        payload = parsePayload(readCell(variables, "payload"));
      });
      When(`the owner is resolved`, () => {
        resolution = resolveOwner(payload);
      });
      Then(`the owner is <owner>`, () => {
        expect(requireResolution().owner).toBe(expected(readCell(variables, "owner"), "no owner"));
      });
      And(`its source is <source>`, () => {
        expect(requireResolution().source).toBe(
          expected(readCell(variables, "source"), "no source"),
        );
      });
    },
  );
  ScenarioOutline(
    `An allowlist check decides on the resolved owner`,
    ({ Given, When, Then }, variables) => {
      let list: Allowlist | undefined;
      let decision: AllowlistDecision | undefined;

      Given(`an allowlist containing "My-User" and "homelab-org"`, () => {
        list = new Allowlist(["My-User", "homelab-org"]);
        expect(list.describe()).toEqual(["homelab-org", "my-user"]);
      });
      When(`the payload <payload> is checked against the allowlist`, () => {
        if (list === undefined) {
          throw new Error("The allowlist has not been built yet.");
        }
        decision = list.check(parsePayload(readCell(variables, "payload")));
      });
      Then(`the decision is <decision>`, () => {
        if (decision === undefined) {
          throw new Error("The allowlist check has not run yet.");
        }
        expect(decision).toEqual(parseDecision(readCell(variables, "decision")));
      });
    },
  );
  Scenario(`An allowlist refuses to be constructed without targets`, ({ Given, When, Then }) => {
    let targets: string[] | undefined;
    let built: Allowlist | undefined;
    let captured: unknown;

    Given(`the configured allowlist targets are empty`, () => {
      targets = [];
      expect(targets).toHaveLength(0);
    });
    When(`an allowlist is built from them`, () => {
      if (targets === undefined) {
        throw new Error("The configured targets have not been read yet.");
      }
      try {
        built = new Allowlist(targets);
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(Error);
    });
    Then(`the build fails with "Allowlist requires at least one target."`, () => {
      expect(built).toBeUndefined();
      expect(captured instanceof Error ? captured.message : undefined).toBe(
        "Allowlist requires at least one target.",
      );
    });
  });
});
