import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
// The schema declares draft 2020-12, which needs Ajv's 2020 entry point;
// the default export only understands draft-07.
import Ajv from "ajv/dist/2020.js";
import { buildJsonSchema, SCHEMA_FILE } from "../src/config/json-schema.js";
import { parseConfig } from "../src/config/schema.js";

const committed = readFileSync(
  fileURLToPath(new URL(`../${SCHEMA_FILE}`, import.meta.url)),
  "utf8",
);

const ajv = new Ajv({ strict: false, allErrors: true });
const validate = ajv.compile(JSON.parse(committed));

/** Does the published schema agree with the runtime validator? */
function bothAccept(doc: unknown): { schema: boolean; runtime: boolean } {
  return { schema: validate(doc) as boolean, runtime: parseConfig(doc).ok };
}

describe("committed JSON Schema", () => {
  it("is up to date with the zod definitions", () => {
    // Also enforced in CI by `npm run schema:check`, which prints a clearer
    // message than the JSON diff below. If this fails, run
    // `npm run schema:generate` and commit the result.
    expect(committed === buildJsonSchema()).toBe(true);
  });

  it("is valid JSON Schema", () => {
    expect(typeof validate).toBe("function");
  });
});

describe("schema and runtime agree", () => {
  it("both accept an empty config", () => {
    expect(bothAccept({})).toEqual({ schema: true, runtime: true });
  });

  it("both accept the shipped example", () => {
    const doc = yaml.load(
      readFileSync(fileURLToPath(new URL("../woodhouse.example.yml", import.meta.url)), "utf8"),
    );
    expect(bothAccept(doc)).toEqual({ schema: true, runtime: true });
  });

  it("both reject an unknown top-level key", () => {
    expect(bothAccept({ gatekeper: {} })).toEqual({
      schema: false,
      runtime: false,
    });
  });

  it("both reject a misspelled autoApproval key", () => {
    // The case that makes the schema worth having: an editor catches this
    // before it is ever pushed.
    expect(bothAccept({ autoApproval: { allowedActor: ["me"] } })).toEqual({
      schema: false,
      runtime: false,
    });
  });

  it("both reject a wrong type", () => {
    expect(bothAccept({ gatekeeper: { enabled: "yes" } })).toEqual({
      schema: false,
      runtime: false,
    });
  });

  it("both reject settings this app refuses to manage", () => {
    expect(bothAccept({ repository: { private: true } })).toEqual({
      schema: false,
      runtime: false,
    });
    expect(bothAccept({ repository: { archived: true } })).toEqual({
      schema: false,
      runtime: false,
    });
  });

  it("both reject an out-of-range grace period", () => {
    expect(bothAccept({ gatekeeper: { gracePeriodSeconds: 99999 } })).toEqual({
      schema: false,
      runtime: false,
    });
  });

  it("both accept the owners/bots actor lists and reject a slashed login", () => {
    expect(
      bothAccept({
        autoApproval: { allowedActors: { owners: ["my-user"], bots: ["renovate[bot]"] } },
      }),
    ).toEqual({ schema: true, runtime: true });
    expect(bothAccept({ autoApproval: { allowedActors: { bots: ["org/team"] } } })).toEqual({
      schema: false,
      runtime: false,
    });
  });

  it("both reject the legacy flat allowedActors array", () => {
    expect(bothAccept({ autoApproval: { allowedActors: ["renovate[bot]"] } })).toEqual({
      schema: false,
      runtime: false,
    });
  });

  it("does not require fields that carry defaults", () => {
    // Generated in "input" mode; output mode would mark every defaulted field
    // required and flag a minimal config as broken.
    expect(bothAccept({ gatekeeper: { strictChecks: ["build"] } })).toEqual({
      schema: true,
      runtime: true,
    });
  });
});

/**
 * The documentation pass (`document-config-schema`) promises hover text on
 * every field and worked examples for the fiddliest three. These guards read
 * the committed schema, so they also catch a description added to the zod
 * source but never regenerated into the published JSON.
 */
const document = JSON.parse(committed) as Record<string, unknown>;

/** Walk `properties` down a path in the committed schema JSON. */
function schemaProperty(...path: string[]): Record<string, unknown> {
  let node = document;
  for (const key of path) {
    node = (node.properties as Record<string, Record<string, unknown>>)[key];
  }
  return node;
}

describe("published documentation", () => {
  it("every field carries a description", () => {
    const missing: string[] = [];

    function walk(node: Record<string, unknown>, trail: string): void {
      const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
      if (properties !== undefined) {
        for (const [key, child] of Object.entries(properties)) {
          const here = trail === "" ? key : `${trail}.${key}`;
          if (typeof child.description !== "string" || child.description.length === 0) {
            missing.push(here);
          }
          walk(child, here);
        }
      }

      const additional = node.additionalProperties;
      if (typeof additional === "object" && additional !== null && !Array.isArray(additional)) {
        walk(additional as Record<string, unknown>, trail);
      }

      const items = node.items;
      if (typeof items === "object" && items !== null && !Array.isArray(items)) {
        walk(items as Record<string, unknown>, trail);
      }

      if (Array.isArray(node.anyOf)) {
        for (const branch of node.anyOf) {
          if (typeof branch === "object" && branch !== null) {
            walk(branch as Record<string, unknown>, trail);
          }
        }
      }
    }

    walk(document, "");
    expect(missing).toEqual([]);
  });

  it("the fiddly fields carry examples the schema and runtime both accept", () => {
    const strictChecks = schemaProperty("gatekeeper", "strictChecks").examples;
    const protectedPaths = schemaProperty("autoApproval", "protectedPaths").examples;
    const rulesets = schemaProperty("rulesets").examples;

    expect(Array.isArray(strictChecks) && strictChecks.length > 0).toBe(true);
    expect(Array.isArray(protectedPaths) && protectedPaths.length > 0).toBe(true);
    expect(Array.isArray(rulesets) && rulesets.length > 0).toBe(true);

    for (const example of strictChecks as unknown[]) {
      expect(bothAccept({ gatekeeper: { strictChecks: example } })).toEqual({
        schema: true,
        runtime: true,
      });
    }
    for (const example of protectedPaths as unknown[]) {
      expect(bothAccept({ autoApproval: { protectedPaths: example } })).toEqual({
        schema: true,
        runtime: true,
      });
    }
    for (const example of rulesets as unknown[]) {
      expect(bothAccept({ rulesets: example })).toEqual({ schema: true, runtime: true });
    }
  });
});
