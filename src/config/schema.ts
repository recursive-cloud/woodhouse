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
 *
 * Sections use `.prefault({})` rather than `.default({})`: in zod 4 a default
 * is the *output* value and would have to restate every field, whereas a
 * prefault is fed through the schema so each field's own default applies. The
 * effect is that omitting a whole section is identical to writing it out with
 * every key left at its default.
 */

import { z } from "zod";

const githubLogin = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .max(255)
  // GitHub logins plus bot suffixes, e.g. "renovate[bot]".
  .regex(/^[A-Za-z0-9-_.]+(\[bot\])?$/, 'must be a GitHub login, optionally suffixed with "[bot]"');

export const gatekeeperSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Create the `woodhouse/white-glove` check at all. If it is already a required status check in branch protection, disabling it here leaves PRs permanently blocked.",
      ),

    strictChecks: z
      .array(z.string().trim().min(1))
      .default([])
      .meta({
        description:
          "Checks that must report `success` explicitly: unlike ordinary checks they may not be skipped or neutral, and their absence holds the white-glove check pending rather than letting it pass.",
        examples: [["build", "test"]],
      }),

    ignoredChecks: z
      .array(z.string().trim().min(1))
      .default([])
      .describe(
        "Check runs excluded from evaluation entirely, by exact name. Useful for advisory-only checks (coverage reports, preview deployments).",
      ),

    gracePeriodSeconds: z
      .number()
      .int()
      .min(0)
      .max(900)
      .default(30)
      .describe(
        "How long to wait for CI to register any check run on a commit before concluding there is none. During the grace period the check is held pending instead of passing on a commit nothing has tested; afterwards a commit with genuinely no checks passes, so docs-only repositories are not deadlocked. Raise it if CI is routinely slow to start.",
      ),
  })
  .strict()
  .describe("The `woodhouse/white-glove` consolidated check this schema configures.")
  .prefault({});

export const autoApprovalSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Master switch. When false nothing is ever auto-approved; the rules below only apply while it is on.",
      ),

    allowedActors: z
      .object({
        owners: z
          .array(githubLogin)
          .default([])
          .describe("PR authors approved unconditionally (still subject to protectedPaths)."),
        bots: z
          .array(githubLogin)
          .default([])
          .describe("PR authors approved only when they enabled auto-merge themselves."),
      })
      .strict()
      .describe(
        "PR authors whose pull requests are approved automatically, split by trust model: `owners` are approved unconditionally, `bots` only when they enabled auto-merge themselves.",
      )
      .prefault({}),

    protectedPaths: z
      .array(z.string().trim().min(1))
      .default([".github/woodhouse.yml", ".github/woodhouse.yaml"])
      .meta({
        description:
          "Refuse to auto-approve a PR that modifies any of these paths. Defaults cover the config files themselves: without it, any listed actor could self-approve a change that widens `allowedActors`, a privilege-escalation path.",
        examples: [[".github/woodhouse.yml", "infrastructure/"]],
      }),
  })
  .strict()
  .describe("Auto-approval of pull requests by trusted actors.")
  .prefault({});

export const repositorySchema = z
  .object({
    has_issues: z.boolean().optional().describe("Enable the repository's Issues tab."),
    has_projects: z.boolean().optional().describe("Enable the repository's Projects tab."),
    has_wiki: z.boolean().optional().describe("Enable the repository's Wiki tab."),
    has_discussions: z.boolean().optional().describe("Enable GitHub Discussions."),
    allow_squash_merge: z.boolean().optional().describe("Allow squash merges."),
    allow_merge_commit: z.boolean().optional().describe("Allow merge commits."),
    allow_rebase_merge: z.boolean().optional().describe("Allow rebase merges."),
    allow_auto_merge: z
      .boolean()
      .optional()
      .describe("Allow pull requests to be auto-merged once the requirements pass."),
    delete_branch_on_merge: z
      .boolean()
      .optional()
      .describe("Delete the head branch automatically once a pull request merges."),
    allow_update_branch: z
      .boolean()
      .optional()
      .describe("Offer the `Update branch` button on pull requests."),
    squash_merge_commit_title: z
      .enum(["PR_TITLE", "COMMIT_OR_PR_TITLE"])
      .optional()
      .describe("Commit-title source for squash merges."),
    squash_merge_commit_message: z
      .enum(["PR_BODY", "COMMIT_MESSAGES", "BLANK"])
      .optional()
      .describe("Commit-message source for squash merges."),
    description: z.string().optional().describe("Repository description."),
    homepage: z.string().optional().describe("Repository homepage URL."),
    topics: z
      .array(z.string().trim().min(1))
      .optional()
      .describe("Repository topic list. Replaces all topics on the repo; GitHub lowercases them."),

    // Deliberately NOT exposed: `private` and `archived`.
    //
    // Flipping visibility to private permanently deletes every fork, and
    // archiving makes a repository read-only in a way this bot could not then
    // undo (it would lose write access to its own config). Neither is a
    // reasonable outcome of a YAML typo in a file that cascades across every
    // repository you own. Change those two by hand.
  })
  .strict()
  .describe("Repository settings synced when `settings.enabled` is true.")
  .prefault({});

/**
 * Kept separate from the rulesets section because GitHub applies both
 * independently and most homelab repos only need one of them.
 */
export const branchProtectionSchema = z
  .object({
    required_status_checks: z
      .object({
        strict: z
          .boolean()
          .default(false)
          .describe("Require branches to be up to date with the base branch before merging."),
        contexts: z
          .array(z.string().trim().min(1))
          .default([])
          .describe("Check context names (GitHub Actions workflow/job) that must pass."),
      })
      .strict()
      .nullable()
      .optional()
      .describe(
        "Status checks a branch must satisfy. API-required null: sent as null when unset; sub-fields left out are kept by GitHub.",
      ),
    enforce_admins: z
      .boolean()
      .nullable()
      .optional()
      .describe(
        "Apply branch protections to repository admins too. API-required null: sent as null when unset.",
      ),
    required_pull_request_reviews: z
      .object({
        required_approving_review_count: z
          .number()
          .int()
          .min(0)
          .max(6)
          .optional()
          .describe("How many approving reviews are required (0-6)."),
        dismiss_stale_reviews: z
          .boolean()
          .optional()
          .describe("Dismiss a review when new commits land."),
        require_code_owner_reviews: z
          .boolean()
          .optional()
          .describe("Require approval from code owners for their files."),
        require_last_push_approval: z
          .boolean()
          .optional()
          .describe("A PR must be approved after its last commit."),
      })
      .strict()
      .nullable()
      .optional()
      .describe(
        "Pull-request review protections. API-required null: sent as null when unset; sub-fields left out are kept by GitHub.",
      ),
    required_linear_history: z
      .boolean()
      .optional()
      .describe("Only allow commits that extend the branch tip (no merges)."),
    allow_force_pushes: z.boolean().nullable().optional().describe("Allow force pushes."),
    allow_deletions: z.boolean().optional().describe("Allow deletion of the branch."),
    required_conversation_resolution: z
      .boolean()
      .optional()
      .describe("Require all conversations to be resolved before merging."),
    lock_branch: z.boolean().optional().describe("Lock the branch against any pushes."),
    block_creations: z
      .boolean()
      .optional()
      .describe("Prevent creation of the branch by users without write access."),
  })
  .strict();

export const labelSchema = z
  .object({
    name: z.string().trim().min(1).describe("Label name."),
    color: z
      .string()
      .trim()
      .regex(/^#?[0-9a-fA-F]{6}$/, "must be a six-digit hex colour")
      .optional()
      .describe("Colour as six hex digits; a leading `#` is accepted and stripped on apply."),
    description: z
      .string()
      .max(100)
      .optional()
      .describe("Label description — at most 100 characters, GitHub's limit."),
    from: z.string().trim().min(1).optional().describe("Rename an existing label to `name` first."),
  })
  .strict();

export const rulesetSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Ruleset name. The case-insensitive match key for updates, deletes, and prune protection — two rulesets differing only in case are rejected as a collision at authoring time.",
      ),
    target: z
      .enum(["branch", "tag", "push"])
      .default("branch")
      .describe("What the ruleset applies to: branch, tag, or push."),
    enforcement: z
      .enum(["active", "evaluate", "disabled"])
      .default("active")
      .describe("active enforces; evaluate monitors without blocking; disabled is a no-op."),
    bypass_actors: z
      .array(
        z
          .object({
            actor_id: z
              .number()
              .int()
              .nullable()
              .optional()
              .describe(
                "The specific actor's ID (user, team, org role, deploy key, or integration).",
              ),
            actor_type: z
              .enum([
                "Integration",
                "OrganizationAdmin",
                "RepositoryRole",
                "Team",
                "DeployKey",
                "User",
              ])
              .describe("The kind of actor that may bypass."),
            bypass_mode: z
              .enum(["always", "pull_request", "exempt"])
              .optional()
              .describe("Scope of the bypass: always, pull_request only, or exempt."),
          })
          .strict(),
      )
      .optional()
      .describe(
        "Actors allowed to bypass this ruleset. actor_type selects the kind, actor_id names the specific actor, bypass_mode controls scope (mirrors the REST reference).",
      ),
    conditions: z
      .object({
        ref_name: z
          .object({
            include: z
              .array(z.string().trim().min(1))
              .optional()
              .describe("Glob-ish name patterns the ruleset applies to."),
            exclude: z
              .array(z.string().trim().min(1))
              .optional()
              .describe("Glob-ish name patterns the ruleset must not apply to."),
          })
          .strict()
          .optional()
          .describe("Patterns the ruleset applies to, as include/exclude name globs."),
      })
      .strict()
      .optional()
      .describe(
        "Conditions. Accepts only `ref_name` — organization-level condition keys 422 on the repository-rulesets endpoint, so they are rejected at authoring time rather than mid-sync.",
      ),
    rules: z
      .array(
        z
          .object({
            type: z.string().trim().min(1).describe("Rule type (e.g. `pull_request`)."),
          })
          .passthrough(),
      )
      .default([])
      .describe(
        "The rules applied. `type` is required (catches obvious mistakes); the rest of each rule body passes through and GitHub validates it on write.",
      ),
  })
  .strict();

export const settingsSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        "Master switch. Off by default: installing this app must not silently start rewriting repository settings until it is explicitly asked to.",
      ),
    pruneLabels: z
      .boolean()
      .default(false)
      .describe("Remove labels that exist on the repo but are absent from config."),
    pruneRulesets: z.boolean().default(false).meta({
      description:
        "Converge everything: delete every ruleset in the repository that is not named in this configuration — including rulesets created outside Woodhouse. Off by default. There is no ownership marker to fall back on: GitHub's ruleset API has no metadata slot for one, so prune cannot tell a hand-made ruleset from a managed one. Turn it on only when the ruleset list below is genuinely the whole truth for the repository.",
    }),
  })
  .strict()
  .describe(
    "Repo-settings sync: the master switch plus the prune toggles for labels and rulesets. Off by default.",
  )
  .prefault({});

export const woodhouseConfigSchema = z
  .object({
    inherit: z
      .boolean()
      .default(true)
      .describe(
        "Set on a repository's local config to opt out of the inherited baseline entirely rather than merging with it.",
      ),

    settings: settingsSchema,
    repository: repositorySchema,
    branchProtection: z
      .record(z.string(), branchProtectionSchema)
      .default({})
      .describe(
        "Classic branch protection keyed by branch name; every configured branch is PUT wholesale and idempotently on each sync. Fields left unset are omitted from the write (GitHub keeps them as-is), except the three API-required fields (`required_status_checks`, `enforce_admins`, `required_pull_request_reviews`), which are sent as explicit `null` when unset; a branch that does not exist is skipped, not an error.",
      ),
    labels: z
      .array(labelSchema)
      .default([])
      .describe(
        "Repository labels converge to this list; removal is governed by `settings.pruneLabels`.",
      ),
    rulesets: z
      .array(rulesetSchema)
      // Case-insensitive name-collision check (see the `rulesets` description).
      .superRefine((rulesets, ctx) => {
        const seen = new Map<string, number>();
        rulesets.forEach((ruleset, index) => {
          const key = ruleset.name.toLowerCase();
          const first = seen.get(key);
          if (first !== undefined) {
            ctx.addIssue({
              code: "custom",
              message: `duplicate ruleset name "${ruleset.name}" (already used by "${rulesets[first]?.name}" at index ${first})`,
              path: [index],
            });
          } else {
            seen.set(key, index);
          }
        });
      })
      .default([])
      .meta({
        description:
          "Repository rulesets converge to this list; every configured ruleset is re-declared wholesale on every sync (create or update, matched by name — GitHub's GET is too normalised to diff). The perimeter is typed and the core is open: `type` is required (catches obvious mistakes) and the rest of each rule body passes through, GitHub validates on write. Supported rule types as prose (deliberately not an enum — GitHub extends the union regularly), indicative not validation: creation, update, deletion, required_linear_history, merge_queue, required_deployments, required_signatures, pull_request, required_status_checks, non_fast_forward, commit_message_pattern, commit_author_email_pattern, committer_email_pattern, branch_name_pattern, tag_name_pattern, workflows, code_scanning, code_quality, code_coverage, copilot_code_review, license_compliance_scanning, file_path_restriction, max_file_path_length, file_extension_restriction, max_file_size. `secret_scanning` is documented but absent from the REST array. Conditions accept only `ref_name` (organization-level keys 422 on this endpoint, rejected at authoring time instead of mid-sync). WARN: `settings.pruneRulesets` deletes every ruleset not named here, including hand-made ones.",
        examples: [
          [
            {
              name: "woodhouse",
              target: "branch",
              enforcement: "active",
              conditions: { ref_name: { include: ["refs/heads/main"] } },
              rules: [
                { type: "required_linear_history" },
                {
                  type: "pull_request",
                  parameters: { required_approving_review_count: 1 },
                },
              ],
            },
          ],
        ],
      }),
    gatekeeper: gatekeeperSchema,
    autoApproval: autoApprovalSchema,
  })
  .strict()
  .prefault({});

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
