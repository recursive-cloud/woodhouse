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

/** A white-glove run GitHub has created but not started yet (no started_at). */
function queuedWhiteGlove(id = 500): RawCheckRun {
  return { name: WHITE_GLOVE_CHECK_NAME, status: "queued", conclusion: null, id };
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
  const config = woodhouseConfigSchema.parse({ gatekeeper: { enabled: true } });
  const resolver = {
    resolve: vi.fn(async () => ({ config, sources: [], issues: [] })),
  } as unknown as ReconcileDeps["resolver"];

  const deps: ReconcileDeps = {
    octokit: fake.octokit,
    resolver,
    log: log as unknown as Logger,
    dryRun: options.dryRun ?? false,
  };

  return { ...fake, log, deps, config };
}

describe("reconcile — white-glove check writes", () => {
  it("creates a new run when a pending verdict follows a completed run", async () => {
    const { deps, create, update, listForRef } = build({
      runs: [whiteGlove("completed"), running("build")],
    });

    await reconcile(deps, OWNER, REPO, SHA);

    // The existing completed run must not be PATCHed back to pending; GitHub
    // accepts that request but silently ignores it (issue #27).
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: WHITE_GLOVE_CHECK_NAME,
        head_sha: SHA,
        status: "in_progress",
      }),
    );
    expect(update).not.toHaveBeenCalled();

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

  it("updates a pending run in place, without head_sha in the body", async () => {
    const { deps, create, update } = build({
      runs: [whiteGlove("in_progress", 301), running("build")],
    });

    await reconcile(deps, OWNER, REPO, SHA);

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);

    const body = update.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual(
      expect.objectContaining({
        name: WHITE_GLOVE_CHECK_NAME,
        status: "in_progress",
        check_run_id: 301,
      }),
    );
    // `head_sha` is a create-only parameter.
    expect(body).not.toHaveProperty("head_sha");
  });

  it("updates a completed run in place for a terminal verdict, without head_sha", async () => {
    const { deps, create, update } = build({
      runs: [whiteGlove("completed", 302), completed("build", "success")],
    });

    await reconcile(deps, OWNER, REPO, SHA);

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);

    const body = update.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual(
      expect.objectContaining({
        name: WHITE_GLOVE_CHECK_NAME,
        status: "completed",
        conclusion: "success",
        check_run_id: 302,
      }),
    );
    expect(body).not.toHaveProperty("head_sha");
  });

  it("updates a queued run in place instead of creating another", async () => {
    const { deps, create, update } = build({
      runs: [queuedWhiteGlove(500), running("build")],
    });

    await reconcile(deps, OWNER, REPO, SHA);

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 500, status: "in_progress" }),
    );
  });

  it("creates the check when the head commit has no existing run", async () => {
    const { deps, create, update } = build({
      runs: [running("build")],
      existing: [],
    });

    await reconcile(deps, OWNER, REPO, SHA);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: WHITE_GLOVE_CHECK_NAME,
        head_sha: SHA,
        status: "in_progress",
      }),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("selects the newest same-name run across suites and updates it in place", async () => {
    // After a re-create the SHA legitimately carries two same-name runs in
    // different suites. The newest attempt (by started_at) must drive the
    // decision, or every pending event would create again.
    const { deps, create, update } = build({
      runs: [whiteGlove("completed", 400), whiteGlove("in_progress", 401), running("build")],
      existing: [
        completed(WHITE_GLOVE_CHECK_NAME, "failure", 400, "2026-01-01T00:00:00Z"),
        running(WHITE_GLOVE_CHECK_NAME, 401, "2026-01-02T00:00:00Z"),
      ],
    });

    await reconcile(deps, OWNER, REPO, SHA);

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 401, status: "in_progress" }),
    );
  });

  it("ignores a foreign-named run when selecting the existing run", async () => {
    // The request pins check_name, but the reduce loop re-asserts it so a
    // response that still carries another suite's run cannot be selected.
    const { deps, create, update } = build({
      runs: [whiteGlove("in_progress", 401), running("build")],
      existing: [
        running(WHITE_GLOVE_CHECK_NAME, 401, "2026-01-02T00:00:00Z"),
        completed("someone-elses-check", "success", 999, "2099-01-01T00:00:00Z"),
      ],
    });

    await reconcile(deps, OWNER, REPO, SHA);

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 401, status: "in_progress" }),
    );
    // A foreign run is never a write target, even when it is newest by date.
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ check_run_id: 999 }));
  });

  it("treats an undefined started_at as older than a timestamped run", async () => {
    // A missing start time cannot be the later attempt; the timestamped run
    // wins even when the metadata-less run has the higher id.
    const { deps, create, update } = build({
      runs: [whiteGlove("in_progress", 601), running("build")],
      existing: [
        running(WHITE_GLOVE_CHECK_NAME, 601, null),
        completed(WHITE_GLOVE_CHECK_NAME, "failure", 500, "2026-01-01T00:00:00Z"),
      ],
    });

    await reconcile(deps, OWNER, REPO, SHA);

    // Selected run is completed, fresh verdict pending → create.
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
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
