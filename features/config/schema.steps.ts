import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import yaml from "js-yaml";
// The schema declares draft 2020-12, which needs Ajv's 2020 entry point;
// the default export only understands draft-07.
import Ajv from "ajv/dist/2020.js";
import { SCHEMA_FILE } from "../../src/config/json-schema.js";
import { parseConfig } from "../../src/config/schema.js";

const feature = await loadFeature("features/config/schema.feature");

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const COMMITTED_SCHEMA = readFileSync(join(PROJECT_ROOT, SCHEMA_FILE), "utf8");
const document = JSON.parse(COMMITTED_SCHEMA) as Record<string, unknown>;

const ajv = new Ajv({ strict: false, allErrors: true });
const validate = ajv.compile(JSON.parse(COMMITTED_SCHEMA));

type ScenarioVariables = Record<string, unknown>;

/** Read one Examples cell. A missing cell is a malformed scenario, not a value to guess. */
function readCell(variables: ScenarioVariables, key: string): string {
  const value = variables[key];
  if (typeof value !== "string") {
    throw new Error(`Scenario outline row is missing a string "${key}" cell.`);
  }
  return value;
}

/** Walk `properties` down a path in the committed schema JSON. */
function schemaProperty(...path: string[]): Record<string, unknown> {
  let node = document;
  for (const key of path) {
    node = (node.properties as Record<string, Record<string, unknown>>)[key];
  }
  return node;
}

interface SchemaCheck {
  readonly status: number | null;
  readonly output: string;
}

interface CorpusVerdict {
  readonly doc: unknown;
  readonly schema: boolean;
  readonly runtime: boolean;
}

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describeFeature(feature, ({ ScenarioOutline, Scenario }) => {
  ScenarioOutline(`Drift fails CI`, ({ Given, When, Then }, variables) => {
    let workDir: string | undefined;
    let checked: SchemaCheck | undefined;

    Given(`the committed JSON Schema <state>`, () => {
      const state = readCell(variables, "state").trim();
      if (
        state !== "matches the zod definitions" &&
        state !== "has drifted from the zod definitions" &&
        state !== "is missing"
      ) {
        throw new Error(`Unrecognised committed schema state: ${JSON.stringify(state)}`);
      }

      workDir = mkdtempSync(join(tmpdir(), "woodhouse-schema-"));
      tempDirs.push(workDir);
      if (state === "is missing") return;

      mkdirSync(join(workDir, dirname(SCHEMA_FILE)), { recursive: true });
      copyFileSync(join(PROJECT_ROOT, SCHEMA_FILE), join(workDir, SCHEMA_FILE));

      if (state === "has drifted from the zod definitions") {
        const drifted = JSON.parse(COMMITTED_SCHEMA) as Record<string, unknown>;
        delete drifted.description;
        writeFileSync(join(workDir, SCHEMA_FILE), `${JSON.stringify(drifted, null, 2)}\n`);
      }
    });
    When(`the schema check runs`, () => {
      if (workDir === undefined) throw new Error("The schema state has not been prepared yet.");
      const result = spawnSync(
        process.execPath,
        [
          join(PROJECT_ROOT, "node_modules/.bin/tsx"),
          join(PROJECT_ROOT, "scripts/check-schema.ts"),
        ],
        { cwd: workDir, encoding: "utf8" },
      );
      expect(result.error).toBeUndefined();
      checked = {
        status: result.status,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      };
    });
    Then(`it <result>`, () => {
      if (checked === undefined) throw new Error("The schema check has not run yet.");
      const result = readCell(variables, "result").trim();

      if (result === "passes") {
        expect(checked.status, checked.output).toBe(0);
        expect(checked.output).toContain("is up to date");
        return;
      }

      if (result === `fails and says to run "npm run schema:generate"`) {
        expect(checked.status, checked.output).not.toBe(0);
        expect(checked.output).toContain("npm run schema:generate");
        return;
      }

      throw new Error(`Unrecognised schema check result phrase: ${JSON.stringify(result)}`);
    });
  });

  Scenario(`Parity corpus`, ({ Given, When, Then }) => {
    let corpus: unknown[] | undefined;
    let verdicts: CorpusVerdict[] | undefined;

    Given(
      `a corpus of valid and invalid configuration documents including the shipped example`,
      () => {
        const example = yaml.load(
          readFileSync(join(PROJECT_ROOT, "woodhouse.example.yml"), "utf8"),
        );
        corpus = [
          {},
          example,
          { gatekeper: {} },
          { autoApproval: { allowedActor: ["me"] } },
          {
            autoApproval: {
              allowedActors: { owners: ["my-user"], bots: ["renovate[bot]"] },
            },
          },
          { autoApproval: { allowedActors: { bots: ["org/team"] } } },
          { autoApproval: { allowedActors: ["renovate[bot]"] } },
          { gatekeeper: { enabled: "yes" } },
          { gatekeeper: { gracePeriodSeconds: 99999 } },
          { gatekeeper: { strictChecks: ["build"] } },
          { repository: { private: true } },
          { repository: { archived: true } },
        ];
      },
    );
    When(`the corpus runs through the published schema and the runtime validator`, () => {
      if (corpus === undefined) throw new Error("The corpus has not been built yet.");
      verdicts = corpus.map((doc) => ({
        doc,
        schema: validate(doc) as boolean,
        runtime: parseConfig(doc).ok,
      }));
    });
    Then(`their verdicts agree on every document`, () => {
      if (verdicts === undefined) throw new Error("The corpus has not run yet.");

      expect(verdicts.length).toBeGreaterThan(0);
      const disagreements = verdicts.filter((verdict) => verdict.schema !== verdict.runtime);
      expect(
        disagreements,
        `schema and runtime disagree: ${JSON.stringify(disagreements)}`,
      ).toEqual([]);
    });
  });

  Scenario(`Hover on rulesets`, ({ When, Then }) => {
    let rulesets: Record<string, unknown> | undefined;

    When(`an editor hovers the "rulesets" key in a "woodhouse.yml"`, () => {
      rulesets = schemaProperty("rulesets");
    });
    Then(
      `the schema shows guidance including the supported rule types, the "ref_name" condition shape, and a worked example`,
      () => {
        if (rulesets === undefined) throw new Error("The rulesets node has not been read yet.");
        const description = rulesets.description;
        if (typeof description !== "string") {
          throw new Error("The rulesets node carries no description.");
        }

        expect(description).toContain("ref_name");
        // Two names that appear in the supported-rule-types prose.
        expect(description).toContain("workflows");
        expect(description).toContain("code_scanning");

        const examples = rulesets.examples;
        expect(Array.isArray(examples) && examples.length > 0).toBe(true);
      },
    );
  });

  Scenario(`Example on a fiddly field`, ({ When, Then }) => {
    let strictChecks: Record<string, unknown> | undefined;

    When(`an editor requests completion for "strictChecks"`, () => {
      strictChecks = schemaProperty("gatekeeper", "strictChecks");
    });
    Then(`the schema offers an example value`, () => {
      if (strictChecks === undefined) {
        throw new Error("The strictChecks node has not been read yet.");
      }
      const examples = strictChecks.examples;
      expect(Array.isArray(examples) && examples.length > 0).toBe(true);
    });
  });

  Scenario(`Prune described truthfully`, ({ When, Then, And }) => {
    let description: string | undefined;

    const requireDescription = (): string => {
      if (description === undefined)
        throw new Error("The pruneRulesets description has not been read yet.");
      return description;
    };

    When(`the "pruneRulesets" description is read from the schema`, () => {
      const node = schemaProperty("settings", "pruneRulesets");
      if (typeof node.description !== "string") {
        throw new Error("The pruneRulesets node carries no description.");
      }
      description = node.description;
    });
    Then(
      `it states that every ruleset absent from the configuration is deleted, including hand-made ones`,
      () => {
        expect(requireDescription()).toContain("not named in this configuration");
        expect(requireDescription()).toContain("including rulesets created outside Woodhouse");
      },
    );
    And(`that the setting is off by default`, () => {
      expect(requireDescription()).toContain("Off by default");
    });
  });
});
