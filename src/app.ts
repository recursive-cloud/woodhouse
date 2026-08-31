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

    // ---------------------------------------------------------------- config
    // Keep the cache honest: any push to a config file invalidates the repo's
    // entry immediately rather than waiting for the TTL to lapse.
    guarded.on("push", "config-invalidate", async (context, scope) => {
      if (scope.repo === undefined) return;

      const touched = context.payload.commits.some((commit) =>
        [...commit.added, ...commit.modified, ...commit.removed].some((path) =>
          path.endsWith("woodhouse.yml") || path.endsWith("woodhouse.yaml"),
        ),
      );
      if (!touched) return;

      // A push to the owner's `.github` repo changes the baseline for every
      // repository, so the whole cache for that owner must go.
      if (scope.repo === ".github") {
        resolver.invalidate(scope.owner, ".github");
        scope.log.info("Baseline config changed; invalidating owner cache");
      }
      resolver.invalidate(scope.owner, scope.repo);
      scope.log.info("Invalidated cached configuration");
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
  };
}
