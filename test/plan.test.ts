import { describe, expect, it } from "vitest";
import {
  diffRepositorySettings,
  planLabels,
  planRulesets,
  topicsDiffer,
  type ExistingLabel,
} from "../src/settings/plan.js";
import { repositorySchema } from "../src/config/schema.js";

const repo = (o: Record<string, unknown>) => repositorySchema.parse(o);

describe("diffRepositorySettings", () => {
  it("returns nothing when already correct", () => {
    expect(
      diffRepositorySettings({ has_issues: true }, repo({ has_issues: true })),
    ).toEqual({});
  });

  it("returns only the changed fields", () => {
    const patch = diffRepositorySettings(
      { has_issues: true, has_wiki: true },
      repo({ has_issues: true, has_wiki: false }),
    );
    expect(patch).toEqual({ has_wiki: false });
  });

  it("distinguishes false from absent", () => {
    // `false` is a real desired value, not "unset"; it must still be sent.
    expect(
      diffRepositorySettings({ has_wiki: true }, repo({ has_wiki: false })),
    ).toEqual({ has_wiki: false });
  });

  it("never emits topics through the repository endpoint", () => {
    expect(
      diffRepositorySettings({}, repo({ topics: ["a"] })),
    ).toEqual({});
  });
});

describe("topicsDiffer", () => {
  it("ignores order", () => {
    expect(topicsDiffer(["b", "a"], ["a", "b"])).toBe(false);
  });

  it("ignores case", () => {
    expect(topicsDiffer(["Home-Lab"], ["home-lab"])).toBe(false);
  });

  it("detects additions and removals", () => {
    expect(topicsDiffer(["a"], ["a", "b"])).toBe(true);
    expect(topicsDiffer(["a", "b"], ["a"])).toBe(true);
  });

  it("treats an empty desired list as a removal", () => {
    expect(topicsDiffer(["a"], [])).toBe(true);
  });
});

const existing = (...labels: [string, string, string | null][]): ExistingLabel[] =>
  labels.map(([name, color, description]) => ({ name, color, description }));

describe("planLabels", () => {
  it("creates missing labels", () => {
    const plan = planLabels([], [{ name: "bug", color: "d73a4a" }], false);
    expect(plan.create).toHaveLength(1);
    expect(plan.update).toHaveLength(0);
  });

  it("does nothing when a label already matches", () => {
    const plan = planLabels(
      existing(["bug", "d73a4a", "Something broken"]),
      [{ name: "bug", color: "d73a4a", description: "Something broken" }],
      false,
    );
    expect(plan.create).toHaveLength(0);
    expect(plan.update).toHaveLength(0);
  });

  it("ignores a leading # and colour casing", () => {
    const plan = planLabels(
      existing(["bug", "d73a4a", null]),
      [{ name: "bug", color: "#D73A4A" }],
      false,
    );
    expect(plan.update).toHaveLength(0);
  });

  it("updates a changed colour", () => {
    const plan = planLabels(
      existing(["bug", "ffffff", null]),
      [{ name: "bug", color: "000000" }],
      false,
    );
    expect(plan.update).toHaveLength(1);
  });

  it("treats a null description as empty", () => {
    const plan = planLabels(
      existing(["bug", "ffffff", null]),
      [{ name: "bug", description: "" }],
      false,
    );
    expect(plan.update).toHaveLength(0);
  });

  it("does not prune unless asked", () => {
    const plan = planLabels(existing(["stale", "ffffff", null]), [], false);
    expect(plan.delete).toEqual([]);
  });

  it("prunes unmanaged labels when enabled", () => {
    const plan = planLabels(
      existing(["stale", "ffffff", null], ["bug", "ffffff", null]),
      [{ name: "bug" }],
      true,
    );
    expect(plan.delete).toEqual(["stale"]);
  });

  it("renames when the source exists and the target does not", () => {
    const plan = planLabels(
      existing(["wontfix", "ffffff", null]),
      [{ name: "won't fix", from: "wontfix" }],
      false,
    );
    expect(plan.rename).toHaveLength(1);
    expect(plan.create).toHaveLength(0);
  });

  it("does not re-run a rename that already happened", () => {
    // Idempotency: on the second push the source is gone and the target
    // exists. Renaming again would 404.
    const plan = planLabels(
      existing(["won't fix", "ffffff", null]),
      [{ name: "won't fix", from: "wontfix" }],
      false,
    );
    expect(plan.rename).toHaveLength(0);
    expect(plan.create).toHaveLength(0);
  });

  it("does not delete the rename source when pruning", () => {
    const plan = planLabels(
      existing(["wontfix", "ffffff", null]),
      [{ name: "won't fix", from: "wontfix" }],
      true,
    );
    expect(plan.delete).toEqual([]);
  });

  it("corrects casing of an existing label", () => {
    const plan = planLabels(
      existing(["Bug", "ffffff", null]),
      [{ name: "bug" }],
      false,
    );
    expect(plan.update).toHaveLength(1);
  });
});

describe("planRulesets", () => {
  it("creates a ruleset that does not exist", () => {
    const plan = planRulesets([], [{ name: "main", target: "branch", enforcement: "active", rules: [] }], false);
    expect(plan.create).toHaveLength(1);
  });

  it("updates by name when one exists", () => {
    const plan = planRulesets(
      [{ id: 7, name: "main" }],
      [{ name: "main", target: "branch", enforcement: "active", rules: [] }],
      false,
    );
    expect(plan.update).toEqual([
      { id: 7, ruleset: expect.objectContaining({ name: "main" }) },
    ]);
    expect(plan.create).toHaveLength(0);
  });

  it("does not delete unmanaged rulesets unless pruning", () => {
    const plan = planRulesets([{ id: 1, name: "manual" }], [], false);
    expect(plan.delete).toEqual([]);
  });

  it("prunes when enabled", () => {
    const plan = planRulesets([{ id: 1, name: "manual" }], [], true);
    expect(plan.delete).toEqual([{ id: 1, name: "manual" }]);
  });
});
