/**
 * Configuration validation for pull requests.
 *
 * A bad `woodhouse.yml` merged to the default branch would silently fall back
 * to defaults on the next push — which, for a file that controls branch
 * protection and auto-approval, is a quiet and dangerous failure. Validating
 * at PR time turns that into an obvious red check instead.
 */

import yaml from "js-yaml";
import type { Context } from "probot";
import type { Logger } from "pino";
import { parseConfig, type ValidationIssue } from "../config/schema.js";
import { LOCAL_PATHS, BASELINE_PATHS } from "../config/resolver.js";
import { SCHEMA_MODELINE } from "../config/json-schema.js";

type Api = Context<"pull_request">["octokit"];

export const CONFIG_CHECK_NAME = "woodhouse/config";

/**
 * Hidden marker identifying our own comment.
 *
 * Matching on the marker rather than on the author means the comment is found
 * reliably even if the App is renamed, and cannot collide with a human comment
 * that happens to quote the bot.
 */
export const COMMENT_MARKER = "<!-- woodhouse:config-validation -->";

/** Any path this app would ever read as configuration. */
const CONFIG_PATHS = new Set<string>([
  ...LOCAL_PATHS,
  ...BASELINE_PATHS.map((p) => p),
]);

export function isConfigPath(path: string): boolean {
  return CONFIG_PATHS.has(path);
}

export type FileVerdict =
  | { readonly path: string; readonly ok: true }
  | {
      readonly path: string;
      readonly ok: false;
      readonly kind: "yaml" | "schema";
      readonly issues: readonly ValidationIssue[];
    };

/**
 * Validate a single config document. Pure, so the error formatting is testable.
 */
export function validateDocument(path: string, source: string): FileVerdict {
  let parsed: unknown;
  try {
    parsed = yaml.load(source, { filename: path });
  } catch (error) {
    return {
      path,
      ok: false,
      kind: "yaml",
      issues: [
        {
          path: "(document)",
          message:
            error instanceof yaml.YAMLException
              ? error.reason
              : String(error),
        },
      ],
    };
  }

  // An empty file is valid: it means "inherit everything".
  const result = parseConfig(parsed ?? {});
  if (result.ok) return { path, ok: true };

  return { path, ok: false, kind: "schema", issues: result.issues };
}

export function summarise(verdicts: readonly FileVerdict[]): {
  conclusion: "success" | "failure";
  title: string;
  summary: string;
} {
  const bad = verdicts.filter((v) => !v.ok) as Extract<
    FileVerdict,
    { ok: false }
  >[];

  if (bad.length === 0) {
    return {
      conclusion: "success",
      title:
        verdicts.length === 1
          ? "Configuration is valid"
          : `${verdicts.length} configuration files are valid`,
      summary: "Very good, sir. The configuration is in order.",
    };
  }

  const lines: string[] = [
    "The following problems must be fixed before this can be merged:",
    "",
  ];

  for (const verdict of bad) {
    lines.push(
      `### \`${verdict.path}\``,
      verdict.kind === "yaml" ? "Not valid YAML:" : "Schema errors:",
      "",
    );
    for (const issue of verdict.issues) {
      lines.push(`- \`${issue.path}\` — ${issue.message}`);
    }
    lines.push("");
  }

  lines.push(
    "_Unknown keys are rejected on purpose: a misspelled key would be " +
      "silently ignored, which for `autoApproval` or `branchProtection` " +
      "would be a security problem rather than a cosmetic one._",
  );

  const count = bad.length;
  return {
    conclusion: "failure",
    title: `${count} configuration file${count === 1 ? "" : "s"} invalid`,
    summary: lines.join("\n"),
  };
}

/**
 * The comment body posted while a configuration change is invalid.
 *
 * The check run already reports the failure, but a check is easy to miss and
 * its output is one click away. Repeating the errors inline is what makes the
 * problem actionable without leaving the conversation.
 */
export function buildComment(verdicts: readonly FileVerdict[]): string {
  const { summary } = summarise(verdicts);

  return [
    COMMENT_MARKER,
    "**Woodhouse here, sir. There is a problem with the configuration.**",
    "",
    summary,
    "",
    "---",
    "",
    "Add this line to the top of the file and your editor will validate it " +
      "before the next push:",
    "",
    "```yaml",
    SCHEMA_MODELINE,
    "```",
  ].join("\n");
}

export interface ValidateDeps {
  readonly octokit: Api;
  readonly log: Logger;
  readonly dryRun: boolean;
}

/**
 * Fetch each config file touched by the PR at the PR's head and validate it.
 * Returns undefined when the PR touches no configuration at all.
 */
/**
 * Keep at most one comment on the pull request, and only while it is needed.
 *
 * Posting afresh on every push would bury a PR that takes a few attempts to
 * fix, so the existing comment is edited in place instead. Once the
 * configuration validates the comment is deleted outright: the check run
 * records that it was ever wrong, and leaving a stale complaint on a
 * now-correct pull request is worse than leaving nothing.
 */
async function syncComment(
  deps: ValidateDeps,
  owner: string,
  repo: string,
  prNumber: number,
  verdicts: readonly FileVerdict[],
  conclusion: "success" | "failure",
): Promise<void> {
  let existing: number | undefined;

  try {
    const comments = await deps.octokit.paginate(
      deps.octokit.issues.listComments,
      { owner, repo, issue_number: prNumber, per_page: 100 },
    );
    existing = comments.find((c) => c.body?.includes(COMMENT_MARKER))?.id;
  } catch (error) {
    // The check run is the authoritative signal; failing to manage a comment
    // must not fail the whole validation.
    deps.log.warn({ err: error, pr: prNumber }, "Could not list PR comments");
    return;
  }

  try {
    if (conclusion === "success") {
      if (existing !== undefined) {
        await deps.octokit.issues.deleteComment({
          owner,
          repo,
          comment_id: existing,
        });
        deps.log.info({ pr: prNumber }, "Configuration fixed; removed comment");
      }
      return;
    }

    const body = buildComment(verdicts);

    if (existing === undefined) {
      await deps.octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
    } else {
      await deps.octokit.issues.updateComment({
        owner,
        repo,
        comment_id: existing,
        body,
      });
    }
  } catch (error) {
    deps.log.warn(
      { err: error, pr: prNumber },
      "Could not write configuration comment",
    );
  }
}

export async function validatePullRequest(
  deps: ValidateDeps,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
): Promise<"success" | "failure" | undefined> {
  const files = await deps.octokit.paginate(deps.octokit.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const touched = files.filter(
    (file) => isConfigPath(file.filename) && file.status !== "removed",
  );

  if (touched.length === 0) return undefined;

  const verdicts: FileVerdict[] = [];

  for (const file of touched) {
    // Read at the PR head, not the default branch: we are validating the
    // proposed content.
    const { data } = await deps.octokit.repos.getContent({
      owner,
      repo,
      path: file.filename,
      ref: headSha,
    });

    const blob = data as { content?: string; type?: string };
    if (blob.type !== "file" || typeof blob.content !== "string") continue;

    verdicts.push(
      validateDocument(
        file.filename,
        Buffer.from(blob.content, "base64").toString("utf8"),
      ),
    );
  }

  if (verdicts.length === 0) return undefined;

  const result = summarise(verdicts);

  if (deps.dryRun) {
    deps.log.info(
      { pr: prNumber, conclusion: result.conclusion, dryRun: true },
      "DRY_RUN: would write config validation check",
    );
    return result.conclusion;
  }

  await deps.octokit.checks.create({
    owner,
    repo,
    name: CONFIG_CHECK_NAME,
    head_sha: headSha,
    status: "completed",
    conclusion: result.conclusion,
    completed_at: new Date().toISOString(),
    output: { title: result.title, summary: result.summary },
  });

  await syncComment(deps, owner, repo, prNumber, verdicts, result.conclusion);

  deps.log.info(
    { pr: prNumber, files: verdicts.length, conclusion: result.conclusion },
    "Validated woodhouse configuration",
  );

  return result.conclusion;
}
