import { describe, expect, it, vi } from "vitest";
import type { Context } from "probot";
import type { Logger } from "pino";
import { commitPass, type CommitPassBody } from "../src/approval/commitPass.js";
import type { ConfigResolver } from "../src/config/resolver.js";
import { woodhouseConfigSchema } from "../src/config/schema.js";

const SHA = "abc123";

type Api = Context<"pull_request">["octokit"];

const OCTOKIT = { pulls: {} } as unknown as Api;

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/** A resolver returning the file's config, or a caller-supplied one. */
function fakeResolver(config = woodhouseConfigSchema.parse({ autoApproval: {} })) {
  return {
    resolve: vi.fn(async () => ({ config, sources: [], issues: [] })),
  } as unknown as ConfigResolver;
}

describe("commitPass", () => {
  it("resolves the repository config and hands the body only the auto-approval block", async () => {
    const config = woodhouseConfigSchema.parse({
      autoApproval: { allowedActors: { bots: ["renovate[bot]"] } },
      settings: { enabled: false },
    });
    const resolver = fakeResolver(config);
    const log = fakeLogger();
    const calls: Parameters<CommitPassBody>[] = [];
    const body = vi.fn(async (...args: Parameters<CommitPassBody>) => {
      calls.push(args);
    });

    const hook = commitPass(resolver, body);
    await hook(OCTOKIT, log)("acme", "widgets", SHA);

    expect(resolver.resolve).toHaveBeenCalledOnce();
    expect(resolver.resolve).toHaveBeenCalledWith(OCTOKIT, "acme", "widgets", log);
    expect(body).toHaveBeenCalledOnce();
    expect(calls[0]?.[0]).toEqual({ octokit: OCTOKIT, log });
    expect(calls[0]?.slice(1, 4)).toEqual(["acme", "widgets", SHA]);
    // The body receives the auto-approval block, not the whole config.
    expect(calls[0]?.[4]).toBe(config.autoApproval);
    expect(calls[0]?.[4]).not.toBe(config);
  });

  it("propagates a resolver rejection without running the body", async () => {
    const resolver = fakeResolver();
    vi.mocked(resolver.resolve).mockRejectedValueOnce(new Error("config down"));
    const body = vi.fn(async () => {});

    const hook = commitPass(resolver, body);

    await expect(hook(OCTOKIT, fakeLogger())("acme", "widgets", SHA)).rejects.toThrow(
      "config down",
    );
    expect(body).not.toHaveBeenCalled();
  });

  it("resolves the config again for every commit event", async () => {
    const resolver = fakeResolver();
    const body = vi.fn(async () => {});
    const hook = commitPass(resolver, body)(OCTOKIT, fakeLogger());

    await hook("acme", "widgets", SHA);
    await hook("acme", "widgets", "def456");

    expect(resolver.resolve).toHaveBeenCalledTimes(2);
    expect(body).toHaveBeenCalledTimes(2);
    expect(body.mock.calls[1]?.[3]).toBe("def456");
  });
});
