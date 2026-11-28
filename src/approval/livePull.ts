/**
 * The live pull request both commit-level passes re-read before acting.
 *
 * The listing and the evaluation can be seconds apart, and a head SHA that has
 * moved or a pull request that has closed must never be approved or escalated.
 * A failed GET is not caught here — the rejection reaches the caller, which
 * logs it and moves on, so a fetch error cannot read as a refusal.
 */

import type { Context } from "probot";
import type { Logger } from "pino";
import { getPullRequest } from "../github/pulls.js";

type Api = Context<"pull_request">["octokit"];

export interface LivePullDeps {
  readonly octokit: Api;
  readonly log: Logger;
}

/** A pull request as the live GET returned it. */
export type LivePull = Awaited<ReturnType<typeof getPullRequest>>;

export interface EvaluatedPull {
  readonly pull: LivePull;
  readonly author: string;
}

/**
 * Re-fetch the pull request and return it only while it still matches `sha`
 * and carries an author login. Either guard returns `undefined` after a debug
 * log, so the caller skips the pull request without an action.
 */
export async function evaluateLivePull(
  deps: LivePullDeps,
  owner: string,
  repo: string,
  number: number,
  sha: string,
): Promise<EvaluatedPull | undefined> {
  const pull = await getPullRequest(deps.octokit, owner, repo, number);

  if (pull.state !== "open" || pull.head.sha !== sha) {
    deps.log.debug(
      { pr: number, state: pull.state, head: pull.head.sha, sha },
      "Pull request no longer matches the evaluated commit; skipping",
    );
    return undefined;
  }

  const author = pull.user?.login;
  if (author === undefined) {
    deps.log.debug({ pr: number }, "Not evaluating: pull request has no author login");
    return undefined;
  }

  return { pull, author };
}
