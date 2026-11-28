/**
 * Conventional-commit PR-title parser.
 *
 * The single owner of the conventional-commit pattern: every consumer that
 * needs to validate or explain a pull-request title imports from here. Pure
 * TypeScript — no GitHub, zod or octokit dependency — so the rules stay
 * directly testable.
 *
 * The parser deliberately never trims its input: surrounding whitespace is a
 * pattern violation, not something to silently repair. A title delivered with
 * no surrounding whitespace therefore passes unchanged; one carrying it fails
 * closed. The pattern below requires a subject that starts and ends with a
 * non-whitespace character.
 */

/** The fixed lowercase conventional-commit types Woodhouse accepts. */
export const CONVENTIONAL_TYPES = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
] as const;

export type ConventionalType = (typeof CONVENTIONAL_TYPES)[number];

/**
 * The one conventional-commit title pattern this module owns.
 *
 * Capture groups: 1 type, 2 scope (optional), 3 breaking marker (optional),
 * 4 subject. Only the title is matched — there is no body in this pattern.
 *
 * The scope accepts word characters, `-` and `.` only. That list is deliberate
 * and not a wildcard: a scope carrying any other character is a failure.
 */
const TITLE_PATTERN = new RegExp(
  `^(${CONVENTIONAL_TYPES.join("|")})(?:\\(([\\w.-]+)\\))?(!)?: (\\S(?:.*\\S)?)$`,
);

export interface ParsedTitle {
  readonly type: ConventionalType;
  readonly scope?: string;
  readonly breaking: boolean;
  readonly subject: string;
}

/** Parse a PR title, or return undefined when it is not a conventional commit. */
export function parseTitle(title: string): ParsedTitle | undefined {
  const match = TITLE_PATTERN.exec(title);
  // `$` also matches before a trailing line terminator; requiring the match to
  // span the whole input keeps a title with a trailing newline a failure.
  if (match === null || match[0] !== title) return undefined;

  const [, type, scope, breaking, subject] = match;
  // The pattern guarantees the required groups; narrow them for the type checker.
  if (type === undefined || subject === undefined) return undefined;

  return {
    type: type as ConventionalType,
    ...(scope === undefined ? {} : { scope }),
    breaking: breaking !== undefined,
    subject,
  };
}

/** Human-readable description of the expected pattern, for check output. */
export function titlePatternDescription(): string {
  return (
    "a conventional commit title `<type>[(<scope>)][!]: <subject>`, where " +
    `<type> is one of ${CONVENTIONAL_TYPES.join(", ")}`
  );
}

/**
 * The failure for a title that does not match, or undefined when it does.
 *
 * Names both the expected pattern and the offending title so a check run can
 * report precisely what to fix.
 */
export function titleFailure(title: string): { readonly message: string } | undefined {
  if (parseTitle(title) !== undefined) return undefined;

  return {
    message: `Pull request title ${JSON.stringify(title)} does not match ${titlePatternDescription()}.`,
  };
}
