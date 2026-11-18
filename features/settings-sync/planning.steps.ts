import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { BASELINE_PATHS, LOCAL_PATHS, isSettingsPath } from "../../src/config/paths.js";
import type { ResolvedConfig } from "../../src/config/resolver.js";
import {
  parseConfig,
  woodhouseConfigSchema,
  type ParseResult,
  type RulesetConfig,
  type WoodhouseConfig,
} from "../../src/config/schema.js";
import { settingsSyncBlock } from "../../src/settings/apply.js";
import { applyBranchProtection } from "../../src/settings/appliers/branch-protection.js";
import type { ApplierResult } from "../../src/settings/appliers/types.js";
import { planRulesets, type ExistingRuleset, type RulesetPlan } from "../../src/settings/plan.js";
import { fakeLogger, readCell } from "../support/scenario.js";
import {
  BASELINE_FILE,
  BASELINE_REPO_LOCAL_FILE,
  LOCAL_FILE,
  ORDINARY_REPO_ROOT_FILE,
  assertPlan,
  atPath,
  configShape,
  layerFiles,
  parseBooleanCell,
  parseConditions,
  parseConfiguredRulesets,
  parseExistingRulesets,
  parseGate,
  parseLayer,
  parseMergedValue,
  recordingOctokit,
  requireDescription,
  requirePlan,
  requireResolved,
  requireValidation,
  resolveFor,
  type RecordedCall,
} from "./planning-world.js";

const feature = await loadFeature("features/settings-sync/planning.feature");

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
