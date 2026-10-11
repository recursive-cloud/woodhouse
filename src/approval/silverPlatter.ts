/**
 * Silver Platter — serves approvals to trusted actors.
 *
 * Gathers the facts, hands them to the pure policy in `policy.ts`, and casts
 * the review if permitted.
 */

import type { Context } from "probot";
import type { Logger } from "pino";
import type { AutoApprovalConfig } from "../config/schema.js";
import { getPullRequest, listChangedFiles } from "../github/pulls.js";
import { classifyActor, decide } from "./policy.js";
import { approvalBody } from "./wording.js";
import { performWrite } from "../lib/dry-run.js";

type Api = Context<"pull_request">["octokit"];

/**
 * Cap on the number of file pages we will enumerate. A PR larger than this is
 * refused rather than approved on incomplete information.
 */
const MAX_FILE_PAGES = 10;

/**
 * How long to wait, on the `opened` action only, before reading the live pull
 * request. The webhook payload's snapshot is stale — a bot like Renovate
 * toggles auto-merge a moment after opening — so we give it that moment. A
 * named constant, tunable without redesign.
 */
const AUTO_MERGE_GRACE_MS = 2_000;

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
  /** The `pull_request` action that triggered this evaluation, e.g. `opened`. */
  readonly action: string;
}

/** Promise-based delay so the grace can be awaited inline in the same pass. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the login that enabled auto-merge on the pull request, from its current
 * state — never the stale `auto_merge` snapshot in the webhook payload.
 *
 * On `opened` we wait the short grace first (an immediate read races the bot's
 * own toggle); on the other events the state has settled. A failed GET is not
 * caught: the rejection propagates and fails the pass, so a fetch error can
 * never become a silent `null` that reads as "nobody enabled auto-merge".
 */
async function getAutoMergeEnabledBy(
  octokit: Api,
  owner: string,
  repo: string,
  number: number,
  action: string,
): Promise<string | null> {
  if (action === "opened") await sleep(AUTO_MERGE_GRACE_MS);

  const pull = await getPullRequest(octokit, owner, repo, number);
  return pull.auto_merge?.enabled_by?.login ?? null;
}

export async function serve(
  deps: SilverPlatterDeps,
  owner: string,
  repo: string,
  pr: PullRequestFacts,
  config: AutoApprovalConfig,
): Promise<boolean> {
  const actorClass = classifyActor(pr.author, config);

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

  const [{ files, truncated }, alreadyApproved, autoMergeEnabledBy] = await Promise.all([
    listChangedFiles(deps.octokit, owner, repo, pr.number, { maxPages: MAX_FILE_PAGES }),
    hasExistingApproval(deps.octokit, owner, repo, pr.number, pr.headSha, self),
    // Owners skip the fetch entirely — their approval never depends on
    // auto-merge. For a bot the full pass always carries a gathered fact
    // (`null` or a login), never `undefined`.
    actorClass === "bot"
      ? getAutoMergeEnabledBy(deps.octokit, owner, repo, pr.number, pr.action)
      : undefined,
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
      autoMergeEnabledBy,
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
      body: approvalBody(actorClass, pr.author),
    });
    return true;
  });

  if (approved === undefined) return false;

  deps.log.info({ pr: pr.number, author: pr.author, sha: pr.headSha }, "Approved pull request");
  return true;
}
