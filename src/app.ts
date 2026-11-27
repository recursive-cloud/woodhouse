/**
 * Woodhouse — the application function.
 *
 * Registered against a single GitHub App. The server may run several of these
 * side by side, one per App, each with its own credentials and allowlist.
 *
 * Every listener goes through `GuardedApp`, never the Probot instance
 * directly, so the installation allowlist is unconditionally enforced.
 */

import type { Probot } from "probot";
import type { Allowlist } from "./security/allowlist.js";
import { GuardedApp } from "./security/guard.js";
import { ConfigResolver, invalidateTouchedConfig } from "./config/resolver.js";
import { isSettingsPath } from "./config/paths.js";
import {
  isSelfCheck,
  reconcile,
  type ReconcileDeps,
  type ReconcileResult,
} from "./gatekeeper/handler.js";
import { syncSettings } from "./settings/apply.js";
import { commentSettingsApplied } from "./settings/mergeFeedback.js";
import { validatePullRequest } from "./settings/validate.js";
import { serve } from "./approval/silverPlatter.js";
import { serve as routeReviewers } from "./approval/routing.js";
import { handleOnboarding } from "./onboarding/handler.js";
import { Scheduler } from "./lib/scheduler.js";
import { KeyedMutex } from "./lib/mutex.js";

export interface AppOptions {
  /** Owners this App is permitted to act on. */
  readonly allowlist: Allowlist;
  /** Repository holding the owner-wide baseline config. */
  readonly baselineRepo: string;
  /** Evaluate and log, but never write to GitHub. */
  readonly dryRun: boolean;
}

/** Reconciliation dependencies plus the scheduler the grace path needs. */
export interface GraceDeps extends ReconcileDeps {
  readonly scheduler: Scheduler;
}

/** What the first pass saw and whether it scheduled a re-check. */
export interface FirstPass {
  readonly result: ReconcileResult;
  readonly graceMs: number;
  /** False when the commit is not waiting on checks, or the grace period is zero. */
  readonly scheduled: boolean;
}

/**
 * Seed the check on a commit, then look again once CI has had a chance to
 * register.
 *
 * The first pass runs with `emptyIsPending`, because at this moment GitHub has
 * almost certainly not created the Actions check runs yet and concluding "no
 * checks, therefore success" would put a green required check on a commit
 * nothing has tested. The scheduled second pass has no such constraint, so a
 * commit that genuinely has no CI settles on success rather than blocking
 * forever.
 */
export async function seedAndSchedule(
  deps: GraceDeps,
  owner: string,
  repo: string,
  sha: string,
): Promise<FirstPass | undefined> {
  const result = await reconcile(deps, owner, repo, sha, { emptyIsPending: true });
  if (result === undefined) return undefined;

  const graceMs = result.gatekeeper.gracePeriodSeconds * 1000;
  if (!result.evaluation.awaitingStart) return { result, graceMs, scheduled: false };
  if (graceMs === 0) return { result, graceMs, scheduled: false };

  deps.log.debug(
    { sha, graceSeconds: result.gatekeeper.gracePeriodSeconds },
    "No checks yet; holding pending for the grace period",
  );

  deps.scheduler.schedule(
    `${owner}/${repo}@${sha}`,
    graceMs,
    async () => {
      await reconcile(deps, owner, repo, sha);
    },
    (error) => deps.log.error({ err: error, sha }, "Grace period recheck failed"),
  );

  return { result, graceMs, scheduled: true };
}

/** The fields of a completed check run the gatekeeper reacts to. */
export interface CompletedCheckRun {
  readonly name: string;
  readonly head_sha: string;
}

/**
 * React to a check run completing on a commit.
 *
 * A check run has just completed, so the commit demonstrably has checks: there
 * is no empty-set ambiguity to guard against here.
 */
export async function handleCheckRunCompleted(
  deps: ReconcileDeps,
  owner: string,
  repo: string,
  checkRun: CompletedCheckRun,
): Promise<ReconcileResult | undefined> {
  // Reacting to our own completion would loop forever.
  if (isSelfCheck(checkRun.name)) return undefined;

  return reconcile(deps, owner, repo, checkRun.head_sha);
}

/**
 * React to a check suite completing on a commit.
 *
 * A suite can complete having produced no check runs at all - for example when
 * every workflow was filtered out by `paths`. Without this the grace period
 * would be the only thing resolving that case.
 */
export async function handleCheckSuiteCompleted(
  deps: ReconcileDeps,
  owner: string,
  repo: string,
  sha: string,
): Promise<ReconcileResult | undefined> {
  return reconcile(deps, owner, repo, sha);
}

export function createApp(options: AppOptions) {
  return function woodhouse(app: Probot): void {
    const resolver = new ConfigResolver({ baselineRepo: options.baselineRepo });
    const guarded = new GuardedApp(app, options.allowlist);
    const scheduler = new Scheduler();
    const settingsMutex = new KeyedMutex();
    const routingMutex = new KeyedMutex();
    const routedReviewers = new Map<string, readonly string[]>();

    const deps = (log: Parameters<typeof serve>[0]["log"]) => ({
      resolver,
      log,
      dryRun: options.dryRun,
    });

    // ------------------------------------------------------------- settings
    guarded.on("push", "settings-sync", async (context, scope) => {
      const repo = scope.repo;
      if (repo === undefined) return;

      const payload = context.payload;

      // Only the default branch defines configuration. Reacting to every
      // branch would let an unreviewed feature branch rewrite settings.
      const defaultRef = `refs/heads/${payload.repository.default_branch}`;
      if (payload.ref !== defaultRef) return;
      if (payload.deleted) return;

      const touchedConfig = payload.commits.some((commit) =>
        [...commit.added, ...commit.modified, ...commit.removed].some((path) =>
          isSettingsPath(path),
        ),
      );

      // Keep the cache honest before reading it back.
      if (touchedConfig) {
        const invalidation = invalidateTouchedConfig(resolver, scope.owner, repo);
        if (invalidation === "owner") {
          scope.log.info("Baseline configuration changed; cleared owner cache");
        }
      }

      const resolved = await resolver.resolve(
        context.octokit as never,
        scope.owner,
        repo,
        scope.log,
      );

      // The gate lives in `syncSettings`: file presence is the opt-in signal,
      // `settings.enabled` is the kill switch, and an invalid resolution fails
      // closed. Serialise per repository so a merge push and the merged pull
      // request's own event cannot run the sync concurrently.
      await settingsMutex.run(`${scope.owner}/${repo}`, () =>
        syncSettings(
          {
            octokit: context.octokit,
            owner: scope.owner,
            repo,
            log: scope.log,
            dryRun: options.dryRun,
          },
          resolved,
        ),
      );
    });

    // A pull request that merges a settings change fires here, not only as a
    // push to the default branch. Forwarding only; the gate, cache
    // invalidation and sync live in `commentSettingsApplied`.
    guarded.on("pull_request.closed", "settings-applied", async (context, scope) => {
      const repo = scope.repo;
      if (repo === undefined) return;

      const payload = context.payload;

      await commentSettingsApplied(
        {
          octokit: context.octokit,
          resolver,
          mutex: settingsMutex,
          log: scope.log,
          dryRun: options.dryRun,
        },
        {
          owner: scope.owner,
          repo,
          defaultBranch: payload.repository.default_branch,
        },
        {
          number: payload.pull_request.number,
          merged: payload.pull_request.merged === true,
          baseRef: payload.pull_request.base.ref,
        },
      );
    });

    // ------------------------------------------------------------ gatekeeper
    guarded.on("check_run.completed", "white-glove:check_run", async (context, scope) => {
      if (scope.repo === undefined) return;

      await handleCheckRunCompleted(
        { octokit: context.octokit, ...deps(scope.log) },
        scope.owner,
        scope.repo,
        context.payload.check_run,
      );
    });

    // A suite can complete having produced no check runs at all - for example
    // when every workflow was filtered out by `paths`. Without this the grace
    // period would be the only thing resolving that case.
    guarded.on("check_suite.completed", "white-glove:check_suite", async (context, scope) => {
      if (scope.repo === undefined) return;

      await handleCheckSuiteCompleted(
        { octokit: context.octokit, ...deps(scope.log) },
        scope.owner,
        scope.repo,
        context.payload.check_suite.head_sha,
      );
    });

    guarded.on(
      ["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"],
      "white-glove:pull_request",
      async (context, scope) => {
        if (scope.repo === undefined) return;

        await seedAndSchedule(
          { octokit: context.octokit, ...deps(scope.log), scheduler },
          scope.owner,
          scope.repo,
          context.payload.pull_request.head.sha,
        );
      },
    );

    // Manual re-run from the Checks tab.
    guarded.on(
      ["check_run.rerequested", "check_suite.rerequested"],
      "white-glove:rerequested",
      async (context, scope) => {
        if (scope.repo === undefined) return;

        const sha =
          "check_run" in context.payload
            ? context.payload.check_run.head_sha
            : context.payload.check_suite.head_sha;

        await seedAndSchedule(
          { octokit: context.octokit, ...deps(scope.log), scheduler },
          scope.owner,
          scope.repo,
          sha,
        );
      },
    );

    // -------------------------------------------------------- silver platter
    guarded.on(
      [
        "pull_request.opened",
        "pull_request.reopened",
        // A draft is never approved, so the moment it becomes ready is the
        // first opportunity to look at it.
        "pull_request.ready_for_review",
        // Approvals are pinned to the head SHA, so a push invalidates the
        // previous review and the pull request needs a fresh one. Renovate
        // force-pushes on every rebase, which without this leaves its pull
        // requests approved once and then permanently stale.
        "pull_request.synchronize",
      ],
      "silver-platter",
      async (context, scope) => {
        if (scope.repo === undefined) return;

        const pr = context.payload.pull_request;

        const { config } = await resolver.resolve(
          context.octokit as never,
          scope.owner,
          scope.repo,
          scope.log,
        );

        await serve(
          {
            octokit: context.octokit,
            log: scope.log,
            dryRun: options.dryRun,
          },
          scope.owner,
          scope.repo,
          {
            number: pr.number,
            author: pr.user.login,
            draft: pr.draft ?? false,
            state: pr.state,
            headSha: pr.head.sha,
            action: context.payload.action,
          },
          config.autoApproval,
        );
      },
    );

    // ------------------------------------------------------ reviewer routing
    // Each open pull request gets one routed reviewer set, replaced on the
    // events that can change which actor class applies.
    guarded.on(
      [
        "pull_request.opened",
        "pull_request.reopened",
        "pull_request.ready_for_review",
        "pull_request.synchronize",
      ],
      "review-routing",
      async (context, scope) => {
        if (scope.repo === undefined) return;

        const repo = scope.repo;
        const pr = context.payload.pull_request;

        const { config } = await resolver.resolve(
          context.octokit as never,
          scope.owner,
          repo,
          scope.log,
        );

        // Serialise per repository: concurrent opened and synchronize events
        // could otherwise both diff against a stale routed set.
        await routingMutex.run(`${scope.owner}/${repo}`, () =>
          routeReviewers(
            {
              octokit: context.octokit,
              log: scope.log,
              dryRun: options.dryRun,
              routed: routedReviewers,
            },
            scope.owner,
            repo,
            {
              number: pr.number,
              author: pr.user.login,
              draft: pr.draft ?? false,
              state: pr.state,
              action: context.payload.action,
            },
            config.autoApproval,
          ),
        );
      },
    );

    // --------------------------------------------------- config validation
    guarded.on(
      ["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"],
      "config-validation",
      async (context, scope) => {
        if (scope.repo === undefined) return;

        await validatePullRequest(
          {
            octokit: context.octokit,
            log: scope.log,
            dryRun: options.dryRun,
          },
          scope.owner,
          scope.repo,
          context.payload.pull_request.number,
          context.payload.pull_request.head.sha,
        );
      },
    );

    // ------------------------------------------------------------- onboarding
    // Registered for the two action-scoped events design D1 names: a fresh
    // install (`installation.created`) and a repository added later
    // (`installation_repositories.added`). Both forward to the same handler,
    // which normalises the repository list per D1. `scope.repo` is deliberately
    // unused: these events are about the installation, not any one repository's
    // webhook subject. The handler keeps its own action gate as defence in
    // depth, so a replayed delivery is still a no-op.
    guarded.on("installation.created", "onboarding", async (context, scope) => {
      await handleOnboarding(
        {
          octokit: context.octokit,
          log: scope.log,
          dryRun: options.dryRun,
        },
        scope.owner,
        context.payload,
      );
    });

    guarded.on("installation_repositories.added", "onboarding", async (context, scope) => {
      await handleOnboarding(
        {
          octokit: context.octokit,
          log: scope.log,
          dryRun: options.dryRun,
        },
        scope.owner,
        context.payload,
      );
    });
  };
}
