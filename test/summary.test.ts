import { describe, expect, it } from "vitest";
import { formatApplySummary, type ApplySummary } from "../src/settings/summary.js";

const empty = (dryRun: boolean): ApplySummary => ({ changes: [], failures: [], dryRun });

describe("formatApplySummary", () => {
  it("says nothing needed changing for an empty live summary", () => {
    expect(formatApplySummary(empty(false))).toBe("Repository already matches configuration");
  });

  it("says nothing needed changing for an empty dry-run summary", () => {
    expect(formatApplySummary(empty(true))).toBe("Repository already matches configuration");
  });

  it("lists mixed changes and failures, with the failure detail", () => {
    const summary: ApplySummary = {
      dryRun: false,
      changes: [
        { area: "repository", action: "update", target: "has_issues, has_wiki" },
        { area: "label", action: "create", target: "bug" },
      ],
      failures: [
        {
          area: "rulesets",
          message: "Cannot apply rulesets: upgrade to a paid plan for private repositories",
        },
      ],
    };

    expect(formatApplySummary(summary)).toBe(
      [
        "Applied 2 change(s)",
        "  - repository update: has_issues, has_wiki",
        "  - label create: bug",
        "Failed 1 area(s)",
        "  - rulesets: Cannot apply rulesets: upgrade to a paid plan for private repositories",
      ].join("\n"),
    );
  });

  it("renders the dry-run variant of the headline", () => {
    const summary: ApplySummary = {
      dryRun: true,
      changes: [{ area: "topics", action: "update", target: "home-lab, self-hosted" }],
      failures: [],
    };

    expect(formatApplySummary(summary)).toBe(
      ["DRY_RUN: would apply 1 change(s)", "  - topics update: home-lab, self-hosted"].join("\n"),
    );
  });

  it("lists failures alone when nothing was applied", () => {
    const summary: ApplySummary = {
      dryRun: false,
      changes: [],
      failures: [{ area: "branch-protection", message: "Forbidden applying branch-protection" }],
    };

    expect(formatApplySummary(summary)).toBe(
      ["Failed 1 area(s)", "  - branch-protection: Forbidden applying branch-protection"].join(
        "\n",
      ),
    );
  });
});
