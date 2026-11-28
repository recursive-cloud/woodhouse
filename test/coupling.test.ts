import { describe, expect, it } from "vitest";
import { defaultConfig, type WoodhouseConfig } from "../src/config/schema.js";
import { couplingIssues, type CouplingConfig } from "../src/settings/coupling.js";

/** Settings GitHub keeps as-is when a repository does not declare them. */
const COUPLED = {
  allow_squash_merge: true,
  squash_merge_commit_title: "PR_TITLE",
  allow_rebase_merge: false,
  allow_merge_commit: false,
} as const;

function configWith(
  repository: Partial<WoodhouseConfig["repository"]> = COUPLED,
  enabled = true,
  strictChecks: readonly string[] = [],
): CouplingConfig {
  const config = defaultConfig();
  return {
    dressCode: { ...config.dressCode, enabled },
    gatekeeper: { strictChecks: [...strictChecks] },
    repository: { ...repository },
  };
}

describe("couplingIssues", () => {
  it("accepts merge settings explicitly coupled to dress-code", () => {
    expect(couplingIssues(configWith())).toEqual([]);
  });

  it("rejects an unset allow_squash_merge", () => {
    const issues = couplingIssues(configWith({ ...COUPLED, allow_squash_merge: undefined }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("repository.allow_squash_merge");
    expect(issues[0]?.message).toContain("requires `allow_squash_merge: true`");
    expect(issues[0]?.message).toContain("leaves it unset");
  });

  it("rejects squash merges carrying the commit message", () => {
    const issues = couplingIssues(
      configWith({ ...COUPLED, squash_merge_commit_title: "COMMIT_OR_PR_TITLE" }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("repository.squash_merge_commit_title");
    expect(issues[0]?.message).toContain("requires `squash_merge_commit_title: PR_TITLE`");
    expect(issues[0]?.message).toContain('sets it to "COMMIT_OR_PR_TITLE"');
  });

  it("rejects rebase merges", () => {
    const issues = couplingIssues(configWith({ ...COUPLED, allow_rebase_merge: true }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("repository.allow_rebase_merge");
    expect(issues[0]?.message).toContain("requires `allow_rebase_merge: false`");
    expect(issues[0]?.message).toContain("sets it to true");
  });

  it("rejects merge commits", () => {
    const issues = couplingIssues(configWith({ ...COUPLED, allow_merge_commit: true }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("repository.allow_merge_commit");
    expect(issues[0]?.message).toContain("requires `allow_merge_commit: false`");
    expect(issues[0]?.message).toContain("sets it to true");
  });

  it("reports one issue per undeclared merge setting", () => {
    const issues = couplingIssues(configWith({}));
    expect(issues.map((issue) => issue.path)).toEqual([
      "repository.allow_squash_merge",
      "repository.squash_merge_commit_title",
      "repository.allow_rebase_merge",
      "repository.allow_merge_commit",
    ]);
    for (const issue of issues) {
      expect(issue.message).toContain("leaves it unset");
    }
  });

  it("reports nothing when dress-code is disabled, however the merges are set", () => {
    const issues = couplingIssues(
      configWith(
        {
          allow_squash_merge: false,
          squash_merge_commit_title: "COMMIT_OR_PR_TITLE",
          allow_rebase_merge: true,
          allow_merge_commit: true,
        },
        false,
      ),
    );
    expect(issues).toEqual([]);
  });

  it("reports nothing when dress-code is absent", () => {
    expect(couplingIssues({ repository: { allow_rebase_merge: true } })).toEqual([]);
    expect(couplingIssues({})).toEqual([]);
  });
});

describe("couplingIssues — strict-listing dress-code", () => {
  const DRESS_CODE = "woodhouse/dress-code";

  it("rejects strict-listing dress-code while dress-code is disabled", () => {
    const issues = couplingIssues(configWith(COUPLED, false, [DRESS_CODE]));

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("gatekeeper.strictChecks");
    expect(issues[0]?.message).toContain(DRESS_CODE);
    expect(issues[0]?.message).toContain("stay pending forever");
    expect(issues[0]?.message).toContain("`dressCode.enabled: true`");
  });

  it("rejects strict-listing dress-code when the section is absent", () => {
    const issues = couplingIssues({
      gatekeeper: { strictChecks: [DRESS_CODE] },
      repository: { ...COUPLED },
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("gatekeeper.strictChecks");
  });

  it("matches the strict-listing name case-sensitively", () => {
    expect(couplingIssues(configWith(COUPLED, false, ["Woodhouse/dress-code"]))).toEqual([]);
  });

  it("does not add the strict-listing issue while dress-code is enabled", () => {
    const issues = couplingIssues(configWith({}, true, [DRESS_CODE]));

    // The merge-setting rule still applies; the strict-listing rule does not.
    expect(issues.map((issue) => issue.path)).toEqual([
      "repository.allow_squash_merge",
      "repository.squash_merge_commit_title",
      "repository.allow_rebase_merge",
      "repository.allow_merge_commit",
    ]);
  });

  it("stays clean when dress-code is enabled, coupled and strict-listed", () => {
    expect(couplingIssues(configWith(COUPLED, true, [DRESS_CODE]))).toEqual([]);
  });
});
