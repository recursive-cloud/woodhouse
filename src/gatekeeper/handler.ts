/**
 * White-glove check handler.
 *
 * Wiring between GitHub events and the pure evaluator in `evaluate.ts`.
 */

import type { Context } from "probot";
import type { Logger } from "pino";
import type { ConfigResolver } from "../config/resolver.js";
import type { GatekeeperConfig } from "../config/schema.js";
import { KeyedMutex } from "../lib/mutex.js";
import { performWrite } from "../lib/dry-run.js";
import { evaluate, type CheckRunLike, type EvaluateOptions, type Evaluation } from "./evaluate.js";
import { resolveCheckWrite } from "./write-decision.js";
import { WHITE_GLOVE_CHECK_NAME, WHITE_GLOVE_TITLE } from "./constants.js";

type AnyOctokit = Context<"check_run">["octokit"];

const mutex = new KeyedMutex();

/**
 * GitHub caps check-run output summaries at 65535 characters. A repository with
 * a very large matrix could plausibly approach that.
 */
const MAX_SUMMARY = 60_000;

function truncate(text: string): string {
  return text.length <= MAX_SUMMARY ? text : `${text.slice(0, MAX_SUMMARY)}\n\n_(truncated)_`;
}

/**
 * Fetch every check run on a commit.
 *
 * We deliberately re-read the full set rather than trusting the single check
 * run in the webhook payload. Deliveries arrive out of order and can be
 * retried; re-reading means every delivery converges on the same answer
 * regardless of ordering, which makes the whole thing idempotent.
 *
 * `filter: "latest"` is GitHub's default and returns only the most recent
 * attempt per check name per suite, so re-runs do not resurrect old failures.
 *
 * But a re-triggered workflow (opening or reopening a PR re-runs CI on the
 * same SHA) can produce a *second* check suite whose checks share names with
 * the first, so a single check name can legitimately appear twice across
 * suites. We therefore deduplicate same-named runs across suites down to their
 * latest attempt (see `evaluate.ts`) and count each once. This is the one case
 * we deliberately override GitHub's per-suite default.
 *
 * Failure over success across DIFFERENT check names is untouched: distinct
 * checks are still all evaluated, so an uncovered real failure cannot be
 * masked by a pass. Only same-named runs (the cross-suite duplicates) are
 * collapsed.
 */
async function listCheckRuns(
  octokit: AnyOctokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<CheckRunLike[]> {
  const runs = await octokit.paginate(octokit.checks.listForRef, {
    owner,
    repo,
    ref: sha,
    filter: "latest",
    per_page: 100,
  });

  return runs.map((run) => ({
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    detailsUrl: run.details_url,
    id: run.id,
    startedAt: run.started_at ?? undefined,
  }));
}

/**
 * Create or update the white-glove check run for a commit.
 *
 * `pending` maps to the Checks API `in_progress` status: there is no "pending"
 * status, and an in-progress required check is what blocks a merge.
 *
 * A completed run must never be PATCHed back to `in_progress`: the Checks API
 * accepts that request but silently ignores the terminal → pending regression,
 * leaving a stale red run beside a "waiting" merge box (issue #27). The pure
 * `resolveCheckWrite` helper decides between POSTing a new run and PATCHing the
 * existing one; this function is only the wiring around it.
 */
async function upsertCheck(
  octokit: AnyOctokit,
  owner: string,
  repo: string,
  sha: string,
  evaluation: Evaluation,
  log: Logger,
  dryRun: boolean,
): Promise<void> {
  const output = {
    title: `${WHITE_GLOVE_TITLE}: ${evaluation.title}`,
    summary: truncate(evaluation.summary),
  };

  const state =
    evaluation.outcome === "pending"
      ? { status: "in_progress" as const, output }
      : {
          status: "completed" as const,
          conclusion: evaluation.outcome,
          completed_at: new Date().toISOString(),
          output,
        };

  await performWrite({ dryRun, log }, "write white-glove check", async () => {
    const existing = await findExisting(octokit, owner, repo, sha);

    if (resolveCheckWrite(existing, evaluation.outcome) === "create") {
      await octokit.checks.create({
        owner,
        repo,
        name: WHITE_GLOVE_CHECK_NAME,
        head_sha: sha,
        ...state,
      });
      log.info(
        { sha, outcome: evaluation.outcome, counts: evaluation.counts },
        "Created white-glove check",
      );
      return;
    }

    // `resolveCheckWrite` only returns "update" when a run exists; fail closed
    // rather than PATCH an unknown target if that contract is ever broken.
    if (existing === undefined) {
      throw new Error("Cannot update white-glove check: no existing run for the head commit");
    }

    // `head_sha` is a create-only parameter; the update body deliberately
    // omits it (GitHub has no such field on the update endpoint).
    await octokit.checks.update({
      owner,
      repo,
      name: WHITE_GLOVE_CHECK_NAME,
      ...state,
      check_run_id: existing.id,
    });
    log.info(
      { sha, outcome: evaluation.outcome, counts: evaluation.counts },
      "Updated white-glove check",
    );
  });
}

/** The subset of a check run `findExisting` needs to pick the latest attempt. */
interface ExistingRun {
  readonly id: number;
  readonly status: string;
  readonly startedAt?: string;
}

/** True when `candidate` is a later attempt than `holder`. Mirrors `evaluate.ts`. */
function laterThan(candidate: ExistingRun, holder: ExistingRun): boolean {
  const a = candidate.startedAt;
  const b = holder.startedAt;

  // Primary key: startedAt. ISO-8601 timestamps sort chronologically as text.
  if (a !== undefined && b !== undefined) {
    if (a !== b) return a > b;
  } else if (a !== b) {
    // Exactly one run carries a start time; the timestamped one is the later
    // attempt — an undefined start is treated as older than any defined one.
    return a !== undefined;
  }

  // Tie-break: greatest run id (higher ids are created later).
  if (candidate.id !== holder.id) return candidate.id > holder.id;

  // No reliable ordering: keep the holder, so the first-seen run wins.
  return false;
}

/**
 * Find the newest same-name run for a commit.
 *
 * After a create-after-completion the SHA can carry two same-name runs in
 * different check suites, so GitHub's own ordering cannot be trusted: the
 * latest attempt by `started_at` (tie-broken by id) must drive the next
 * create-vs-update decision. Otherwise every pending event would create
 * another run. A single bounded `listForRef` is enough to choose from.
 *
 * The request pins `check_name`, but the loop re-asserts the name anyway so a
 * foreign-named run can never be selected even if the API response is odd.
 */
async function findExisting(
  octokit: AnyOctokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<ExistingRun | undefined> {
  const response = await octokit.checks.listForRef({
    owner,
    repo,
    ref: sha,
    check_name: WHITE_GLOVE_CHECK_NAME,
    filter: "latest",
    per_page: 100,
  });

  let latest: ExistingRun | undefined;
  for (const run of response.data.check_runs) {
    // Fail closed: never select a run that is not ours, whatever the API returns.
    if (run.name !== WHITE_GLOVE_CHECK_NAME) continue;
    const candidate: ExistingRun = {
      id: run.id,
      status: run.status,
      startedAt: run.started_at ?? undefined,
    };
    if (latest === undefined || laterThan(candidate, latest)) {
      latest = candidate;
    }
  }
  return latest;
}

export interface ReconcileDeps {
  readonly octokit: AnyOctokit;
  readonly resolver: ConfigResolver;
  readonly log: Logger;
  readonly dryRun: boolean;
}

export interface ReconcileResult {
  readonly evaluation: Evaluation;
  /** The config actually used, so callers can read the grace period. */
  readonly gatekeeper: GatekeeperConfig;
}

/**
 * Evaluate a commit and reconcile the white-glove check to match.
 * Serialised per commit to avoid concurrent writes producing duplicates.
 */
export async function reconcile(
  deps: ReconcileDeps,
  owner: string,
  repo: string,
  sha: string,
  options: EvaluateOptions = {},
): Promise<ReconcileResult | undefined> {
  return mutex.run(`${owner}/${repo}@${sha}`, async () => {
    const { config } = await deps.resolver.resolve(deps.octokit as never, owner, repo, deps.log);

    const gatekeeper: GatekeeperConfig = config.gatekeeper;
    if (!gatekeeper.enabled) {
      deps.log.debug({ sha }, "Gatekeeper disabled by configuration; skipping");
      return undefined;
    }

    const runs = await listCheckRuns(deps.octokit, owner, repo, sha);
    const evaluation = evaluate(runs, gatekeeper, options);

    deps.log.debug(
      {
        sha,
        considered: runs.length,
        outcome: evaluation.outcome,
        awaitingStart: evaluation.awaitingStart,
      },
      "Evaluated commit",
    );

    await upsertCheck(deps.octokit, owner, repo, sha, evaluation, deps.log, deps.dryRun);
    return { evaluation, gatekeeper };
  });
}

/** True when this event is our own check run and must not be reacted to. */
export function isSelfCheck(name: string): boolean {
  return name === WHITE_GLOVE_CHECK_NAME;
}
