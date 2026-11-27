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
import { performWrite } from "../lib/dry-run.js";
import { classifyActor } from "./policy.js";
import { appLogin, getAutoMergeEnabledBy } from "./silverPlatter.js";

type Api = Context<"pull_request">["octokit"];

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
 * Route to every configured owner, or to nobody when there is no owner to
 * route to. `reason` carries the situation that led here.
 */
function ownersFor(config: AutoApprovalConfig, reason: string): RoutingDecision {
  // Deduplicate while preserving order: GitHub rejects a request naming the
  // same reviewer twice, and a repeated config login must not do that.
  const owners = [...new Set(config.allowedActors.owners)];

  if (owners.length === 0) {
    return {
      reviewers: [],
      reason: `${reason}; no owner is configured in autoApproval.allowedActors.owners, so there is no reviewer to route to`,
    };
  }

  return { reviewers: [...owners], reason };
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
          `author "${request.author}" is a bot and enabled auto-merge itself but the app login is unknown; routing to the configured owners`,
        );
      }

      return ownersFor(
        config,
        `author "${request.author}" is a bot but auto-merge was enabled by "${enabledBy}"; routing to the configured owners`,
      );
    }

    return ownersFor(
      config,
      `author "${request.author}" is a bot but nobody enabled auto-merge; routing to the configured owners`,
    );
  }

  return ownersFor(
    config,
    `author "${request.author}" is not in autoApproval.allowedActors; routing to the configured owners`,
  );
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

  const key = `${owner}/${repo}#${pr.number}`;
  const previous = deps.routed.get(key) ?? [];
  const next = decision.reviewers;

  const toWithdraw = previous.filter(
    (login) => !next.some((candidate) => normalizeLogin(candidate) === normalizeLogin(login)),
  );
  const toRequest = next.filter(
    (login) => !previous.some((candidate) => normalizeLogin(candidate) === normalizeLogin(login)),
  );

  if (toWithdraw.length > 0) {
    const withdrawn = await performWrite(deps, "withdraw the previous review request", async () => {
      await deps.octokit.pulls.removeRequestedReviewers({
        owner,
        repo,
        pull_number: pr.number,
        reviewers: [...toWithdraw],
      });
      return true;
    });

    // Dry-run: nothing reached GitHub, so the next pass must still see the
    // previous set as un-replaced.
    if (withdrawn === undefined) return;
  }

  if (toRequest.length > 0) {
    const requested = await performWrite(deps, "request the routed reviewer(s)", async () => {
      await deps.octokit.pulls.requestReviewers({
        owner,
        repo,
        pull_number: pr.number,
        reviewers: [...toRequest],
      });
      return true;
    });

    // Dry-run: nothing reached GitHub, so remember nothing.
    if (requested === undefined) return;
  }

  if (toWithdraw.length === 0 && toRequest.length === 0) {
    deps.log.debug(
      { pr: pr.number, reviewers: next, reason: decision.reason },
      "Review routing unchanged",
    );
    return;
  }

  deps.routed.set(key, next);
  deps.log.info(
    { pr: pr.number, reviewers: next, reason: decision.reason },
    "Routed pull request reviewers",
  );
}
