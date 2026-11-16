import { describe, expect, it } from "vitest";
import { SIGN_OFF } from "../src/approval/wording.js";
import {
  SETTINGS_APPLIED_MARKER,
  buildSettingsAppliedComment,
  isMergedSettingsChange,
} from "../src/settings/mergeFeedback.js";
import type { ApplySummary } from "../src/settings/summary.js";
import type { ChangedFile } from "../src/github/pulls.js";

const file = (filename: string, status = "modified", previous_filename?: string): ChangedFile => ({
  filename,
  status,
  previous_filename,
});

describe("isMergedSettingsChange", () => {
  it("requires the pull request to have merged", () => {
    expect(
      isMergedSettingsChange(false, "main", "main", [file(".github/woodhouse.yml", "added")]),
    ).toBe(false);
  });

  it("requires the merge to have landed on the default branch", () => {
    expect(isMergedSettingsChange(true, "feature", "main", [file(".github/woodhouse.yml")])).toBe(
      false,
    );
  });

  it.each(["added", "modified", "removed"])("counts a settings file %s", (status) => {
    expect(
      isMergedSettingsChange(true, "main", "main", [file(".github/woodhouse.yml", status)]),
    ).toBe(true);
  });

  it("counts each of the four settings paths", () => {
    for (const path of [
      ".github/woodhouse.yml",
      ".github/woodhouse.yaml",
      "woodhouse.yml",
      "woodhouse.yaml",
    ]) {
      expect(isMergedSettingsChange(true, "main", "main", [file(path)])).toBe(true);
    }
  });

  it("ignores a merge that touches no settings file", () => {
    expect(
      isMergedSettingsChange(true, "main", "main", [file("src/index.ts"), file("README.md")]),
    ).toBe(false);
  });

  it("is false when the file list is empty", () => {
    expect(isMergedSettingsChange(true, "main", "main", [])).toBe(false);
  });

  it.each([
    "docs/woodhouse.yml",
    "woodhouse.yml.bak",
    ".github/woodhouse.yaml.bak",
    "sub/.github/woodhouse.yml",
  ])("rejects the near-miss %s", (path) => {
    expect(isMergedSettingsChange(true, "main", "main", [file(path, "added")])).toBe(false);
  });

  it("counts a rename away from a settings path", () => {
    expect(
      isMergedSettingsChange(true, "main", "main", [
        file("config/old.yml", "renamed", ".github/woodhouse.yml"),
      ]),
    ).toBe(true);
  });

  it("counts a rename into a settings path", () => {
    expect(
      isMergedSettingsChange(true, "main", "main", [
        file(".github/woodhouse.yml", "renamed", "config/old.yml"),
      ]),
    ).toBe(true);
  });

  it("ignores a rename that involves no settings path", () => {
    expect(
      isMergedSettingsChange(true, "main", "main", [file("src/b.ts", "renamed", "src/a.ts")]),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * Outcome comment builder
 * ---------------------------------------------------------------------- */

const summary = (
  changes: ApplySummary["changes"] = [],
  failures: ApplySummary["failures"] = [],
): ApplySummary => ({ changes, failures, dryRun: false });

describe("buildSettingsAppliedComment", () => {
  it("reports changes and failures together", () => {
    expect(
      buildSettingsAppliedComment(
        summary(
          [{ area: "label", action: "create", target: "bug" }],
          [{ area: "rulesets", message: "Forbidden" }],
        ),
        false,
      ),
    ).toBe(
      `${SETTINGS_APPLIED_MARKER}\n` +
        "**Woodhouse here, sir. I have applied the settings changed by this merge.**\n" +
        "\n" +
        "Applied:\n" +
        "- label create: bug\n" +
        "\n" +
        "Failed:\n" +
        "- rulesets: Forbidden\n" +
        "\n" +
        SIGN_OFF,
    );
  });

  it("combines a baseline change with an applied change", () => {
    expect(
      buildSettingsAppliedComment(
        summary([{ area: "label", action: "create", target: "bug" }]),
        true,
      ),
    ).toBe(
      `${SETTINGS_APPLIED_MARKER}\n` +
        "**Woodhouse here, sir. I have applied the settings changed by this merge.**\n" +
        "\n" +
        "Applied:\n" +
        "- label create: bug\n" +
        "\n" +
        "This is the baseline repository, sir, so it has been synced directly. " +
        "Other repositories will adopt the change at their next event.\n" +
        "\n" +
        SIGN_OFF,
    );
  });
});
