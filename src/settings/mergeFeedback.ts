/**
 * Settings-applied feedback: did this merge change the settings, and if so,
 * sync them.
 *
 * A `pull_request` closed event fires for every pull request, merged or not,
 * into any branch. Reacting to all of them would be noise, so the decision of
 * whether a merge actually changed live settings is kept here as a plain
 * function over plain data and tested exhaustively, without octokit.
 *
 * Three things must all hold:
 *  - the pull request actually merged (a close without merge is not a change);
 *  - it merged into the default branch (settings only live from the default
 *    branch, so a merge into a feature branch has not changed live config);
 *  - at least one changed file is a settings path, in any status — an added,
 *    modified or deleted settings file is equally a settings change.
 *
 * `commentSettingsApplied` applies that gate to a real delivery and then runs
 * the existing sync machinery: it invalidates the config cache, resolves the
 * freshly-merged configuration, honours the master `settings.enabled` switch,
 * and runs `syncSettings` under the same per-repository mutex as the push
 * handler. Once the sync returns, it posts the outcome as a marker comment so
 * the merge reports what actually happened.
 */

import type { Context } from "probot";
import type { Logger } from "pino";
import { SIGN_OFF } from "../approval/wording.js";
import { isSettingsPath } from "../config/paths.js";
import {
  type ContentsClient,
  type ResolvedConfig,
  invalidateTouchedConfig,
} from "../config/resolver.js";
import { syncMarkerComment } from "../github/comments.js";
import { type ChangedFile, listChangedFiles } from "../github/pulls.js";
import type { KeyedMutex } from "../lib/mutex.js";
import { syncSettings } from "./apply.js";
import type { ApplySummary } from "./summary.js";

/**
 * True when `file` is a settings path — as its new name, or, for a rename, as
 * the name it came from. Renaming `.github/woodhouse.yml` away is a removal
 * from the new location, so the old path matters just as much as the new one.
 */
function touchesSettings(file: ChangedFile): boolean {
  if (isSettingsPath(file.filename)) return true;
  return file.previous_filename != null && isSettingsPath(file.previous_filename);
}

/**
 * Decide whether a merged pull request changed the repository's settings.
 *
 * `baseRef` and `defaultBranch` are bare branch names as GitHub reports them
 * (`pull_request.base.ref` and `repository.default_branch`), compared exactly.
 * The file list is whatever `listChangedFiles` returned; the status is not
 * consulted because added, modified and removed all count.
 */
export function isMergedSettingsChange(
  merged: boolean,
  baseRef: string,
  defaultBranch: string,
  files: readonly ChangedFile[],
): boolean {
  if (!merged) return false;
  if (baseRef !== defaultBranch) return false;
  return files.some(touchesSettings);
}

/* -------------------------------------------------------------------------
 * Outcome comment
 * ---------------------------------------------------------------------- */

/** Identifies Woodhouse's own settings-applied comment across re-deliveries. */
export const SETTINGS_APPLIED_MARKER = "<!-- woodhouse:settings-applied -->";

/**
 * Build the outcome comment for a completed settings sync, in the butler
 * register. Pure and exactly testable; the handler logs it verbatim and hands
 * it to `syncMarkerComment`.
 *
 * The marker leads so an existing comment is found and updated in place on a
 * re-delivery, and the sign-off closes every variant. `baseline` says this
 * repository is the baseline: the comment then states the baseline itself was
 * synced and that other repositories adopt the change at their next event -
 * never that every repository was re-synced. An empty summary (the merge push
 * already applied everything) says so rather than staying silent, and changes
 * and failures can coexist.
 */
export function buildSettingsAppliedComment(summary: ApplySummary, baseline: boolean): string {
  const { changes, failures } = summary;
  const lines: string[] = [SETTINGS_APPLIED_MARKER];

  const nothingFurther = changes.length === 0 && failures.length === 0;
  lines.push(
    nothingFurther
      ? "**Woodhouse here, sir. The settings are in effect and nothing further needed changing.**"
      : "**Woodhouse here, sir. I have applied the settings changed by this merge.**",
  );

  if (changes.length > 0) {
    lines.push("", "Applied:");
    for (const change of changes) {
      lines.push(`- ${change.area} ${change.action}: ${change.target}`);
    }
  }

  if (failures.length > 0) {
    lines.push("", "Failed:");
    for (const failure of failures) {
      lines.push(`- ${failure.area}: ${failure.message}`);
    }
  }

  if (baseline) {
    lines.push(
      "",
      "This is the baseline repository, sir, so it has been synced directly. " +
        "Other repositories will adopt the change at their next event.",
    );
  }

  lines.push("", SIGN_OFF);
  return lines.join("\n");
}

/* -------------------------------------------------------------------------
 * Handler
 * ---------------------------------------------------------------------- */

type Api = Context<"pull_request">["octokit"];

/**
 * The slice of `ConfigResolver` this handler needs, so a test can pass a
 * literal fake. `ConfigResolver` itself satisfies it structurally.
 */
export interface MergeFeedbackResolver {
  isBaselineRepo(repo: string): boolean;
  invalidate(owner: string, repo: string): void;
  invalidateOwner(owner: string): void;
  resolve(
    client: ContentsClient,
    owner: string,
    repo: string,
    log: Logger,
  ): Promise<ResolvedConfig>;
}

export interface MergeFeedbackDeps {
  readonly octokit: Api;
  readonly resolver: MergeFeedbackResolver;
  /** The same instance the push handler serialises on. */
  readonly mutex: KeyedMutex;
  readonly log: Logger;
  readonly dryRun: boolean;
}

/** Repository coordinates plus the branch settings live on. */
export interface MergeFeedbackScope {
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch: string;
}

/** The pull-request facts the gate needs, lifted from the payload. */
export interface MergedPullRequest {
  readonly number: number;
  readonly merged: boolean;
  readonly baseRef: string;
}

/**
 * React to a merged pull request that changed the repository's settings.
 *
 * Ordered cheapest-first: two payload facts decide whether it is even worth
 * listing files, and the file list (fetched uncapped, so a settings deletion
 * can never fall off the end of a page cap) decides whether the cache needs
 * invalidating and the config re-resolved. Only when settings management is
 * actually enabled does the sync run, serialised with every other sync for the
 * same repository.
 */
export async function commentSettingsApplied(
  deps: MergeFeedbackDeps,
  scope: MergeFeedbackScope,
  pr: MergedPullRequest,
): Promise<void> {
  const { owner, repo, defaultBranch } = scope;
  const { log } = deps;

  // Cheap gates first: a close without a merge, or a merge into a feature
  // branch, changes no live config and never reaches GitHub.
  if (!pr.merged) return;
  if (pr.baseRef !== defaultBranch) return;

  // Uncapped on purpose: a page cap could hide a settings deletion on a later
  // page and let a settings change slip through unnoticed.
  const { files } = await listChangedFiles(deps.octokit, owner, repo, pr.number);

  if (!isMergedSettingsChange(pr.merged, pr.baseRef, defaultBranch, files)) return;

  // Delivery order between `closed` and the merge `push` is not guaranteed, so
  // the cache must be dropped before resolving rather than trusting either
  // event to have done it.
  const invalidation = invalidateTouchedConfig(deps.resolver, owner, repo);
  if (invalidation === "owner") {
    log.info("Baseline configuration changed; cleared owner cache");
  }

  const { config } = await deps.resolver.resolve(deps.octokit as never, owner, repo, log);

  if (!config.settings.enabled) {
    log.debug({ owner, repo }, "Settings management disabled; skipping sync");
    return;
  }

  log.debug({ owner, repo }, "Settings changed on merge; running settings sync");

  // The same key and instance as the push handler, so a merge push and this
  // event cannot run the sync concurrently.
  const summary = await deps.mutex.run(`${owner}/${repo}`, () =>
    syncSettings(
      {
        octokit: deps.octokit as never,
        owner,
        repo,
        log,
        dryRun: deps.dryRun,
      },
      config,
    ),
  );

  // The comment is not a settings write, so it sits outside the mutex; the
  // manager guards its own writes, so in dry-run nothing reaches GitHub. The
  // body is logged unconditionally, which is exactly what a dry-run must show.
  const body = buildSettingsAppliedComment(summary, invalidation === "owner");
  log.info({ owner, repo }, `Settings-applied comment:\n${body}`);

  await syncMarkerComment(deps, {
    owner,
    repo,
    issueNumber: pr.number,
    marker: SETTINGS_APPLIED_MARKER,
    body,
  });
}
