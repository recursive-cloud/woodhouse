/**
 * Dress-code configuration.
 *
 * Kept separate from `schema.ts` the same way as the environments section:
 * the section grows its own options while `woodhouseConfigSchema` only
 * composes it.
 */

import { z } from "zod";

/** The `dressCode` section of `woodhouseConfigSchema`. */
export const dressCodeSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        "Create the `woodhouse/dress-code` check on every pull request's head commit, validating the title against the conventional-commit pattern. Enabling requires the repository merge settings coupled accordingly (squash merges carrying the PR title, rebase and merge-commit merges disallowed), enforced by pull-request configuration validation.",
      ),
  })
  .strict()
  .describe("The `woodhouse/dress-code` PR-title check this schema configures.")
  .prefault({});
