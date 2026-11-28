import { describe, expect, it, vi } from "vitest";
import type { Context } from "probot";
import type { Logger } from "pino";
import { evaluateLivePull, type LivePullDeps } from "../src/approval/livePull.js";

const SHA = "abc123";
const RENOVATE = "renovate[bot]";

type Api = Context<"pull_request">["octokit"];

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/** A pull request as the live GET returns it. */
const BASE_LIVE_PULL = {
  number: 7,
  state: "open",
  draft: false,
  user: { login: RENOVATE },
  head: { sha: SHA },
  auto_merge: null,
};

function livePull(overrides: Record<string, unknown>) {
  return { ...BASE_LIVE_PULL, ...overrides };
}

function fakeDeps(data: unknown = livePull({})) {
  const get = vi.fn(async () => ({ data }));
  const log = fakeLogger();
  const octokit = { pulls: { get } } as unknown as Api;
  return { deps: { octokit, log } as LivePullDeps, get, log };
}

describe("evaluateLivePull", () => {
  it("returns the pull and its author when it is open and still headed by the commit", async () => {
    const pull = livePull({});
    const { deps, get } = fakeDeps(pull);

    const evaluated = await evaluateLivePull(deps, "acme", "widgets", 7, SHA);

    expect(evaluated).toEqual({ pull, author: RENOVATE });
    expect(get).toHaveBeenCalledWith({ owner: "acme", repo: "widgets", pull_number: 7 });
    expect(deps.log.debug).not.toHaveBeenCalled();
  });

  it("returns undefined after a debug log when the pull request is no longer open", async () => {
    const { deps } = fakeDeps(livePull({ state: "closed" }));

    const evaluated = await evaluateLivePull(deps, "acme", "widgets", 7, SHA);

    expect(evaluated).toBeUndefined();
    expect(deps.log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ pr: 7, state: "closed", head: SHA, sha: SHA }),
      expect.any(String),
    );
  });

  it("returns undefined after a debug log when the head moved", async () => {
    const { deps } = fakeDeps(livePull({ head: { sha: "def456" } }));

    const evaluated = await evaluateLivePull(deps, "acme", "widgets", 7, SHA);

    expect(evaluated).toBeUndefined();
    expect(deps.log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ pr: 7, state: "open", head: "def456", sha: SHA }),
      expect.any(String),
    );
  });

  it("returns undefined after a debug log when the pull has no author login", async () => {
    const { deps } = fakeDeps(livePull({ user: null }));

    const evaluated = await evaluateLivePull(deps, "acme", "widgets", 7, SHA);

    expect(evaluated).toBeUndefined();
    expect(deps.log.debug).toHaveBeenCalledWith(
      { pr: 7 },
      "Not evaluating: pull request has no author login",
    );
  });

  it("propagates a rejected GET instead of reading it as a refusal", async () => {
    const { deps, get } = fakeDeps();
    const failure = new Error("boom");
    get.mockRejectedValueOnce(failure);

    await expect(evaluateLivePull(deps, "acme", "widgets", 7, SHA)).rejects.toThrow("boom");
    expect(deps.log.debug).not.toHaveBeenCalled();
  });
});
