/**
 * Reviewer routing — asks the right reviewer for each pull request.
 *
 * Routing is keyed to the auto-approval actor lists, so the reviewer a pull
 * request gets follows the same trust model that decides who may be approved:
 * an owner's pull request is routed to Woodhouse itself (an owner has already
 * vouched for the work), a bot's pull request is routed to Woodhouse only when
 * the bot enabled auto-merge itself, and everything else is routed to the
 * configured owners.
 *
 * Replacement semantics: one routed set at a time. Each pass diffs the desired
 * set against the set the previous pass requested and withdraws what it is no
 * longer asking for. Only reviewers this module requested are ever withdrawn —
 * requests made by people are not tracked, hence untouched.
 *
 * Tracking is in memory, per App process. A restart forgets what was requested,
 * so the next pass re-requests the desired set; a duplicate reviewer request is
 * idempotent on GitHub's side, so the cost is a redundant write, never a wrong
 * reviewer.
 */

import type { Context } from "probot";
import type { Logger } from "pino";
import type { AutoApprovalConfig } from "../config/schema.js";
import { getPullRequest } from "../github/pulls.js";
import { performWrite } from "../lib/dry-run.js";
import type { KeyedMutex } from "../lib/mutex.js";
import { classifyActor } from "./policy.js";

type Api = Context<"pull_request">["octokit"];

/**
 * How long to wait, on the `opened` action only, before reading the live pull
 * request for its auto-merge fact. Routing runs synchronously on the `opened`
 * event, so an immediate GET can still race the bot's own auto-merge toggle;
 * the webhook payload's snapshot is stale by the same margin. This grace is
 * routing's own, independent of commit-level approvals: those re-read the live
 * pull request after checks pass and no longer need it. A named constant,
 * tunable without redesign.
 */
const AUTO_MERGE_GRACE_MS = 2_000;

/** Promise-based delay so the grace can be awaited inline in the same pass. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The app's own login, e.g. `woodhouse[bot]`. Resolved once per process: it
 * cannot change while we are running, and `GET /app` is a wasted request on
 * every pull request otherwise.
 */
let cachedAppLogin: Promise<string> | undefined;

export function resetAppLoginCache(): void {
  cachedAppLogin = undefined;
}

export async function appLogin(octokit: Api): Promise<string> {
  cachedAppLogin ??= octokit.apps
    .getAuthenticated()
    .then((response) => `${(response.data as { slug: string }).slug}[bot]`)
    .catch((error: unknown) => {
      // Do not cache a failure; a transient error should not disable routing
      // for the lifetime of the process.
      cachedAppLogin = undefined;
      throw error;
    });
  return cachedAppLogin;
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

export interface RoutingRequest {
  readonly author: string;
  readonly draft: boolean;
  readonly state: string;
  /**
   * Tri-state auto-merge fact, same convention as ApprovalRequest.autoMergeEnabledBy:
   * undefined = not gathered (owner/neither authors never gather it), null = gathered
   * nobody enabled auto-merge, string = the login that enabled it.
   */
  readonly autoMergeEnabledBy?: string | null;
}

export interface RoutingDecision {
  /** Logins to request as reviewers; empty means request nothing. */
  readonly reviewers: readonly string[];
  readonly reason: string;
}

/** GitHub logins compare case-insensitively; normalise both sides of every check. */
const normalizeLogin = (login: string): string => login.trim().toLowerCase();

/**
 * Route to every configured owner except the App's own login, or to nobody
 * when there is no owner left to route to. `reason` carries the situation
 * that led here.
 */
function ownersFor(
  config: AutoApprovalConfig,
  selfLogin: string | undefined,
  reason: string,
): RoutingDecision {
  // Validation rejects duplicate owners case-insensitively (see the schema),
  // so the list is taken as-is. The App can never be its own reviewer, so a
  // configured login equal to `selfLogin` is filtered out.
  const owners =
    selfLogin === undefined
      ? [...config.allowedActors.owners]
      : config.allowedActors.owners.filter(
          (owner) => normalizeLogin(owner) !== normalizeLogin(selfLogin),
        );

  if (owners.length === 0) {
    return {
      reviewers: [],
      reason: `${reason}; no reviewer to route to in autoApproval.allowedActors.owners`,
    };
  }

  return { reviewers: owners, reason };
}

/**
 * Decide which reviewers to request on a pull request. Pure: every fact is
 * passed in, so the refusal reasons are directly testable.
 *
 * @param selfLogin the App's own login, e.g. `woodhouse[bot]`. Only resolved
 *   when auto-approval is enabled; `undefined` routes an owner or bot case to
 *   the configured owners rather than requesting a missing login.
 */
export function route(
  request: RoutingRequest,
  config: AutoApprovalConfig,
  selfLogin: string | undefined,
): RoutingDecision {
  if (request.state !== "open") {
    return { reviewers: [], reason: `pull request is ${request.state}` };
  }

  if (request.draft) {
    // A draft is an explicit statement that the work is not ready; asking
    // someone to review it now is premature.
    return { reviewers: [], reason: "pull request is a draft" };
  }

  const actorClass = classifyActor(request.author, config);

  if (actorClass === "owner") {
    // Woodhouse never requests itself for a pull request it is not involved
    // in: with auto-approval disabled an owner's pull request gets no request.
    if (!config.enabled) {
      return {
        reviewers: [],
        reason: `auto-approval is disabled; owner "${request.author}" gets no reviewer request`,
      };
    }

    if (selfLogin !== undefined) {
      return {
        reviewers: [selfLogin],
        reason: `author "${request.author}" is an owner; routing to the app itself`,
      };
    }

    // Fail-safe guard: an enabled config should always have a resolved login,
    // but never request the literal `undefined`.
    return ownersFor(
      config,
      selfLogin,
      `author "${request.author}" is an owner but the app login is unknown; routing to the configured owners`,
    );
  }

  if (actorClass === "bot") {
    const enabledBy = request.autoMergeEnabledBy;

    if (config.enabled && typeof enabledBy === "string") {
      if (normalizeLogin(enabledBy) === normalizeLogin(request.author)) {
        if (selfLogin !== undefined) {
          return {
            reviewers: [selfLogin],
            reason: `author "${request.author}" is a bot and enabled auto-merge itself; routing to the app itself`,
          };
        }

        return ownersFor(
          config,
          selfLogin,
          `author "${request.author}" is a bot and enabled auto-merge itself but the app login is unknown; routing to the configured owners`,
        );
      }

      return ownersFor(
        config,
        selfLogin,
        `author "${request.author}" is a bot but auto-merge was enabled by "${enabledBy}"; routing to the configured owners`,
      );
    }

    return ownersFor(
      config,
      selfLogin,
      `author "${request.author}" is a bot but nobody enabled auto-merge; routing to the configured owners`,
    );
  }

  return ownersFor(
    config,
    selfLogin,
    `author "${request.author}" is not in autoApproval.allowedActors; routing to the configured owners`,
  );
}

/** Drop the tracked routed set for a closed pull request. Close and merge end
 *  routing's interest in a pull request; the tracked entry would otherwise live
 *  for the rest of the process. No API write: GitHub owns review requests on a
 *  closed pull request.
 */
export function forget(
  deps: Pick<RoutingDeps, "log" | "routed">,
  owner: string,
  repo: string,
  number: number,
): void {
  const key = `${owner}/${repo}#${number}`;
  if (deps.routed.delete(key)) {
    deps.log.debug({ pr: number }, "Forgot routed reviewers on close");
  }
}

export interface RoutingDeps {
  readonly octokit: Api;
  readonly log: Logger;
  readonly dryRun: boolean;
  /** Reviewer sets routing last requested, keyed `${owner}/${repo}#${number}`. */
  readonly routed: Map<string, readonly string[]>;
}

export interface RoutingFacts {
  readonly number: number;
  readonly author: string;
  readonly draft: boolean;
  readonly state: string;
  /** The `pull_request` action that triggered this pass, e.g. `opened`. */
  readonly action: string;
}

/**
 * Gather the facts, decide, and reconcile the requested reviewer set with the
 * last one routing made.
 */
export async function serve(
  deps: RoutingDeps,
  owner: string,
  repo: string,
  pr: RoutingFacts,
  config: AutoApprovalConfig,
): Promise<void> {
  const actorClass = classifyActor(pr.author, config);

  // Only a bot on an open, non-draft pull request can use the fact: route()
  // discards it in every other case, so gathering it there would waste the
  // grace and a GET. Owners and unlisted authors never need it either.
  const autoMergeEnabledBy =
    actorClass === "bot" && config.enabled && pr.state === "open" && !pr.draft
      ? await getAutoMergeEnabledBy(deps.octokit, owner, repo, pr.number, pr.action)
      : undefined;

  const selfLogin = config.enabled ? await appLogin(deps.octokit) : undefined;

  const decision = route(
    {
      author: pr.author,
      draft: pr.draft,
      state: pr.state,
      autoMergeEnabledBy,
    },
    config,
    selfLogin,
  );

  await reconcileReviewers(deps, owner, repo, pr.number, decision);
}

/**
 * True when the reviewer set routing last requested for the pull request
 * contains `login`, compared case-insensitively.
 */
export function holdsRequest(
  deps: Pick<RoutingDeps, "routed">,
  owner: string,
  repo: string,
  number: number,
  login: string,
): boolean {
  const key = `${owner}/${repo}#${number}`;
  const tracked = deps.routed.get(key) ?? [];
  return tracked.some((candidate) => normalizeLogin(candidate) === normalizeLogin(login));
}

/**
 * Reconcile one desired reviewer set with the set routing last requested for
 * the pull request: withdraw what is no longer wanted, request what is new,
 * then remember the result.
 *
 * The whole read-modify-write runs under `mutex` when one is given, keyed per
 * repository exactly like the routing listener. Callers already holding that
 * lock (the listener itself) pass no mutex.
 */
export async function reconcileReviewers(
  deps: RoutingDeps,
  owner: string,
  repo: string,
  prNumber: number,
  decision: RoutingDecision,
  mutex?: KeyedMutex,
): Promise<void> {
  const reconcile = async (): Promise<void> => {
    const key = `${owner}/${repo}#${prNumber}`;
    const previous = deps.routed.get(key) ?? [];
    const next = decision.reviewers;

    const toWithdraw = previous.filter(
      (login) => !next.some((candidate) => normalizeLogin(candidate) === normalizeLogin(login)),
    );
    const toRequest = next.filter(
      (login) => !previous.some((candidate) => normalizeLogin(candidate) === normalizeLogin(login)),
    );

    if (toWithdraw.length > 0) {
      const withdrawn = await performWrite(
        deps,
        "withdraw the previous review request",
        async () => {
          await deps.octokit.pulls.removeRequestedReviewers({
            owner,
            repo,
            pull_number: prNumber,
            reviewers: [...toWithdraw],
          });
          return true;
        },
      );

      // Dry-run: nothing reached GitHub, so the next pass must still see the
      // previous set as un-replaced.
      if (withdrawn === undefined) return;
    }

    if (toRequest.length > 0) {
      const requested = await performWrite(deps, "request the routed reviewer(s)", async () => {
        await deps.octokit.pulls.requestReviewers({
          owner,
          repo,
          pull_number: prNumber,
          reviewers: [...toRequest],
        });
        return true;
      });

      // Dry-run: nothing reached GitHub, so remember nothing.
      if (requested === undefined) return;
    }

    if (toWithdraw.length === 0 && toRequest.length === 0) {
      deps.log.debug(
        { pr: prNumber, reviewers: next, reason: decision.reason },
        "Review routing unchanged",
      );
      return;
    }

    deps.routed.set(key, next);
    deps.log.info(
      { pr: prNumber, reviewers: next, reason: decision.reason },
      "Routed pull request reviewers",
    );
  };

  if (mutex !== undefined) {
    await mutex.run(`${owner}/${repo}`, reconcile);
    return;
  }

  await reconcile();
}

/**
 * Hand the pull request's review to the configured owners, withdrawing
 * whichever routed reviewer is currently tracked (typically Woodhouse itself).
 *
 * Replacement semantics do the dedupe the issue asks for: the diff withdraws
 * Woodhouse exactly when Woodhouse holds the tracked request, and requests the
 * owners exactly when they are not already the tracked set. A second hand-off
 * therefore writes nothing.
 */
export async function handToOwners(
  deps: RoutingDeps,
  owner: string,
  repo: string,
  number: number,
  config: AutoApprovalConfig,
  reason: string,
  mutex?: KeyedMutex,
): Promise<void> {
  const selfLogin = config.enabled ? await appLogin(deps.octokit) : undefined;
  await reconcileReviewers(deps, owner, repo, number, ownersFor(config, selfLogin, reason), mutex);
}

/**
 * The routing state the commit-level passes share with the routing listener:
 * the same map the listener tracks, and the optional mutex that serialises
 * reviewer writes per repository with it. Lock order is commit mutex → routing
 * mutex only, never the reverse.
 */
export interface SharedRoutingState {
  readonly routed: Map<string, readonly string[]>;
  readonly mutex?: KeyedMutex;
}
