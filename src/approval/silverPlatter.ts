/**
 * Silver Platter — serves approvals to trusted actors.
 *
 * Gathers the facts, hands them to the pure policy in `policy.ts`, and casts
 * the review if permitted.
 */

import type { Context } from "probot";
import type { Logger } from "pino";
import type { AutoApprovalConfig } from "../config/schema.js";
import { listChangedFiles } from "../github/pulls.js";
import { decide } from "./policy.js";
import { performWrite } from "../lib/dry-run.js";

type Api = Context<"pull_request">["octokit"];

/**
 * Cap on the number of file pages we will enumerate. A PR larger than this is
 * refused rather than approved on incomplete information.
 */
const MAX_FILE_PAGES = 10;

/**
 * The app's own login, e.g. `woodhouse[bot]`. Resolved once per process: it
 * cannot change while we are running, and `GET /app` is a wasted request on
 * every pull request otherwise.
 */
let cachedAppLogin: Promise<string> | undefined;

export function resetAppLoginCache(): void {
  cachedAppLogin = undefined;
}

async function appLogin(octokit: Api): Promise<string> {
  cachedAppLogin ??= octokit.apps
    .getAuthenticated()
    .then((response) => `${(response.data as { slug: string }).slug}[bot]`)
    .catch((error: unknown) => {
      // Do not cache a failure; a transient error should not disable approvals
      // for the lifetime of the process.
      cachedAppLogin = undefined;
      throw error;
    });
  return cachedAppLogin;
}

async function hasExistingApproval(
  octokit: Api,
  owner: string,
  repo: string,
  number: number,
  headSha: string,
  self: string,
): Promise<boolean> {
  const reviews = await octokit.paginate(octokit.pulls.listReviews, {
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  });

  return reviews.some(
    (review) =>
      review.state === "APPROVED" &&
      review.user?.login?.toLowerCase() === self.toLowerCase() &&
      // Scoped to the commit: a new push must earn a fresh approval, otherwise
      // an approved PR could be amended with arbitrary code afterwards.
      review.commit_id === headSha,
  );
}

export interface SilverPlatterDeps {
  readonly octokit: Api;
  readonly log: Logger;
  readonly dryRun: boolean;
}

export interface PullRequestFacts {
  readonly number: number;
  readonly author: string;
  readonly draft: boolean;
  readonly state: string;
  readonly headSha: string;
}

export async function serve(
  deps: SilverPlatterDeps,
  owner: string,
  repo: string,
  pr: PullRequestFacts,
  config: AutoApprovalConfig,
): Promise<boolean> {
  // Cheap checks first, so an unremarkable PR from an untrusted author costs
  // no API calls at all. Most webhook traffic will land here.
  const preliminary = decide(
    {
      author: pr.author,
      draft: pr.draft,
      state: pr.state,
      changedFiles: [],
      fileListTruncated: false,
      alreadyApproved: false,
    },
    config,
  );

  if (!preliminary.approve) {
    deps.log.debug({ pr: pr.number, reason: preliminary.reason }, "Not auto-approving");
    return false;
  }

  const self = await appLogin(deps.octokit);

  const [{ files, truncated }, alreadyApproved] = await Promise.all([
    listChangedFiles(deps.octokit, owner, repo, pr.number, { maxPages: MAX_FILE_PAGES }),
    hasExistingApproval(deps.octokit, owner, repo, pr.number, pr.headSha, self),
  ]);

  // A previous_filename means the file was moved; the old location matters
  // just as much for protected-path checks.
  const changedFiles = [
    ...files.map((f) => f.filename),
    ...files.map((f) => f.previous_filename).filter((n): n is string => typeof n === "string"),
  ];

  const decision = decide(
    {
      author: pr.author,
      draft: pr.draft,
      state: pr.state,
      changedFiles,
      fileListTruncated: truncated,
      alreadyApproved,
    },
    config,
  );

  if (!decision.approve) {
    deps.log.info({ pr: pr.number, reason: decision.reason }, "Not auto-approving");
    return false;
  }

  const approved = await performWrite(deps, "approve pull request", async () => {
    await deps.octokit.pulls.createReview({
      owner,
      repo,
      pull_number: pr.number,
      event: "APPROVE",
      // Pin the review to the commit we actually inspected. Without this a push
      // landing mid-flight would be approved without ever being examined.
      commit_id: pr.headSha,
      body:
        "Approved automatically — the author is listed in " +
        "`autoApproval.allowedActors` and this pull request touches no " +
        "protected paths.\n\n_Woodhouse, at your service._",
    });
    return true;
  });

  if (approved === undefined) return false;

  deps.log.info({ pr: pr.number, author: pr.author, sha: pr.headSha }, "Approved pull request");
  return true;
}
