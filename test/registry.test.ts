import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAppDefinitions,
  resolveDefinitions,
  type AppDefinition,
} from "../src/apps/registry.js";
import { ConfigurationError } from "../src/lib/env.js";

const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";

const dir = mkdtempSync(join(tmpdir(), "woodhouse-"));

function configFile(source: string, name = `${Math.random()}.cjs`): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

const defaults = {
  allowedInstallationTargets: ["acme"],
  baselineRepo: ".github-private",
  dryRun: false,
};

describe("loadAppDefinitions", () => {
  it("loads the shipped default config", () => {
    const definitions = loadAppDefinitions("config/apps.cjs", {
      APP_ID: "123",
      PRIVATE_KEY: PEM,
      WEBHOOK_SECRET: "shh",
    } as NodeJS.ProcessEnv);

    expect(Object.keys(definitions)).toEqual(["123"]);
    expect(definitions["123"]).toMatchObject({ appId: 123, webhookSecret: "shh" });
  });

  it("supports several Apps with operator-chosen variable names", () => {
    const path = configFile(`
      module.exports = function (env) {
        return {
          [env.ORG_A_APP_ID]: {
            appId: parseInt(env.ORG_A_APP_ID, 10),
            privateKey: env.ORG_A_PRIVATE_KEY,
            webhookSecret: env.ORG_A_WEBHOOK_SECRET,
            allowedInstallationTargets: ["org-a"],
          },
          [env.ORG_B_APP_ID]: {
            appId: parseInt(env.ORG_B_APP_ID, 10),
            privateKey: env.ORG_B_PRIVATE_KEY,
            webhookSecret: env.ORG_B_WEBHOOK_SECRET,
            allowedInstallationTargets: ["org-b"],
          },
        };
      };
    `);

    const definitions = loadAppDefinitions(path, {
      ORG_A_APP_ID: "111",
      ORG_A_PRIVATE_KEY: PEM,
      ORG_A_WEBHOOK_SECRET: "a",
      ORG_B_APP_ID: "222",
      ORG_B_PRIVATE_KEY: PEM,
      ORG_B_WEBHOOK_SECRET: "b",
    } as NodeJS.ProcessEnv);

    expect(Object.keys(definitions).sort()).toEqual(["111", "222"]);
  });

  it("reports a missing file clearly", () => {
    expect(() =>
      loadAppDefinitions(join(dir, "nope.cjs"), {} as NodeJS.ProcessEnv),
    ).toThrow(/not found/);
  });

  it("rejects a file that does not export a function", () => {
    const path = configFile(`module.exports = { "1": {} };`);
    expect(() => loadAppDefinitions(path, {} as NodeJS.ProcessEnv)).toThrow(
      /must export a function/,
    );
  });

  it("surfaces an error thrown by the config function", () => {
    const path = configFile(`module.exports = function () { throw new Error("boom"); };`);
    expect(() => loadAppDefinitions(path, {} as NodeJS.ProcessEnv)).toThrow(
      /threw: boom/,
    );
  });

  it("rejects unknown keys in an App definition", () => {
    // A typo'd key that silently did nothing could mean an App runs without
    // the allowlist its author believed they had set.
    const path = configFile(`
      module.exports = function () {
        return { "1": { appId: 1, privateKey: "k", webhookSecret: "s", allowedTargets: ["x"] } };
      };
    `);
    expect(() => loadAppDefinitions(path, {} as NodeJS.ProcessEnv)).toThrow(
      /Invalid app configuration/,
    );
  });
});

const def = (over: Partial<AppDefinition> = {}): AppDefinition => ({
  appId: 123,
  privateKey: PEM,
  webhookSecret: "shh",
  ...over,
});

describe("resolveDefinitions", () => {
  it("resolves a single App", () => {
    const [app] = resolveDefinitions({ "123": def() }, defaults);
    expect(app!.appId).toBe(123);
    expect(app!.allowlist.has("acme")).toBe(true);
    expect(app!.baselineRepo).toBe(".github-private");
  });

  it("refuses an empty configuration", () => {
    // Typically means the environment variables the config file reads are
    // unset, which would otherwise start a server that serves nothing.
    expect(() => resolveDefinitions({}, defaults)).toThrow(/No GitHub Apps/);
  });

  it("rejects a key that disagrees with its appId", () => {
    // Webhooks are matched on the key, so a mismatch would silently drop
    // every delivery for that App.
    expect(() => resolveDefinitions({ "999": def({ appId: 123 }) }, defaults))
      .toThrow(/does not match its appId/);
  });

  it("rejects a NaN appId from an unset variable", () => {
    expect(() =>
      resolveDefinitions({ undefined: def({ appId: "undefined" }) }, defaults),
    ).toThrow(/invalid appId/);
  });

  it("accepts a string appId", () => {
    const [app] = resolveDefinitions({ "123": def({ appId: "123" }) }, defaults);
    expect(app!.appId).toBe(123);
  });

  it("per-App allowlist overrides the global default", () => {
    const [app] = resolveDefinitions(
      { "123": def({ allowedInstallationTargets: ["org-a"] }) },
      defaults,
    );
    expect(app!.allowlist.has("org-a")).toBe(true);
    expect(app!.allowlist.has("acme")).toBe(false);
  });

  it("refuses an App with no allowlist from either source", () => {
    expect(() =>
      resolveDefinitions(
        { "123": def() },
        { ...defaults, allowedInstallationTargets: undefined },
      ),
    ).toThrow(/no installation allowlist/);
  });

  it("rejects a wildcard in a per-App allowlist", () => {
    expect(() =>
      resolveDefinitions(
        { "123": def({ allowedInstallationTargets: ["*"] }) },
        defaults,
      ),
    ).toThrow(/wildcard/);
  });

  it("accepts a base64 private key", () => {
    const [app] = resolveDefinitions(
      { "123": def({ privateKey: Buffer.from(PEM).toString("base64") }) },
      defaults,
    );
    expect(app!.privateKey).toBe(PEM);
  });

  it("rejects a private key that is not a PEM", () => {
    expect(() =>
      resolveDefinitions({ "123": def({ privateKey: "nonsense" }) }, defaults),
    ).toThrow(ConfigurationError);
  });

  it("per-App baselineRepo overrides the default", () => {
    const [app] = resolveDefinitions(
      { "123": def({ baselineRepo: ".github" }) },
      defaults,
    );
    expect(app!.baselineRepo).toBe(".github");
  });

  it("keeps Apps isolated from one another", () => {
    const apps = resolveDefinitions(
      {
        "111": def({ appId: 111, allowedInstallationTargets: ["org-a"] }),
        "222": def({ appId: 222, allowedInstallationTargets: ["org-b"] }),
      },
      defaults,
    );

    expect(apps).toHaveLength(2);
    expect(apps[0]!.allowlist.has("org-b")).toBe(false);
    expect(apps[1]!.allowlist.has("org-a")).toBe(false);
  });
});

describe("resolveDefinitions — unset environment variables", () => {
  it("explains a NaN appId from parseInt of an unset variable", () => {
    // `parseInt(env.MISSING, 10)` is NaN, and the computed key becomes the
    // string "undefined". This is the most likely misconfiguration, so it
    // gets a targeted message rather than a schema error.
    expect(() =>
      resolveDefinitions(
        { undefined: { appId: Number.NaN, privateKey: PEM, webhookSecret: "s" } },
        defaults,
      ),
    ).toThrow(/environment variable it reads is not set/);
  });

  it("survives the whole file evaluating to unset variables", () => {
    const path = configFile(`
      module.exports = function (env) {
        return {
          [env.APP_ID]: {
            appId: parseInt(env.APP_ID, 10),
            privateKey: env.PRIVATE_KEY,
            webhookSecret: env.WEBHOOK_SECRET,
          },
        };
      };
    `);
    expect(() => loadAppDefinitions(path, {} as NodeJS.ProcessEnv)).toThrow(
      /is not set/,
    );
  });
});

describe("resolveDefinitions — allowlist sources", () => {
  it("needs no global default when every App sets its own", () => {
    // The environment variable is genuinely optional; this is the
    // configuration a multi-tenant deployment should prefer.
    const apps = resolveDefinitions(
      {
        "111": def({ appId: 111, allowedInstallationTargets: ["org-a"] }),
        "222": def({ appId: 222, allowedInstallationTargets: ["org-b"] }),
      },
      { ...defaults, allowedInstallationTargets: undefined },
    );

    expect(apps).toHaveLength(2);
    expect(apps[0]!.allowlist.describe()).toEqual(["org-a"]);
    expect(apps[1]!.allowlist.describe()).toEqual(["org-b"]);
  });

  it("falls back to the global default per App", () => {
    const apps = resolveDefinitions(
      {
        "111": def({ appId: 111, allowedInstallationTargets: ["org-a"] }),
        "222": def({ appId: 222 }),
      },
      defaults,
    );

    expect(apps[0]!.allowlist.describe()).toEqual(["org-a"]);
    expect(apps[1]!.allowlist.describe()).toEqual(["acme"]);
  });

  it("names both remedies when an App has no allowlist", () => {
    expect(() =>
      resolveDefinitions(
        { "123": def() },
        { ...defaults, allowedInstallationTargets: undefined },
      ),
    ).toThrow(/allowedInstallationTargets.*ALLOWED_INSTALLATION_TARGETS/s);
  });
});
