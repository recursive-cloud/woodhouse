import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { type ApplyContext, syncSettings } from "../src/settings/apply.js";
import { formatApplySummary } from "../src/settings/summary.js";
import { woodhouseConfigSchema } from "../src/config/schema.js";

const RULESETS_ROUTE = "GET /repos/{owner}/{repo}/rulesets";

/**
 * Fake octokit covering every surface the four appliers touch. Each call is
 * tagged into `calls` in the order it fired, so the orchestrator's applier
 * order is assertable without reaching for the network.
 */
function fakeOctokit() {
  const calls: string[] = [];

  const get = vi.fn(async () => {
    calls.push("repos.get");
    return { data: { has_issues: false } };
  });
  const update = vi.fn(async () => {
    calls.push("repos.update");
    return { data: {} };
  });
  const replaceAllTopics = vi.fn(async () => {
    calls.push("repos.replaceAllTopics");
    return { data: {} };
  });
  const updateBranchProtection = vi.fn(async () => {
    calls.push("repos.updateBranchProtection");
    return { data: {} };
  });

  const listLabelsForRepo = vi.fn(async () => ({ data: [] }));
  const createLabel = vi.fn(async () => {
    calls.push("issues.createLabel");
    return { data: {} };
  });
  const updateLabel = vi.fn(async () => {
    calls.push("issues.updateLabel");
    return { data: {} };
  });
  const deleteLabel = vi.fn(async () => {
    calls.push("issues.deleteLabel");
    return { data: {} };
  });

  // Labels paginate a method; rulesets paginate a route string.
  const paginate = vi.fn(async (target: unknown) => {
    if (target === RULESETS_ROUTE) {
      calls.push("rulesets.list");
      return [];
    }
    calls.push("labels.list");
    return [];
  });

  const request = vi.fn(async (route: string) => {
    calls.push(`request ${route}`);
    return { data: {} };
  });

  const octokit = {
    repos: { get, update, replaceAllTopics, updateBranchProtection },
    issues: { listLabelsForRepo, createLabel, updateLabel, deleteLabel },
    paginate,
    request,
  } as unknown as ApplyContext["octokit"];

  return {
    octokit,
    calls,
    get,
    update,
    replaceAllTopics,
    updateBranchProtection,
    listLabelsForRepo,
    createLabel,
    updateLabel,
    deleteLabel,
    paginate,
    request,
  };
}

function fakeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/** A config with one pending change in every area, so all four appliers run. */
const FULL_CONFIG = {
  settings: { enabled: true },
  repository: { has_issues: true },
  labels: [{ name: "bug", color: "d73a4a" }],
  branchProtection: { main: {} },
  rulesets: [{ name: "main" }],
};

function build(configInput: Record<string, unknown> = {}, dryRun = false) {
  const fake = fakeOctokit();
  const log = fakeLogger();
  const ctx = {
    octokit: fake.octokit,
    owner: "acme",
    repo: "widgets",
    log,
    dryRun,
  } as unknown as ApplyContext;

  return { ...fake, log, ctx, config: woodhouseConfigSchema.parse(configInput) };
}

/** An error shaped like an Octokit request failure. */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("syncSettings", () => {
  it("runs the appliers in the declared order, observable in the call sequence", async () => {
    const { ctx, config, calls } = build(FULL_CONFIG);

    const result = await syncSettings(ctx, config);

    expect(calls).toEqual([
      "repos.get",
      "repos.update",
      "labels.list",
      "issues.createLabel",
      "repos.updateBranchProtection",
      "rulesets.list",
      "request POST /repos/{owner}/{repo}/rulesets",
    ]);
    expect(result.changes).toEqual([
      { area: "repository", action: "update", target: "has_issues" },
      { area: "label", action: "create", target: "bug" },
      { area: "branch-protection", action: "update", target: "main" },
      { area: "ruleset", action: "create", target: "main" },
    ]);
    expect(result.failures).toEqual([]);
    expect(result.dryRun).toBe(false);
  });

  it("aggregates changes and records a thrown non-403 failure, continuing to later appliers", async () => {
    const { ctx, config, log, createLabel, updateBranchProtection, request } = build(FULL_CONFIG);
    createLabel.mockRejectedValueOnce(httpError(500, "boom"));

    const result = await syncSettings(ctx, config);

    // The labels failure did not stop branch-protection or rulesets.
    expect(updateBranchProtection).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(result.changes).toEqual([
      { area: "repository", action: "update", target: "has_issues" },
      { area: "branch-protection", action: "update", target: "main" },
      { area: "ruleset", action: "create", target: "main" },
    ]);
    expect(result.failures).toEqual([{ area: "labels", message: "boom" }]);
    expect(log.error).toHaveBeenCalledWith(
      { applier: "labels", status: 500, err: "boom" },
      "Failed applying labels",
    );
  });

  it("folds a thrown 403 into a failure carrying the describeForbidden detail", async () => {
    const { ctx, config, log, update, updateBranchProtection, request } = build(FULL_CONFIG);
    const raw = "Resource not accessible by integration";
    update.mockRejectedValueOnce(httpError(403, raw));

    const result = await syncSettings(ctx, config);

    // Pinned exactly: the collected message is the classified detail, not the
    // raw GitHub message (design D1's deliberate improvement).
    const detail =
      "Forbidden applying repository: Resource not accessible by integration " +
      "The App is probably missing a permission; `administration: write` is " +
      "required for repository settings.";

    expect(updateBranchProtection).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(result.failures).toEqual([{ area: "repository", message: detail }]);
    expect(log.error).toHaveBeenCalledWith(
      { applier: "repository", status: 403, err: raw },
      detail,
    );
  });

  it("performs zero calls and returns an empty summary when settings are disabled", async () => {
    const { ctx, config, log, calls, get } = build({
      ...FULL_CONFIG,
      settings: { enabled: false },
    });

    const result = await syncSettings(ctx, config);

    expect(calls).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], failures: [], dryRun: false });
    expect(log.debug).toHaveBeenCalledWith("Settings sync not enabled for this repository");
  });

  it("performs zero writes in dry-run and logs the summary through the formatter", async () => {
    const { ctx, config, log, calls, update, createLabel, updateBranchProtection, request } = build(
      FULL_CONFIG,
      true,
    );

    const result = await syncSettings(ctx, config);

    // Reads still fire; every write is suppressed by performWrite.
    expect(update).not.toHaveBeenCalled();
    expect(createLabel).not.toHaveBeenCalled();
    expect(updateBranchProtection).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(calls).toEqual(["repos.get", "labels.list", "rulesets.list"]);

    expect(result.changes).toHaveLength(4);
    expect(result.failures).toEqual([]);
    expect(result.dryRun).toBe(true);

    expect(log.info).toHaveBeenCalledWith(
      { changes: result.changes, dryRun: true },
      formatApplySummary(result),
    );
  });

  it("logs the empty summary at debug when nothing changed and nothing failed", async () => {
    const { ctx, config, log } = build({ settings: { enabled: true } });

    const result = await syncSettings(ctx, config);

    expect(result).toEqual({ changes: [], failures: [], dryRun: false });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("Repository already matches configuration");
  });

  it("logs no summary when there are failures but no changes", async () => {
    const { ctx, config, log, update } = build({
      settings: { enabled: true },
      repository: { has_issues: true },
    });
    update.mockRejectedValueOnce(httpError(500, "boom"));

    const result = await syncSettings(ctx, config);

    expect(result.changes).toEqual([]);
    expect(result.failures).toEqual([{ area: "repository", message: "boom" }]);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      { applier: "repository", status: 500, err: "boom" },
      "Failed applying repository",
    );
  });
});
