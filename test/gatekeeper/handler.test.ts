import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { reconcile, type ReconcileDeps } from "../../src/gatekeeper/handler.js";
import { WHITE_GLOVE_CHECK_NAME } from "../../src/gatekeeper/constants.js";
import { woodhouseConfigSchema } from "../../src/config/schema.js";

const OWNER = "acme";
const REPO = "widgets";
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** The subset of a raw Checks API run the handler reads. */
interface RawCheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly id?: number;
  readonly started_at?: string;
  readonly details_url?: string | null;
}

/** A completed run; `conclusion` defaults to success. */
function completed(
  name: string,
  conclusion: string | null = "success",
  id = 100,
  startedAt = "2026-01-01T00:00:00Z",
): RawCheckRun {
  return { name, status: "completed", conclusion, id, started_at: startedAt };
}

/** A non-terminal run, i.e. still pending from the evaluator's point of view. */
function running(
  name: string,
  id = 200,
  startedAt: string | null = "2026-01-02T00:00:00Z",
): RawCheckRun {
  return { name, status: "in_progress", conclusion: null, id, started_at: startedAt ?? undefined };
}

function whiteGlove(status: "completed" | "in_progress", id = 300): RawCheckRun {
  return status === "completed"
    ? completed(WHITE_GLOVE_CHECK_NAME, "failure", id)
    : running(WHITE_GLOVE_CHECK_NAME, id);
}

interface BuildOptions {
  /** Check runs the evaluator sees (via `paginate`). */
  readonly runs?: readonly RawCheckRun[];
  /** Check runs `findExisting` sees (via `checks.listForRef`); defaults to
   * the white-glove runs among `runs`, since that call filters by name. */
  readonly existing?: readonly RawCheckRun[];
  readonly dryRun?: boolean;
  /** Overrides the gatekeeper's enabled flag; defaults to enabled. */
  readonly gatekeeperEnabled?: boolean;
  readonly onSuccess?: (owner: string, repo: string, sha: string) => Promise<void>;
}

/**
 * Fake octokit covering only the checks surface the handler touches. Every
 * call is recorded so the tests can pin which write path was taken without
 * reaching for the network.
 */
function fakeOctokit(options: BuildOptions) {
  const { runs = [] } = options;
  const existing = options.existing ?? runs.filter((run) => run.name === WHITE_GLOVE_CHECK_NAME);
  const paginate = vi.fn(async () => runs);
  const listForRef = vi.fn(async () => ({ data: { check_runs: existing } }));
  const create = vi.fn(async () => ({ data: {} }));
  const update = vi.fn(async () => ({ data: {} }));

  const octokit = {
    paginate,
    checks: { listForRef, create, update },
  } as unknown as ReconcileDeps["octokit"];

  return { octokit, paginate, listForRef, create, update };
}

function fakeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function build(options: BuildOptions = {}) {
  const fake = fakeOctokit(options);
  const log = fakeLogger();
  const config = woodhouseConfigSchema.parse({
    gatekeeper: { enabled: options.gatekeeperEnabled ?? true },
  });
  const resolver = {
    resolve: vi.fn(async () => ({ config, sources: [], issues: [] })),
  } as unknown as ReconcileDeps["resolver"];

  const deps: ReconcileDeps = {
    octokit: fake.octokit,
    resolver,
    log: log as unknown as Logger,
    dryRun: options.dryRun ?? false,
    ...(options.onSuccess === undefined ? {} : { onSuccess: options.onSuccess }),
  };

  return { ...fake, log, deps, config };
}

describe("reconcile — white-glove check writes", () => {
  it("queries the existing white-glove run with one bounded, name-filtered request", async () => {
    // The fixture is a completed run with a pending verdict: the existing
    // completed run must not be PATCHed back to pending, because GitHub
    // accepts that request but silently ignores it (issue #27).
    const { deps, listForRef } = build({
      runs: [whiteGlove("completed"), running("build")],
    });

    await reconcile(deps, OWNER, REPO, SHA);

    // One request, no pagination, bounded and same-name-filtered.
    expect(listForRef).toHaveBeenCalledTimes(1);
    expect(listForRef).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: OWNER,
        repo: REPO,
        ref: SHA,
        check_name: WHITE_GLOVE_CHECK_NAME,
        filter: "latest",
        per_page: 100,
      }),
    );
  });

  it("performs no writes in dry-run", async () => {
    const { deps, create, update, listForRef, log } = build({
      runs: [whiteGlove("completed"), running("build")],
      dryRun: true,
    });

    await reconcile(deps, OWNER, REPO, SHA);

    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    // The guard returns before even looking for an existing run.
    expect(listForRef).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("DRY_RUN: would write white-glove check");
  });
});

describe("reconcile — the post-success hook", () => {
  it("invokes onSuccess with the commit after the check write on success", async () => {
    const onSuccess = vi.fn(async () => {});
    const { deps, create } = build({ runs: [completed("build")], onSuccess });

    const result = await reconcile(deps, OWNER, REPO, SHA);

    expect(result?.evaluation.outcome).toBe("success");
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith(OWNER, REPO, SHA);
    expect(create).toHaveBeenCalledOnce();

    // The check write happens first; the hook runs after it, still inside the
    // per-commit mutex.
    const writeOrder = create.mock.invocationCallOrder[0];
    const hookOrder = onSuccess.mock.invocationCallOrder[0];
    expect(writeOrder ?? -1).toBeLessThan(hookOrder ?? -1);
  });

  it("does not invoke onSuccess when the evaluation fails", async () => {
    const onSuccess = vi.fn(async () => {});
    const { deps, update } = build({
      runs: [whiteGlove("completed"), completed("build", "failure")],
      onSuccess,
    });

    const result = await reconcile(deps, OWNER, REPO, SHA);

    expect(result?.evaluation.outcome).toBe("failure");
    expect(update).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("does not invoke onSuccess while the evaluation is pending", async () => {
    const onSuccess = vi.fn(async () => {});
    const { deps } = build({ runs: [running("build")], onSuccess });

    const result = await reconcile(deps, OWNER, REPO, SHA);

    expect(result?.evaluation.outcome).toBe("pending");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("does not invoke onSuccess when the gatekeeper is disabled", async () => {
    const onSuccess = vi.fn(async () => {});
    const { deps, listForRef, create, update } = build({
      runs: [completed("build")],
      gatekeeperEnabled: false,
      onSuccess,
    });

    const result = await reconcile(deps, OWNER, REPO, SHA);

    expect(result).toBeUndefined();
    expect(listForRef).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("logs a rejecting onSuccess and still resolves with the evaluation", async () => {
    const onSuccess = vi.fn(async () => {
      throw new Error("boom");
    });
    const { deps, log } = build({ runs: [completed("build")], onSuccess });

    const result = await reconcile(deps, OWNER, REPO, SHA);

    expect(result?.evaluation.outcome).toBe("success");
    expect(log.error).toHaveBeenCalledWith(
      { err: expect.any(Error), sha: SHA },
      "Post-success hook failed",
    );
  });

  it("resolves normally when no hook is supplied", async () => {
    const { deps } = build({ runs: [completed("build")] });

    const result = await reconcile(deps, OWNER, REPO, SHA);

    expect(result?.evaluation.outcome).toBe("success");
  });
});
