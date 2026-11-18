/**
 * Fixture and harness layer for the settings-sync planning acceptance suite.
 *
 * The phrases the feature's Examples cells use, the fake Contents client the
 * real `ConfigResolver` reads through, and the recording octokit the branch
 * protection applier writes through all live here. This module is not a vitest
 * entry: `planning.steps.ts` imports it, so the steps file holds the step
 * definitions and the assertions built from these helpers.
 */

import { expect } from "vitest";
import {
  ConfigResolver,
  type ContentsClient,
  type ResolvedConfig,
} from "../../src/config/resolver.js";
import {
  woodhouseConfigSchema,
  type ParseResult,
  type RulesetConfig,
} from "../../src/config/schema.js";
import type { ApplierContext } from "../../src/settings/appliers/types.js";
import { type ExistingRuleset, type RulesetPlan } from "../../src/settings/plan.js";
import type { SettingsSyncBlockReason } from "../../src/settings/apply.js";
import { fakeLogger } from "../support/scenario.js";

/** Keys the fake contents client serves the two layers from. */
export const BASELINE_FILE = ".github-private:woodhouse.yml";
export const LOCAL_FILE = "app:.github/woodhouse.yml";
export const BASELINE_REPO_LOCAL_FILE = ".github-private:.github/woodhouse.yml";
export const ORDINARY_REPO_ROOT_FILE = "app:woodhouse.yml";

/**
 * Build the YAML text a `<baseline>` or `<local>` cell names, or undefined when
 * the layer is absent.
 *
 * The phrases are fixed by the feature; an unrecognised phrase is a broken
 * scenario, so this throws instead of returning a layer that might pass.
 */
export function parseLayer(phrase: string): string | undefined {
  switch (phrase.trim()) {
    case "that is absent":
      return undefined;
    case "that sets settings enabled false":
      return "settings:\n  enabled: false\n";
    case "that sets settings enabled true":
      return "settings:\n  enabled: true\n";
    case "that sets repository has_wiki false":
      return "repository:\n  has_wiki: false\n";
    case "that sets repository has_wiki true":
      return "repository:\n  has_wiki: true\n";
    case "that sets repository has_wiki null":
      return "repository:\n  has_wiki: null\n";
    case "that sets repository has_issues true":
      return "repository:\n  has_issues: true\n";
    case "that sets gatekeeper strictChecks build":
      return "gatekeeper:\n  strictChecks: [build]\n";
    case "that sets gatekeeper strictChecks build and lint":
      return "gatekeeper:\n  strictChecks: [build, lint]\n";
    case "that sets gatekeeper strictChecks none":
      return "gatekeeper:\n  strictChecks: []\n";
    case "that sets gatekeeper ignoredChecks coverage":
      return "gatekeeper:\n  ignoredChecks: [coverage]\n";
    case "that sets inherit false":
      return "inherit: false\n";
    case "that sets an invalid gatekeeper":
      return "gatekeeper:\n  enabled: nonsense\n";
    case "that is not valid YAML":
      return "settings: [unclosed\n";
    default:
      throw new Error(`Unrecognised layer phrase: ${JSON.stringify(phrase)}`);
  }
}

/** Build the expected gate result from a `<gate>` cell, or a quoted plain step value. */
export function parseGate(phrase: string): SettingsSyncBlockReason | null {
  const text = phrase.trim().replace(/^"(.*)"$/, "$1");
  switch (text) {
    case "no local file":
      return "no-local-file";
    case "settings disabled":
      return "settings-disabled";
    case "invalid config":
      return "invalid-config";
    case "runs":
      return null;
    default:
      throw new Error(`Unrecognised sync gate phrase: ${JSON.stringify(phrase)}`);
  }
}

export function parseBooleanCell(cell: string): boolean {
  if (cell === "true") return true;
  if (cell === "false") return false;
  throw new Error(`Unrecognised boolean cell: ${JSON.stringify(cell)}`);
}

/** Build the expected merged value from a `<value>` cell. */
export function parseMergedValue(phrase: string): unknown {
  switch (phrase.trim()) {
    case "false":
      return false;
    case "true":
      return true;
    case "absent":
      return undefined;
    case "an empty list":
      return [];
    case "the list build":
      return ["build"];
    default:
      throw new Error(`Unrecognised merged value phrase: ${JSON.stringify(phrase)}`);
  }
}

/** Walk a dotted key such as `repository.has_wiki` into the resolved config. */
export function atPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

/** Build the conditions object a `<conditions>` cell names. */
export function parseConditions(phrase: string): Record<string, unknown> {
  switch (phrase.trim()) {
    case "that accept ref_name with include DEFAULT_BRANCH":
      return { ref_name: { include: ["~DEFAULT_BRANCH"] } };
    case "that reject the organization-only repository_name key":
      return { repository_name: { include: ["~DEFAULT_BRANCH"] } };
    default:
      throw new Error(`Unrecognised conditions phrase: ${JSON.stringify(phrase)}`);
  }
}

/** Build the existing rulesets an `<existing>` cell names. */
export function parseExistingRulesets(phrase: string): ExistingRuleset[] {
  switch (phrase.trim()) {
    case "that is empty":
      return [];
    case "that hold main as id 7":
      return [{ id: 7, name: "main" }];
    case "that hold hotfix as id 9":
      return [{ id: 9, name: "hotfix" }];
    case "that hold main as id 7 and hotfix as id 9":
      return [
        { id: 7, name: "main" },
        { id: 9, name: "hotfix" },
      ];
    default:
      throw new Error(`Unrecognised existing rulesets phrase: ${JSON.stringify(phrase)}`);
  }
}

/**
 * Build the configured rulesets a `<configured>` cell names, through the
 * schema so the plan receives fully-defaulted config rather than raw YAML.
 */
export function parseConfiguredRulesets(phrase: string): RulesetConfig[] {
  switch (phrase.trim()) {
    case "that configure main":
      return woodhouseConfigSchema.parse({
        rulesets: [{ name: "main", target: "branch", enforcement: "active", rules: [] }],
      }).rulesets;
    case "that configure nothing":
      return [];
    default:
      throw new Error(`Unrecognised configured rulesets phrase: ${JSON.stringify(phrase)}`);
  }
}

/** Assert the plan facts a `<plan>` cell names. */
export function assertPlan(plan: RulesetPlan, phrase: string): void {
  switch (phrase.trim()) {
    case "a create for main":
      expect(plan.create.map((ruleset) => ruleset.name)).toEqual(["main"]);
      expect(plan.update).toEqual([]);
      expect(plan.delete).toEqual([]);
      return;
    case "an update for main id 7":
      expect(plan.create).toEqual([]);
      expect(plan.update).toHaveLength(1);
      expect(plan.update[0]?.id).toBe(7);
      expect(plan.update[0]?.ruleset.name).toBe("main");
      expect(plan.delete).toEqual([]);
      return;
    case "no deletes":
      expect(plan.delete).toEqual([]);
      return;
    case "a delete for hotfix id 9":
      expect(plan.delete).toEqual([{ id: 9, name: "hotfix" }]);
      expect(plan.create).toEqual([]);
      expect(plan.update).toEqual([]);
      return;
    case "a delete for hotfix id 9 and an update for main id 7":
      expect(plan.delete).toEqual([{ id: 9, name: "hotfix" }]);
      expect(plan.update).toHaveLength(1);
      expect(plan.update[0]?.id).toBe(7);
      return;
    default:
      throw new Error(`Unrecognised plan phrase: ${JSON.stringify(phrase)}`);
  }
}

const notFound = Object.assign(new Error("Not Found"), { status: 404 });

/** Serves file contents from a `repo:path` map; 404s for anything else. */
function fakeClient(files: Record<string, string>): ContentsClient {
  return {
    repos: {
      async getContent({ repo, path }) {
        const text = files[`${repo}:${path}`];
        if (text === undefined) throw notFound;
        return {
          data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(text).toString("base64"),
          },
        };
      },
    },
  };
}

/** Assemble the layer files the given-layer phrases described. */
export function layerFiles(
  baseline: string | undefined,
  local: string | undefined,
): Record<string, string> {
  const files: Record<string, string> = {};
  if (baseline !== undefined) files[BASELINE_FILE] = baseline;
  if (local !== undefined) files[LOCAL_FILE] = local;
  return files;
}

export function resolveFor(
  files: Record<string, string>,
  owner: string,
  repo: string,
): Promise<ResolvedConfig> {
  return new ConfigResolver().resolve(fakeClient(files), owner, repo, fakeLogger());
}

export function requireResolved(resolved: ResolvedConfig | undefined): ResolvedConfig {
  if (resolved === undefined) throw new Error("The configuration has not been resolved yet.");
  return resolved;
}

export function requireValidation(result: ParseResult | undefined): ParseResult {
  if (result === undefined) throw new Error("The configuration has not been validated yet.");
  return result;
}

export function requirePlan(plan: RulesetPlan | undefined): RulesetPlan {
  if (plan === undefined) throw new Error("The ruleset plan has not been built yet.");
  return plan;
}

export function requireDescription(description: string | undefined, surface: string): string {
  if (description === undefined) {
    throw new Error(`The ${surface} configuration surface has no description.`);
  }
  return description;
}

export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/**
 * Fake octokit with a call log over every method it exposes, so a scenario can
 * prove that no write path other than the expected one ran.
 */
export function recordingOctokit(): {
  octokit: ApplierContext["octokit"];
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return { data: {} };
    };

  return {
    octokit: {
      repos: { updateBranchProtection: record("repos.updateBranchProtection") },
    } as unknown as ApplierContext["octokit"],
    calls,
  };
}

/** Field descriptions are declared on the schema, so read them from there. */
export const configShape = woodhouseConfigSchema.unwrap().shape;
