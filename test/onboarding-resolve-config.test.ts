import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { resolveOnboardingConfig } from "../src/app.js";
import type { ConfigResolver, ContentsClient, ResolvedConfig } from "../src/config/resolver.js";
import { defaultConfig, type ValidationIssue } from "../src/config/schema.js";

function fakeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const OCTOKIT = { repos: { getContent: vi.fn() } } as unknown as ContentsClient;

function resolverReturning(result: ResolvedConfig) {
  return { resolve: vi.fn(async () => result) } as unknown as Pick<ConfigResolver, "resolve">;
}

describe("resolveOnboardingConfig", () => {
  it("returns the resolved configuration when there are no validation issues", async () => {
    const result: ResolvedConfig = {
      config: defaultConfig(),
      sources: [],
      issues: [],
    };
    const log = fakeLogger();

    const config = await resolveOnboardingConfig(
      resolverReturning(result),
      OCTOKIT,
      log as unknown as Logger,
      "acme",
      "widgets",
    );

    expect(config).toBe(result.config);
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("maps a resolution with validation issues to undefined, never the fallback defaults", async () => {
    const issues: ValidationIssue[] = [
      { path: "settings.enabled", message: "Expected boolean, received string" },
    ];
    const result: ResolvedConfig = {
      config: defaultConfig(),
      sources: ["acme/.github-private:woodhouse.yml"],
      issues,
    };
    const log = fakeLogger();

    const config = await resolveOnboardingConfig(
      resolverReturning(result),
      OCTOKIT,
      log as unknown as Logger,
      "acme",
      "widgets",
    );

    // The resolver hands back defaults with issues; the wrapper must not pass
    // those defaults on as if the repository were simply unmanaged.
    expect(result.config.settings.enabled).toBe(false);
    expect(config).toBeUndefined();
  });

  it("maps a rejection to undefined and logs its cause at debug level", async () => {
    const failure = new Error("network unavailable");
    const resolver = {
      resolve: vi.fn(async () => {
        throw failure;
      }),
    } as unknown as Pick<ConfigResolver, "resolve">;
    const log = fakeLogger();

    const config = await resolveOnboardingConfig(
      resolver,
      OCTOKIT,
      log as unknown as Logger,
      "acme",
      "widgets",
    );

    expect(config).toBeUndefined();
    expect(log.debug).toHaveBeenCalledWith(
      { owner: "acme", repo: "widgets", err: failure },
      "Could not resolve onboarding configuration",
    );
  });
});
