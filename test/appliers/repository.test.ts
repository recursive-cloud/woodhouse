import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { applyRepository } from "../../src/settings/appliers/repository.js";
import type { ApplierContext } from "../../src/settings/appliers/types.js";
import { woodhouseConfigSchema } from "../../src/config/schema.js";

/**
 * Fake octokit covering only the repository surfaces this applier touches.
 * Every call is recorded so the tests can assert the plan-to-call mapping
 * without reaching for the network.
 */
function fakeOctokit(current: Record<string, unknown>) {
  const get = vi.fn(async () => ({ data: current }));
  const update = vi.fn(async () => ({ data: {} }));
  const replaceAllTopics = vi.fn(async () => ({ data: {} }));

  const octokit = {
    repos: { get, update, replaceAllTopics },
  } as unknown as ApplierContext["octokit"];

  return { octokit, get, update, replaceAllTopics };
}

function fakeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function build(
  current: Record<string, unknown>,
  configInput: Record<string, unknown> = {},
  dryRun = false,
) {
  const fake = fakeOctokit(current);
  const log = fakeLogger();
  const ctx = {
    octokit: fake.octokit,
    owner: "acme",
    repo: "widgets",
    log,
    dryRun,
  } as unknown as ApplierContext;

  return { ...fake, log, ctx, config: woodhouseConfigSchema.parse(configInput) };
}

describe("applyRepository", () => {
  it("PATCHes only the fields the plan says differ", async () => {
    const { ctx, config, get, update, replaceAllTopics } = build(
      { has_issues: true, has_wiki: true },
      { repository: { has_issues: true, has_wiki: false } },
    );

    const result = await applyRepository(ctx, config);

    expect(get).toHaveBeenCalledWith({ owner: "acme", repo: "widgets" });
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({ owner: "acme", repo: "widgets", has_wiki: false });
    expect(replaceAllTopics).not.toHaveBeenCalled();
    expect(result).toEqual({
      changes: [{ area: "repository", action: "update", target: "has_wiki" }],
      failures: [],
    });
  });

  it("lists the patched fields sorted in the change record", async () => {
    const { ctx, config, update } = build(
      { has_wiki: true, has_issues: false },
      { repository: { has_wiki: false, has_issues: true } },
    );

    const result = await applyRepository(ctx, config);

    expect(update).toHaveBeenCalledOnce();
    expect(result.changes).toEqual([
      { area: "repository", action: "update", target: "has_issues, has_wiki" },
    ]);
  });

  it("replaces topics only when topicsDiffer says so, lowercasing the names", async () => {
    const differing = build(
      { topics: ["Home-Lab"] },
      { repository: { topics: ["Home-Lab", "New"] } },
    );

    const result = await applyRepository(differing.ctx, differing.config);

    expect(differing.replaceAllTopics).toHaveBeenCalledOnce();
    expect(differing.replaceAllTopics).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      names: ["home-lab", "new"],
    });
    expect(result.changes).toEqual([{ area: "topics", action: "update", target: "Home-Lab, New" }]);
  });

  it("does not replace topics when order and case already match", async () => {
    const same = build({ topics: ["home-lab"] }, { repository: { topics: ["Home-Lab"] } });

    const result = await applyRepository(same.ctx, same.config);

    expect(same.replaceAllTopics).not.toHaveBeenCalled();
    expect(result.changes).toEqual([]);
  });

  it("reads but writes nothing when the plan is empty", async () => {
    const { ctx, config, get, update, replaceAllTopics } = build({}, { repository: {} });

    const result = await applyRepository(ctx, config);

    // Today's flow fetches before diffing, so the read stays even for a no-op.
    expect(get).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    expect(replaceAllTopics).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], failures: [] });
  });

  it("performs zero writes in dry-run", async () => {
    const { ctx, config, get, update, replaceAllTopics } = build(
      { has_wiki: true, topics: ["old"] },
      { repository: { has_wiki: false, topics: ["new"] } },
      true,
    );

    const result = await applyRepository(ctx, config);

    expect(get).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    expect(replaceAllTopics).not.toHaveBeenCalled();
    // The change records are still produced; only the writes are suppressed.
    expect(result.changes).toHaveLength(2);
  });

  it("skips an archived repository without writing", async () => {
    const { ctx, config, get, update, replaceAllTopics, log } = build(
      { archived: true, has_wiki: true },
      { repository: { has_wiki: false, topics: ["new"] } },
    );

    const result = await applyRepository(ctx, config);

    expect(get).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    expect(replaceAllTopics).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], failures: [] });
    expect(log.info).toHaveBeenCalledWith("Repository is archived; skipping settings sync");
  });
});
