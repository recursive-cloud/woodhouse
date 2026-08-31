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

type Api = Context<"pull_request">["octokit"];

export const CONFIG_CHECK_NAME = "woodhouse/config";

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

export interface ValidateDeps {
  readonly octokit: Api;
  readonly log: Logger;
  readonly dryRun: boolean;
}

/**
 * Fetch each config file touched by the PR at the PR's head and validate it.
 * Returns undefined when the PR touches no configuration at all.
 */
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

  deps.log.info(
    { pr: prNumber, files: verdicts.length, conclusion: result.conclusion },
    "Validated woodhouse configuration",
  );

  return result.conclusion;
}
