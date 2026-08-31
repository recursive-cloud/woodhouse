import { describe, expect, it } from "vitest";
import { deepMerge, mergeLayers } from "../src/config/merge.js";
import { parseConfig } from "../src/config/schema.js";

describe("deepMerge", () => {
  it("merges nested objects", () => {
    expect(
      deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } }),
    ).toEqual({ a: { x: 1, y: 3, z: 4 } });
  });

  it("replaces arrays rather than concatenating them", () => {
    // Concatenation would make it impossible to shrink an inherited
    // security-relevant list such as allowedActors.
    expect(deepMerge({ a: [1, 2, 3] }, { a: [9] })).toEqual({ a: [9] });
  });

  it("lets an explicit empty array mean none", () => {
    expect(deepMerge({ actors: ["me"] }, { actors: [] })).toEqual({
      actors: [],
    });
  });

  it("leaves the base untouched when the override is undefined", () => {
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it("clears a key with an explicit null", () => {
    expect(deepMerge({ a: 1, b: 2 }, { a: null })).toEqual({ b: 2 });
  });

  it("does not mutate its inputs", () => {
    const base = { a: { b: 1 } };
    deepMerge(base, { a: { b: 2 } });
    expect(base).toEqual({ a: { b: 1 } });
  });

  it("refuses to walk prototype-polluting keys", () => {
    const result = deepMerge<Record<string, unknown>>(
      {},
      JSON.parse('{"__proto__": {"polluted": true}}'),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(result.polluted).toBeUndefined();
  });
});

describe("mergeLayers", () => {
  it("applies layers lowest-precedence first", () => {
    expect(
      mergeLayers([{ a: 1, b: 1 }, { b: 2, c: 2 }, { c: 3 }]),
    ).toEqual({ a: 1, b: 2, c: 3 });
  });
});

describe("config schema", () => {
  it("fills defaults for an empty config", () => {
    const result = parseConfig({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.gatekeeper.enabled).toBe(true);
    expect(result.config.gatekeeper.strictChecks).toEqual([]);
    expect(result.config.autoApproval.protectedPaths).toContain(
      ".github/woodhouse.yml",
    );
  });

  it("rejects unknown keys so typos are not silently ignored", () => {
    // `allowedActor` silently doing nothing would be a security bug.
    const result = parseConfig({ autoApproval: { allowedActor: ["me"] } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toContain("autoApproval");
  });

  it("accepts bot logins", () => {
    const result = parseConfig({
      autoApproval: { allowedActors: ["renovate[bot]", "my-user"] },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a login containing a slash", () => {
    const result = parseConfig({
      autoApproval: { allowedActors: ["org/team"] },
    });
    expect(result.ok).toBe(false);
  });

  it("reports a readable path for nested errors", () => {
    const result = parseConfig({ gatekeeper: { enabled: "yes" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("gatekeeper.enabled");
  });

  it("merges a baseline and a local layer before validating", () => {
    // Validating each layer separately would apply defaults to the local layer
    // and clobber real baseline values.
    const merged = mergeLayers([
      { gatekeeper: { strictChecks: ["build"] }, repository: { has_wiki: false } },
      { gatekeeper: { ignoredChecks: ["coverage"] } },
    ]);
    const result = parseConfig(merged);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.gatekeeper.strictChecks).toEqual(["build"]);
    expect(result.config.gatekeeper.ignoredChecks).toEqual(["coverage"]);
    expect(result.config.repository.has_wiki).toBe(false);
  });
});
