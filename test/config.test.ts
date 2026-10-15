import { describe, expect, it } from "vitest";
import { deepMerge, mergeLayers } from "../src/config/merge.js";
import { parseConfig } from "../src/config/schema.js";

describe("deepMerge", () => {
  it("merges nested objects", () => {
    expect(deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } })).toEqual({
      a: { x: 1, y: 3, z: 4 },
    });
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
    expect(mergeLayers([{ a: 1, b: 1 }, { b: 2, c: 2 }, { c: 3 }])).toEqual({ a: 1, b: 2, c: 3 });
  });
});

describe("config schema", () => {
  it("fills defaults for an empty config", () => {
    const result = parseConfig({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.gatekeeper.enabled).toBe(true);
    expect(result.config.gatekeeper.strictChecks).toEqual([]);
    expect(result.config.autoApproval.protectedPaths).toContain(".github/woodhouse.yml");
  });

  it("rejects unknown keys so typos are not silently ignored", () => {
    // `allowedActor` silently doing nothing would be a security bug.
    const result = parseConfig({ autoApproval: { allowedActor: ["me"] } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toContain("autoApproval");
  });

  it("accepts the owners/bots object form", () => {
    const result = parseConfig({
      autoApproval: { allowedActors: { owners: ["my-user"], bots: ["renovate[bot]"] } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.autoApproval.allowedActors).toEqual({
      owners: ["my-user"],
      bots: ["renovate[bot]"],
    });
  });

  it("defaults both actor lists to empty when allowedActors is omitted", () => {
    const withSection = parseConfig({ autoApproval: { enabled: true } });
    expect(withSection.ok).toBe(true);
    if (withSection.ok) {
      expect(withSection.config.autoApproval.allowedActors).toEqual({ owners: [], bots: [] });
    }

    const withoutSection = parseConfig({});
    expect(withoutSection.ok).toBe(true);
    if (withoutSection.ok) {
      expect(withoutSection.config.autoApproval.allowedActors).toEqual({ owners: [], bots: [] });
    }
  });

  it("rejects the legacy flat allowedActors list", () => {
    const result = parseConfig({
      autoApproval: { allowedActors: ["renovate[bot]"] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path.startsWith("autoApproval.allowedActors"))).toBe(true);
  });

  it("rejects an unknown key inside allowedActors", () => {
    const result = parseConfig({
      autoApproval: { allowedActors: { owners: ["me"], bot: ["renovate[bot]"] } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path.includes("allowedActors"))).toBe(true);
  });

  it("rejects a login containing a slash", () => {
    const result = parseConfig({
      autoApproval: { allowedActors: { bots: ["org/team"] } },
    });
    expect(result.ok).toBe(false);
  });

  it("reports a readable path for nested errors", () => {
    const result = parseConfig({ gatekeeper: { enabled: "yes" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("gatekeeper.enabled");
  });

  it("accepts a ref_name condition", () => {
    const result = parseConfig({
      rulesets: [{ name: "main", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } } }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.rulesets[0]?.conditions).toEqual({
      ref_name: { include: ["~DEFAULT_BRANCH"] },
    });
  });

  it("rejects an organization-only condition key with the condition path", () => {
    // `repository_name` is organization-ruleset-only and would 422 at write time.
    const result = parseConfig({
      rulesets: [
        { name: "main", conditions: { repository_name: { include: ["~DEFAULT_BRANCH"] } } },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.issues.find((i) => i.path.startsWith("rulesets"));
    expect(issue?.path).toBe("rulesets.0.conditions");
    expect(issue?.message).toContain("repository_name");
  });

  it("accepts the User actor type and exempt bypass mode", () => {
    const result = parseConfig({
      rulesets: [
        {
          name: "main",
          bypass_actors: [{ actor_id: 42, actor_type: "User", bypass_mode: "exempt" }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.rulesets[0]?.bypass_actors?.[0]).toEqual({
      actor_id: 42,
      actor_type: "User",
      bypass_mode: "exempt",
    });
  });

  it("rejects duplicate ruleset names case-insensitively", () => {
    const result = parseConfig({ rulesets: [{ name: "main" }, { name: "MAIN" }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const duplicate = result.issues.find((i) => i.path.startsWith("rulesets"));
    expect(duplicate?.message).toContain("MAIN");
    expect(duplicate?.message).toContain("main");
  });

  it("accepts distinct ruleset names", () => {
    const result = parseConfig({ rulesets: [{ name: "main" }, { name: "release" }] });
    expect(result.ok).toBe(true);
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
