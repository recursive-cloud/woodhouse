import { describe, expect, it } from "vitest";
import { BASELINE_PATHS, isSettingsPath, LOCAL_PATHS } from "../src/config/paths.js";

// The four exact settings-file paths: two local overrides, two baselines.
const SETTINGS_PATHS = [
  ".github/woodhouse.yml",
  ".github/woodhouse.yaml",
  "woodhouse.yml",
  "woodhouse.yaml",
];

describe("isSettingsPath", () => {
  it.each(SETTINGS_PATHS)("matches the exact path %s", (path) => {
    expect(isSettingsPath(path)).toBe(true);
  });

  it.each([
    "docs/woodhouse.yml",
    "sub/.github/woodhouse.yml",
    "woodhouse.yml.example",
    "WOODHOUSE.yml",
  ])("rejects the near-miss %s", (path) => {
    expect(isSettingsPath(path)).toBe(false);
  });

  it("classifies exactly the exported local and baseline paths", () => {
    expect([...LOCAL_PATHS, ...BASELINE_PATHS]).toEqual(SETTINGS_PATHS);
  });
});
