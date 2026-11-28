/**
 * The `woodhouse/dress-code` check.
 *
 * The title rule itself lives in `conventional/parse.ts`; this module only
 * turns a title into a check-run verdict and writes it. The write path is the
 * white-glove path reused wholesale: latest-run lookup (`findLatestRun`),
 * create-vs-update resolution (`resolveCheckWrite`) and the dry-run guard
 * (`performWrite`).
 */

import type { Context } from "probot";
import type { Logger } from "pino";
import type { ConfigResolver } from "../config/resolver.js";
import { titleFailure } from "../conventional/parse.js";
import type { Outcome } from "../gatekeeper/evaluate.js";
import { findLatestRun, truncate } from "../gatekeeper/handler.js";
import { resolveCheckWrite } from "../gatekeeper/write-decision.js";
import { performWrite } from "../lib/dry-run.js";
import { KeyedMutex } from "../lib/mutex.js";
import {
  DRESS_CODE_CHECK_NAME,
  DRESS_CODE_DISABLED_REASON,
  DRESS_CODE_NO_PULL_REQUEST_REASON,
  DRESS_CODE_TITLE,
} from "./constants.js";

type AnyOctokit = Context<"check_run">["octokit"];

const mutex = new KeyedMutex();

export interface DressCodeDeps {
  readonly octokit: AnyOctokit;
  readonly resolver: Pick<ConfigResolver, "resolve">;
  readonly log: Logger;
  readonly dryRun: boolean;
}

/** The commit and title a pull-request event supplies. */
export interface DressCodeTarget {
  readonly owner: string;
  readonly repo: string;
  readonly sha: string;
  readonly title: string;
}

export type DressCodeConclusion = "success" | "failure" | "neutral";

export interface DressCodeDecision {
  readonly outcome: DressCodeConclusion;
  readonly output: {
    readonly title: string;
    readonly summary: string;
  };
}

/**
 * Pure: map a pull-request title to the check verdict and output.
 *
 * The title is passed through untrimmed — surrounding whitespace is a pattern
 * violation, not something this layer repairs.
 */
export function decideDressCode(title: string): DressCodeDecision {
  const failure = titleFailure(title);

  if (failure === undefined) {
    return {
      outcome: "success",
      output: {
        title: `${DRESS_CODE_TITLE}: Title is conventional`,
        summary:
          "Very good, sir. The pull request title is a conventional commit " +
          "that release-please can use.",
      },
    };
  }

  return {
    outcome: "failure",
    output: {
      title: `${DRESS_CODE_TITLE}: Title is not conventional`,
      // `titleFailure` names both the expected pattern and the offending title.
      summary: `${failure.message}\n\nSquash merges carry the pull request title, so it must follow the pattern.`,
    },
  };
}

/** Pure: a terminal neutral verdict explaining why no title check ran. */
export function neutralDressCode(reason: string): DressCodeDecision {
  return {
    outcome: "neutral",
    output: {
      title: `${DRESS_CODE_TITLE}: Skipped`,
      summary: reason,
    },
  };
}

function lockKey(owner: string, repo: string, sha: string): string {
  return `${owner}/${repo}@${sha}`;
}

/**
 * Resolve the enabled flag.
 *
 * Deliberate: the config resolution runs outside the per-commit mutex. A config
 * superseded between this read and the write is converged by the next event for
 * the commit, which re-resolves it.
 */
async function isEnabled(deps: DressCodeDeps, owner: string, repo: string): Promise<boolean> {
  const { config } = await deps.resolver.resolve(deps.octokit as never, owner, repo, deps.log);
  return config.dressCode.enabled;
}

/**
 * Create or update the dress-code run for a commit.
 *
 * Always terminal: a dress-code run never sits pending or queued, so a
 * completed run is always safe to update in place.
 */
async function writeDecision(
  deps: DressCodeDeps,
  owner: string,
  repo: string,
  sha: string,
  decision: DressCodeDecision,
): Promise<void> {
  const state = {
    status: "completed" as const,
    conclusion: decision.outcome,
    completed_at: new Date().toISOString(),
    output: {
      ...decision.output,
      // A failure summary embeds the pull-request title, so it must be capped
      // exactly like the white-glove write path caps its own summary.
      summary: truncate(decision.output.summary),
    },
  };

  // Neutral is terminal exactly like success and failure, so it takes the same
  // create-vs-update resolution. Only a pending verdict would need a fresh run,
  // and dress-code never writes one.
  const writeOutcome: Outcome = decision.outcome === "neutral" ? "success" : decision.outcome;

  await performWrite({ dryRun: deps.dryRun, log: deps.log }, "write dress-code check", async () => {
    const existing = await findLatestRun(deps.octokit, owner, repo, sha, DRESS_CODE_CHECK_NAME);

    if (resolveCheckWrite(existing, writeOutcome) === "create") {
      await deps.octokit.checks.create({
        owner,
        repo,
        name: DRESS_CODE_CHECK_NAME,
        head_sha: sha,
        ...state,
      });
      deps.log.info({ sha, conclusion: decision.outcome }, "Created dress-code check");
      return;
    }

    // `resolveCheckWrite` only returns "update" when a run exists; fail closed
    // rather than PATCH an unknown target if that contract is ever broken.
    if (existing === undefined) {
      throw new Error("Cannot update dress-code check: no existing run for the head commit");
    }

    // `head_sha` is a create-only parameter; the update body deliberately
    // omits it (GitHub has no such field on the update endpoint).
    await deps.octokit.checks.update({
      owner,
      repo,
      name: DRESS_CODE_CHECK_NAME,
      ...state,
      check_run_id: existing.id,
    });
    deps.log.info({ sha, conclusion: decision.outcome }, "Updated dress-code check");
  });
}

/**
 * The title of the pull request headed by `sha`, preferring open pull requests
 * and then the lowest PR number.
 *
 * A re-requested check carries no pull-request payload, so the associated-PR
 * listing is the only way back to the title. The listing is paginated so a
 * commit with many associated pull requests cannot hide the open one on a later
 * page. Returns undefined when no pull request's head is the commit we were
 * asked about.
 */
async function titleForCommit(
  octokit: AnyOctokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<string | undefined> {
  const pulls = await octokit.paginate(octokit.repos.listPullRequestsAssociatedWithCommit, {
    owner,
    repo,
    commit_sha: sha,
    per_page: 100,
  });

  const matching = pulls.filter((pull) => pull.head.sha === sha);
  if (matching.length === 0) return undefined;

  const open = matching.filter((pull) => pull.state === "open");
  const candidates = open.length > 0 ? open : matching;

  let chosen: (typeof candidates)[number] | undefined;
  for (const pull of candidates) {
    if (chosen === undefined || pull.number < chosen.number) chosen = pull;
  }
  return chosen?.title;
}

/**
 * Run the dress-code check for a pull request event.
 *
 * Disabled resolves to no write at all: the check is opt-in per repository.
 */
export async function runDressCodeCheck(
  deps: DressCodeDeps,
  target: DressCodeTarget,
): Promise<void> {
  const { owner, repo, sha, title } = target;

  if (!(await isEnabled(deps, owner, repo))) {
    deps.log.debug({ sha }, "Dress-code disabled by configuration; skipping");
    return;
  }

  await mutex.run(lockKey(owner, repo, sha), async () => {
    await writeDecision(deps, owner, repo, sha, decideDressCode(title));
  });
}

/**
 * Complete a check the user re-requested from the Checks tab.
 *
 * A re-requested run must never stay queued. When dress-code is disabled, or
 * the commit has no associated pull request, the run completes neutral with an
 * explanation instead of a title verdict.
 */
export async function reRequestDressCodeCheck(
  deps: DressCodeDeps,
  owner: string,
  repo: string,
  sha: string,
): Promise<void> {
  const enabled = await isEnabled(deps, owner, repo);

  await mutex.run(lockKey(owner, repo, sha), async () => {
    if (!enabled) {
      await writeDecision(deps, owner, repo, sha, neutralDressCode(DRESS_CODE_DISABLED_REASON));
      return;
    }

    const title = await titleForCommit(deps.octokit, owner, repo, sha);
    if (title === undefined) {
      await writeDecision(
        deps,
        owner,
        repo,
        sha,
        neutralDressCode(DRESS_CODE_NO_PULL_REQUEST_REASON),
      );
      return;
    }

    await writeDecision(deps, owner, repo, sha, decideDressCode(title));
  });
}
