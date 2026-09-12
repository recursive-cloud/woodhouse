import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  loadEnv,
  parseAllowedTargets,
  parseBaselineRepo,
} from "../src/lib/env.js";

describe("parseAllowedTargets", () => {
  it("parses a JSON array", () => {
    expect(parseAllowedTargets('["a", "b"]')).toEqual(["a", "b"]);
  });

  it("parses a comma-separated list", () => {
    expect(parseAllowedTargets("a, b ,c")).toEqual(["a", "b", "c"]);
  });

  it("parses a single value", () => {
    expect(parseAllowedTargets("solo")).toEqual(["solo"]);
  });

  it.each([undefined, "", "   ", "[]", ",,,"])(
    "refuses empty input %p",
    (input) => {
      // Fail-closed: an empty allowlist must never mean "allow everything".
      expect(() => parseAllowedTargets(input)).toThrow(ConfigurationError);
    },
  );

  it.each(["*", "all", '["*"]', "me,*"])("refuses wildcard %p", (input) => {
    expect(() => parseAllowedTargets(input)).toThrow(/wildcard/);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseAllowedTargets('["a"')).toThrow(ConfigurationError);
  });

  it("rejects non-string array members", () => {
    expect(() => parseAllowedTargets("[1, 2]")).toThrow(ConfigurationError);
  });
});

const baseEnv = {
  ALLOWED_INSTALLATION_TARGETS: "me",
};

describe("loadEnv", () => {
  it("loads a valid environment", () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.allowedInstallationTargets).toEqual(["me"]);
    expect(env.appsConfigPath).toBe("config/apps.cjs");
    expect(env.port).toBe(3000);
    expect(env.baselineRepo).toBe(".github-private");
  });

  it("no longer requires App credentials", () => {
    // Credentials belong to individual Apps now and are assembled by the
    // configuration file, which may read any variable names the operator's
    // secret tooling produces.
    expect(() => loadEnv({ ...baseEnv })).not.toThrow();
  });

  it("allows an absent allowlist, deferring to per-App config", () => {
    // Still fail-closed overall: the registry refuses to start an App that
    // ends up with no allowlist from either source.
    expect(loadEnv({}).allowedInstallationTargets).toBeUndefined();
  });

  it("still rejects a wildcard allowlist", () => {
    expect(() => loadEnv({ ALLOWED_INSTALLATION_TARGETS: "*" })).toThrow(
      /wildcard/,
    );
  });

  it("honours APPS_CONFIG_PATH", () => {
    expect(loadEnv({ APPS_CONFIG_PATH: "/etc/woodhouse/apps.cjs" }).appsConfigPath)
      .toBe("/etc/woodhouse/apps.cjs");
  });

  it.each(["0", "70000", "abc"])("rejects invalid PORT %p", (port) => {
    expect(() => loadEnv({ ...baseEnv, PORT: port })).toThrow(/PORT/);
  });

  it("rejects an unknown LOG_LEVEL", () => {
    expect(() => loadEnv({ ...baseEnv, LOG_LEVEL: "chatty" })).toThrow(
      /LOG_LEVEL/,
    );
  });

  it("parses DRY_RUN", () => {
    expect(loadEnv({ ...baseEnv, DRY_RUN: "true" }).dryRun).toBe(true);
    expect(loadEnv({ ...baseEnv, DRY_RUN: "no" }).dryRun).toBe(false);
    expect(loadEnv({ ...baseEnv }).dryRun).toBe(false);
  });
});

describe("parseBaselineRepo", () => {
  it("defaults to .github-private", () => {
    // Not `.github`: that repo must be public for several built-in GitHub
    // features, and the baseline holds the auto-approval actor list.
    expect(parseBaselineRepo(undefined)).toBe(".github-private");
    expect(parseBaselineRepo("  ")).toBe(".github-private");
  });

  it("accepts an override", () => {
    expect(parseBaselineRepo(".github")).toBe(".github");
    expect(parseBaselineRepo("org-config")).toBe("org-config");
  });

  it("rejects an owner/repo pair", () => {
    // The owner is always the installation account; accepting a qualified
    // name would silently read from somewhere other than intended.
    expect(() => parseBaselineRepo("someone-else/.github")).toThrow(
      /repository name only/,
    );
  });

  it("rejects invalid repository names", () => {
    expect(() => parseBaselineRepo("has space")).toThrow(ConfigurationError);
    expect(() => parseBaselineRepo("../escape")).toThrow(ConfigurationError);
  });
});
