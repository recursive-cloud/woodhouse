/**
 * Escalation — hands a stuck pull request to the human owners.
 *
 * A bot pull request with auto-merge active can sit red forever: routing asked
 * Woodhouse to review it because the bot enabled auto-merge itself, but the
 * approval pass only runs after a successful white-glove evaluation, so
 * Woodhouse holds the review and never approves while checks fail. This pass
 * runs on failure instead: when Woodhouse holds the review of a bot pull
 * request the bot asked to merge, it withdraws itself and requests the
 * configured owners. The owners then see the failing pull request.
 *
 * The approval pass complements this on recovery: when the commit finally
 * passes and Woodhouse approves, it withdraws the owners.
 */

import type { ConfigResolver } from "../config/resolver.js";
import type { AutoApprovalConfig } from "../config/schema.js";
import { appLogin } from "../github/app-login.js";
import type { KeyedMutex } from "../lib/mutex.js";
import { commitPass, forEachOpenPull, type CommitPass } from "./commitPass.js";
import { evaluateLivePull } from "./livePull.js";
import { classifyActor, normalizeLogin, type ActorClass } from "./policy.js";
import {
  handToOwners,
  holdsRequest,
  type RoutingDeps,
  type SharedRoutingState,
} from "./routing.js";

export interface EscalationFacts {
  readonly author: string;
  readonly actorClass: ActorClass;
  /** Login that enabled auto-merge, from the live pull request; null means nobody. */
  readonly autoMergeEnabledBy: string | null;
  /** True when the app's own login is in the tracked routed set. */
  readonly heldBySelf: boolean;
}

/**
 * True only when a bot enabled auto-merge on its own pull request and the app
 * currently holds its review. An owner, an unlisted author, a bot that did not
 * ask to merge, or a pull request whose review already sits with someone else
 * never needs the hand-off.
 */
export function shouldHandToOwners(facts: EscalationFacts): boolean {
  return (
    facts.actorClass === "bot" &&
    facts.autoMergeEnabledBy !== null &&
    normalizeLogin(facts.autoMergeEnabledBy) === normalizeLogin(facts.author) &&
    facts.heldBySelf
  );
}

/**
 * Evaluate one open pull request headed by a failed commit and hand it to the
 * owners when it needs the hand-off. `evaluateLivePull` provides the same
 * moved-head and closed guards as the approval pass. A rejected GET propagates
 * to the caller.
 *
 * Check events read settled state, so there is deliberately no auto-merge
 * grace sleep here — the same posture as ADR 0014's commit-level approval.
 * With `autoApproval.enabled` false routing never requests the app, so `held`
 * is false and escalation is naturally inert; a mid-process config flip
 * resolves to the same state `route()` produces when disabled.
 */
async function escalatePullRequest(
  deps: RoutingDeps,
  owner: string,
  repo: string,
  sha: string,
  number: number,
  config: AutoApprovalConfig,
  self: string,
  mutex?: KeyedMutex,
): Promise<void> {
  const evaluated = await evaluateLivePull(deps, owner, repo, number, sha);
  if (evaluated === undefined) return;

  const { pull, author } = evaluated;

  const actorClass = classifyActor(author, config);
  const autoMergeEnabledBy = pull.auto_merge?.enabled_by?.login ?? null;
  const heldBySelf = holdsRequest(deps, owner, repo, number, self);

  if (!shouldHandToOwners({ author, actorClass, autoMergeEnabledBy, heldBySelf })) {
    deps.log.debug(
      { pr: number, actorClass, autoMergeEnabledBy, heldBySelf },
      "Not handing the review to the owners",
    );
    return;
  }

  await handToOwners(deps, owner, repo, number, config, `checks failed on commit ${sha}`, mutex);
}

/**
 * Escalate every open pull request headed by the failed commit. A failure
 * evaluating one pull request is logged and the walk moves on to the next: the
 * commit's next event re-runs the pass.
 */
async function escalateFailedCommit(
  deps: RoutingDeps,
  owner: string,
  repo: string,
  sha: string,
  config: AutoApprovalConfig,
  self: string,
  mutex?: KeyedMutex,
): Promise<void> {
  await forEachOpenPull(deps, owner, repo, sha, (number) =>
    escalatePullRequest(deps, owner, repo, sha, number, config, self, mutex),
  );
}

/**
 * Factory for the commit-level failure hook: resolve the repository's config,
 * then hand the stopped pull requests to the owners.
 *
 * Mirrors `approvalPass`: the `autoApproval.enabled` gate is checked here
 * because escalation is the failure-side half of the same decision.
 */
export function escalationPass(
  resolver: ConfigResolver,
  dryRun: boolean,
  routing: SharedRoutingState,
): CommitPass {
  return commitPass(resolver, async (deps, owner, repo, sha, config) => {
    const routingDeps: RoutingDeps = { ...deps, dryRun, routed: routing.routed };

    // With auto-approval disabled routing never requests the app, so nothing
    // can be held; skip without resolving the login.
    const self = config.enabled ? await appLogin(deps.octokit) : undefined;
    if (self === undefined) {
      deps.log.debug({ sha }, "Auto-approval disabled by configuration; skipping escalation");
      return;
    }

    await escalateFailedCommit(routingDeps, owner, repo, sha, config, self, routing.mutex);
  });
}
