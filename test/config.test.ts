import { describe, expect, it } from "vitest";
import { deepMerge } from "../src/config/merge.js";
import { parseConfig } from "../src/config/schema.js";

describe("deepMerge", () => {
  it("leaves the base untouched when the override is undefined", () => {
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 });
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

describe("config schema", () => {
  it("fills defaults for an empty config", () => {
    const result = parseConfig({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.gatekeeper.enabled).toBe(true);
    expect(result.config.settings.enabled).toBe(true);
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

  it("accepts distinct owners", () => {
    expect(parseConfig({ autoApproval: { allowedActors: { owners: ["alice", "bob"] } } }).ok).toBe(
      true,
    );
  });

  it("rejects owners that differ only in case", () => {
    const result = parseConfig({
      autoApproval: { allowedActors: { owners: ["foo", "Foo"] } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.message).join("\n")).toContain(
      'duplicate owner "Foo" (already listed as "foo" at index 0)',
    );
    expect(result.issues.map((issue) => issue.path)).toContain(
      "autoApproval.allowedActors.owners.1",
    );
  });

  it("rejects exact duplicate owners", () => {
    const result = parseConfig({
      autoApproval: { allowedActors: { owners: ["foo", "foo"] } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.message).join("\n")).toContain(
      'duplicate owner "foo" (already listed as "foo" at index 0)',
    );
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
});
