/**
 * Woodhouse — the application function.
 *
 * Every listener is registered through `GuardedApp`, never on the Probot
 * instance directly, so the installation allowlist is unconditionally enforced.
 */

import type { Probot } from "probot";
import { Allowlist } from "./security/allowlist.js";
import { GuardedApp } from "./security/guard.js";
import { ConfigResolver } from "./config/resolver.js";
import { isSelfCheck, reconcile } from "./gatekeeper/handler.js";
import { syncSettings } from "./settings/apply.js";
import { validatePullRequest } from "./settings/validate.js";
import { serve } from "./approval/silverPlatter.js";
import { loadEnv, type WoodhouseEnv } from "./lib/env.js";

export interface AppOptions {
  readonly env?: WoodhouseEnv;
}

export function createApp(options: AppOptions = {}) {
  const env = options.env ?? loadEnv();

  return function woodhouse(app: Probot): void {
    const allowlist = new Allowlist(env.allowedInstallationTargets);
    const resolver = new ConfigResolver();
    const guarded = new GuardedApp(app, allowlist);

    app.log.info(
      {
        allowedInstallationTargets: allowlist.describe(),
        dryRun: env.dryRun,
      },
      "Woodhouse reporting for duty",
    );

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
        if (scope.repo === ".github") {
          // The baseline changed, so every repository this owner has is now
          // stale, not merely `.github`.
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
          dryRun: env.dryRun,
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

        await reconcile(
          {
            octokit: context.octokit,
            resolver,
            log: scope.log,
            dryRun: env.dryRun,
          },
          scope.owner,
          scope.repo,
          sha,
        );
      },
    );

    // The check must exist as soon as the PR does, otherwise a PR whose checks
    // have not started yet shows no white-glove entry at all and, if it is a
    // required check, GitHub reports it as "expected — waiting" with no context.
    guarded.on(
      [
        "pull_request.opened",
        "pull_request.reopened",
        "pull_request.synchronize",
      ],
      "white-glove:pull_request",
      async (context, scope) => {
        if (scope.repo === undefined) return;

        await reconcile(
          {
            octokit: context.octokit,
            resolver,
            log: scope.log,
            dryRun: env.dryRun,
          },
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

        await reconcile(
          {
            octokit: context.octokit,
            resolver,
            log: scope.log,
            dryRun: env.dryRun,
          },
          scope.owner,
          scope.repo,
          sha,
        );
      },
    );

    // -------------------------------------------------------- silver platter
    guarded.on(
      ["pull_request.opened", "pull_request.reopened"],
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
            dryRun: env.dryRun,
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
            dryRun: env.dryRun,
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
