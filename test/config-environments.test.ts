import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/schema.js";

/** Parse one environment entry under the given name. */
function withEnvironment(name: string, environment: unknown) {
  return parseConfig({ environments: { [name]: environment } });
}

/** Parse a config expected to fail, returning its issues. */
function issuesOf(input: unknown): { path: string; message: string }[] {
  const result = parseConfig(input);
  expect(result.ok).toBe(false);
  return result.ok ? [] : [...result.issues];
}

describe("environments config", () => {
  it("defaults to an empty record when the section is omitted", () => {
    const result = parseConfig({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.environments).toEqual({});
  });

  it("accepts a bare entry because every field is optional", () => {
    const result = withEnvironment("production", {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.environments.production).toEqual({});
  });

  it("accepts an explicit null entry as clearing that environment", () => {
    const result = withEnvironment("staging", null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.environments.staging).toBeNull();
  });

  it("accepts the wait_timer boundaries", () => {
    for (const waitTimer of [0, 43200]) {
      const result = withEnvironment("production", { wait_timer: waitTimer });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.environments.production?.wait_timer).toBe(waitTimer);
    }
  });

  it("rejects wait_timer outside 0-43200", () => {
    for (const waitTimer of [-1, 43201]) {
      const result = withEnvironment("production", { wait_timer: waitTimer });
      expect(result.ok).toBe(false);
    }
  });

  it("accepts absent and explicit null reviewers", () => {
    const absent = withEnvironment("production", {});
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.config.environments.production?.reviewers).toBeUndefined();

    const cleared = withEnvironment("production", { reviewers: null });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.config.environments.production?.reviewers).toBeNull();
  });

  it("requires a present reviewers list to hold between 1 and 6 entries", () => {
    expect(withEnvironment("production", { reviewers: [] }).ok).toBe(false);
    expect(
      withEnvironment("production", {
        reviewers: Array.from({ length: 7 }, () => ({ type: "User", id: 1 })),
      }).ok,
    ).toBe(false);

    const six = withEnvironment("production", {
      reviewers: Array.from({ length: 6 }, (_, index) => ({ type: "User", id: index })),
    });
    expect(six.ok).toBe(true);
  });

  it("validates reviewer type and id", () => {
    expect(withEnvironment("production", { reviewers: [{ type: "Group", id: 1 }] }).ok).toBe(false);
    expect(withEnvironment("production", { reviewers: [{ type: "User" }] }).ok).toBe(false);
    expect(withEnvironment("production", { reviewers: [{ type: "User", id: 1.5 }] }).ok).toBe(
      false,
    );

    const team = withEnvironment("production", { reviewers: [{ type: "Team", id: 42 }] });
    expect(team.ok).toBe(true);
    if (!team.ok) return;
    expect(team.config.environments.production?.reviewers).toEqual([{ type: "Team", id: 42 }]);
  });

  it("accepts can_admins_bypass", () => {
    const result = withEnvironment("production", { can_admins_bypass: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.environments.production?.can_admins_bypass).toBe(false);
  });

  it("accepts a 255-character name and rejects 256", () => {
    expect(withEnvironment("a".repeat(255), {}).ok).toBe(true);
    expect(withEnvironment("a".repeat(256), {}).ok).toBe(false);
  });

  it("rejects names that differ only in case", () => {
    const issues = issuesOf({ environments: { Prod: {}, prod: {} } });
    expect(issues.map((issue) => issue.message).join("\n")).toContain("duplicate environment name");
    expect(issues.map((issue) => issue.path)).toContain("environments.prod");
  });

  it("rejects an unknown field inside an entry", () => {
    const issues = issuesOf({ environments: { production: { wait_timer: 1, waitTimer: 2 } } });
    expect(issues.some((issue) => issue.path.startsWith("environments.production"))).toBe(true);
  });

  it("still rejects an unknown top-level key", () => {
    expect(parseConfig({ environment: {} }).ok).toBe(false);
  });
});
