/**
 * Coupling required by dress-code.
 *
 * The `woodhouse/dress-code` check validates the pull-request title because a
 * squash merge carries that title into the commit. GitHub only guarantees that
 * when squash merges are allowed *and* configured to use the PR title, and when
 * neither rebase nor merge-commit merges can bypass it. Enabling dress-code on
 * any other merge configuration would let a pull request merge with a commit
 * message the check never saw.
 *
 * A second rule guards strict-listing: a `gatekeeper.strictChecks` entry for
 * `woodhouse/dress-code` while the check is not enabled would hold every
 * white-glove verdict in the repository pending forever, because nothing ever
 * posts the check.
 *
 * This module is the pure statement of both rules. It runs against the config
 * resolved from a pull request's head, so a repository file cannot re-enable a
 * merge setting the baseline's dress-code enablement forbids.
 */

import type { ValidationIssue } from "../config/schema.js";
import { DRESS_CODE_CHECK_NAME } from "../dresscode/constants.js";

/**
 * The narrowest config shape the rule reads.
 *
 * Both sections are optional so the rule stays a plain function over plain
 * data: an absent `dressCode` means "off", exactly like an explicit false.
 */
export interface CouplingConfig {
  readonly dressCode?: { readonly enabled?: boolean | undefined } | undefined;
  readonly gatekeeper?: { readonly strictChecks?: readonly string[] | undefined } | undefined;
  readonly repository?:
    | {
        readonly allow_squash_merge?: boolean | undefined;
        readonly squash_merge_commit_title?: string | undefined;
        readonly allow_rebase_merge?: boolean | undefined;
        readonly allow_merge_commit?: boolean | undefined;
      }
    | undefined;
}

interface Requirement {
  readonly field: string;
  readonly required: string;
  readonly value: boolean | string | undefined;
  readonly satisfied: boolean;
}

/** Say both what dress-code requires and what the configuration actually has. */
function message({ field, required, value }: Requirement): string {
  const current =
    value === undefined
      ? "the resolved configuration leaves it unset"
      : `the resolved configuration sets it to ${JSON.stringify(value)}`;
  return `dress-code requires \`${field}: ${required}\`; ${current}.`;
}

/**
 * The merge settings dress-code requires, or an empty list when dress-code is
 * off.
 *
 * Absent values are violations: the coupling has to be declared explicitly.
 * Schema defaults do not count because `repository` fields carry none — leaving
 * the pair out lets GitHub keep whatever the repository already had.
 */
export function couplingIssues(config: CouplingConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Exact, case-sensitive match: ADR 0010 governs check-name matching, and a
  // mis-cased entry does not select the check either.
  const strictChecks = config.gatekeeper?.strictChecks ?? [];
  if (config.dressCode?.enabled !== true && strictChecks.includes(DRESS_CODE_CHECK_NAME)) {
    issues.push({
      path: "gatekeeper.strictChecks",
      message:
        `\`gatekeeper.strictChecks\` lists \`${DRESS_CODE_CHECK_NAME}\` while ` +
        "`dressCode.enabled` is not true: the white-glove verdict would stay " +
        "pending forever because nothing posts the check. Strict-listing it " +
        "requires `dressCode.enabled: true`.",
    });
  }

  // The merge-setting rule only applies while dress-code is enabled; the
  // strict-listing rule above fires independently.
  if (config.dressCode?.enabled !== true) return issues;

  const repository = config.repository ?? {};

  const requirements: readonly Requirement[] = [
    {
      field: "allow_squash_merge",
      required: "true",
      value: repository.allow_squash_merge,
      satisfied: repository.allow_squash_merge === true,
    },
    {
      field: "squash_merge_commit_title",
      required: "PR_TITLE",
      value: repository.squash_merge_commit_title,
      satisfied: repository.squash_merge_commit_title === "PR_TITLE",
    },
    {
      field: "allow_rebase_merge",
      required: "false",
      value: repository.allow_rebase_merge,
      satisfied: repository.allow_rebase_merge === false,
    },
    {
      field: "allow_merge_commit",
      required: "false",
      value: repository.allow_merge_commit,
      satisfied: repository.allow_merge_commit === false,
    },
  ];

  for (const requirement of requirements) {
    if (requirement.satisfied) continue;
    issues.push({
      path: `repository.${requirement.field}`,
      message: message(requirement),
    });
  }

  return issues;
}
