/**
 * Shared marker-comment manager.
 *
 * Keeps at most one comment carrying a caller-supplied hidden marker on an
 * issue or pull request, and only while the caller wants it. The caller
 * decides *which* outcome it wants (present body vs. `undefined` for absent);
 * this module owns only the mechanics: list comments, find by marker, then
 * create, update in place, or delete.
 *
 * The manager guards its own writes through `performWrite`, so every caller
 * gets dry-run safety structurally: in dry-run it performs zero octokit calls
 * (including no listing) and logs a single `DRY_RUN: would ...` line.
 */

import type { Context } from "probot";
import type { Logger } from "pino";
import { performWrite, type WriteContext } from "../lib/dry-run.js";

type Api = Context<"issues">["octokit"];

/** GitHub's maximum page size; a short page marks the last one. */
const PER_PAGE = 100;

export interface CommentDeps extends WriteContext {
  readonly octokit: Api;
  readonly log: Logger;
}

export interface SyncMarkerCommentOptions {
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  /**
   * Hidden HTML-comment marker identifying our own comment. Identity is
   * marker-based, not author-based, so the comment is found reliably even if
   * the App is renamed, and a human quoting the bot cannot collide with it.
   */
  readonly marker: string;
  /** A defined body ensures the comment is present; `undefined` ensures absent. */
  readonly body: string | undefined;
}

/**
 * Reconcile the marker comment to the requested state.
 *
 * `body === undefined` ensures the comment is absent (delete it if found); a
 * defined body ensures it is present (create it, or update the existing one in
 * place). A listing or write failure is logged and swallowed: the caller's
 * authoritative signal (a check run, an approval) must not fail because a
 * cosmetic comment could not be managed.
 */
export async function syncMarkerComment(
  deps: CommentDeps,
  options: SyncMarkerCommentOptions,
): Promise<void> {
  await performWrite(deps, `sync comment ${options.marker}`, async () => {
    let existing: number | undefined;

    try {
      const comments = await deps.octokit.paginate(deps.octokit.issues.listComments, {
        owner: options.owner,
        repo: options.repo,
        issue_number: options.issueNumber,
        per_page: PER_PAGE,
      });
      existing = comments.find((c) => c.body?.includes(options.marker))?.id;
    } catch (error) {
      deps.log.warn({ err: error, issue: options.issueNumber }, "Could not list comments");
      return;
    }

    try {
      if (options.body === undefined) {
        if (existing !== undefined) {
          await deps.octokit.issues.deleteComment({
            owner: options.owner,
            repo: options.repo,
            comment_id: existing,
          });
          deps.log.info({ issue: options.issueNumber }, "Removed marker comment");
        }
        return;
      }

      if (existing === undefined) {
        await deps.octokit.issues.createComment({
          owner: options.owner,
          repo: options.repo,
          issue_number: options.issueNumber,
          body: options.body,
        });
      } else {
        await deps.octokit.issues.updateComment({
          owner: options.owner,
          repo: options.repo,
          comment_id: existing,
          body: options.body,
        });
      }
    } catch (error) {
      deps.log.warn({ err: error, issue: options.issueNumber }, "Could not write marker comment");
    }
  });
}
