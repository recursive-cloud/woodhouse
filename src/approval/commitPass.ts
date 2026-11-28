/**
 * Factory for the commit-level hooks approval and escalation share.
 *
 * Both resolve the repository's configuration for the event, then act on the
 * commit with the resolved `autoApproval` block. Keeping the skeleton here is
 * what makes the two hooks differ only in their per-commit body.
 */

import type { Context } from "probot";
import type { Logger } from "pino";
import type { ConfigResolver } from "../config/resolver.js";
import type { AutoApprovalConfig } from "../config/schema.js";

type Api = Context<"pull_request">["octokit"];

/** The clients every commit-level hook body receives. */
export interface CommitPassDeps {
  readonly octokit: Api;
  readonly log: Logger;
}

export type CommitPassBody = (
  deps: CommitPassDeps,
  owner: string,
  repo: string,
  sha: string,
  config: AutoApprovalConfig,
) => Promise<void>;

/** The hook the app wires in: one call per commit event. */
export type CommitPass = (
  octokit: Api,
  log: Logger,
) => (owner: string, repo: string, sha: string) => Promise<void>;

/**
 * Build a commit-level hook: resolve the repository's config once per event,
 * then run `body` with the auto-approval block.
 */
export function commitPass(resolver: ConfigResolver, body: CommitPassBody): CommitPass {
  return (octokit, log) => async (owner, repo, sha) => {
    const { config } = await resolver.resolve(octokit as never, owner, repo, log);
    await body({ octokit, log }, owner, repo, sha, config.autoApproval);
  };
}
