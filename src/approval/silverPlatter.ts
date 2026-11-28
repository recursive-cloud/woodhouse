/**
 * Silver Platter — serves approvals to trusted actors.
 *
 * Approval is commit-level. A white-glove evaluation concluding success calls
 * in here with the head SHA; this pass resolves the open pull requests headed
 * by that commit and evaluates each one independently against its live state.
 * The pure policy in `policy.ts` still owns every decision.
 */

import type { Context } from "probot";
import type { Logger } from "pino";
import type { ConfigResolver } from "../config/resolver.js";
import type { AutoApprovalConfig } from "../config/schema.js";
import { appLogin } from "../github/app-login.js";
import { listChangedFiles } from "../github/pulls.js";
import { commitPass, forEachOpenPull, type CommitPass } from "./commitPass.js";
import { evaluateLivePull } from "./livePull.js";
import { classifyActor, decide } from "./policy.js";
import {
  handToOwners,
  holdsRequest,
  withdrawTrackedReviewers,
  type RoutingDeps,
  type SharedRoutingState,
} from "./routing.js";
import { approvalBody } from "./wording.js";
import { performWrite } from "../lib/dry-run.js";

type Api = Context<"pull_request">["octokit"];

/**
 * Cap on the number of file pages we will enumerate. A PR larger than this is
 * refused rather than approved on incomplete information.
 */
const MAX_FILE_PAGES = 10;

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
  /**
   * The routing state shared with the reviewer-routing listener. Present only
   * when reviewer routing is live; without it refusal escalation and recovery
   * reconcile are inert — that is what keeps the auto-approval-only harness
   * and its scenarios unchanged.
   */
  readonly routing?: SharedRoutingState;
}

/** The routing dependencies of the shared state, for escalation writes. */
function routingDeps(deps: SilverPlatterDeps, routing: SharedRoutingState): RoutingDeps {
  return {
    octokit: deps.octokit,
    log: deps.log,
    dryRun: deps.dryRun,
    routed: routing.routed,
  };
}

/**
 * Evaluate one open pull request headed by the commit. Returns true only when
 * a review was actually submitted.
 *
 * The live pull request comes from `evaluateLivePull`, so a head that moved or
 * a pull request that closed is skipped. A failed GET is not caught here — the
 * rejection reaches the commit-level fan-out, which logs it and moves on, so a
 * fetch error cannot read as a refusal.
 */
async function approvePullRequest(
  deps: SilverPlatterDeps,
  owner: string,
  repo: string,
  sha: string,
  number: number,
  config: AutoApprovalConfig,
): Promise<boolean> {
  const evaluated = await evaluateLivePull(deps, owner, repo, number, sha);
  if (evaluated === undefined) return false;

  const { pull, author } = evaluated;

  const actorClass = classifyActor(author, config);

  // Cheap checks first: an untrusted author or a draft is refused before any
  // review, file or app-login read.
  const preliminary = decide(
    {
      author,
      draft: pull.draft ?? false,
      state: pull.state,
      changedFiles: [],
      fileListTruncated: false,
      alreadyApproved: false,
    },
    config,
  );

  if (!preliminary.approve) {
    deps.log.debug({ pr: number, reason: preliminary.reason }, "Not auto-approving");
    return false;
  }

  const self = await appLogin(deps.octokit);

  const alreadyApproved = await hasExistingApproval(deps.octokit, owner, repo, number, sha, self);

  // Owners skip the fact entirely — their approval never depends on
  // auto-merge. For a bot the fact always comes from the same re-fetched pull
  // request, never a second GET.
  const autoMergeEnabledBy =
    actorClass === "bot" ? (pull.auto_merge?.enabled_by?.login ?? null) : undefined;

  // The file listing is the most expensive read, so it comes last.
  const { files, truncated } = await listChangedFiles(deps.octokit, owner, repo, number, {
    maxPages: MAX_FILE_PAGES,
  });

  // A previous_filename means the file was moved; the old location matters
  // just as much for protected-path checks.
  const changedFiles = [
    ...files.map((f) => f.filename),
    ...files.map((f) => f.previous_filename).filter((n): n is string => typeof n === "string"),
  ];

  const decision = decide(
    {
      author,
      draft: pull.draft ?? false,
      state: pull.state,
      changedFiles,
      fileListTruncated: truncated,
      alreadyApproved,
      autoMergeEnabledBy,
    },
    config,
  );

  if (!decision.approve) {
    deps.log.info({ pr: number, reason: decision.reason }, "Not auto-approving");

    // A policy refusal on a passing commit is the other way a bot pull request
    // gets stuck: routing put the review with Woodhouse, but Woodhouse will
    // never approve. Hand it to the owners instead. `alreadyApproved` keeps a
    // re-delivery of an approved commit from re-escalating after recovery
    // withdrew the owners — the guard is the boolean, never the reason text.
    if (
      deps.routing !== undefined &&
      !alreadyApproved &&
      holdsRequest(deps.routing, owner, repo, number, self)
    ) {
      await handToOwners(
        routingDeps(deps, deps.routing),
        owner,
        repo,
        number,
        config,
        `auto-approval refused: ${decision.reason}`,
        deps.routing.mutex,
      );
    }

    return false;
  }

  const approved = await performWrite(deps, "approve pull request", async () => {
    await deps.octokit.pulls.createReview({
      owner,
      repo,
      pull_number: number,
      event: "APPROVE",
      // Pin the review to the commit we actually inspected. Without this a push
      // landing mid-flight would be approved without ever being examined.
      commit_id: sha,
      body: approvalBody(actorClass, author),
    });
    return true;
  });

  if (approved === undefined) return false;

  // Recovery: the owners were asked to look while the commit was failing; now
  // Woodhouse has the review, so withdraw them. Only the tracked logins other
  // than Woodhouse are withdrawn — the code never calls removeRequestedReviewers
  // for a login it does not believe is currently requested. The tracked set
  // ends empty because Woodhouse holds the review through its approval; the
  // next routing pass re-requests whatever the desired set then is.
  //
  // The read-modify-write, including the clear for a set with no owner left
  // to withdraw, runs under the same per-repo routing mutex as every other
  // reviewer write, so a concurrent routing pass cannot interleave between the
  // tracked-set read and the write. Lock order stays commit mutex → routing
  // mutex: this already runs inside reconcile's commit mutex. Recovery is only
  // reachable after a confirmed approval write (the dry-run path returns early
  // above), so the unconditional tracked-set clear corresponds to a real state
  // change and does not violate the dry-run doctrine the withdrawal branch
  // follows.
  if (deps.routing !== undefined) {
    await withdrawTrackedReviewers(routingDeps(deps, deps.routing), owner, repo, number, {
      except: self,
      mutex: deps.routing.mutex,
    });
  }

  deps.log.info({ pr: number, author, sha }, "Approved pull request");
  return true;
}

/**
 * Approve every open pull request headed by `sha`, after a white-glove
 * evaluation of that commit concluded success.
 *
 * Returns true if at least one review was submitted; a commit heading no open
 * pull request does nothing. A rejected listing propagates — an API failure
 * must never be mistaken for "no pull requests". A failure evaluating one pull
 * request is logged and the pass moves on to the next one; the commit's next
 * event re-runs the pass.
 */
export async function serve(
  deps: SilverPlatterDeps,
  owner: string,
  repo: string,
  sha: string,
  config: AutoApprovalConfig,
): Promise<boolean> {
  // Auto-approval off must not even pay for the commit-to-PR listing.
  if (!config.enabled) {
    deps.log.debug({ sha }, "Auto-approval disabled by configuration; skipping");
    return false;
  }

  const approved = await forEachOpenPull(deps, owner, repo, sha, (number) =>
    approvePullRequest(deps, owner, repo, sha, number, config),
  );
  return approved.some((result) => result);
}

/**
 * Factory for the commit-level approval hook: resolve the repository's config,
 * then serve approvals for every open pull request headed by the commit.
 *
 * Shared by the production app wiring and the acceptance harness so the
 * scenarios exercise the same config resolution and `serve` call production
 * uses. The `autoApproval.enabled` gate lives inside `serve`, so the hook
 * itself stays unconditional.
 */
export function approvalPass(
  resolver: ConfigResolver,
  dryRun: boolean,
  routing?: SharedRoutingState,
): CommitPass {
  return commitPass(resolver, async (deps, owner, repo, sha, config) => {
    await serve({ ...deps, dryRun, routing }, owner, repo, sha, config);
  });
}
