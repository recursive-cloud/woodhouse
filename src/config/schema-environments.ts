/**
 * Deployment environment configuration.
 *
 * Kept separate from `schema.ts` because the section carries its own
 * cross-field rules: the environment entry validates branch-policy mode and
 * duplicate patterns, and the environments record rejects names differing only
 * in case. Both are composed into `woodhouseConfigSchema` unchanged.
 */

import { z } from "zod";

/**
 * Deployment environment settings, keyed by environment name in
 * `woodhouseConfigSchema`.
 */
export const environmentSchema = z
  .object({
    wait_timer: z
      .number()
      .int()
      .min(0)
      .max(43200)
      .optional()
      .describe(
        "Minutes a deployment waits before it can proceed (0-43200). Sent as 0 when unset.",
      ),
    prevent_self_review: z
      .boolean()
      .optional()
      .describe(
        "Block the user who triggered a deployment from approving it. Sent as false when unset.",
      ),
    reviewers: z
      .array(
        z
          .object({
            type: z.enum(["User", "Team"]).describe("Whether `id` names a user or a team."),
            id: z.number().int().describe("Numeric ID of the user or team."),
          })
          .strict(),
      )
      .min(1)
      .max(6)
      .nullable()
      .optional()
      .describe(
        "Required reviewers, at most 6. A present list needs at least one entry; null clears an inherited list. Sent as null when unset.",
      ),
    can_admins_bypass: z
      .boolean()
      .optional()
      .describe(
        "Allow repository admins to deploy without meeting the protection rules. GitHub does not document this field on the REST reference, but it is accepted and functional. Omitted from the write when unset.",
      ),
    deployment_branch_policy: z
      .enum(["protected", "custom"])
      .optional()
      .describe(
        'Branch-policy mode for this environment: "protected" allows only protected branches to deploy, "custom" allows the patterns in `branch_policies`. The config carries the plain mode string; the applier maps it to the REST API\'s mutually exclusive `deployment_branch_policy` object (`protected_branches` / `custom_branch_policies`) when writing the environment. Unset is sent as null, allowing all branches.',
      ),
    branch_policies: z
      .array(z.string().trim().min(1))
      .optional()
      .describe(
        'Branch-name patterns allowed to deploy when `deployment_branch_policy` is "custom". Patterns converge: created when missing on the environment, deleted when absent from this list. Requires `deployment_branch_policy: "custom"`. Patterns differing only in case are rejected as duplicates at authoring time.',
      ),
  })
  .strict()
  .superRefine((environment, ctx) => {
    const policies = environment.branch_policies;
    if (policies === undefined) return;

    if (environment.deployment_branch_policy !== "custom") {
      ctx.addIssue({
        code: "custom",
        message: 'branch_policies requires deployment_branch_policy "custom"',
        path: ["branch_policies"],
      });
    }

    // Case-insensitive pattern-collision check (see the `branch_policies` description).
    const seen = new Map<string, string>();
    policies.forEach((policy, index) => {
      const key = policy.toLowerCase();
      const first = seen.get(key);
      if (first !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate branch policy pattern "${policy}" (already used by "${first}")`,
          path: ["branch_policies", index],
        });
      } else {
        seen.set(key, policy);
      }
    });
  });

/** The environments section of `woodhouseConfigSchema`: entries keyed by name. */
export const environmentsSchema = z
  .record(z.string().max(255), environmentSchema.nullable())
  // Case-insensitive name-collision check (see the `environments` description).
  .superRefine((environments, ctx) => {
    const seen = new Map<string, string>();
    for (const name of Object.keys(environments)) {
      const key = name.toLowerCase();
      const first = seen.get(key);
      if (first !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate environment name "${name}" (already used by "${first}")`,
          path: [name],
        });
      } else {
        seen.set(key, name);
      }
    }
  })
  .default({})
  .meta({
    description:
      "Deployment environments keyed by name, each name at most 255 characters; names differing only in case are rejected as duplicates at authoring time. Every configured environment is re-declared wholesale (PUT) on each sync, and reported as applied even when it already matches. Unset fields are sent as the API defaults (`wait_timer` 0, `prevent_self_review` false, `reviewers` null), so a bare entry declares an environment with no wait timer and no required reviewers; an unset `deployment_branch_policy` is sent as null, allowing all branches. When the mode is set, the environment is re-declared with the mode mapped to the API's mutually exclusive `deployment_branch_policy` object, and in custom mode its branch-policy patterns converge to `branch_policies`: created when missing on the environment, deleted when absent from the list. That pattern deletion is deliberate and never touches the environment itself. `reviewers: null` clears an inherited list. Matching is by exact declared name, so a case-variant environment already on the repository is left untouched. Environments are never deleted: removing an entry only stops the re-assertion. An entry whose value is explicit `null` removes that environment from the merged configuration and nothing is written for it — the convention a local file uses to clear an environment it inherited from the baseline.",
  });
