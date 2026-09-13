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
      readFileSync(
        fileURLToPath(new URL("../woodhouse.example.yml", import.meta.url)),
        "utf8",
      ),
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

  it("both accept a bot login and reject a slashed one", () => {
    expect(bothAccept({ autoApproval: { allowedActors: ["renovate[bot]"] } }))
      .toEqual({ schema: true, runtime: true });
    expect(bothAccept({ autoApproval: { allowedActors: ["org/team"] } }))
      .toEqual({ schema: false, runtime: false });
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
