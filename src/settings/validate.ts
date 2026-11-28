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
import { isSettingsPath } from "../config/paths.js";
import { SCHEMA_MODELINE } from "../config/json-schema.js";
import { listChangedFiles } from "../github/pulls.js";
import { syncMarkerComment } from "../github/comments.js";
import { performWrite } from "../lib/dry-run.js";
import type { ConfigResolver, ContentsClient } from "../config/resolver.js";
import { couplingIssues } from "./coupling.js";

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

/**
 * The synthetic path a coupling verdict reports under.
 *
 * The problem is not in one touched file: it is the merged result of the whole
 * cascade (baseline plus the pull request's local layer), so naming a single
 * file would point the author at the wrong place.
 */
export const RESOLVED_CONFIGURATION_PATH = "(resolved configuration)";

/** Any path this app would ever read as configuration. */
export function isConfigPath(path: string): boolean {
  return isSettingsPath(path);
}

export type VerdictKind = "yaml" | "schema" | "coupling";

export type FileVerdict =
  | { readonly path: string; readonly ok: true }
  | {
      readonly path: string;
      readonly ok: false;
      readonly kind: VerdictKind;
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
          message: error instanceof yaml.YAMLException ? error.reason : String(error),
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
  const bad = verdicts.filter((v) => !v.ok) as Extract<FileVerdict, { ok: false }>[];

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

  const lines: string[] = ["The following problems must be fixed before this can be merged:", ""];

  for (const verdict of bad) {
    lines.push(`### \`${verdict.path}\``, kindHeading(verdict.kind), "");
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

  // A coupling verdict stands for the resolved cascade, not for a file, so it
  // never inflates the invalid-file count.
  const invalidFiles = bad.filter((verdict) => verdict.kind !== "coupling").length;
  return {
    conclusion: "failure",
    title:
      invalidFiles === 0
        ? "Dress-code merge settings are not coupled"
        : `${invalidFiles} configuration file${invalidFiles === 1 ? "" : "s"} invalid`,
    summary: lines.join("\n"),
  };
}

/**
 * Heading shown above each verdict's issues. The union type makes the lookup
 * exhaustive: a new verdict kind fails to compile until its heading is added.
 */
const KIND_HEADING: Record<VerdictKind, string> = {
  yaml: "Not valid YAML:",
  schema: "Schema errors:",
  coupling: "Merge settings required by dress-code:",
};

function kindHeading(kind: VerdictKind): string {
  return KIND_HEADING[kind];
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
  readonly resolver: ConfigResolver;
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
 *
 * Validation decides the outcome; the shared manager owns the mechanics and
 * guards its own write (so dry-run never lists comments either).
 */
async function syncComment(
  deps: ValidateDeps,
  owner: string,
  repo: string,
  prNumber: number,
  verdicts: readonly FileVerdict[],
  conclusion: "success" | "failure",
): Promise<void> {
  await syncMarkerComment(deps, {
    owner,
    repo,
    issueNumber: prNumber,
    marker: COMMENT_MARKER,
    body: conclusion === "success" ? undefined : buildComment(verdicts),
  });
}

export async function validatePullRequest(
  deps: ValidateDeps,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
): Promise<"success" | "failure" | undefined> {
  // Unbounded, exactly as before: validation must see every changed file.
  const { files } = await listChangedFiles(deps.octokit, owner, repo, prNumber);

  const touched = files.filter((file) => isConfigPath(file.filename) && file.status !== "removed");

  // A deletion-only pull request still skips validation entirely. Accepted gap:
  // the coupling rule is not evaluated when the change removes a settings file.
  // A deletion cannot leave a repository dress-coded, and the runtime falls
  // back to defaults (dress-code off) on the next event.
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
      validateDocument(file.filename, Buffer.from(blob.content, "base64").toString("utf8")),
    );
  }

  if (verdicts.length === 0) return undefined;

  // Resolve the cascade at the pull-request head: the local layer is the
  // proposed content, while the baseline layer stays pinned to the default
  // branch of the baseline repository (the resolver's semantics). A pull request
  // in the baseline repository therefore never sees its own PR-time dress-code
  // flip; ADR 0015 records that limitation.
  const { config } = await deps.resolver.resolve(
    deps.octokit as ContentsClient,
    owner,
    repo,
    deps.log,
    headSha,
  );

  // Accepted gap: when the cascade fails to parse, the resolver falls back to
  // defaults (dress-code disabled), so the coupling check is skipped. The
  // schema errors are already reported by the per-document verdicts above.
  const issues = couplingIssues(config);
  if (issues.length > 0) {
    verdicts.push({
      path: RESOLVED_CONFIGURATION_PATH,
      ok: false,
      kind: "coupling",
      issues,
    });
  }

  const result = summarise(verdicts);

  await performWrite(deps, "write config validation check", async () => {
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

    deps.log.info(
      { pr: prNumber, files: verdicts.length, conclusion: result.conclusion },
      "Validated woodhouse configuration",
    );
  });

  // The comment write is guarded inside the manager, outside the check's
  // composite wrap: dry-run yields one line for the check and one for the
  // comment instead of a single combined gate.
  await syncComment(deps, owner, repo, prNumber, verdicts, result.conclusion);

  return result.conclusion;
}
