import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { BASELINE_PATHS, LOCAL_PATHS, isSettingsPath } from "../../src/config/paths.js";
import {
  ConfigResolver,
  type ContentsClient,
  type ResolvedConfig,
} from "../../src/config/resolver.js";
import {
  parseConfig,
  woodhouseConfigSchema,
  type ParseResult,
  type RulesetConfig,
  type WoodhouseConfig,
} from "../../src/config/schema.js";
import { settingsSyncBlock, type SettingsSyncBlockReason } from "../../src/settings/apply.js";
import { applyBranchProtection } from "../../src/settings/appliers/branch-protection.js";
import type { ApplierContext, ApplierResult } from "../../src/settings/appliers/types.js";
import { planRulesets, type ExistingRuleset, type RulesetPlan } from "../../src/settings/plan.js";
import { fakeLogger, readCell } from "../support/scenario.js";

const feature = await loadFeature("features/settings-sync/planning.feature");

/** Keys the fake contents client serves the two layers from. */
const BASELINE_FILE = ".github-private:woodhouse.yml";
const LOCAL_FILE = "app:.github/woodhouse.yml";
const BASELINE_REPO_LOCAL_FILE = ".github-private:.github/woodhouse.yml";
const ORDINARY_REPO_ROOT_FILE = "app:woodhouse.yml";

/**
 * Build the YAML text a `<baseline>` or `<local>` cell names, or undefined when
 * the layer is absent.
 *
 * The phrases are fixed by the feature; an unrecognised phrase is a broken
 * scenario, so this throws instead of returning a layer that might pass.
 */
function parseLayer(phrase: string): string | undefined {
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
function parseGate(phrase: string): SettingsSyncBlockReason | null {
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

function parseBooleanCell(cell: string): boolean {
  if (cell === "true") return true;
  if (cell === "false") return false;
  throw new Error(`Unrecognised boolean cell: ${JSON.stringify(cell)}`);
}

/** Build the expected merged value from a `<value>` cell. */
function parseMergedValue(phrase: string): unknown {
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
function atPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

/** Build the conditions object a `<conditions>` cell names. */
function parseConditions(phrase: string): Record<string, unknown> {
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
function parseExistingRulesets(phrase: string): ExistingRuleset[] {
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
function parseConfiguredRulesets(phrase: string): RulesetConfig[] {
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

/** Assert the plan facts an `<plan>` cell names. */
function assertPlan(plan: RulesetPlan, phrase: string): void {
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
function layerFiles(
  baseline: string | undefined,
  local: string | undefined,
): Record<string, string> {
  const files: Record<string, string> = {};
  if (baseline !== undefined) files[BASELINE_FILE] = baseline;
  if (local !== undefined) files[LOCAL_FILE] = local;
  return files;
}

function resolveFor(
  files: Record<string, string>,
  owner: string,
  repo: string,
): Promise<ResolvedConfig> {
  return new ConfigResolver().resolve(fakeClient(files), owner, repo, fakeLogger());
}

function requireResolved(resolved: ResolvedConfig | undefined): ResolvedConfig {
  if (resolved === undefined) throw new Error("The configuration has not been resolved yet.");
  return resolved;
}

function requireValidation(result: ParseResult | undefined): ParseResult {
  if (result === undefined) throw new Error("The configuration has not been validated yet.");
  return result;
}

function requirePlan(plan: RulesetPlan | undefined): RulesetPlan {
  if (plan === undefined) throw new Error("The ruleset plan has not been built yet.");
  return plan;
}

function requireDescription(description: string | undefined, surface: string): string {
  if (description === undefined) {
    throw new Error(`The ${surface} configuration surface has no description.`);
  }
  return description;
}

interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/**
 * Fake octokit with a call log over every method it exposes, so a scenario can
 * prove that no write path other than the expected one ran.
 */
function recordingOctokit(): {
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
const configShape = woodhouseConfigSchema.unwrap().shape;

describeFeature(
  feature,
  ({
    BeforeAllScenarios,
    AfterAllScenarios,
    BeforeEachScenario,
    AfterEachScenario,
    ScenarioOutline,
    Scenario,
  }) => {
    BeforeAllScenarios(() => {});
    AfterAllScenarios(() => {});
    BeforeEachScenario(() => {});
    AfterEachScenario(() => {});

    ScenarioOutline(
      `The sync gate decides from the resolved configuration`,
      ({ Given, When, Then, And }, variables) => {
        let baseline: string | undefined;
        let local: string | undefined;
        let resolved: ResolvedConfig | undefined;

        Given(`a baseline layer <baseline>`, () => {
          baseline = parseLayer(readCell(variables, "baseline"));
        });
        And(`a local layer <local>`, () => {
          local = parseLayer(readCell(variables, "local"));
        });
        When(`the repository's configuration is resolved`, async () => {
          resolved = await resolveFor(layerFiles(baseline, local), "acme", "app");
        });
        Then(`the sync gate reports <gate>`, () => {
          expect(settingsSyncBlock(requireResolved(resolved))).toBe(
            parseGate(readCell(variables, "gate")),
          );
        });
        And(`the resolved settings switch is <enabled>`, () => {
          expect(requireResolved(resolved).config.settings.enabled).toBe(
            parseBooleanCell(readCell(variables, "enabled")),
          );
        });
      },
    );

    Scenario(
      `The baseline repository resolves its root file as the baseline layer`,
      ({ Given, When, Then, And }) => {
        let files: Record<string, string> = {};
        let resolved: ResolvedConfig | undefined;

        Given(`a root woodhouse.yml in the baseline repository`, () => {
          files = { [BASELINE_FILE]: "repository:\n  has_wiki: true\n" };
        });
        When(`the baseline repository's configuration is resolved`, async () => {
          resolved = await resolveFor(files, "acme", ".github-private");
        });
        Then(`the root file contributes as the baseline layer`, () => {
          const result = requireResolved(resolved);
          expect(result.sources).toEqual(["acme/.github-private:woodhouse.yml"]);
          expect(result.config.repository.has_wiki).toBe(true);
          expect(result.localSource).toBeUndefined();
        });
        And(`no local file is reported`, () => {
          expect(requireResolved(resolved).localSource).toBeUndefined();
        });
        And(`the sync gate reports "no local file"`, () => {
          expect(settingsSyncBlock(requireResolved(resolved))).toBe("no-local-file");
        });
      },
    );

    Scenario(
      `The baseline repository resolves to defaults with no configuration anywhere`,
      ({ Given, When, Then, And }) => {
        let files: Record<string, string> = {};
        let resolved: ResolvedConfig | undefined;

        Given(`no baseline file and no local file`, () => {
          files = {};
        });
        When(`the baseline repository's configuration is resolved`, async () => {
          resolved = await resolveFor(files, "acme", ".github-private");
        });
        Then(`the configuration resolves to defaults`, () => {
          const result = requireResolved(resolved);
          expect(result.sources).toEqual([]);
          expect(result.config.settings.enabled).toBe(true);
          expect(result.config.repository.has_wiki).toBeUndefined();
        });
        And(`no local file is reported`, () => {
          expect(requireResolved(resolved).localSource).toBeUndefined();
        });
      },
    );

    Scenario(
      `The baseline repository manages itself through its own settings file`,
      ({ Given, When, Then, And }) => {
        let files: Record<string, string> = {};
        let resolved: ResolvedConfig | undefined;

        Given(`a root woodhouse.yml in the baseline repository`, () => {
          files = { ...files, [BASELINE_FILE]: "repository:\n  has_wiki: true\n" };
        });
        And(`the baseline repository's own .github settings file`, () => {
          files = {
            ...files,
            [BASELINE_REPO_LOCAL_FILE]:
              "settings:\n  enabled: true\nrepository:\n  has_wiki: false\n",
          };
        });
        When(`the baseline repository's configuration is resolved`, async () => {
          resolved = await resolveFor(files, "acme", ".github-private");
        });
        Then(`the local file is reported`, () => {
          expect(requireResolved(resolved).localSource).toBe(
            "acme/.github-private:.github/woodhouse.yml",
          );
        });
        And(`the sync gate reports "runs"`, () => {
          expect(settingsSyncBlock(requireResolved(resolved))).toBeNull();
        });
      },
    );

    Scenario(
      `A root settings file in an ordinary repository contributes nothing`,
      ({ Given, When, Then, And }) => {
        let files: Record<string, string> = {};
        let resolved: ResolvedConfig | undefined;

        Given(`a baseline layer that sets repository has_wiki false`, () => {
          files = { ...files, [BASELINE_FILE]: "repository:\n  has_wiki: false\n" };
        });
        And(`a local layer that sets repository has_wiki false`, () => {
          files = { ...files, [LOCAL_FILE]: "repository:\n  has_wiki: false\n" };
        });
        And(`a root woodhouse.yml in the repository that sets settings enabled false`, () => {
          files = {
            ...files,
            [ORDINARY_REPO_ROOT_FILE]:
              "settings:\n  enabled: false\nrepository:\n  has_issues: true\n",
          };
        });
        When(`the repository's configuration is resolved`, async () => {
          resolved = await resolveFor(files, "acme", "app");
        });
        Then(`the root file is not among the resolved sources`, () => {
          const result = requireResolved(resolved);
          expect(result.sources).not.toContain("acme/app:woodhouse.yml");
          expect(result.sources).toContain("acme/app:.github/woodhouse.yml");
        });
        And(`the resolved settings switch is true`, () => {
          expect(requireResolved(resolved).config.settings.enabled).toBe(true);
        });
        And(`the sync gate reports "runs"`, () => {
          expect(settingsSyncBlock(requireResolved(resolved))).toBeNull();
        });
      },
    );

    ScenarioOutline(
      `Layers cascade with objects merged and arrays replaced`,
      ({ Given, When, Then, And }, variables) => {
        let baseline: string | undefined;
        let local: string | undefined;
        let resolved: ResolvedConfig | undefined;

        Given(`a baseline layer <baseline>`, () => {
          baseline = parseLayer(readCell(variables, "baseline"));
        });
        And(`a local layer <local>`, () => {
          local = parseLayer(readCell(variables, "local"));
        });
        When(`the repository's configuration is resolved`, async () => {
          resolved = await resolveFor(layerFiles(baseline, local), "acme", "app");
        });
        Then(`the merged value at <key> is <value>`, () => {
          expect(atPath(requireResolved(resolved).config, readCell(variables, "key"))).toEqual(
            parseMergedValue(readCell(variables, "value")),
          );
        });
      },
    );

    Scenario(
      `Layers merge before validation so baseline values survive local defaults`,
      ({ Given, When, Then, And }) => {
        let files: Record<string, string> = {};
        let resolved: ResolvedConfig | undefined;

        Given(`a baseline layer that sets gatekeeper strictChecks build`, () => {
          files = { ...files, [BASELINE_FILE]: "gatekeeper:\n  strictChecks: [build]\n" };
        });
        And(`a local layer that sets gatekeeper ignoredChecks coverage`, () => {
          files = {
            ...files,
            [LOCAL_FILE]: "gatekeeper:\n  ignoredChecks: [coverage]\n",
          };
        });
        When(`the repository's configuration is resolved`, async () => {
          resolved = await resolveFor(files, "acme", "app");
        });
        Then(
          `the configuration validates with strictChecks build and ignoredChecks coverage`,
          () => {
            const result = requireResolved(resolved);
            expect(result.issues).toEqual([]);
            expect(result.config.gatekeeper.strictChecks).toEqual(["build"]);
            expect(result.config.gatekeeper.ignoredChecks).toEqual(["coverage"]);
          },
        );
      },
    );

    Scenario(`inherit false drops the baseline layer entirely`, ({ Given, When, Then, And }) => {
      let files: Record<string, string> = {};
      let resolved: ResolvedConfig | undefined;

      Given(`a baseline layer that sets repository has_wiki false`, () => {
        files = { ...files, [BASELINE_FILE]: "repository:\n  has_wiki: false\n" };
      });
      And(`a local layer that sets inherit false`, () => {
        files = { ...files, [LOCAL_FILE]: "inherit: false\n" };
      });
      When(`the repository's configuration is resolved`, async () => {
        resolved = await resolveFor(files, "acme", "app");
      });
      Then(`the resolved sources contain no baseline layer`, () => {
        expect(requireResolved(resolved).sources).toEqual(["acme/app:.github/woodhouse.yml"]);
      });
      And(`the merged value at repository.has_wiki is absent`, () => {
        expect(atPath(requireResolved(resolved).config, "repository.has_wiki")).toBeUndefined();
      });
    });

    ScenarioOutline(
      `Ruleset conditions accept only ref_name`,
      ({ Given, When, Then }, variables) => {
        let input: Record<string, unknown> | undefined;
        let conditions: Record<string, unknown> | undefined;
        let validation: ParseResult | undefined;

        Given(`a configuration with a ruleset named main declaring conditions <conditions>`, () => {
          conditions = parseConditions(readCell(variables, "conditions"));
          input = {
            rulesets: [{ name: "main", target: "branch", enforcement: "active", conditions }],
          };
        });
        When(`the configuration is validated`, () => {
          validation = parseConfig(input);
        });
        Then(`the validation <verdict>`, () => {
          const result = requireValidation(validation);
          const verdict = readCell(variables, "verdict");

          if (verdict === "passes") {
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.config.rulesets[0]?.conditions).toEqual(conditions);
            return;
          }

          if (verdict === "fails naming rulesets.0.conditions") {
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(
              result.issues.some(
                (issue) =>
                  issue.path === "rulesets.0.conditions" &&
                  issue.message.includes("repository_name"),
              ),
            ).toBe(true);
            return;
          }

          throw new Error(`Unrecognised validation verdict: ${JSON.stringify(verdict)}`);
        });
      },
    );

    Scenario(`Ruleset names are unique case-insensitively`, ({ Given, When, Then }) => {
      let input: Record<string, unknown> | undefined;
      let validation: ParseResult | undefined;

      Given(`a configuration listing rulesets named main and MAIN`, () => {
        input = {
          rulesets: [
            { name: "main", target: "branch", enforcement: "active", rules: [] },
            { name: "MAIN", target: "branch", enforcement: "active", rules: [] },
          ],
        };
      });
      When(`the configuration is validated`, () => {
        validation = parseConfig(input);
      });
      Then(`the validation fails naming the duplicate`, () => {
        const result = requireValidation(validation);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(
          result.issues.some(
            (issue) =>
              issue.path.startsWith("rulesets") &&
              issue.message.includes("main") &&
              issue.message.includes("MAIN"),
          ),
        ).toBe(true);
      });
    });

    Scenario(`Ruleset names that differ validate together`, ({ Given, When, Then, And }) => {
      let input: unknown;
      let validation: ReturnType<typeof parseConfig> | undefined;

      Given(`a configuration listing rulesets named main and release`, () => {
        input = {
          rulesets: [
            { name: "main", target: "branch", enforcement: "active", rules: [] },
            { name: "release", target: "branch", enforcement: "active", rules: [] },
          ],
        };
      });
      When(`the configuration is validated`, () => {
        validation = parseConfig(input);
      });
      Then(`the validation passes`, () => {
        expect(requireValidation(validation).ok).toBe(true);
      });
      And(`both rulesets survive validation`, () => {
        const result = requireValidation(validation);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.config.rulesets).toHaveLength(2);
        expect(result.config.rulesets.map((ruleset) => ruleset.name)).toEqual(["main", "release"]);
      });
    });

    ScenarioOutline(
      `The ruleset plan converges by re-declaration and prunes only on opt-in`,
      ({ Given, When, Then, And }, variables) => {
        let existing: ExistingRuleset[] = [];
        let desired: RulesetConfig[] = [];
        let prune = false;
        let plan: RulesetPlan | undefined;

        Given(`existing rulesets <existing>`, () => {
          existing = parseExistingRulesets(readCell(variables, "existing"));
        });
        And(`configured rulesets <configured>`, () => {
          desired = parseConfiguredRulesets(readCell(variables, "configured"));
        });
        And(`pruning is <prune>`, () => {
          const cell = readCell(variables, "prune");
          if (cell === "on") {
            prune = true;
          } else if (cell === "off") {
            prune = false;
          } else {
            throw new Error(`Unrecognised prune cell: ${JSON.stringify(cell)}`);
          }
        });
        When(`the ruleset plan is built`, () => {
          plan = planRulesets(existing, desired, prune);
        });
        Then(`it plans <plan>`, () => {
          assertPlan(requirePlan(plan), readCell(variables, "plan"));
        });
      },
    );

    ScenarioOutline(
      `Only the four settings paths are configuration`,
      ({ Given, When, Then }, variables) => {
        let path: string | undefined;
        let classified: boolean | undefined;

        Given(`a changed file at <path>`, () => {
          path = readCell(variables, "path");
        });
        When(`the path is classified`, () => {
          if (path === undefined) throw new Error("The changed file path has not been read yet.");
          classified = isSettingsPath(path);
        });
        Then(`it is <verdict>`, () => {
          const verdict = readCell(variables, "verdict");
          if (verdict === "configuration") {
            expect(classified).toBe(true);
            return;
          }
          if (verdict === "not configuration") {
            expect(classified).toBe(false);
            return;
          }
          throw new Error(`Unrecognised path verdict: ${JSON.stringify(verdict)}`);
        });
      },
    );

    Scenario(`The settings paths are exactly the four known paths`, ({ Given, Then }) => {
      let paths: string[] = [];

      Given(`the exported local and baseline paths`, () => {
        paths = [...LOCAL_PATHS, ...BASELINE_PATHS];
      });
      Then(`they are exactly the four settings paths`, () => {
        expect(paths.toSorted()).toEqual(
          [
            ".github/woodhouse.yml",
            ".github/woodhouse.yaml",
            "woodhouse.yml",
            "woodhouse.yaml",
          ].toSorted(),
        );
      });
    });

    Scenario(
      `A removed branchProtection block plans no write for that branch`,
      ({ Given, When, Then, And }) => {
        let before: WoodhouseConfig | undefined;
        let result: ApplierResult | undefined;
        let calls: RecordedCall[] = [];

        Given(`a configuration that protects branches main and release`, () => {
          before = woodhouseConfigSchema.parse({
            branchProtection: { main: {}, release: {} },
          });
          expect(Object.keys(before.branchProtection)).toEqual(["main", "release"]);
        });
        When(
          `branch protection is planned for a configuration that stops listing release`,
          async () => {
            const fake = recordingOctokit();
            calls = fake.calls;
            result = await applyBranchProtection(
              {
                octokit: fake.octokit,
                owner: "acme",
                repo: "app",
                log: fakeLogger(),
                dryRun: false,
              },
              woodhouseConfigSchema.parse({ branchProtection: { main: {} } }),
            );
          },
        );
        Then(`no write is planned for release`, () => {
          // The write log is the only evidence of a plan: one PUT, for main.
          expect(calls.map((call) => (call.args[0] as { branch?: string }).branch)).toEqual([
            "main",
          ]);
        });
        And(`no branch protection is planned as a delete`, () => {
          expect(calls.map((call) => call.method)).toEqual(["repos.updateBranchProtection"]);
          if (result === undefined) throw new Error("Branch protection has not been planned yet.");
          expect(result.changes.some((change) => change.action === "delete")).toBe(false);
        });
      },
    );

    Scenario(
      `The branch protection surface points at the Convert to ruleset flow`,
      ({ Given, Then, And }) => {
        let description: string | undefined;

        Given(`the branch protection configuration surface description`, () => {
          description = configShape.branchProtection.description;
        });
        Then(`it directs operators to GitHub's Convert to ruleset flow`, () => {
          expect(requireDescription(description, "branch protection")).toContain(
            "Convert to ruleset",
          );
        });
        And(`it says removal does not delete the protection behind the block`, () => {
          expect(requireDescription(description, "branch protection")).toContain("does not delete");
        });
      },
    );

    Scenario(`The prune surface warns it deletes hand-made rulesets`, ({ Given, Then, And }) => {
      let description: string | undefined;

      Given(`the pruneRulesets configuration surface description`, () => {
        description = configShape.settings.unwrap().shape.pruneRulesets.description;
      });
      Then(`it warns that prune deletes every ruleset not named in the configuration`, () => {
        expect(requireDescription(description, "pruneRulesets")).toContain(
          "not named in this configuration",
        );
      });
      And(`it says that includes rulesets created outside Woodhouse`, () => {
        expect(requireDescription(description, "pruneRulesets")).toContain(
          "rulesets created outside Woodhouse",
        );
      });
    });
  },
);
