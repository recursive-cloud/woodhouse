import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { applyLabels } from "../../src/settings/appliers/labels.js";
import type { ApplierContext } from "../../src/settings/appliers/types.js";
import { woodhouseConfigSchema } from "../../src/config/schema.js";

interface ExistingLabel {
  name: string;
  color: string;
  description: string | null;
}

/**
 * Fake octokit covering only the label surfaces this applier touches. Every
 * call is recorded so the tests can assert the plan-to-call mapping without
 * reaching for the network.
 */
function fakeOctokit(existing: ExistingLabel[] = []) {
  const listLabelsForRepo = vi.fn(async () => ({ data: existing }));
  const paginate = vi.fn(async () => existing);
  const createLabel = vi.fn(async () => ({ data: {} }));
  const updateLabel = vi.fn(async () => ({ data: {} }));
  const deleteLabel = vi.fn(async () => ({ data: {} }));

  const octokit = {
    paginate,
    issues: { listLabelsForRepo, createLabel, updateLabel, deleteLabel },
  } as unknown as ApplierContext["octokit"];

  return { octokit, paginate, listLabelsForRepo, createLabel, updateLabel, deleteLabel };
}

function fakeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function build(
  existing: ExistingLabel[] = [],
  configInput: Record<string, unknown> = {},
  dryRun = false,
) {
  const fake = fakeOctokit(existing);
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

describe("applyLabels", () => {
  it("creates one label per plan.create, mapping colour and description", async () => {
    const { ctx, config, createLabel, updateLabel, deleteLabel } = build([], {
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "docs", color: "#00ff00", description: "Documentation" },
      ],
    });

    const result = await applyLabels(ctx, config);

    expect(createLabel).toHaveBeenCalledTimes(2);
    expect(createLabel).toHaveBeenNthCalledWith(1, {
      owner: "acme",
      repo: "widgets",
      name: "bug",
      color: "d73a4a",
    });
    expect(createLabel).toHaveBeenNthCalledWith(2, {
      owner: "acme",
      repo: "widgets",
      name: "docs",
      color: "00ff00",
      description: "Documentation",
    });
    expect(updateLabel).not.toHaveBeenCalled();
    expect(deleteLabel).not.toHaveBeenCalled();
    expect(result).toEqual({
      changes: [
        { area: "label", action: "create", target: "bug" },
        { area: "label", action: "create", target: "docs" },
      ],
      failures: [],
    });
  });

  it("renames per plan.rename, sending the old name and the new one", async () => {
    const { ctx, config, createLabel, updateLabel, deleteLabel } = build(
      [{ name: "old", color: "ffffff", description: null }],
      { labels: [{ name: "new", from: "old" }] },
    );

    const result = await applyLabels(ctx, config);

    expect(updateLabel).toHaveBeenCalledOnce();
    expect(updateLabel).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      name: "old",
      new_name: "new",
    });
    expect(createLabel).not.toHaveBeenCalled();
    expect(deleteLabel).not.toHaveBeenCalled();
    expect(result).toEqual({
      changes: [{ area: "label", action: "rename", target: "old -> new" }],
      failures: [],
    });
  });

  it("updates per plan.update, sending the name as both name and new_name", async () => {
    const { ctx, config, createLabel, updateLabel, deleteLabel } = build(
      [{ name: "bug", color: "ffffff", description: null }],
      { labels: [{ name: "bug", color: "d73a4a" }] },
    );

    const result = await applyLabels(ctx, config);

    expect(updateLabel).toHaveBeenCalledOnce();
    expect(updateLabel).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      name: "bug",
      new_name: "bug",
      color: "d73a4a",
    });
    expect(createLabel).not.toHaveBeenCalled();
    expect(deleteLabel).not.toHaveBeenCalled();
    expect(result).toEqual({
      changes: [{ area: "label", action: "update", target: "bug" }],
      failures: [],
    });
  });

  it("deletes per plan.delete when pruning is enabled", async () => {
    const { ctx, config, createLabel, updateLabel, deleteLabel } = build(
      [{ name: "stale", color: "ffffff", description: null }],
      { labels: [], settings: { pruneLabels: true } },
    );

    const result = await applyLabels(ctx, config);

    expect(deleteLabel).toHaveBeenCalledOnce();
    expect(deleteLabel).toHaveBeenCalledWith({ owner: "acme", repo: "widgets", name: "stale" });
    expect(createLabel).not.toHaveBeenCalled();
    expect(updateLabel).not.toHaveBeenCalled();
    expect(result).toEqual({
      changes: [{ area: "label", action: "delete", target: "stale" }],
      failures: [],
    });
  });

  it("reads but writes nothing when the plan is empty", async () => {
    const { ctx, config, paginate, listLabelsForRepo, createLabel, updateLabel, deleteLabel } =
      build([{ name: "bug", color: "d73a4a", description: null }], {
        labels: [{ name: "bug", color: "d73a4a" }],
      });

    const result = await applyLabels(ctx, config);

    // Today's flow fetches before planning, so the read stays even for a no-op.
    expect(paginate).toHaveBeenCalledOnce();
    expect(paginate).toHaveBeenCalledWith(listLabelsForRepo, {
      owner: "acme",
      repo: "widgets",
      per_page: 100,
    });
    expect(createLabel).not.toHaveBeenCalled();
    expect(updateLabel).not.toHaveBeenCalled();
    expect(deleteLabel).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], failures: [] });
  });

  it("reads nothing and writes nothing when there are no labels and no pruning", async () => {
    const { ctx, config, paginate, createLabel, updateLabel, deleteLabel } = build([], {
      labels: [],
    });

    const result = await applyLabels(ctx, config);

    expect(paginate).not.toHaveBeenCalled();
    expect(createLabel).not.toHaveBeenCalled();
    expect(updateLabel).not.toHaveBeenCalled();
    expect(deleteLabel).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], failures: [] });
  });

  it("propagates an error from a label write", async () => {
    const { ctx, config, createLabel } = build([], { labels: [{ name: "bug", color: "d73a4a" }] });
    createLabel.mockRejectedValueOnce(new Error("boom"));

    await expect(applyLabels(ctx, config)).rejects.toThrow("boom");
  });

  it("performs zero writes in dry-run but still reports the changes", async () => {
    const { ctx, config, paginate, createLabel, updateLabel, deleteLabel } = build(
      [
        { name: "old", color: "ffffff", description: null },
        { name: "bug", color: "ffffff", description: null },
        { name: "stale", color: "ffffff", description: null },
      ],
      {
        labels: [
          { name: "new", from: "old" },
          { name: "bug", color: "d73a4a" },
          { name: "fresh", color: "00ff00" },
        ],
        settings: { pruneLabels: true },
      },
      true,
    );

    const result = await applyLabels(ctx, config);

    expect(paginate).toHaveBeenCalledOnce();
    expect(createLabel).not.toHaveBeenCalled();
    expect(updateLabel).not.toHaveBeenCalled();
    expect(deleteLabel).not.toHaveBeenCalled();
    expect(result.changes).toHaveLength(4);
    expect(result.failures).toEqual([]);
  });
});
