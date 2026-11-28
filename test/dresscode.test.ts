import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import {
  decideDressCode,
  reRequestDressCodeCheck,
  runDressCodeCheck,
  type DressCodeDeps,
} from "../src/dresscode/check.js";
import {
  DRESS_CODE_CHECK_NAME,
  DRESS_CODE_DISABLED_REASON,
  DRESS_CODE_NO_PULL_REQUEST_REASON,
} from "../src/dresscode/constants.js";
import { titlePatternDescription } from "../src/conventional/parse.js";
import { woodhouseConfigSchema } from "../src/config/schema.js";

const OWNER = "acme";
const REPO = "widgets";
const SHA = "1111111111111111111111111111111111111111";
const NEW_SHA = "2222222222222222222222222222222222222222";

interface StoredRun {
  readonly id: number;
  readonly head_sha: string;
  readonly name: string;
  status: string;
  conclusion: string | null;
  started_at?: string;
  output?: { title?: string; summary?: string };
}

interface FakePull {
  readonly number: number;
  readonly state: string;
  readonly title: string;
  readonly head: { readonly sha: string };
}

interface BuildOptions {
  readonly enabled?: boolean;
  readonly dryRun?: boolean;
  readonly runs?: readonly StoredRun[];
  readonly pullRequests?: readonly FakePull[];
}

function storedRun(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id: 77,
    head_sha: SHA,
    name: DRESS_CODE_CHECK_NAME,
    status: "completed",
    conclusion: "success",
    started_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * A stateful fake octokit: the Checks API store is mutated by create/update so
 * listForRef reflects what GitHub would return, which is what makes the
 * update-in-place assertions meaningful.
 */
function build(options: BuildOptions = {}) {
  const runs: StoredRun[] = structuredClone([...(options.runs ?? [])]);
  const pullRequests: FakePull[] = structuredClone([...(options.pullRequests ?? [])]);
  let nextId = 100;

  const create = vi.fn(async (params: Record<string, unknown>) => {
    const run: StoredRun = {
      id: nextId++,
      head_sha: String(params.head_sha),
      name: String(params.name),
      status: String(params.status),
      conclusion: (params.conclusion as string | null | undefined) ?? null,
      output: params.output as StoredRun["output"],
    };
    runs.push(run);
    return { data: run };
  });

  const update = vi.fn(async (params: Record<string, unknown>) => {
    const run = runs.find((candidate) => candidate.id === params.check_run_id);
    if (run === undefined) {
      throw new Error(`No fake check run with id ${String(params.check_run_id)}`);
    }
    run.status = String(params.status);
    run.conclusion = (params.conclusion as string | null | undefined) ?? null;
    run.output = params.output as StoredRun["output"];
    return { data: run };
  });

  const listForRef = vi.fn(async (params: { ref: string; check_name?: string | undefined }) => ({
    data: {
      check_runs: runs.filter(
        (run) =>
          run.head_sha === params.ref &&
          (params.check_name === undefined || run.name === params.check_name),
      ),
    },
  }));

  const listPullRequestsAssociatedWithCommit = vi.fn(
    async (_params: { owner: string; repo: string; commit_sha: string }) => ({
      data: pullRequests,
    }),
  );

  const octokit = {
    checks: { create, update, listForRef },
    repos: { listPullRequestsAssociatedWithCommit },
  } as unknown as DressCodeDeps["octokit"];

  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;

  const config = woodhouseConfigSchema.parse({
    dressCode: { enabled: options.enabled ?? true },
  });
  const resolver = {
    resolve: vi.fn(async () => ({ config, sources: [], issues: [] })),
  } as unknown as DressCodeDeps["resolver"];

  const deps: DressCodeDeps = {
    octokit,
    resolver,
    log,
    dryRun: options.dryRun ?? false,
  };

  return {
    deps,
    log,
    runs,
    pullRequests,
    create,
    update,
    listForRef,
    listPullRequestsAssociatedWithCommit,
  };
}

const CONVENTIONAL_TITLES = [
  "feat(settings): add the environments section",
  "feat: add an environments section",
  "fix: handle the empty payload",
] as const;

const NON_CONVENTIONAL_TITLES = [
  "updated the readme",
  "WIP",
  "FIX: urgent",
  "feat: ",
  // Untrimmed input is a violation, not something the check repairs.
  " feat: leading space",
] as const;

describe("decideDressCode — the pure verdict", () => {
  it.each(CONVENTIONAL_TITLES)("accepts %j", (title) => {
    const decision = decideDressCode(title);

    expect(decision.outcome).toBe("success");
    expect(decision.output.title).toContain("conventional");
    expect(decision.output.summary).not.toBe("");
  });

  it.each(NON_CONVENTIONAL_TITLES)("rejects %j with guidance", (title) => {
    const decision = decideDressCode(title);

    expect(decision.outcome).toBe("failure");
    expect(decision.output.summary).toContain(titlePatternDescription());
    expect(decision.output.summary).toContain(JSON.stringify(title));
  });
});

describe("runDressCodeCheck", () => {
  it("creates a completed run on the head commit for a matching title", async () => {
    const { deps, create, update, listForRef } = build();

    await runDressCodeCheck(deps, {
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      title: "feat: add an environments section",
    });

    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: OWNER,
        repo: REPO,
        name: DRESS_CODE_CHECK_NAME,
        head_sha: SHA,
        status: "completed",
        conclusion: "success",
        output: expect.objectContaining({
          title: expect.stringContaining("conventional"),
          summary: expect.any(String),
        }),
      }),
    );
    expect(listForRef).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: SHA,
        check_name: DRESS_CODE_CHECK_NAME,
        filter: "latest",
      }),
    );
  });

  it("reports failure naming the expected pattern and the offending title", async () => {
    const { deps, create } = build();

    await runDressCodeCheck(deps, {
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      title: "updated the readme",
    });

    const body = create.mock.calls[0]?.[0] as {
      conclusion: string;
      output: { summary: string };
    };
    expect(body.conclusion).toBe("failure");
    expect(body.output.summary).toContain(titlePatternDescription());
    expect(body.output.summary).toContain(JSON.stringify("updated the readme"));
  });

  it("caps a failure summary that would exceed GitHub's output limit", async () => {
    const { deps, create } = build();
    const title = "y".repeat(70_000);

    await runDressCodeCheck(deps, {
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      title,
    });

    const body = create.mock.calls[0]?.[0] as { output: { summary: string } };
    expect(body.output.summary.length).toBeLessThanOrEqual(65_535);
    expect(body.output.summary.endsWith("\n\n_(truncated)_")).toBe(true);
  });

  it("performs no writes at all when dress-code is disabled", async () => {
    const { deps, create, update, listForRef, log } = build({ enabled: false });

    await runDressCodeCheck(deps, {
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      title: "quick fix",
    });

    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(listForRef).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      { sha: SHA },
      "Dress-code disabled by configuration; skipping",
    );
  });

  it("performs no GitHub writes in dry-run and logs the skipped write", async () => {
    const { deps, create, update, listForRef, log } = build({ dryRun: true });

    await runDressCodeCheck(deps, {
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      title: "feat: add an environments section",
    });

    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    // `performWrite` returns before the existing-run lookup too.
    expect(listForRef).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("DRY_RUN: would write dress-code check");
  });

  it("updates an existing completed run in place instead of creating another", async () => {
    const { deps, create, update } = build({ runs: [storedRun()] });

    await runDressCodeCheck(deps, {
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      title: "quick fix",
    });

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
    const body = update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual(
      expect.objectContaining({
        name: DRESS_CODE_CHECK_NAME,
        check_run_id: 77,
        status: "completed",
        conclusion: "failure",
      }),
    );
    // `head_sha` is create-only; GitHub's update endpoint has no such field.
    expect(body).not.toHaveProperty("head_sha");
  });

  it("creates a fresh run for a new head commit", async () => {
    const { deps, create, update } = build({ runs: [storedRun()] });

    await runDressCodeCheck(deps, {
      owner: OWNER,
      repo: REPO,
      sha: NEW_SHA,
      title: "feat: add an environments section",
    });

    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ head_sha: NEW_SHA }));
  });
});

describe("reRequestDressCodeCheck", () => {
  it("completes a queued run using the title of the associated pull request", async () => {
    const { deps, create, update } = build({
      runs: [storedRun({ status: "queued", conclusion: null })],
      pullRequests: [
        {
          number: 12,
          state: "open",
          title: "feat: add an environments section",
          head: { sha: SHA },
        },
      ],
    });

    await reRequestDressCodeCheck(deps, OWNER, REPO, SHA);

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 77,
        status: "completed",
        conclusion: "success",
      }),
    );
  });

  it("ignores pull requests whose head is not the requested commit", async () => {
    const { deps, create } = build({
      pullRequests: [
        {
          number: 2,
          state: "open",
          title: "WIP",
          head: { sha: NEW_SHA },
        },
        {
          number: 3,
          state: "open",
          title: "fix: handle the empty payload",
          head: { sha: SHA },
        },
      ],
    });

    await reRequestDressCodeCheck(deps, OWNER, REPO, SHA);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ conclusion: "success" }));
  });

  it("prefers an open pull request over a closed one", async () => {
    const { deps, create } = build({
      pullRequests: [
        {
          number: 1,
          state: "closed",
          title: "fix: handle the empty payload",
          head: { sha: SHA },
        },
        {
          number: 5,
          state: "open",
          title: "quick fix",
          head: { sha: SHA },
        },
      ],
    });

    await reRequestDressCodeCheck(deps, OWNER, REPO, SHA);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ conclusion: "failure" }));
  });

  it("tie-breaks matching open pull requests to the lowest number", async () => {
    const { deps, create } = build({
      pullRequests: [
        {
          number: 8,
          state: "open",
          title: "quick fix",
          head: { sha: SHA },
        },
        {
          number: 4,
          state: "open",
          title: "docs: explain the workflow",
          head: { sha: SHA },
        },
      ],
    });

    await reRequestDressCodeCheck(deps, OWNER, REPO, SHA);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ conclusion: "success" }));
  });

  it("completes neutral when no pull request is headed by the commit", async () => {
    const { deps, create, update, listPullRequestsAssociatedWithCommit } = build({
      runs: [storedRun({ status: "queued", conclusion: null })],
      pullRequests: [
        {
          number: 9,
          state: "open",
          title: "feat: somewhere else",
          head: { sha: NEW_SHA },
        },
      ],
    });

    await reRequestDressCodeCheck(deps, OWNER, REPO, SHA);

    expect(listPullRequestsAssociatedWithCommit).toHaveBeenCalledWith(
      expect.objectContaining({ commit_sha: SHA }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ conclusion: "neutral" }));
    const body = update.mock.calls[0]?.[0] as {
      output: { summary: string };
    };
    expect(body.output.summary).toContain(DRESS_CODE_NO_PULL_REQUEST_REASON);
  });

  it("completes neutral with the disabled explanation when dress-code is off", async () => {
    const { deps, update, listPullRequestsAssociatedWithCommit } = build({
      enabled: false,
      runs: [storedRun({ status: "queued", conclusion: null })],
    });

    await reRequestDressCodeCheck(deps, OWNER, REPO, SHA);

    // The associated-PR lookup is not needed to explain a disabled check.
    expect(listPullRequestsAssociatedWithCommit).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 77,
        status: "completed",
        conclusion: "neutral",
        output: expect.objectContaining({ summary: DRESS_CODE_DISABLED_REASON }),
      }),
    );
  });
});
