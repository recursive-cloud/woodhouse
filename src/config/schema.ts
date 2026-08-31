/**
 * Schema for `woodhouse.yml`.
 *
 * This is the single source of truth for what a valid configuration looks
 * like. It is used in three places:
 *   1. parsing the cascaded config at runtime,
 *   2. validating PRs that touch a config file (Phase 6),
 *   3. documenting the config surface.
 *
 * `.strict()` is used throughout so that typos (`allowedActor` vs
 * `allowedActors`) are surfaced as errors instead of silently ignored — a
 * silently-dropped key in the auto-approval section would be a security bug.
 */

import { z } from "zod";

const githubLogin = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .max(255)
  // GitHub logins plus bot suffixes, e.g. "renovate[bot]".
  .regex(
    /^[A-Za-z0-9-_.]+(\[bot\])?$/,
    'must be a GitHub login, optionally suffixed with "[bot]"',
  );

export const gatekeeperSchema = z
  .object({
    /**
     * When false, the white-glove check is not created at all. Note that if the
     * check is already a required status check in branch protection, disabling
     * it here will leave PRs permanently blocked.
     */
    enabled: z.boolean().default(true),

    /**
     * Checks that must report `success` explicitly. Unlike ordinary checks,
     * these may not be `skipped` or `neutral`, and their *absence* holds the
     * white-glove check at pending rather than letting it pass.
     */
    strictChecks: z.array(z.string().trim().min(1)).default([]),

    /**
     * Check runs to exclude from evaluation entirely, by exact name. Useful for
     * advisory-only checks (coverage reports, preview deployments).
     */
    ignoredChecks: z.array(z.string().trim().min(1)).default([]),
  })
  .strict()
  .default({});

export const autoApprovalSchema = z
  .object({
    enabled: z.boolean().default(true),

    /** PR authors whose pull requests are approved automatically. */
    allowedActors: z.array(githubLogin).default([]),

    /**
     * Refuse to auto-approve a PR that modifies any of these paths. Defaults
     * cover the config files themselves: without this, anyone in
     * `allowedActors` could self-approve a change that widens
     * `allowedActors`, which is a privilege-escalation path.
     */
    protectedPaths: z
      .array(z.string().trim().min(1))
      .default([".github/woodhouse.yml", ".github/woodhouse.yaml"]),
  })
  .strict()
  .default({});

export const repositorySchema = z
  .object({
    has_issues: z.boolean().optional(),
    has_projects: z.boolean().optional(),
    has_wiki: z.boolean().optional(),
    has_discussions: z.boolean().optional(),
    allow_squash_merge: z.boolean().optional(),
    allow_merge_commit: z.boolean().optional(),
    allow_rebase_merge: z.boolean().optional(),
    allow_auto_merge: z.boolean().optional(),
    delete_branch_on_merge: z.boolean().optional(),
    allow_update_branch: z.boolean().optional(),
    squash_merge_commit_title: z
      .enum(["PR_TITLE", "COMMIT_OR_PR_TITLE"])
      .optional(),
    squash_merge_commit_message: z
      .enum(["PR_BODY", "COMMIT_MESSAGES", "BLANK"])
      .optional(),
    description: z.string().optional(),
    homepage: z.string().optional(),
    topics: z.array(z.string()).optional(),
    private: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .default({});

export const woodhouseConfigSchema = z
  .object({
    /**
     * Set on a repository's local config to opt out of the inherited baseline
     * entirely rather than merging with it.
     */
    inherit: z.boolean().default(true),

    repository: repositorySchema,
    gatekeeper: gatekeeperSchema,
    autoApproval: autoApprovalSchema,
  })
  .strict()
  .default({});

export type WoodhouseConfig = z.infer<typeof woodhouseConfigSchema>;
export type GatekeeperConfig = WoodhouseConfig["gatekeeper"];
export type AutoApprovalConfig = WoodhouseConfig["autoApproval"];

/** Fully-defaulted config, used when no file exists anywhere in the cascade. */
export function defaultConfig(): WoodhouseConfig {
  return woodhouseConfigSchema.parse({});
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly config: WoodhouseConfig }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export function parseConfig(input: unknown): ParseResult {
  const result = woodhouseConfigSchema.safeParse(input ?? {});
  if (result.success) return { ok: true, config: result.data };

  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
      message: issue.message,
    })),
  };
}
