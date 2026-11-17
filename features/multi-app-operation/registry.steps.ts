import { expect } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";
import type { Logger } from "pino";
import {
  AppRegistry,
  loadAppDefinitions,
  resolveDefinitions,
  type AppDefinition,
  type RegistryDefaults,
} from "../../src/apps/registry.js";
import { ConfigurationError } from "../../src/lib/env.js";
import { handleHealth } from "../../src/health.js";
import { fakeLogger } from "../support/scenario.js";

const feature = await loadFeature("features/multi-app-operation/registry.feature");

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";

const dir = mkdtempSync(join(tmpdir(), "woodhouse-registry-"));

function configFile(source: string): string {
  const path = join(dir, `${Math.random()}.cjs`);
  writeFileSync(path, source);
  return path;
}

const defaults: RegistryDefaults = {
  allowedInstallationTargets: ["acme"],
  baselineRepo: ".github-private",
  dryRun: true,
};

const twoAppConfig = `
  module.exports = function (env) {
    return {
      [env.ORG_A_APP_ID]: {
        appId: parseInt(env.ORG_A_APP_ID, 10),
        label: "org-a-app",
        privateKey: env.ORG_A_PRIVATE_KEY,
        webhookSecret: "a",
        allowedInstallationTargets: ["org-a"],
      },
      [env.ORG_B_APP_ID]: {
        appId: parseInt(env.ORG_B_APP_ID, 10),
        label: "org-b-app",
        privateKey: env.ORG_B_PRIVATE_KEY,
        webhookSecret: "b",
        allowedInstallationTargets: ["org-b"],
      },
    };
  };
`;

const twoAppEnv = {
  ORG_A_APP_ID: "111",
  ORG_A_PRIVATE_KEY: PEM,
  ORG_B_APP_ID: "222",
  ORG_B_PRIVATE_KEY: PEM,
} as NodeJS.ProcessEnv;

/** The registry plus the definitions it was built from. */
interface TwoAppRegistry {
  readonly registry: AppRegistry;
  readonly definitions: Record<string, AppDefinition>;
}

/** Startup as `server.ts` performs it: load the file, then build the registry. */
async function createTwoAppRegistry(log: Logger): Promise<TwoAppRegistry> {
  const definitions = loadAppDefinitions(configFile(twoAppConfig), twoAppEnv);
  const registry = await AppRegistry.create(definitions, defaults, log);
  return { registry, definitions };
}

describeFeature(feature, ({ Scenario }) => {
  Scenario(`Two Apps, one container`, ({ Given, When, Then, And }) => {
    let path: string | undefined;
    let env: NodeJS.ProcessEnv | undefined;
    let registry: AppRegistry | undefined;
    const { log, info } = fakeLogger();

    const requireRegistry = (): AppRegistry => {
      if (registry === undefined) {
        throw new Error("The registry has not been created yet.");
      }
      return registry;
    };

    Given(
      `a definition file configuring Apps "111" as "org-a-app" and "222" as "org-b-app"`,
      () => {
        path = configFile(twoAppConfig);
        env = twoAppEnv;
      },
    );
    When(`the registry is created at startup`, async () => {
      if (path === undefined || env === undefined) {
        throw new Error("The definition file has not been prepared yet.");
      }
      const definitions = loadAppDefinitions(path, env);
      registry = await AppRegistry.create(definitions, defaults, log);
    });
    Then(`both Apps are registered`, () => {
      const built = requireRegistry();
      expect(built.size).toBe(2);
      expect(built.get(111)?.label).toBe("org-a-app");
      expect(built.get(222)?.label).toBe("org-b-app");
    });
    And(`the startup log lists the labels "org-a-app" and "org-b-app"`, () => {
      requireRegistry();
      const registered = (label: string): boolean =>
        info.mock.calls.some(
          ([fields, message]) =>
            message === "Registered GitHub App" &&
            (fields as { app?: unknown } | undefined)?.app === label,
        );
      expect(registered("org-a-app")).toBe(true);
      expect(registered("org-b-app")).toBe(true);
    });
  });

  Scenario(`Per-App allowlist overrides the default`, ({ Given, When, Then, And }) => {
    let resolved: ReturnType<typeof resolveDefinitions> | undefined;
    let definitions: Record<string, AppDefinition> | undefined;

    const requireApp = (): ReturnType<typeof resolveDefinitions>[number] => {
      if (resolved === undefined) {
        throw new Error("The settings have not been resolved yet.");
      }
      const [first] = resolved;
      if (first === undefined) {
        throw new Error("The resolution produced no App.");
      }
      return first;
    };

    Given(`a global default allowlist of "acme" and baseline repository ".github-private"`, () => {
      expect(defaults.allowedInstallationTargets).toEqual(["acme"]);
      expect(defaults.baselineRepo).toBe(".github-private");
    });
    And(`an App definition setting its own allowed installation targets to "org-a"`, () => {
      definitions = {
        "111": {
          appId: 111,
          privateKey: PEM,
          webhookSecret: "s",
          allowedInstallationTargets: ["org-a"],
        },
      };
    });
    When(`the App's settings are resolved`, () => {
      if (definitions === undefined) {
        throw new Error("The App definition has not been built yet.");
      }
      resolved = resolveDefinitions(definitions, defaults);
    });
    Then(`the App's boundary is "org-a" and not "acme"`, () => {
      const app = requireApp();
      expect(app.allowlist.has("org-a")).toBe(true);
      expect(app.allowlist.has("acme")).toBe(false);
    });
    And(`the App's baseline repository is the default ".github-private"`, () => {
      expect(requireApp().baselineRepo).toBe(".github-private");
    });
  });

  Scenario(
    `An App without its own settings inherits the global defaults`,
    ({ Given, When, Then, And }) => {
      let resolved: ReturnType<typeof resolveDefinitions> | undefined;
      let definitions: Record<string, AppDefinition> | undefined;

      const requireApp = (): ReturnType<typeof resolveDefinitions>[number] => {
        if (resolved === undefined) {
          throw new Error("The defaults have not been applied yet.");
        }
        const [first] = resolved;
        if (first === undefined) {
          throw new Error("The resolution produced no App.");
        }
        return first;
      };

      Given(
        `a global default allowlist of "acme" and baseline repository ".github-private"`,
        () => {
          expect(defaults.allowedInstallationTargets).toEqual(["acme"]);
          expect(defaults.baselineRepo).toBe(".github-private");
        },
      );
      And(`an App definition with no allowlist and no baseline repository of its own`, () => {
        definitions = { "222": { appId: 222, privateKey: PEM, webhookSecret: "s" } };
      });
      When(`the defaults are applied to the App`, () => {
        if (definitions === undefined) {
          throw new Error("The App definition has not been built yet.");
        }
        resolved = resolveDefinitions(definitions, defaults);
      });
      Then(`the App's boundary is "acme" and its baseline repository is ".github-private"`, () => {
        const app = requireApp();
        expect(app.allowlist.describe()).toContain("acme");
        expect(app.allowlist.has("acme")).toBe(true);
        expect(app.baselineRepo).toBe(".github-private");
      });
    },
  );

  Scenario(
    `An unset environment variable makes startup fail naming the App`,
    ({ Given, When, Then }) => {
      let path: string | undefined;
      let env: NodeJS.ProcessEnv | undefined;
      let captured: unknown;

      Given(
        `a definition file whose App is labelled "org-c" and takes its ID from an unset variable`,
        () => {
          path = configFile(`
            module.exports = function (env) {
              return {
                [env.APP_ID]: {
                  appId: parseInt(env.APP_ID, 10),
                  label: env.APP_LABEL,
                  privateKey: env.PRIVATE_KEY,
                  webhookSecret: "shh",
                },
              };
            };
          `);
          // APP_ID is deliberately absent: the file reads it, so the computed
          // key becomes the string "undefined" and the appId becomes NaN.
          env = { APP_LABEL: "org-c", PRIVATE_KEY: PEM } as NodeJS.ProcessEnv;
        },
      );
      When(`the configuration is resolved at startup`, () => {
        if (path === undefined || env === undefined) {
          throw new Error("The definition file has not been prepared yet.");
        }
        try {
          resolveDefinitions(loadAppDefinitions(path, env), defaults);
        } catch (error) {
          captured = error;
        }
      });
      Then(`startup fails naming "org-c" and the unset variable`, () => {
        expect(captured).toBeInstanceOf(ConfigurationError);
        const message = captured instanceof Error ? captured.message : "";
        expect(message).toContain('App "org-c"');
        expect(message).toContain("The environment variable it reads is not set.");
      });
    },
  );

  Scenario(
    `A private key that is not a PEM makes startup fail naming the App`,
    ({ Given, When, Then }) => {
      let path: string | undefined;
      let definitions: Record<string, AppDefinition> | undefined;
      let captured: unknown;

      Given(`a definition file whose App 222 has a private key that is not a PEM`, () => {
        path = configFile(`
          module.exports = function () {
            return {
              "222": {
                appId: 222,
                privateKey: "definitely-not-a-pem",
                webhookSecret: "s",
                allowedInstallationTargets: ["org"],
              },
            };
          };
        `);
      });
      When(`startup validates the configuration`, () => {
        if (path === undefined) {
          throw new Error("The definition file has not been prepared yet.");
        }
        definitions = loadAppDefinitions(path, {} as NodeJS.ProcessEnv);
        try {
          resolveDefinitions(definitions, defaults);
        } catch (error) {
          captured = error;
        }
      });
      Then(`startup fails naming the App 222 and its private key`, () => {
        expect(captured).toBeInstanceOf(ConfigurationError);
        const message = captured instanceof Error ? captured.message : "";
        expect(message).toContain("App 222");
        expect(message).toContain("private key that is not a PEM");
      });
    },
  );

  Scenario(`Health check`, ({ Given, When, Then }) => {
    const { log } = fakeLogger();
    let registry: AppRegistry | undefined;
    let statusCode: number | undefined;
    let body: unknown;

    Given(`an instance serving two Apps`, async () => {
      const created = await createTwoAppRegistry(log);
      registry = created.registry;
      expect(registry.size).toBe(2);
    });
    When(`the health endpoint is requested`, () => {
      if (registry === undefined) {
        throw new Error("The instance has not been started yet.");
      }
      const res = {
        status(code: number) {
          statusCode = code;
          return res;
        },
        json(payload: unknown) {
          body = payload;
          return res;
        },
      } as unknown as Response;
      handleHealth({} as Request, res, registry);
    });
    Then(`the response is 200 with status "ok" and an App count of 2`, () => {
      expect(statusCode).toBe(200);
      expect(body).toEqual({ status: "ok", apps: 2 });
    });
  });

  Scenario(`A duplicate App ID is refused at startup`, ({ Given, When, Then }) => {
    let definitions: Record<string, AppDefinition> | undefined;
    let captured: unknown;

    Given(`a configuration whose two Apps both declare the App ID 111`, () => {
      // The keys differ only by a trailing space, which `key.trim()` accepts,
      // so the duplicate App ID is the first thing that fails.
      definitions = {
        "111": {
          appId: "111",
          privateKey: PEM,
          webhookSecret: "s",
          allowedInstallationTargets: ["org"],
        },
        "111 ": {
          appId: "111",
          privateKey: PEM,
          webhookSecret: "s",
          allowedInstallationTargets: ["org"],
        },
      };
      expect(Object.keys(definitions)).toHaveLength(2);
    });
    When(`the configuration is validated at startup`, () => {
      if (definitions === undefined) {
        throw new Error("The configuration has not been built yet.");
      }
      try {
        resolveDefinitions(definitions, defaults);
      } catch (error) {
        captured = error;
      }
    });
    Then(`startup fails with "Duplicate App ID 111."`, () => {
      expect(captured).toBeInstanceOf(ConfigurationError);
      expect(captured instanceof Error ? captured.message : undefined).toBe(
        "Duplicate App ID 111.",
      );
    });
  });
});
