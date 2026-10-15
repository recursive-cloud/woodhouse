/**
 * The onboarding git-write seam — the only place Woodhouse writes a branch, a
 * commit, or a pull request to a user's repository.
 *
 * Every call goes through `performWrite`, so dry-run is structural: in DRY_RUN
 * this module makes zero octokit calls of any kind. Nothing here reads either —
 * the default branch, its head SHA, and whether the onboarding branch already
 * exists are pre-resolved facts supplied by the handler, which has to read that
 * state for `shouldOnboard` regardless. Keeping the probes out of here is what
 * makes "dry-run issues zero calls" literally true against a recording fake.
 *
 * Errors are deliberately not caught. A 403 from an installation restricted to
 * read-only contents propagates to the handler, which records it per
 * repository; the handler catches, not this seam.
 */

import type { Context } from "probot";
import { performWrite, type WriteContext } from "../lib/dry-run.js";
import {
  ONBOARDING_BRANCH,
  ONBOARDING_FILE_PATH,
  ONBOARDING_LABEL,
  ONBOARDING_PR_BODY,
  ONBOARDING_PR_TITLE,
  ONBOARDING_TEMPLATE,
} from "./wording.js";

type Api = Context<"push">["octokit"];

/**
 * The conventional commit message for the single commit that adds the starter
 * configuration. It lives beside the write that uses it: the wording constants
 * in `wording.ts` are the idempotency-search keys and do not include it.
 */
export const ONBOARDING_COMMIT_MESSAGE = "chore: add Woodhouse configuration";

/** Everything the write seam needs: the dry-run context plus the octokit client. */
export interface OnboardingWriteDeps extends WriteContext {
  readonly octokit: Api;
}

/**
 * Repository state the handler resolves before calling the seam.
 *
 * All three are plain data on purpose — the seam must not make a read, or a
 * dry-run would issue calls:
 *
 * - `defaultBranch` is the base of the pull request.
 * - `defaultBranchSha` is the head SHA the onboarding branch is created from.
 * - `branchExists` tells the seam whether the branch has to be created. When it
 *   already does, the seam opens a pull request from the existing branch
 *   without rewriting it (the closed-unmerged case); the template-drift edge is
 *   documented, not solved.
 */
export interface OnboardingFacts {
  readonly defaultBranch: string;
  readonly defaultBranchSha: string;
  readonly branchExists: boolean;
}

/**
 * What the handler needs to log the outcome. `pullRequestNumber` is undefined
 * in dry-run, where no pull request exists.
 */
export interface OnboardingResult {
  readonly pullRequestNumber?: number;
}

/**
 * Open the onboarding pull request for one repository.
 *
 * On a fresh repository this creates the branch from the default branch's head,
 * commits the starter configuration to it, opens the pull request, and labels
 * it — in that order. On a repository whose onboarding branch already exists it
 * skips straight to the pull request (task 2.2): no ref call, no contents call,
 * nothing rewritten.
 *
 * The label add is a fourth write, also behind `performWrite`: `pulls.create`
 * cannot set labels, and `woodhouse: onboarding` is the idempotency marker the
 * handler's probe searches for. GitHub creates a missing label on first add, so
 * there is no label-creation call.
 */
export async function openOnboardingPullRequest(
  deps: OnboardingWriteDeps,
  owner: string,
  repo: string,
  facts: OnboardingFacts,
): Promise<OnboardingResult> {
  const base = { owner, repo };

  if (!facts.branchExists) {
    await performWrite(deps, `create branch ${ONBOARDING_BRANCH}`, () =>
      deps.octokit.git.createRef({
        ...base,
        ref: `refs/heads/${ONBOARDING_BRANCH}`,
        sha: facts.defaultBranchSha,
      }),
    );

    await performWrite(deps, `commit ${ONBOARDING_FILE_PATH} to ${ONBOARDING_BRANCH}`, () =>
      deps.octokit.repos.createOrUpdateFileContents({
        ...base,
        path: ONBOARDING_FILE_PATH,
        branch: ONBOARDING_BRANCH,
        message: ONBOARDING_COMMIT_MESSAGE,
        content: Buffer.from(ONBOARDING_TEMPLATE, "utf8").toString("base64"),
      }),
    );
  }

  const created = await performWrite(deps, `open pull request "${ONBOARDING_PR_TITLE}"`, () =>
    deps.octokit.pulls.create({
      ...base,
      title: ONBOARDING_PR_TITLE,
      head: ONBOARDING_BRANCH,
      base: facts.defaultBranch,
      body: ONBOARDING_PR_BODY,
    }),
  );

  if (deps.dryRun) {
    // Dry-run: nothing was created, so there is no pull request to label. The
    // per-write `performWrite` labels already carry the branch, the file and
    // the title; this surfaces the whole would-be pull request (including the
    // body) in one place for the operator.
    deps.log.info(
      {
        branch: ONBOARDING_BRANCH,
        file: ONBOARDING_FILE_PATH,
        title: ONBOARDING_PR_TITLE,
        body: ONBOARDING_PR_BODY,
      },
      "DRY_RUN: would open onboarding pull request",
    );
    return {};
  }

  if (created === undefined) {
    // Unreachable on the live path (`performWrite` returns the callback's
    // result). Fail closed rather than try to label a pull request we cannot
    // identify.
    return {};
  }

  const pullRequestNumber = created.data.number;

  await performWrite(
    deps,
    `add label "${ONBOARDING_LABEL}" to pull request #${pullRequestNumber}`,
    () =>
      deps.octokit.issues.addLabels({
        ...base,
        issue_number: pullRequestNumber,
        labels: [ONBOARDING_LABEL],
      }),
  );

  return { pullRequestNumber };
}
