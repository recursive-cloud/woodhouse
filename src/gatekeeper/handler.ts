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
import {
  evaluate,
  type CheckRunLike,
  type Evaluation,
} from "./evaluate.js";
import { WHITE_GLOVE_CHECK_NAME, WHITE_GLOVE_TITLE } from "./constants.js";

type AnyOctokit = Context<"check_run">["octokit"];

const mutex = new KeyedMutex();

/**
 * GitHub caps check-run output summaries at 65535 characters. A repository with
 * a very large matrix could plausibly approach that.
 */
const MAX_SUMMARY = 60_000;

function truncate(text: string): string {
  return text.length <= MAX_SUMMARY
    ? text
    : `${text.slice(0, MAX_SUMMARY)}\n\n_(truncated)_`;
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
 * Note that we do NOT deduplicate by name ourselves: two different apps may
 * legitimately publish the same check name, and since failure takes precedence
 * over success, evaluating both is the fail-safe behaviour.
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
  }));
}

/**
 * Create or update the white-glove check run for a commit.
 *
 * `pending` maps to the Checks API `in_progress` status: there is no "pending"
 * status, and an in-progress required check is what blocks a merge.
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

  const base = { owner, repo, name: WHITE_GLOVE_CHECK_NAME, head_sha: sha };

  const body =
    evaluation.outcome === "pending"
      ? { ...base, status: "in_progress" as const, output }
      : {
          ...base,
          status: "completed" as const,
          conclusion: evaluation.outcome,
          completed_at: new Date().toISOString(),
          output,
        };

  if (dryRun) {
    log.info({ sha, outcome: evaluation.outcome, dryRun: true },
      "DRY_RUN: would write white-glove check");
    return;
  }

  const existing = await findExisting(octokit, owner, repo, sha);

  if (existing === undefined) {
    await octokit.checks.create(body);
    log.info(
      { sha, outcome: evaluation.outcome, counts: evaluation.counts },
      "Created white-glove check",
    );
    return;
  }

  await octokit.checks.update({ ...body, check_run_id: existing });
  log.info(
    { sha, outcome: evaluation.outcome, counts: evaluation.counts },
    "Updated white-glove check",
  );
}

async function findExisting(
  octokit: AnyOctokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<number | undefined> {
  const response = await octokit.checks.listForRef({
    owner,
    repo,
    ref: sha,
    check_name: WHITE_GLOVE_CHECK_NAME,
    per_page: 1,
    filter: "latest",
  });
  return response.data.check_runs[0]?.id;
}

export interface ReconcileDeps {
  readonly octokit: AnyOctokit;
  readonly resolver: ConfigResolver;
  readonly log: Logger;
  readonly dryRun: boolean;
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
): Promise<Evaluation | undefined> {
  return mutex.run(`${owner}/${repo}@${sha}`, async () => {
    const { config } = await deps.resolver.resolve(
      deps.octokit as never,
      owner,
      repo,
      deps.log,
    );

    const gatekeeper: GatekeeperConfig = config.gatekeeper;
    if (!gatekeeper.enabled) {
      deps.log.debug({ sha }, "Gatekeeper disabled by configuration; skipping");
      return undefined;
    }

    const runs = await listCheckRuns(deps.octokit, owner, repo, sha);
    const evaluation = evaluate(runs, gatekeeper);

    deps.log.debug(
      { sha, considered: runs.length, outcome: evaluation.outcome },
      "Evaluated commit",
    );

    await upsertCheck(
      deps.octokit,
      owner,
      repo,
      sha,
      evaluation,
      deps.log,
      deps.dryRun,
    );
    return evaluation;
  });
}

/** True when this event is our own check run and must not be reacted to. */
export function isSelfCheck(name: string): boolean {
  return name === WHITE_GLOVE_CHECK_NAME;
}
