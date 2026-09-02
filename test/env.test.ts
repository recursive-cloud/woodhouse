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

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";

const baseEnv = {
  APP_ID: "123",
  PRIVATE_KEY: PEM,
  WEBHOOK_SECRET: "shh",
  ALLOWED_INSTALLATION_TARGETS: "me",
};

describe("loadEnv", () => {
  it("loads a valid environment", () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.appId).toBe("123");
    expect(env.privateKey).toContain("BEGIN RSA PRIVATE KEY");
    expect(env.allowedInstallationTargets).toEqual(["me"]);
    expect(env.port).toBe(3000);
  });

  it("accepts a base64-encoded private key", () => {
    const env = loadEnv({
      ...baseEnv,
      PRIVATE_KEY: Buffer.from(PEM).toString("base64"),
    });
    expect(env.privateKey).toBe(PEM);
  });

  it("un-escapes literal \\n in a single-line key", () => {
    const env = loadEnv({
      ...baseEnv,
      PRIVATE_KEY: PEM.replace(/\n/g, "\\n"),
    });
    expect(env.privateKey).toBe(PEM);
  });

  it("rejects a key that is not a PEM", () => {
    expect(() => loadEnv({ ...baseEnv, PRIVATE_KEY: "nonsense" })).toThrow(
      /PEM/,
    );
  });

  it.each(["APP_ID", "PRIVATE_KEY", "WEBHOOK_SECRET"])(
    "requires %s",
    (key) => {
      const env: Record<string, string> = { ...baseEnv };
      delete env[key];
      expect(() => loadEnv(env)).toThrow(ConfigurationError);
    },
  );

  it("requires the allowlist", () => {
    const env: Record<string, string> = { ...baseEnv };
    delete env.ALLOWED_INSTALLATION_TARGETS;
    expect(() => loadEnv(env)).toThrow(/allowlist/);
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
