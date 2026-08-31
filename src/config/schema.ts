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
    topics: z.array(z.string().trim().min(1)).optional(),

    // Deliberately NOT exposed: `private` and `archived`.
    //
    // Flipping visibility to private permanently deletes every fork, and
    // archiving makes a repository read-only in a way this bot could not then
    // undo (it would lose write access to its own config). Neither is a
    // reasonable outcome of a YAML typo in a file that cascades across every
    // repository you own. Change those two by hand.
  })
  .strict()
  .default({});

/**
 * Classic branch protection, keyed by branch name.
 *
 * Kept separate from rulesets because GitHub applies both independently and
 * most homelab repos only need one of them.
 */
export const branchProtectionSchema = z
  .object({
    required_status_checks: z
      .object({
        strict: z.boolean().default(false),
        contexts: z.array(z.string().trim().min(1)).default([]),
      })
      .strict()
      .nullable()
      .optional(),
    enforce_admins: z.boolean().nullable().optional(),
    required_pull_request_reviews: z
      .object({
        required_approving_review_count: z.number().int().min(0).max(6).optional(),
        dismiss_stale_reviews: z.boolean().optional(),
        require_code_owner_reviews: z.boolean().optional(),
        require_last_push_approval: z.boolean().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    required_linear_history: z.boolean().optional(),
    allow_force_pushes: z.boolean().nullable().optional(),
    allow_deletions: z.boolean().optional(),
    required_conversation_resolution: z.boolean().optional(),
    lock_branch: z.boolean().optional(),
    block_creations: z.boolean().optional(),
  })
  .strict();

export const labelSchema = z
  .object({
    name: z.string().trim().min(1),
    /** Six hex digits; a leading `#` is accepted and stripped on apply. */
    color: z
      .string()
      .trim()
      .regex(/^#?[0-9a-fA-F]{6}$/, "must be a six-digit hex colour")
      .optional(),
    description: z.string().max(100).optional(),
    /** Rename an existing label to `name`. */
    from: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * Repository rulesets.
 *
 * `rules` is intentionally loose: the rule union is large, versioned, and
 * GitHub extends it regularly. Pinning it here would reject valid new rule
 * types. The `type` discriminant is required so obvious mistakes are still
 * caught, and GitHub validates the rest on write.
 */
export const rulesetSchema = z
  .object({
    name: z.string().trim().min(1),
    target: z.enum(["branch", "tag", "push"]).default("branch"),
    enforcement: z.enum(["active", "evaluate", "disabled"]).default("active"),
    bypass_actors: z
      .array(
        z
          .object({
            actor_id: z.number().int().nullable().optional(),
            actor_type: z.enum([
              "Integration",
              "OrganizationAdmin",
              "RepositoryRole",
              "Team",
              "DeployKey",
            ]),
            bypass_mode: z.enum(["always", "pull_request"]).optional(),
          })
          .strict(),
      )
      .optional(),
    conditions: z.record(z.unknown()).optional(),
    rules: z
      .array(z.object({ type: z.string().trim().min(1) }).passthrough())
      .default([]),
  })
  .strict();

export const settingsSchema = z
  .object({
    /**
     * Master switch. Off by default: installing this app must not silently
     * start rewriting repository settings until it is explicitly asked to.
     */
    enabled: z.boolean().default(false),
    /** Remove labels that exist on the repo but are absent from config. */
    pruneLabels: z.boolean().default(false),
    /** Delete rulesets managed by us but no longer present in config. */
    pruneRulesets: z.boolean().default(false),
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

    settings: settingsSchema,
    repository: repositorySchema,
    branchProtection: z.record(branchProtectionSchema).default({}),
    labels: z.array(labelSchema).default([]),
    rulesets: z.array(rulesetSchema).default([]),
    gatekeeper: gatekeeperSchema,
    autoApproval: autoApprovalSchema,
  })
  .strict()
  .default({});

export type WoodhouseConfig = z.infer<typeof woodhouseConfigSchema>;
export type GatekeeperConfig = WoodhouseConfig["gatekeeper"];
export type AutoApprovalConfig = WoodhouseConfig["autoApproval"];
export type SettingsConfig = WoodhouseConfig["settings"];
export type RepositoryConfig = WoodhouseConfig["repository"];
export type BranchProtectionConfig = z.infer<typeof branchProtectionSchema>;
export type LabelConfig = z.infer<typeof labelSchema>;
export type RulesetConfig = z.infer<typeof rulesetSchema>;

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
