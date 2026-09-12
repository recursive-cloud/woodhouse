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
import { ConfigResolver } from "./config/resolver.js";
import { isSelfCheck, reconcile } from "./gatekeeper/handler.js";
import { syncSettings } from "./settings/apply.js";
import { validatePullRequest } from "./settings/validate.js";
import { serve } from "./approval/silverPlatter.js";
import { Scheduler } from "./lib/scheduler.js";

export interface AppOptions {
  /** Owners this App is permitted to act on. */
  readonly allowlist: Allowlist;
  /** Repository holding the owner-wide baseline config. */
  readonly baselineRepo: string;
  /** Evaluate and log, but never write to GitHub. */
  readonly dryRun: boolean;
}

export function createApp(options: AppOptions) {
  return function woodhouse(app: Probot): void {
    const resolver = new ConfigResolver({ baselineRepo: options.baselineRepo });
    const guarded = new GuardedApp(app, options.allowlist);
    const scheduler = new Scheduler();

    const deps = (log: Parameters<typeof serve>[0]["log"]) => ({
      resolver,
      log,
      dryRun: options.dryRun,
    });

    // ------------------------------------------------------------- settings
    guarded.on("push", "settings-sync", async (context, scope) => {
      if (scope.repo === undefined) return;

      const payload = context.payload;

      // Only the default branch defines configuration. Reacting to every
      // branch would let an unreviewed feature branch rewrite settings.
      const defaultRef = `refs/heads/${payload.repository.default_branch}`;
      if (payload.ref !== defaultRef) return;
      if (payload.deleted) return;

      const touchedConfig = payload.commits.some((commit) =>
        [...commit.added, ...commit.modified, ...commit.removed].some(
          (path) =>
            path.endsWith("woodhouse.yml") || path.endsWith("woodhouse.yaml"),
        ),
      );

      // Keep the cache honest before reading it back.
      if (touchedConfig) {
        if (resolver.isBaselineRepo(scope.repo)) {
          // The baseline changed, so every repository this owner has is now
          // stale, not merely the baseline repo itself.
          resolver.invalidateOwner(scope.owner);
          scope.log.info("Baseline configuration changed; cleared owner cache");
        } else {
          resolver.invalidate(scope.owner, scope.repo);
        }
      }

      const { config, sources } = await resolver.resolve(
        context.octokit as never,
        scope.owner,
        scope.repo,
        scope.log,
      );

      if (!config.settings.enabled) return;

      scope.log.debug({ sources }, "Running settings sync");

      await syncSettings(
        {
          octokit: context.octokit,
          owner: scope.owner,
          repo: scope.repo,
          log: scope.log,
          dryRun: options.dryRun,
        },
        config,
      );
    });

    // ------------------------------------------------------------ gatekeeper
    guarded.on(
      "check_run.completed",
      "white-glove:check_run",
      async (context, scope) => {
        if (scope.repo === undefined) return;

        // Reacting to our own completion would loop forever.
        if (isSelfCheck(context.payload.check_run.name)) return;

        const sha = context.payload.check_run.head_sha;

        // A check run has just completed, so the commit demonstrably has
        // checks: there is no empty-set ambiguity to guard against here.
        await reconcile(
          { octokit: context.octokit, ...deps(scope.log) },
          scope.owner,
          scope.repo,
          sha,
        );
      },
    );

    // A suite can complete having produced no check runs at all - for example
    // when every workflow was filtered out by `paths`. Without this the grace
    // period would be the only thing resolving that case.
    guarded.on(
      "check_suite.completed",
      "white-glove:check_suite",
      async (context, scope) => {
        if (scope.repo === undefined) return;

        await reconcile(
          { octokit: context.octokit, ...deps(scope.log) },
          scope.owner,
          scope.repo,
          context.payload.check_suite.head_sha,
        );
      },
    );

    /**
     * Seed the check on a pull request, then look again once CI has had a
     * chance to register.
     *
     * The first pass runs with `emptyIsPending`, because at this moment GitHub
     * has almost certainly not created the Actions check runs yet and
     * concluding "no checks, therefore success" would put a green required
     * check on a commit nothing has tested. The scheduled second pass has no
     * such constraint, so a commit that genuinely has no CI settles on success
     * rather than blocking forever.
     */
    const seedAndSchedule = async (
      octokit: Parameters<typeof reconcile>[0]["octokit"],
      scope: { owner: string; repo: string; log: ReturnType<typeof deps>["log"] },
      sha: string,
    ) => {
      const result = await reconcile(
        { octokit, ...deps(scope.log) },
        scope.owner,
        scope.repo,
        sha,
        { emptyIsPending: true },
      );

      if (result === undefined) return;
      if (!result.evaluation.awaitingStart) return;

      const graceMs = result.gatekeeper.gracePeriodSeconds * 1000;
      if (graceMs === 0) return;

      scope.log.debug(
        { sha, graceSeconds: result.gatekeeper.gracePeriodSeconds },
        "No checks yet; holding pending for the grace period",
      );

      scheduler.schedule(
        `${scope.owner}/${scope.repo}@${sha}`,
        graceMs,
        async () => {
          await reconcile(
            { octokit, ...deps(scope.log) },
            scope.owner,
            scope.repo,
            sha,
          );
        },
        (error) =>
          scope.log.error({ err: error, sha }, "Grace period recheck failed"),
      );
    };

    guarded.on(
      [
        "pull_request.opened",
        "pull_request.reopened",
        "pull_request.synchronize",
      ],
      "white-glove:pull_request",
      async (context, scope) => {
        if (scope.repo === undefined) return;

        await seedAndSchedule(
          context.octokit,
          { owner: scope.owner, repo: scope.repo, log: scope.log },
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
          context.octokit,
          { owner: scope.owner, repo: scope.repo, log: scope.log },
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
          },
          config.autoApproval,
        );
      },
    );

    // --------------------------------------------------- config validation
    guarded.on(
      [
        "pull_request.opened",
        "pull_request.reopened",
        "pull_request.synchronize",
      ],
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
  };
}
